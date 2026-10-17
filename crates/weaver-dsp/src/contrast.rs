//! Ajuste Radiométrico e CLAHE (Contrast Limited Adaptive Histogram Equalization).
//!
//! Implementa transformações fotométricas de brilho, contraste sigmoidal, correção gamma e
//! o algoritmo CLAHE operando sobre o canal de luminância (L* do CIELAB ou escala de cinza),
//! com interpolação bilinear contínua entre tiles vizinhos para suprimir artefatos de bloco.

use weaver_domain::{LabColor, LinearRgbColor};

use crate::image::GrayImage;

/// Ajusta o brilho aditivo de um canal normalizado $[0.0, 1.0]$.
#[inline]
pub fn apply_brightness(val: f32, brightness: f32) -> f32 {
    (val + brightness).clamp(0.0, 1.0)
}

/// Aplica ajuste de contraste sigmoidal (curva logística suave) em torno de um ponto médio.
///
/// Preserva extremos $[0.0, 1.0]$ sem clipping abrupto de realces e sombras profundas.
/// - `contrast`: inclinação da sigmoide ($\ge 0.0$). Se $0.0$, retorna o valor original.
/// - `midpoint`: ponto de inflexão da curva em $[0.0, 1.0]$ (tipicamente $0.5$).
#[inline]
pub fn apply_sigmoidal_contrast(val: f32, contrast: f32, midpoint: f32) -> f32 {
    if contrast <= 1e-4 {
        return val.clamp(0.0, 1.0);
    }

    let x = val.clamp(0.0, 1.0);
    let m = midpoint.clamp(0.0, 1.0);
    let c = contrast;

    let s = |v: f32| 1.0 / (1.0 + (-c * (v - m)).exp());
    let s0 = s(0.0);
    let s1 = s(1.0);
    let denom = s1 - s0;

    if denom.abs() <= 1e-6 {
        x
    } else {
        ((s(x) - s0) / denom).clamp(0.0, 1.0)
    }
}

/// Aplica correção gamma (potência exponencial) em canal normalizado $[0.0, 1.0]$.
///
/// $\text{val}_{\text{out}} = \text{val}^{1 / \gamma}$. Valores $\gamma > 1.0$ clareiam os meios-tons.
#[inline]
pub fn apply_gamma(val: f32, gamma: f32) -> f32 {
    if gamma <= 1e-4 || (gamma - 1.0).abs() <= 1e-4 {
        val.clamp(0.0, 1.0)
    } else {
        val.clamp(0.0, 1.0).powf(1.0 / gamma)
    }
}

/// Aplica o conjunto completo de transformações radiométricas a um buffer escalar mutável.
pub fn adjust_radiometry(
    channel: &mut [f32],
    brightness: f32,
    contrast: f32,
    gamma: f32,
    midpoint: f32,
) {
    for px in channel.iter_mut() {
        let mut v = apply_brightness(*px, brightness);
        v = apply_sigmoidal_contrast(v, contrast, midpoint);
        v = apply_gamma(v, gamma);
        *px = v;
    }
}

/// Ajusta brilho e contraste sobre um `GrayImage` onde `contrast == 1.0` é neutro.
pub fn adjust_brightness_contrast_gray(image: &mut GrayImage, brightness: f32, contrast: f32) {
    for px in image.data.iter_mut() {
        let mut v = apply_brightness(*px, brightness);
        if (contrast - 1.0).abs() > 1e-4 {
            if contrast > 1.0 {
                let slope = (contrast - 1.0) * 6.0;
                v = apply_sigmoidal_contrast(v, slope, 0.5);
            } else {
                let factor = contrast.max(0.0);
                v = (0.5 + (v - 0.5) * factor).clamp(0.0, 1.0);
            }
        }
        *px = v;
    }
}

/// Aplica correção gamma sobre um `GrayImage`.
pub fn apply_gamma_gray(image: &mut GrayImage, gamma: f32) {
    for px in image.data.iter_mut() {
        *px = apply_gamma(*px, gamma);
    }
}

/// Aplica filtro Unsharp Mask (máscara de nitidez gaussiana separável 1D) sobre um `GrayImage`.
///
/// Realça micro-feições faciais (íris, pálpebras, lábios) antes da otimização de cordas.
pub fn apply_unsharp_mask(image: &mut GrayImage, sigma: f32, amount: f32) {
    if sigma <= 0.05 || amount <= 1e-4 || image.width < 3 || image.height < 3 {
        return;
    }

    let radius = ((sigma * 3.0).ceil() as i32).clamp(1, 12);
    let mut kernel = Vec::with_capacity((2 * radius + 1) as usize);
    let mut sum = 0.0f32;
    let inv_two_sigma2 = 1.0 / (2.0 * sigma * sigma);
    for r in -radius..=radius {
        let w = (-(r as f32 * r as f32) * inv_two_sigma2).exp();
        kernel.push(w);
        sum += w;
    }
    if sum > 1e-6 {
        for w in &mut kernel {
            *w /= sum;
        }
    }

    let w = image.width as i32;
    let h = image.height as i32;
    let len = (w * h) as usize;
    let mut temp = vec![0.0f32; len];
    let mut blurred = vec![0.0f32; len];

    // Passo horizontal
    for y in 0..h {
        let row_offset = (y * w) as usize;
        for x in 0..w {
            let mut acc = 0.0f32;
            for (k_idx, k_r) in (-radius..=radius).enumerate() {
                let sx = (x + k_r).clamp(0, w - 1) as usize;
                acc += image.data[row_offset + sx] * kernel[k_idx];
            }
            temp[row_offset + x as usize] = acc;
        }
    }

    // Passo vertical
    for y in 0..h {
        for x in 0..w {
            let mut acc = 0.0f32;
            for (k_idx, k_r) in (-radius..=radius).enumerate() {
                let sy = (y + k_r).clamp(0, h - 1) as usize;
                acc += temp[sy * (w as usize) + (x as usize)] * kernel[k_idx];
            }
            blurred[(y * w + x) as usize] = acc;
        }
    }

    for (px, &blur) in image.data.iter_mut().zip(blurred.iter()) {
        let detail = *px - blur;
        *px = (*px + amount * detail).clamp(0.0, 1.0);
    }
}

/// Aplica modelagem tonal para retratos (`shadowLift` e `torsoFeathering`) em luminância perceptual sRGB.
///
/// - `shadow_lift` ($0.10 \dots 0.15$): eleva suavemente sombras profundas ($v < 0.35$) para evitar
///   "buracos negros" de saturação de linhas, preservando inalterados os meios-tons ($v \ge 0.35$).
/// - `torso_feathering` ($0.20 \dots 0.30$): atenua progressivamente regiões escuras na base do tear
///   ($y > 0.58 H$) para impedir que roupas/tronco roubem cordas verticais da face.
pub fn apply_portrait_tone_shaping(
    image: &mut GrayImage,
    shadow_lift: f32,
    torso_feathering: f32,
) {
    let w = image.width;
    let h = image.height;
    if w == 0 || h == 0 || (shadow_lift <= 1e-4 && torso_feathering <= 1e-4) {
        return;
    }

    let lift = shadow_lift.clamp(0.0, 0.35);
    let feather = torso_feathering.clamp(0.0, 0.50);
    let feather_strength = (feather * 2.8).clamp(0.0, 0.92);
    let inv_h = 1.0 / (h.max(2) - 1) as f32;
    let inv_w = 1.0 / (w.max(2) - 1) as f32;

    for y in 0..h {
        let y_norm = y as f32 * inv_h;
        let dy_face = (y_norm - 0.52) / 0.25;

        // Piso de saturação suave na calota superior do cabelo (y < 0.28) para que a massa capilar
        // atinja o alvo após ~15% das cordas e pare de roubar fios dos olhos/óculos/boca
        let crown_t = if y_norm < 0.28 {
            let lin_t = ((0.28 - y_norm) / 0.28).clamp(0.0, 1.0);
            0.5 * (1.0 - (std::f32::consts::PI * lin_t).cos())
        } else {
            0.0
        };

        for x in 0..w {
            let x_norm = x as f32 * inv_w;
            let x_lat = (x_norm - 0.50).abs() * 2.0;
            let dx_face = (x_norm - 0.50) / 0.26;
            let face_radial_sq = dx_face * dx_face + dy_face * dy_face;
            // Transição gaussiana contínua (zero bordas visíveis entre o centro facial e a periferia)
            let core_w = (-0.55 * face_radial_sq).exp();

            let idx = (y * w + x) as usize;
            let mut v = image.data[idx].clamp(0.0, 1.0);

            // 1. Negros estruturais (pupilas, íris, óculos, narinas, linha labial) vs sombras periféricas
            if v < 0.44 {
                let dark_preserve = core_w;
                let periph_lift = if lift > 1e-4 {
                    let t = (0.44 - v) / 0.44;
                    lift * 1.10 * t * (1.0 - v)
                } else {
                    0.0
                };
                let v_core = (v * 0.92).clamp(0.0, 1.0);
                let v_periph = (v + periph_lift).clamp(0.0, 1.0);
                v = v_core * dark_preserve + v_periph * (1.0 - dark_preserve);
            }

            // 2. Curva contínua de elevação de meios-tons claros (pele da testa, ponte do nariz,
            //    bochechas e interior das lentes dos óculos):
            if v > 0.30 && v < 0.95 {
                let mid_t = ((v - 0.30) / 0.65).clamp(0.0, 1.0);
                let bell = (std::f32::consts::PI * mid_t).sin();
                let amp = 0.14 + 0.05 * core_w;
                v = (v + amp * bell).clamp(0.0, 1.0);
            }

            // 3. Piso de sombra suave no topo do cabelo e têmporas laterais (fora das feições centrais):
            let temple_t = if y_norm < 0.44 && x_lat > 0.50 {
                let lat_t = ((x_lat - 0.50) / 0.50).clamp(0.0, 1.0);
                let vert_t = ((0.44 - y_norm) / 0.44).clamp(0.0, 1.0);
                0.5 * (1.0 - (std::f32::consts::PI * lat_t).cos()) * vert_t * 0.65
            } else {
                0.0
            };
            let hair_t = crown_t.max(temple_t) * (1.0 - 0.85 * core_w);
            if lift > 1e-4 && hair_t > 1e-4 && v < 0.50 {
                let target_hair_floor = 0.36 + 0.10 * hair_t;
                if v < target_hair_floor {
                    let blend = (hair_t * (0.60 + lift * 1.4)).clamp(0.0, 0.82);
                    v = (v + blend * (target_hair_floor - v)).clamp(0.0, 1.0);
                }
            }

            // 4. Atenuação progressiva do tronco/gola/capuz escuro na base do tear:
            //    No centro (onde ficam a boca e o queixo), começa apenas abaixo de y > 0.76;
            //    Nas laterais (onde sobe a gola/capuz do moletom), começa suavemente em y > 0.54.
            let y_start = 0.76 - 0.22 * (x_lat.clamp(0.0, 1.0).powi(2));
            let span = (1.0 - y_start).max(0.15);
            let eff_torso_t = if y_norm > y_start {
                let lin_t = ((y_norm - y_start) / span).clamp(0.0, 1.0);
                0.5 * (1.0 - (std::f32::consts::PI * lin_t).cos())
            } else {
                0.0
            };
            if feather_strength > 1e-4 && eff_torso_t > 1e-4 && v < 0.88 {
                let lateral_boost = 1.0 + 0.30 * x_lat * x_lat;
                let blend = (feather_strength * eff_torso_t * lateral_boost).clamp(0.0, 0.90);
                let target_fade = 0.86;
                if v < target_fade {
                    v = (v + blend * (target_fade - v)).clamp(0.0, 1.0);
                }
            }

            image.data[idx] = v;
        }
    }
}

/// Configuração do equalizador adaptativo CLAHE.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClaheConfig {
    /// Número de divisões horizontais da grade de tiles (ex: 8).
    pub grid_cols: usize,
    /// Número de divisões verticais da grade de tiles (ex: 8).
    pub grid_rows: usize,
    /// Fator multiplicador de corte do histograma (tipicamente $2.0 \dots 4.0$).
    pub clip_limit: f32,
    /// Número de bins do histograma (padrão: 256).
    pub num_bins: usize,
}

impl Default for ClaheConfig {
    fn default() -> Self {
        Self {
            grid_cols: 8,
            grid_rows: 8,
            clip_limit: 3.0,
            num_bins: 256,
        }
    }
}

/// Aplica CLAHE diretamente sobre um canal escalar flutuante $[0.0, 1.0]$.
pub fn clahe_channel(channel: &mut [f32], width: u32, height: u32, config: &ClaheConfig) {
    if width == 0 || height == 0 || channel.len() != (width * height) as usize {
        return;
    }

    let cols = config.grid_cols.max(1).min(width as usize);
    let rows = config.grid_rows.max(1).min(height as usize);
    let num_bins = config.num_bins.max(16);

    // 1. Constrói as tabelas de mapeamento (LUTs) equalizadas e clipadas para cada tile
    let mut luts = vec![vec![0.0f32; num_bins]; rows * cols];

    for ty in 0..rows {
        let y0 = (ty * height as usize) / rows;
        let y1 = ((ty + 1) * height as usize) / rows;
        let tile_h = y1 - y0;

        for tx in 0..cols {
            let x0 = (tx * width as usize) / cols;
            let x1 = ((tx + 1) * width as usize) / cols;
            let tile_w = x1 - x0;
            let tile_pixels = (tile_w * tile_h).max(1);

            // Histograma local
            let mut hist = vec![0u32; num_bins];
            for y in y0..y1 {
                let row_offset = y * width as usize;
                for x in x0..x1 {
                    let v = channel[row_offset + x].clamp(0.0, 1.0);
                    let bin = ((v * (num_bins - 1) as f32).round() as usize).min(num_bins - 1);
                    hist[bin] += 1;
                }
            }

            // Limite de corte e redistribuição uniforme do excesso
            let average_bin_count = tile_pixels as f32 / num_bins as f32;
            let clip_threshold = (config.clip_limit * average_bin_count).round() as u32;
            let clip_threshold = clip_threshold.max(1);

            let mut excess = 0u32;
            for count in hist.iter_mut() {
                if *count > clip_threshold {
                    excess += *count - clip_threshold;
                    *count = clip_threshold;
                }
            }

            let bonus = excess / num_bins as u32;
            let remainder = excess % num_bins as u32;

            for count in hist.iter_mut() {
                *count += bonus;
            }
            for i in 0..remainder as usize {
                hist[i] += 1;
            }

            // CDF (Função de Distribuição Cumulativa)
            let lut = &mut luts[ty * cols + tx];
            let mut cumulative = 0u32;
            for (bin, &count) in hist.iter().enumerate() {
                cumulative += count;
                lut[bin] = (cumulative as f32 / tile_pixels as f32).clamp(0.0, 1.0);
            }
        }
    }

    // 2. Interpolação bilinear contínua dos centros de tiles para cada pixel
    let tile_w = width as f32 / cols as f32;
    let tile_h = height as f32 / rows as f32;

    let mut centers_x = Vec::with_capacity(cols);
    for tx in 0..cols {
        centers_x.push((tx as f32 + 0.5) * tile_w - 0.5);
    }

    let mut centers_y = Vec::with_capacity(rows);
    for ty in 0..rows {
        centers_y.push((ty as f32 + 0.5) * tile_h - 0.5);
    }

    for y in 0..height {
        let py = y as f32;
        let (ty0, ty1, beta) = locate_interp_interval(py, &centers_y, rows);
        let row_offset = y as usize * width as usize;

        for x in 0..width {
            let px = x as f32;
            let (tx0, tx1, alpha) = locate_interp_interval(px, &centers_x, cols);

            let v = channel[row_offset + x as usize].clamp(0.0, 1.0);
            let bin = ((v * (num_bins - 1) as f32).round() as usize).min(num_bins - 1);

            let lut00 = luts[ty0 * cols + tx0][bin];
            let lut01 = luts[ty0 * cols + tx1][bin];
            let lut10 = luts[ty1 * cols + tx0][bin];
            let lut11 = luts[ty1 * cols + tx1][bin];

            let top = (1.0 - alpha) * lut00 + alpha * lut01;
            let bottom = (1.0 - alpha) * lut10 + alpha * lut11;
            let interpolated = (1.0 - beta) * top + beta * bottom;

            channel[row_offset + x as usize] = interpolated.clamp(0.0, 1.0);
        }
    }
}

/// Localiza o intervalo de interpolação e peso fracionário entre centros vizinhos de tiles.
#[inline]
fn locate_interp_interval(coord: f32, centers: &[f32], count: usize) -> (usize, usize, f32) {
    if count <= 1 {
        return (0, 0, 0.0);
    }

    if coord <= centers[0] {
        return (0, 0, 0.0);
    }
    if coord >= centers[count - 1] {
        let last = count - 1;
        return (last, last, 0.0);
    }

    for i in 0..(count - 1) {
        if coord >= centers[i] && coord < centers[i + 1] {
            let span = centers[i + 1] - centers[i];
            let frac = if span > 1e-6 {
                (coord - centers[i]) / span
            } else {
                0.0
            };
            return (i, i + 1, frac);
        }
    }

    let last = count - 1;
    (last, last, 0.0)
}

/// Aplica equalização CLAHE sobre um `GrayImage`.
pub fn clahe_gray(image: &mut GrayImage, config: &ClaheConfig) {
    clahe_channel(&mut image.data, image.width, image.height, config);
}

/// Aplica equalização CLAHE no canal de Luminosidade $L^*$ do espaço CIELAB, preservando $a^*$ e $b^*$.
pub fn clahe_lab(lab_pixels: &mut [LabColor], width: u32, height: u32, config: &ClaheConfig) {
    assert_eq!(lab_pixels.len(), (width * height) as usize);

    // Extrai L* normalizado em [0.0, 1.0]
    let mut l_channel: Vec<f32> = lab_pixels.iter().map(|c| (c.l / 100.0).clamp(0.0, 1.0)).collect();

    // Aplica CLAHE
    clahe_channel(&mut l_channel, width, height, config);

    // Restaura L* escalado para [0.0, 100.0] preservando a* e b* intactos
    for (i, p) in lab_pixels.iter_mut().enumerate() {
        p.l = l_channel[i] * 100.0;
    }
}

/// Aplica equalização CLAHE sobre um buffer de `LinearRgbColor` convertendo via CIELAB.
pub fn clahe_linear_rgb(
    rgb_pixels: &mut [LinearRgbColor],
    width: u32,
    height: u32,
    config: &ClaheConfig,
) {
    assert_eq!(rgb_pixels.len(), (width * height) as usize);

    let mut lab_pixels: Vec<LabColor> = rgb_pixels.iter().map(|c| c.to_lab()).collect();
    clahe_lab(&mut lab_pixels, width, height, config);

    for (i, rgb) in rgb_pixels.iter_mut().enumerate() {
        *rgb = lab_pixels[i].to_linear_rgb().clamp();
    }
}

/// Calcula a entropia de Shannon de um canal em $[0.0, 1.0]$ utilizando 256 bins.
pub fn compute_channel_entropy(channel: &[f32]) -> f32 {
    if channel.is_empty() {
        return 0.0;
    }

    const BINS: usize = 256;
    let mut hist = [0u32; BINS];
    let n = channel.len() as f32;

    for &v in channel {
        let bin = ((v.clamp(0.0, 1.0) * (BINS - 1) as f32).round() as usize).min(BINS - 1);
        hist[bin] += 1;
    }

    let mut entropy = 0.0f32;
    for &count in &hist {
        if count > 0 {
            let p = count as f32 / n;
            entropy -= p * p.log2();
        }
    }

    entropy
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_brightness_adjustment() {
        assert!((apply_brightness(0.5, 0.2) - 0.7).abs() < 1e-6);
        assert!((apply_brightness(0.5, -0.3) - 0.2).abs() < 1e-6);
        assert_eq!(apply_brightness(0.9, 0.3), 1.0); // Clamped
        assert_eq!(apply_brightness(0.1, -0.3), 0.0); // Clamped
    }

    #[test]
    fn test_sigmoidal_contrast_invariants() {
        // Fixa os extremos [0.0, 1.0]
        assert!((apply_sigmoidal_contrast(0.0, 5.0, 0.5) - 0.0).abs() < 1e-5);
        assert!((apply_sigmoidal_contrast(1.0, 5.0, 0.5) - 1.0).abs() < 1e-5);

        // Ponto de inflexão em 0.5 deve ser preservado para midpoint=0.5
        assert!((apply_sigmoidal_contrast(0.5, 5.0, 0.5) - 0.5).abs() < 1e-5);

        // Aumenta inclinação dos meios tons: 0.6 deve ser > 0.6, e 0.4 deve ser < 0.4
        assert!(apply_sigmoidal_contrast(0.6, 5.0, 0.5) > 0.6);
        assert!(apply_sigmoidal_contrast(0.4, 5.0, 0.5) < 0.4);

        // Contraste zero é a identidade
        assert_eq!(apply_sigmoidal_contrast(0.35, 0.0, 0.5), 0.35);
    }

    #[test]
    fn test_gamma_correction() {
        // Gamma 1.0 é identidade
        assert_eq!(apply_gamma(0.5, 1.0), 0.5);

        // Gamma > 1.0 clareia meios-tons (val^(1/gamma))
        assert!(apply_gamma(0.5, 2.2) > 0.5);

        // Gamma < 1.0 escurece meios-tons
        assert!(apply_gamma(0.5, 0.5) < 0.5);
    }
}
