//! Detectores de Borda Sobel e Canny e Fusão de Altas Frequências.
//!
//! Implementa operadores de gradiente de Sobel, o detector de bordas de Canny completo
//! (suavização gaussiana 5x5, supressão não-máxima e histerese) e rotinas de fusão
//! e saliência multiescala para realce de feições estruturais (olhos, óculos, lábios).

use std::f32::consts::PI;
use crate::image::{GrayImage, ImageBuffer, Rgba8Image};

/// Resultado da aplicação do operador de Sobel contendo magnitude, ângulos e gradientes direcionais.
#[derive(Debug, Clone, PartialEq)]
pub struct SobelResult {
    /// Magnitude normalizada do gradiente $\Vert\nabla I\Vert \in [0.0, 1.0]$.
    pub magnitude: GrayImage,
    /// Direção do gradiente $\theta = \text{atan2}(G_y, G_x)$ em radianos $[-\pi, \pi]$.
    pub direction: ImageBuffer<f32>,
    /// Gradiente horizontal bruto $G_x \in [-4.0, 4.0]$.
    pub gx: ImageBuffer<f32>,
    /// Gradiente vertical bruto $G_y \in [-4.0, 4.0]$.
    pub gy: ImageBuffer<f32>,
}

/// Parâmetros de configuração para o detector de bordas de Canny.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CannyConfig {
    /// Limiar inferior para histerese em $[0.0, 1.0]$. Padrão: 0.08.
    pub low_threshold: f32,
    /// Limiar superior para histerese em $[0.0, 1.0]$. Padrão: 0.18.
    pub high_threshold: f32,
    /// Desvio padrão $\sigma$ para o filtro gaussiano $5 \times 5$. Padrão: 1.0.
    pub gaussian_sigma: f32,
}

impl Default for CannyConfig {
    fn default() -> Self {
        Self {
            low_threshold: 0.08,
            high_threshold: 0.18,
            gaussian_sigma: 1.0,
        }
    }
}

/// Calcula o operador de Sobel sobre uma imagem em escala de cinza.
///
/// Retorna a magnitude euclidiana normalizada $\Vert\nabla I\Vert = \frac{\sqrt{G_x^2 + G_y^2}}{4.0}$,
/// a direção angular $\theta = \text{atan2}(G_y, G_x)$ e os gradientes $G_x$ e $G_y$.
pub fn sobel(img: &GrayImage) -> SobelResult {
    let w = img.width;
    let h = img.height;
    let total = (w * h) as usize;

    let mut magnitude_data = vec![0.0f32; total];
    let mut direction_data = vec![0.0f32; total];
    let mut gx_data = vec![0.0f32; total];
    let mut gy_data = vec![0.0f32; total];

    if w < 2 || h < 2 {
        return SobelResult {
            magnitude: GrayImage::new(w, h, 1, magnitude_data),
            direction: ImageBuffer::new(w, h, 1, direction_data),
            gx: ImageBuffer::new(w, h, 1, gx_data),
            gy: ImageBuffer::new(w, h, 1, gy_data),
        };
    }

    for y in 0..h {
        let y0 = if y == 0 { 0 } else { y - 1 };
        let y1 = if y + 1 >= h { h - 1 } else { y + 1 };

        for x in 0..w {
            let x0 = if x == 0 { 0 } else { x - 1 };
            let x1 = if x + 1 >= w { w - 1 } else { x + 1 };

            let p00 = img.get_pixel(x0, y0)[0];
            let p10 = img.get_pixel(x, y0)[0];
            let p20 = img.get_pixel(x1, y0)[0];

            let p01 = img.get_pixel(x0, y)[0];
            let p21 = img.get_pixel(x1, y)[0];

            let p02 = img.get_pixel(x0, y1)[0];
            let p12 = img.get_pixel(x, y1)[0];
            let p22 = img.get_pixel(x1, y1)[0];

            // Gradiente horizontal: colunas direita - esquerda
            let gx = (p20 + 2.0 * p21 + p22) - (p00 + 2.0 * p01 + p02);
            // Gradiente vertical: linhas inferior - superior
            let gy = (p02 + 2.0 * p12 + p22) - (p00 + 2.0 * p10 + p20);

            let mag = (gx * gx + gy * gy).sqrt();
            let mag_norm = (mag / 4.0).clamp(0.0, 1.0);
            let dir = gy.atan2(gx);

            let idx = (y * w + x) as usize;
            magnitude_data[idx] = mag_norm;
            direction_data[idx] = dir;
            gx_data[idx] = gx;
            gy_data[idx] = gy;
        }
    }

    SobelResult {
        magnitude: GrayImage::new(w, h, 1, magnitude_data),
        direction: ImageBuffer::new(w, h, 1, direction_data),
        gx: ImageBuffer::new(w, h, 1, gx_data),
        gy: ImageBuffer::new(w, h, 1, gy_data),
    }
}

/// Aplica suavização gaussiana separável $5 \times 5$ com reflexão/clamping nas bordas.
pub fn gaussian_blur_5x5(img: &GrayImage, sigma: f32) -> GrayImage {
    let w = img.width;
    let h = img.height;
    if w == 0 || h == 0 {
        return img.clone();
    }

    let sigma_val = sigma.max(0.1);
    let mut kernel = [0.0f32; 5];
    let mut k_sum = 0.0f32;
    for i in 0..5 {
        let d = (i as f32) - 2.0;
        let v = (-0.5 * (d * d) / (sigma_val * sigma_val)).exp();
        kernel[i] = v;
        k_sum += v;
    }
    for k in &mut kernel {
        *k /= k_sum;
    }

    let total = (w * h) as usize;
    let mut temp = vec![0.0f32; total];
    let mut out = vec![0.0f32; total];

    // Passe horizontal
    for y in 0..h {
        let row_offset = (y * w) as usize;
        for x in 0..w {
            let mut sum = 0.0f32;
            for (k_idx, &kw) in kernel.iter().enumerate() {
                let sx = (x as i32 + k_idx as i32 - 2).clamp(0, w as i32 - 1) as usize;
                sum += img.data[row_offset + sx] * kw;
            }
            temp[row_offset + x as usize] = sum;
        }
    }

    // Passe vertical
    for y in 0..h {
        let row_offset = (y * w) as usize;
        for x in 0..w {
            let mut sum = 0.0f32;
            for (k_idx, &kw) in kernel.iter().enumerate() {
                let sy = (y as i32 + k_idx as i32 - 2).clamp(0, h as i32 - 1) as usize;
                sum += temp[sy * w as usize + x as usize] * kw;
            }
            out[row_offset + x as usize] = sum;
        }
    }

    GrayImage::new(w, h, 1, out)
}

/// Detector de Bordas de Canny completo:
/// 1. Suavização Gaussiana $5 \times 5$.
/// 2. Gradiente de Sobel (magnitude e ângulo $\theta$).
/// 3. Supressão Não-Máxima (NMS) quantizada em $0^\circ, 45^\circ, 90^\circ, 135^\circ$.
/// 4. Limiarização dupla com histerese (conexão de bordas fracas a fortes).
pub fn canny(img: &GrayImage, config: &CannyConfig) -> GrayImage {
    let w = img.width;
    let h = img.height;
    if w < 3 || h < 3 {
        return GrayImage::zeros(w, h, 1);
    }

    // 1. Suavização Gaussiana 5x5
    let smoothed = gaussian_blur_5x5(img, config.gaussian_sigma);

    // 2. Gradiente de Sobel
    let sobel_res = sobel(&smoothed);
    let mag = &sobel_res.magnitude.data;
    let dir = &sobel_res.direction.data;

    // 3. Supressão Não-Máxima (NMS)
    let total = (w * h) as usize;
    let mut nms = vec![0.0f32; total];

    for y in 1..(h - 1) {
        for x in 1..(w - 1) {
            let idx = (y * w + x) as usize;
            let m = mag[idx];
            if m < config.low_threshold {
                continue;
            }

            let theta = dir[idx]; // em [-PI, PI]
            let mut angle_deg = theta * (180.0 / PI);
            if angle_deg < 0.0 {
                angle_deg += 180.0;
            }

            // Quantização dos 4 setores canônicos com desempate estrito para espessura de 1 pixel
            let is_local_max = if angle_deg < 22.5 || angle_deg >= 157.5 {
                // Setor 0°: Gradiente horizontal (Leste-Oeste)
                let left = mag[(y * w + (x - 1)) as usize];
                let right = mag[(y * w + (x + 1)) as usize];
                m >= left && m > right
            } else if angle_deg >= 22.5 && angle_deg < 67.5 {
                // Setor 45°: Gradiente diagonal (Sudeste - Noroeste em coordenadas de tela)
                let nw = mag[((y - 1) * w + (x - 1)) as usize];
                let se = mag[((y + 1) * w + (x + 1)) as usize];
                m >= nw && m > se
            } else if angle_deg >= 67.5 && angle_deg < 112.5 {
                // Setor 90°: Gradiente vertical (Norte-Sul)
                let top = mag[((y - 1) * w + x) as usize];
                let bottom = mag[((y + 1) * w + x) as usize];
                m >= top && m > bottom
            } else {
                // Setor 135°: Gradiente diagonal (Nordeste - Sudoeste)
                let ne = mag[((y - 1) * w + (x + 1)) as usize];
                let sw = mag[((y + 1) * w + (x - 1)) as usize];
                m >= ne && m > sw
            };

            if is_local_max {
                nms[idx] = m;
            } else {
                nms[idx] = 0.0;
            }
        }
    }

    // 4. Limiarização com Histerese
    let mut edges = vec![0.0f32; total];
    let mut queue = Vec::with_capacity(total / 8);

    // Identifica bordas fortes
    for y in 1..(h - 1) {
        for x in 1..(w - 1) {
            let idx = (y * w + x) as usize;
            if nms[idx] >= config.high_threshold {
                edges[idx] = 1.0;
                queue.push((x, y));
            }
        }
    }

    // Rastreia bordas fracas conectadas a bordas fortes em vizinhança 8
    while let Some((cx, cy)) = queue.pop() {
        for dy in [-1i32, 0, 1] {
            for dx in [-1i32, 0, 1] {
                if dx == 0 && dy == 0 {
                    continue;
                }
                let nx = cx as i32 + dx;
                let ny = cy as i32 + dy;
                if nx >= 0 && nx < w as i32 && ny >= 0 && ny < h as i32 {
                    let n_idx = (ny as u32 * w + nx as u32) as usize;
                    if edges[n_idx] < 1.0 && nms[n_idx] >= config.low_threshold {
                        edges[n_idx] = 1.0;
                        queue.push((nx as u32, ny as u32));
                    }
                }
            }
        }
    }

    GrayImage::new(w, h, 1, edges)
}

/// Mescla o mapa de bordas com a imagem base de luminância conforme o peso $\beta_{\text{borda}}$.
///
/// No modelo físico do Weaver Art, bordas estruturais reforçadas intensificam o contraste escurecendo
/// os detalhes finos correspondentes a fios escuros:
/// $$I_{\text{fused}}(x, y) = \text{clamp}(I(x, y) - \beta_{\text{borda}} \cdot E(x, y), 0.0, 1.0)$$
pub fn fuse_high_frequency(base: &GrayImage, edges: &GrayImage, beta_edge: f32) -> GrayImage {
    assert_eq!(base.width, edges.width);
    assert_eq!(base.height, edges.height);

    let count = base.data.len();
    let mut fused = Vec::with_capacity(count);

    for i in 0..count {
        let b = base.data[i];
        let e = edges.data[i];
        let v = (b - beta_edge * e).clamp(0.0, 1.0);
        fused.push(v);
    }

    GrayImage::new(base.width, base.height, 1, fused)
}

/// Saliência multiescala não-linear para feições faciais (olhos, nariz, boca e óculos).
///
/// Combina gradiente direto e gradiente suavizado ($\sigma = 1.5$) com compressão
/// não-linear por potência $\gamma \in (0, 1]$ para evitar saturação excessiva em bordas grossas.
pub fn compute_multiscale_saliency(luma: &GrayImage, gamma: f32) -> GrayImage {
    let e1 = sobel(luma).magnitude;
    let blurred = gaussian_blur_5x5(luma, 1.5);
    let e2 = sobel(&blurred).magnitude;

    let count = luma.data.len();
    let mut saliency = Vec::with_capacity(count);
    let safe_gamma = gamma.clamp(0.2, 1.5);

    for i in 0..count {
        let combined = 0.70 * e1.data[i] + 0.30 * e2.data[i];
        let compressed = combined.clamp(0.0, 1.0).powf(safe_gamma);
        saliency.push(compressed);
    }

    GrayImage::new(luma.width, luma.height, 1, saliency)
}

/// Renderiza o mapa de bordas em formato RGBA (brilho ciano/elétrico sobre fundo escuro).
pub fn edges_to_rgba(edges: &GrayImage) -> Rgba8Image {
    let count = (edges.width * edges.height) as usize;
    let mut data = Vec::with_capacity(count * 4);

    for &e in &edges.data {
        let mag = (e.clamp(0.0, 1.0) * 255.0).round();
        let r = (mag * 0.20) as u8;
        let g = (mag * 0.85) as u8;
        let b = mag as u8;
        data.push(r);
        data.push(g);
        data.push(b);
        data.push(255);
    }

    Rgba8Image::new(edges.width, edges.height, 4, data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sobel_gradient_magnitude_and_direction() {
        let w = 16u32;
        let h = 16u32;
        let mut img = GrayImage::zeros(w, h, 1);

        // Degrau vertical no meio: esquerda 0.0, direita 1.0
        for y in 0..h {
            for x in 8..w {
                img.set_pixel(x, y, &[1.0]);
            }
        }

        let res = sobel(&img);

        // Ao longo do degrau vertical em x=7 ou 8, o gradiente horizontal Gx deve ser positivo
        let gx_val = res.gx.get_pixel(7, 8)[0];
        assert!(gx_val > 0.0, "Gx deve detectar transição vertical");
        let gy_val = res.gy.get_pixel(7, 8)[0];
        assert!(gy_val.abs() < 1e-4, "Gy deve ser nulo em degrau puramente vertical");

        // Direção deve ser próxima de 0 radianos
        let dir = res.direction.get_pixel(7, 8)[0];
        assert!(dir.abs() < 1e-3, "Direção de gradiente horizontal deve ser 0 rad");

        // Em regiões homogêneas (x=2, y=2), magnitude deve ser nula
        assert_eq!(res.magnitude.get_pixel(2, 2)[0], 0.0);
    }

    #[test]
    fn test_canny_thin_edges_and_hysteresis() {
        let w = 32u32;
        let h = 32u32;
        let mut img = GrayImage::zeros(w, h, 1);

        // Linha grossa de 3 pixels de largura com intensidade 1.0
        for y in 8..24 {
            for x in 14..=16 {
                img.set_pixel(x, y, &[1.0]);
            }
        }

        let config = CannyConfig {
            low_threshold: 0.05,
            high_threshold: 0.15,
            gaussian_sigma: 1.0,
        };

        let edges = canny(&img, &config);

        // A supressão não-máxima deve afinar a borda para 1 pixel de espessura nas transições
        let mut edge_count_in_row = 0;
        for x in 0..w {
            if edges.get_pixel(x, 16)[0] > 0.5 {
                edge_count_in_row += 1;
            }
        }

        // Deve haver bordas finas (transição esquerda e direita da barra)
        assert!(
            edge_count_in_row == 2,
            "Canny deve produzir bordas finas de 1 pixel em cada lado da barra: count={}",
            edge_count_in_row
        );
    }

    #[test]
    fn test_fuse_high_frequency_darkens_edges() {
        let w = 10u32;
        let h = 10u32;
        let base = GrayImage::fill(w, h, 1, 0.8);
        let mut edges = GrayImage::zeros(w, h, 1);
        edges.set_pixel(5, 5, &[1.0]);

        let fused = fuse_high_frequency(&base, &edges, 0.5);

        // Ponto sem borda mantém valor base
        assert!((fused.get_pixel(0, 0)[0] - 0.8).abs() < 1e-5);
        // Ponto com borda escurece em 0.5 * 1.0 = 0.3
        assert!((fused.get_pixel(5, 5)[0] - 0.3).abs() < 1e-5);
    }
}
