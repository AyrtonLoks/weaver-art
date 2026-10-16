//! Enquadramento Afim, Auto-Crop Inteligente e Máscara Geométrica do Tear.
//!
//! Implementa transformações afins 2D (escala/zoom, translação pan e rotação) com interpolação
//! contínua (bilinear e bicúbica), recorte por máscara de `LoomGeometry` e localização automática
//! de cabeça/rosto via análise de saliência de alta frequência e matiz de pele.

use std::f32::consts::PI;
use weaver_domain::{LoomGeometry, LoomGridMapping};

use crate::image::{GrayImage, ImageBuffer, Rgba8Image};

/// Método de interpolação sub-pixel para mapeamento afim de coordenadas.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum InterpolationMethod {
    /// Interpolação bilinear rápida de 4 pontos (padrão).
    #[default]
    Bilinear,
    /// Interpolação bicúbica de alta precisão em vizinhança 4x4 (Catmull-Rom).
    Bicubic,
}

/// Parâmetros de enquadramento afim interativo e auto-crop.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FramingConfig {
    /// Fator de ampliação/zoom ($> 1.0$ amplia, $< 1.0$ reduz). Padrão: 1.0.
    pub zoom: f32,
    /// Deslocamento horizontal normalizado em $[-1.0, 1.0]$ relativo ao semi-eixo da imagem.
    pub pan_x: f32,
    /// Deslocamento vertical normalizado em $[-1.0, 1.0]$ relativo ao semi-eixo da imagem.
    pub pan_y: f32,
    /// Rotação da imagem em graus no sentido horário em torno do centro de enquadramento.
    pub rotation_deg: f32,
}

impl Default for FramingConfig {
    fn default() -> Self {
        Self {
            zoom: 1.0,
            pan_x: 0.0,
            pan_y: 0.0,
            rotation_deg: 0.0,
        }
    }
}

/// Máscara booleana pré-calculada para recorte geométrico na grade de simulação.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoomMask {
    pub width: u32,
    pub height: u32,
    pub mask: Vec<bool>,
}

impl LoomMask {
    /// Gera a máscara binária avaliando a inclusão de cada pixel no contorno físico do tear.
    pub fn from_loom(loom: &LoomGeometry, width: u32, height: u32) -> Self {
        let mapping = LoomGridMapping::from_loom(loom, width, height);
        let count = (width * height) as usize;
        let mut mask = Vec::with_capacity(count);

        for y in 0..height {
            for x in 0..width {
                let (x_mm, y_mm) = mapping.pixel_to_mm(x as f64, y as f64);
                mask.push(loom.is_inside(x_mm, y_mm));
            }
        }

        Self {
            width,
            height,
            mask,
        }
    }

    /// Retorna se o pixel nas coordenadas inteiras $(x, y)$ reside dentro do contorno útil do tear.
    #[inline]
    pub fn is_inside(&self, x: u32, y: u32) -> bool {
        let idx = y as usize * self.width as usize + x as usize;
        self.mask.get(idx).copied().unwrap_or(false)
    }
}

/// Opções de configuração para o algoritmo de Auto-Enquadramento.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AutoFramingOptions {
    /// Proporção alvo que a cabeça/feições devem ocupar em relação ao diâmetro do tear (padrão 80% = 0.80).
    pub target_ratio: f32,
    /// Deslocamento vertical para posicionar a linha dos olhos ligeiramente acima do centro geométrico (~terço superior).
    pub eye_line_offset_ratio: f32,
}

impl Default for AutoFramingOptions {
    fn default() -> Self {
        Self {
            target_ratio: 0.80,
            eye_line_offset_ratio: 0.08,
        }
    }
}

/// Resultado analítico do cálculo de Auto-Enquadramento.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AutoFramingResult {
    /// Configuração ideal de zoom e pan calculada.
    pub config: FramingConfig,
    /// Bounding Box da região facial detectada: `[min_x, min_y, max_x, max_y]`.
    pub face_bbox: [f32; 4],
    /// Centroide $(X, Y)$ da massa de saliência facial.
    pub centroid: (f32, f32),
    /// Grau de confiança da detecção em $[0.0, 1.0]$.
    pub confidence: f32,
}

/// Aplica transformação afim 2D e mascara pixels externos utilizando a geometria do tear.
pub fn apply_affine_transform(
    src: &ImageBuffer<f32>,
    out_width: u32,
    out_height: u32,
    config: &FramingConfig,
    method: InterpolationMethod,
    loom_mask: Option<&LoomMask>,
    background_val: f32,
) -> ImageBuffer<f32> {
    let mut dst = ImageBuffer::fill(out_width, out_height, src.channels, background_val);
    let channels = src.channels;

    let in_w = src.width as f32;
    let in_h = src.height as f32;
    let out_w = out_width as f32;
    let out_h = out_height as f32;

    let c_in_x = (in_w - 1.0) * 0.5;
    let c_in_y = (in_h - 1.0) * 0.5;
    let c_out_x = (out_w - 1.0) * 0.5;
    let c_out_y = (out_h - 1.0) * 0.5;

    let r_in = in_w.min(in_h) * 0.5;
    let r_out = out_w.min(out_h) * 0.5;

    let zoom = config.zoom.max(1e-4);
    let scale = r_in / (r_out * zoom);

    let theta_rad = config.rotation_deg * (PI / 180.0);
    let cos_t = theta_rad.cos();
    let sin_t = theta_rad.sin();

    let pan_shift_x = config.pan_x * r_in;
    let pan_shift_y = config.pan_y * r_in;

    let mut sample_buf = vec![0.0f32; channels];

    for y_out in 0..out_height {
        let dy = y_out as f32 - c_out_y;

        for x_out in 0..out_width {
            if let Some(mask) = loom_mask {
                if !mask.is_inside(x_out, y_out) {
                    continue;
                }
            }

            let dx = x_out as f32 - c_out_x;

            // Rotação inversa (no sentido anti-horário pelo ângulo theta)
            let dx_rot = dx * cos_t + dy * sin_t;
            let dy_rot = -dx * sin_t + dy * cos_t;

            // Mapeamento para coordenadas da imagem de entrada
            let x_in = c_in_x + pan_shift_x + dx_rot * scale;
            let y_in = c_in_y + pan_shift_y + dy_rot * scale;

            match method {
                InterpolationMethod::Bilinear => {
                    src.sample_bilinear(x_in, y_in, &mut sample_buf);
                }
                InterpolationMethod::Bicubic => {
                    src.sample_bicubic(x_in, y_in, &mut sample_buf);
                }
            }

            dst.set_pixel(x_out, y_out, &sample_buf);
        }
    }

    dst
}

/// Calcula o Auto-Enquadramento inteligente para imagens RGBA coloridas.
///
/// Combina mapa de energia de alta frequência (gradiente de Sobel), probabilidade cromática de pele
/// e prior composicional central para estimar o centroide da cabeça e proporção de 80%.
pub fn compute_auto_framing(
    image: &Rgba8Image,
    options: &AutoFramingOptions,
) -> AutoFramingResult {
    let gray = image.to_gray();
    let width = image.width;
    let height = image.height;

    if width < 4 || height < 4 {
        return AutoFramingResult {
            config: FramingConfig::default(),
            face_bbox: [0.0, 0.0, width as f32, height as f32],
            centroid: (width as f32 * 0.5, height as f32 * 0.5),
            confidence: 0.0,
        };
    }

    // 1. Mapa de Gradiente Sobel (Altas Frequências)
    let edges = compute_sobel_gradient_magnitude(&gray);

    // 2. Mapa de Probabilidade de Pele
    let skin = compute_skin_probability_map(image);

    // 3. Combinação de Saliência com Prior Central
    let mut saliency = vec![0.0f32; (width * height) as usize];
    let c_x = width as f32 * 0.5;
    let c_y = height as f32 * 0.45; // Cabeça ligeiramente no terço superior
    let inv_sigma_x_sq = 1.0 / (0.40 * width as f32).powi(2);
    let inv_sigma_y_sq = 1.0 / (0.40 * height as f32).powi(2);

    let mut total_mass = 0.0f32;
    let mut weighted_x = 0.0f32;
    let mut weighted_y = 0.0f32;

    for y in 0..height {
        let dy = y as f32 - c_y;
        let dy_sq = dy * dy * inv_sigma_y_sq;

        for x in 0..width {
            let idx = (y * width + x) as usize;
            let dx = x as f32 - c_x;
            let dx_sq = dx * dx * inv_sigma_x_sq;
            let center_weight = (-0.5 * (dx_sq + dy_sq)).exp();

            // Saliência = Alta Frequência * (Fator Base + Peso de Pele) * Centro
            let s = edges[idx] * (0.30 + 0.70 * skin[idx]) * center_weight;
            saliency[idx] = s;

            total_mass += s;
            weighted_x += x as f32 * s;
            weighted_y += y as f32 * s;
        }
    }

    if total_mass <= 1e-4 {
        return AutoFramingResult {
            config: FramingConfig::default(),
            face_bbox: [0.0, 0.0, width as f32, height as f32],
            centroid: (c_x, c_y),
            confidence: 0.0,
        };
    }

    let mean_x = weighted_x / total_mass;
    let mean_y = weighted_y / total_mass;

    // 4. Dispersão espacial (desvio padrão ponderado)
    let mut var_x = 0.0f32;
    let mut var_y = 0.0f32;
    for y in 0..height {
        let dy = y as f32 - mean_y;
        for x in 0..width {
            let idx = (y * width + x) as usize;
            let s = saliency[idx];
            let dx = x as f32 - mean_x;
            var_x += dx * dx * s;
            var_y += dy * dy * s;
        }
    }
    let sigma_x = (var_x / total_mass).sqrt().max(1.0);
    let sigma_y = (var_y / total_mass).sqrt().max(1.0);

    // Bounding Box estimada (aproximadamente cobrindo a extensão facial e cabelo)
    let min_x = (mean_x - 1.8 * sigma_x).clamp(0.0, width as f32);
    let max_x = (mean_x + 1.8 * sigma_x).clamp(0.0, width as f32);
    let min_y = (mean_y - 2.0 * sigma_y).clamp(0.0, height as f32);
    let max_y = (mean_y + 2.0 * sigma_y).clamp(0.0, height as f32);

    let face_w = max_x - min_x;
    let face_h = max_y - min_y;
    let min_dim = (width.min(height) as f32).max(1.0);
    let face_extent = face_w.max(face_h).clamp(0.20 * min_dim, min_dim);

    // 5. Cálculo dos parâmetros ideais de enquadramento
    let r_in = min_dim * 0.5;
    let target_diameter = 2.0 * r_in * options.target_ratio.clamp(0.40, 1.0);
    let zoom = (target_diameter / face_extent).clamp(0.50, 4.0);

    let pan_x = ((mean_x - c_x) / r_in).clamp(-1.0, 1.0);
    let pan_y = ((mean_y - c_y) / r_in - options.eye_line_offset_ratio).clamp(-1.0, 1.0);

    // 6. Confiança baseada na concentração de saliência dentro do Bounding Box
    let mut bbox_mass = 0.0f32;
    let bx0 = min_x.floor() as u32;
    let bx1 = max_x.ceil().min(width as f32 - 1.0) as u32;
    let by0 = min_y.floor() as u32;
    let by1 = max_y.ceil().min(height as f32 - 1.0) as u32;

    for y in by0..=by1 {
        for x in bx0..=bx1 {
            let idx = (y * width + x) as usize;
            bbox_mass += saliency[idx];
        }
    }
    let confidence = (bbox_mass / total_mass).clamp(0.0, 1.0);

    AutoFramingResult {
        config: FramingConfig {
            zoom,
            pan_x,
            pan_y,
            rotation_deg: 0.0,
        },
        face_bbox: [min_x, min_y, max_x, max_y],
        centroid: (mean_x, mean_y),
        confidence,
    }
}

/// Calcula a magnitude de gradiente de Sobel normalizada $[0.0, 1.0]$.
fn compute_sobel_gradient_magnitude(gray: &GrayImage) -> Vec<f32> {
    let w = gray.width;
    let h = gray.height;
    let mut grad = vec![0.0f32; (w * h) as usize];

    if w < 3 || h < 3 {
        return grad;
    }

    for y in 1..(h - 1) {
        for x in 1..(w - 1) {
            let p00 = gray.get_pixel(x - 1, y - 1)[0];
            let p10 = gray.get_pixel(x, y - 1)[0];
            let p20 = gray.get_pixel(x + 1, y - 1)[0];

            let p01 = gray.get_pixel(x - 1, y)[0];
            let p21 = gray.get_pixel(x + 1, y)[0];

            let p02 = gray.get_pixel(x - 1, y + 1)[0];
            let p12 = gray.get_pixel(x, y + 1)[0];
            let p22 = gray.get_pixel(x + 1, y + 1)[0];

            let gx = (p20 + 2.0 * p21 + p22) - (p00 + 2.0 * p01 + p02);
            let gy = (p02 + 2.0 * p12 + p22) - (p00 + 2.0 * p10 + p20);

            let mag = (gx * gx + gy * gy).sqrt();
            grad[(y * w + x) as usize] = mag.clamp(0.0, 1.0);
        }
    }

    grad
}

/// Calcula o mapa de probabilidade de pele em $[0.0, 1.0]$ no espaço YCbCr e crominância normalizada.
fn compute_skin_probability_map(image: &Rgba8Image) -> Vec<f32> {
    let count = (image.width * image.height) as usize;
    let mut skin = vec![0.0f32; count];

    for (i, chunk) in image.data.chunks_exact(4).enumerate() {
        let r = chunk[0] as f32;
        let g = chunk[1] as f32;
        let b = chunk[2] as f32;

        let sum = r + g + b;
        if sum < 15.0 {
            skin[i] = 0.0;
            continue;
        }

        // Conversão aproximada YCbCr
        let cb = 128.0 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        let cr = 128.0 + 0.5 * r - 0.418688 * g - 0.081312 * b;

        // Distribuição típica de pele humana: Cb ~ 102, Cr ~ 153
        let d_cb = (cb - 105.0) / 25.0;
        let d_cr = (cr - 150.0) / 25.0;
        let dist_sq = d_cb * d_cb + d_cr * d_cr;

        let nr = r / sum;
        let ng = g / sum;
        let is_skin_hue = nr > 0.33 && nr < 0.60 && ng > 0.25 && ng < 0.38 && r > g && g > b;

        if is_skin_hue {
            skin[i] = (-0.5 * dist_sq).exp().clamp(0.0, 1.0);
        } else {
            skin[i] = ((-0.5 * dist_sq).exp() * 0.25).clamp(0.0, 1.0);
        }
    }

    skin
}

#[cfg(test)]
mod tests {
    use super::*;
    use weaver_domain::{LoomGeometry, LoomPhysicalSpec};

    #[test]
    fn test_affine_rotation_90_degrees() {
        let mut src = ImageBuffer::fill(10, 10, 1, 0.0);
        // Pixel brilhante em (2, 5)
        src.set_pixel(2, 5, &[1.0]);

        // Rotação de 90 graus no sentido horário em torno do centro (4.5, 4.5)
        let config = FramingConfig {
            zoom: 1.0,
            pan_x: 0.0,
            pan_y: 0.0,
            rotation_deg: 90.0,
        };

        let dst = apply_affine_transform(
            &src,
            10,
            10,
            &config,
            InterpolationMethod::Bilinear,
            None,
            0.0,
        );

        // Com rotação horária de 90 graus: (dx, dy) -> (-dy, dx)
        // dx = 2 - 4.5 = -2.5, dy = 5 - 4.5 = 0.5
        // Após rotação no sentido horário, o ponto se desloca para dx' = -dy = -0.5, dy' = dx = -2.5
        // x' = 4.5 - 0.5 = 4.0, y' = 4.5 - 2.5 = 2.0
        let val_at_target = dst.get_pixel(4, 2)[0];
        assert!(
            val_at_target > 0.6,
            "Pixel rotacionado esperado em (4, 2), valor obtido: {:.3}",
            val_at_target
        );
    }

    #[test]
    fn test_rectangular_loom_mask() {
        let spec = LoomPhysicalSpec::rectangle(300.0, 200.0, 40, 2.0, 2.0, 10.0);
        let loom = LoomGeometry::new(spec);
        let mask = LoomMask::from_loom(&loom, 30, 20);

        // O centro deve estar dentro
        assert!(mask.is_inside(15, 10));

        // Ponto interno próximo ao centro
        assert!(mask.is_inside(12, 10));

        // Canto exterior distante (0, 0) deve estar fora
        assert!(!mask.is_inside(0, 0));
    }
}

