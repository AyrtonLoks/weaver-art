//! Mapa de Importância Espacial $W(x,y)$ e Ponderação de Saliência Facial.
//!
//! Implementa a matriz contígua $W(x,y)$, a composição automática com saliência facial
//! e bordas estruturais, além da integração com o pincel interativo da UI (`user_brush_mask`).

use crate::edges::{compute_multiscale_saliency, gaussian_blur_gray};
use crate::image::{GrayImage, Rgba8Image};
use crate::morphology::{black_tophat, StructuringElement};

/// Modo de mesclagem do buffer manual de pincel sobre o mapa de importância.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BrushMergeMode {
    /// Aditivo: valores positivos aumentam o peso, negativos reduzem/zeram (padrão).
    #[default]
    Add,
    /// Multiplicativo: multiplica a importância existente pelo fator do pincel.
    Multiply,
    /// Substituição: sobrescreve o valor nas regiões onde o pincel atuou.
    Override,
}

/// Matriz de ponderação espacial contígua $W(x,y)$ utilizada pelos solvers de String Art.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportanceMap {
    pub width: u32,
    pub height: u32,
    pub weights: Vec<f32>,
}

impl ImportanceMap {
    /// Cria um novo mapa de importância a partir de um vetor de pesos contíguo.
    pub fn new(width: u32, height: u32, weights: Vec<f32>) -> Self {
        assert_eq!(
            weights.len(),
            (width * height) as usize,
            "Tamanho do vetor de pesos não corresponde a width * height"
        );
        Self {
            width,
            height,
            weights,
        }
    }

    /// Cria um mapa de importância neutro preenchido com peso $1.0$.
    pub fn ones(width: u32, height: u32) -> Self {
        let total = (width * height) as usize;
        Self {
            width,
            height,
            weights: vec![1.0f32; total],
        }
    }

    /// Cria um mapa de importância preenchido com zeros.
    pub fn zeros(width: u32, height: u32) -> Self {
        let total = (width * height) as usize;
        Self {
            width,
            height,
            weights: vec![0.0f32; total],
        }
    }

    /// Retorna o peso na coordenada inteira $(x, y)$.
    #[inline]
    pub fn get(&self, x: u32, y: u32) -> f32 {
        let idx = (y * self.width + x) as usize;
        self.weights[idx]
    }

    /// Sobrescreve o peso na coordenada inteira $(x, y)$.
    #[inline]
    pub fn set(&mut self, x: u32, y: u32, val: f32) {
        let idx = (y * self.width + x) as usize;
        self.weights[idx] = val;
    }

    /// Retorna uma fatia imutável do buffer de pesos.
    pub fn as_slice(&self) -> &[f32] {
        &self.weights
    }

    /// Retorna uma fatia mutável do buffer de pesos.
    pub fn as_mut_slice(&mut self) -> &mut [f32] {
        &mut self.weights
    }

    /// Converte os pesos do mapa para uma `GrayImage`.
    pub fn to_gray_image(&self) -> GrayImage {
        GrayImage::new(self.width, self.height, 1, self.weights.clone())
    }

    /// Compõe automaticamente o mapa de importância:
    /// $$W(x, y) = 1.0 + \beta_{\text{face}} \cdot M_{\text{saliência\_facial}}(x, y) + \beta_{\text{borda}} \cdot E_{\text{Sobel/Canny}}(x, y)$$
    pub fn compose_auto(
        width: u32,
        height: u32,
        facial_saliency: Option<&GrayImage>,
        edges: Option<&GrayImage>,
        beta_face: f32,
        beta_edge: f32,
    ) -> Self {
        let total = (width * height) as usize;
        let mut weights = vec![1.0f32; total];

        for i in 0..total {
            let mut w = 1.0f32;
            if let Some(fs) = facial_saliency {
                if i < fs.data.len() {
                    w += beta_face * fs.data[i];
                }
            }
            if let Some(ed) = edges {
                if i < ed.data.len() {
                    w += beta_edge * ed.data[i];
                }
            }
            weights[i] = w.max(0.0);
        }

        Self {
            width,
            height,
            weights,
        }
    }

    /// Mescla um buffer de pincel manual (`user_brush_mask`) vindo da interface do usuário.
    ///
    /// Valores positivos no pincel reforçam a importância da região (ex: olhos, óculos, boca).
    /// Valores negativos atenuam ou zeram a importância (ex: artefatos ou fundo).
    pub fn merge_user_brush(&mut self, user_brush_mask: &[f32]) {
        self.merge_user_brush_with_mode(user_brush_mask, BrushMergeMode::Add);
    }

    /// Mescla o pincel do usuário com modo de fusão configurável (`Add`, `Multiply`, `Override`).
    pub fn merge_user_brush_with_mode(&mut self, user_brush_mask: &[f32], mode: BrushMergeMode) {
        let count = self.weights.len().min(user_brush_mask.len());
        match mode {
            BrushMergeMode::Add => {
                for i in 0..count {
                    let b = user_brush_mask[i];
                    if b.abs() > 1e-6 {
                        self.weights[i] = (self.weights[i] + b).max(0.0);
                    }
                }
            }
            BrushMergeMode::Multiply => {
                for i in 0..count {
                    let b = user_brush_mask[i];
                    self.weights[i] = (self.weights[i] * b).max(0.0);
                }
            }
            BrushMergeMode::Override => {
                for i in 0..count {
                    let b = user_brush_mask[i];
                    if b > 0.0 {
                        self.weights[i] = b.max(0.0);
                    }
                }
            }
        }
    }

    /// Renderiza o mapa de importância em formato RGBA como um mapa de calor radiante
    /// (Preto $\to$ Vermelho $\to$ Amarelo $\to$ Branco).
    pub fn to_preview_rgba(&self) -> Rgba8Image {
        let count = self.weights.len();
        let mut data = Vec::with_capacity(count * 4);

        let max_val = self
            .weights
            .iter()
            .copied()
            .fold(1.0f32, f32::max)
            .max(1.0001);

        for &w in &self.weights {
            // Normaliza em [0.0, 1.0] onde 0.0 é totalmente suprimido e 1.0 é peso máximo
            let norm = (w / max_val).clamp(0.0, 1.0);

            // Escala de cor térmica (Preto -> Vermelho -> Amarelo -> Branco)
            let (r, g, b) = if norm < 0.33 {
                let t = norm / 0.33;
                ((t * 180.0).round() as u8, 0u8, 0u8)
            } else if norm < 0.66 {
                let t = (norm - 0.33) / 0.33;
                (255u8, (t * 210.0).round() as u8, 0u8)
            } else {
                let t = (norm - 0.66) / 0.34;
                (255u8, 255u8, (t * 255.0).round() as u8)
            };

            data.push(r);
            data.push(g);
            data.push(b);
            data.push(255);
        }

        Rgba8Image::new(self.width, self.height, 4, data)
    }
}

/// Extrai a probabilidade de pele em $[0.0, 1.0]$ no espaço YCbCr e crominância normalizada.
pub fn compute_skin_probability(image: &Rgba8Image) -> Vec<f32> {
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

        let cb = 128.0 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        let cr = 128.0 + 0.5 * r - 0.418688 * g - 0.081312 * b;

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

/// Calcula o mapa de saliência facial $M(x, y) \in [0, 1]$ de forma genérica (sem zonas fixas):
///
/// $M = \text{norm}\big(G_\sigma * [\,S_{\text{bordas}} \cdot (0{,}35 + 0{,}65\,P_{\text{pele}}) \cdot \Pi_{\text{centro}}\,]\big)$
///
/// - $S_{\text{bordas}}$: saliência multiescala de alta frequência (olhos, boca, contornos);
/// - $P_{\text{pele}}$: probabilidade cromática de pele (YCbCr);
/// - $\Pi_{\text{centro}}$: prior gaussiano largo centrado no tear (o enquadramento já posiciona o rosto);
/// - $G_\sigma$: desfoque gaussiano ($\sigma$ = 2 % do lado) que elimina bordas duras no mapa.
pub fn compute_facial_saliency_map(rgba: &Rgba8Image) -> GrayImage {
    let w = rgba.width;
    let h = rgba.height;
    if w == 0 || h == 0 {
        return GrayImage::zeros(w, h, 1);
    }

    let perceptual_gray = rgba.to_perceptual_luma_gray();
    let edge_saliency = compute_multiscale_saliency(&perceptual_gray, 0.65);
    let skin_prob = compute_skin_probability(rgba);

    let cx = (w as f32 - 1.0) * 0.5;
    let cy = (h as f32 - 1.0) * 0.5;
    let inv_sx = 1.0 / (0.35 * w as f32).max(1.0).powi(2);
    let inv_sy = 1.0 / (0.35 * h as f32).max(1.0).powi(2);

    let mut raw = GrayImage::zeros(w, h, 1);
    for y in 0..h {
        let dy = y as f32 - cy;
        for x in 0..w {
            let dx = x as f32 - cx;
            let prior = (-0.5 * (dx * dx * inv_sx + dy * dy * inv_sy)).exp();
            let i = (y * w + x) as usize;
            raw.data[i] = edge_saliency.data[i] * (0.35 + 0.65 * skin_prob[i]) * prior;
        }
    }

    let sigma = (w.min(h) as f32 * 0.02).max(0.8);
    let mut saliency = gaussian_blur_gray(&raw, sigma);
    let max_s = saliency.data.iter().copied().fold(0.0f32, f32::max);
    if max_s > 1e-6 {
        for s in &mut saliency.data {
            *s = (*s / max_s).clamp(0.0, 1.0);
        }
    }
    saliency
}
/// Mapa de **feições escuras pequenas** $F(x, y) \in [0, 1]$ (olhos, sobrancelhas, aro de óculos,
/// narinas, boca) sem zonas fixas:
///
/// $F = \text{norm}_{p99}\big(G_\sigma * [\,\text{BlackTopHat}_{r}(L) \cdot (0{,}25 + 0{,}75\,P_{\text{pele}})\,]\big)$
///
/// - `BlackTopHat` (fechamento − imagem) com disco de raio ≈ 1,2 % do lado destaca estruturas
///   escuras menores que o disco, ignorando sombras largas;
/// - a probabilidade de pele (desfocada) concentra o mapa no rosto;
/// - normalização pelo percentil 99 evita que um único ponto domine.
pub fn compute_dark_feature_map(luma_perceptual: &GrayImage, rgba: &Rgba8Image) -> GrayImage {
    let (w, h) = (luma_perceptual.width, luma_perceptual.height);
    let n = (w * h) as usize;
    if n == 0 || rgba.width != w || rgba.height != h {
        return GrayImage::zeros(w, h, 1);
    }
    let radius = ((w.min(h) as f32) * 0.012).round().max(2.0) as u32;
    let tophat = black_tophat(
        &luma_perceptual.data,
        w,
        h,
        &StructuringElement::disc(radius),
    );
    let skin = gaussian_blur_gray(
        &GrayImage::new(w, h, 1, compute_skin_probability(rgba)),
        w.min(h) as f32 * 0.03,
    );
    let raw: Vec<f32> = tophat
        .iter()
        .zip(&skin.data)
        .map(|(t, s)| t * (0.25 + 0.75 * s.clamp(0.0, 1.0)))
        .collect();
    let mut map = gaussian_blur_gray(
        &GrayImage::new(w, h, 1, raw),
        (w.min(h) as f32 * 0.006).max(0.6),
    );
    let mut sorted = map.data.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let p99 = sorted[((n - 1) as f32 * 0.99) as usize].max(1e-6);
    map.data
        .iter_mut()
        .for_each(|v| *v = (*v / p99).clamp(0.0, 1.0));
    map
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_importance_map_ones_and_compose() {
        let w = 8u32;
        let h = 8u32;
        let imp = ImportanceMap::ones(w, h);
        assert_eq!(imp.get(0, 0), 1.0);
        assert_eq!(imp.get(7, 7), 1.0);

        let mut face_sal = GrayImage::zeros(w, h, 1);
        face_sal.set_pixel(3, 3, &[1.0]);

        let mut edges = GrayImage::zeros(w, h, 1);
        edges.set_pixel(3, 3, &[0.5]);

        let composed = ImportanceMap::compose_auto(w, h, Some(&face_sal), Some(&edges), 2.0, 1.0);
        // Em (3, 3): 1.0 + 2.0 * 1.0 + 1.0 * 0.5 = 3.5
        assert!((composed.get(3, 3) - 3.5).abs() < 1e-5);
        // Em outros pontos: 1.0
        assert!((composed.get(0, 0) - 1.0).abs() < 1e-5);
    }

    #[test]
    fn test_merge_user_brush_reinforce_and_zero() {
        let w = 4u32;
        let h = 4u32;
        let mut imp = ImportanceMap::ones(w, h);

        let mut brush = vec![0.0f32; 16];
        // Reforça o pixel (1, 1) em +2.5
        brush[1 * 4 + 1] = 2.5;
        // Zera o pixel (2, 2) aplicando -10.0
        brush[2 * 4 + 2] = -10.0;

        imp.merge_user_brush(&brush);

        assert!((imp.get(1, 1) - 3.5).abs() < 1e-5);
        assert_eq!(imp.get(2, 2), 0.0);
        assert_eq!(imp.get(0, 0), 1.0);
    }

    #[test]
    fn test_to_preview_rgba_generates_valid_colors() {
        let w = 4u32;
        let h = 4u32;
        let mut imp = ImportanceMap::ones(w, h);
        imp.set(1, 1, 5.0); // Ponto muito quente

        let preview = imp.to_preview_rgba();
        assert_eq!(preview.channels, 4);
        assert_eq!(preview.data.len(), 16 * 4);

        // Alpha deve ser sempre 255
        for i in (3..preview.data.len()).step_by(4) {
            assert_eq!(preview.data[i], 255);
        }

        // Ponto quente (1, 1) deve tender para o branco/amarelo brilhante
        let idx = (1 * 4 + 1) * 4;
        assert_eq!(preview.data[idx], 255);
        assert!(preview.data[idx + 1] > 200);
    }

    #[test]
    fn dark_feature_map_highlights_small_dark_blobs_inside_skin() {
        // Imagem pequena para que as feições ocupem uma fração realista (> 1 %) dos pixels
        let (w, h) = (60u32, 60u32);
        let mut rgba = Rgba8Image::fill(w, h, 4, 255u8);
        let mut luma = GrayImage::fill(w, h, 1, 0.9);
        for y in 0..h {
            for x in 0..w {
                let skin = (x as f32 - 30.0).powi(2) + (y as f32 - 30.0).powi(2) < 25.0f32.powi(2);
                if skin {
                    rgba.set_pixel(x, y, &[215, 165, 135, 255]);
                    luma.set_pixel(x, y, &[0.75]);
                }
            }
        }
        // várias "feições" escuras pequenas dentro da pele e uma idêntica fora dela (no fundo)
        for &(bx, by) in &[
            (20u32, 22u32),
            (35, 22),
            (27, 30),
            (22, 38),
            (33, 38),
            (27, 14),
        ] {
            for y in by..by + 4 {
                for x in bx..bx + 5 {
                    luma.set_pixel(x, y, &[0.1]);
                }
            }
        }
        for y in 22..26 {
            for x in 1..6 {
                luma.set_pixel(x, y, &[0.1]);
            }
        }
        let f = compute_dark_feature_map(&luma, &rgba);
        let eye = f.get_pixel(22, 24)[0];
        let outside = f.get_pixel(3, 24)[0];
        let cheek = f.get_pixel(44, 30)[0];
        assert!(eye > 0.5, "olho deveria ser destacado: {eye}");
        assert!(
            eye > outside * 1.5,
            "feição na pele deve pesar mais que no fundo: {eye} vs {outside}"
        );
        assert!(cheek < 0.1, "pele lisa não é feição: {cheek}");
    }
}
