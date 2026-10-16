//! Mapa de Importância Espacial $W(x,y)$ e Ponderação de Saliência Facial.
//!
//! Implementa a matriz contígua $W(x,y)$, a composição automática com saliência facial
//! e bordas estruturais, além da integração com o pincel interativo da UI (`user_brush_mask`).

use crate::edges::compute_multiscale_saliency;
use crate::image::{GrayImage, Rgba8Image};

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

/// Calcula o mapa de saliência facial $M_{\text{saliência\_facial}}(x, y) \in [0.0, 1.0]$.
///
/// Integra altas frequências estruturais (bordas), probabilidade cromática de pele
/// e prior elíptico central posicionado na zona áurea facial.
pub fn compute_facial_saliency_map(rgba: &Rgba8Image) -> GrayImage {
    let w = rgba.width;
    let h = rgba.height;
    if w == 0 || h == 0 {
        return GrayImage::zeros(w, h, 1);
    }

    let gray = rgba.to_gray();
    let edge_saliency = compute_multiscale_saliency(&gray, 0.70);
    let skin_prob = compute_skin_probability(rgba);

    let cx = w as f32 * 0.50;
    let cy = h as f32 * 0.45; // Olhos e nariz no terço superior
    let inv_rx_sq = 1.0 / (0.38 * w as f32).max(1.0).powi(2);
    let inv_ry_sq = 1.0 / (0.42 * h as f32).max(1.0).powi(2);

    let total = (w * h) as usize;
    let mut saliency = Vec::with_capacity(total);

    for y in 0..h {
        let dy = y as f32 - cy;
        let dy_sq = dy * dy * inv_ry_sq;

        for x in 0..w {
            let dx = x as f32 - cx;
            let dx_sq = dx * dx * inv_rx_sq;
            let center_weight = (-0.5 * (dx_sq + dy_sq)).exp();

            let idx = (y * w + x) as usize;
            let edge = edge_saliency.data[idx];
            let skin = skin_prob[idx];

            let s = edge * (0.35 + 0.65 * skin) * center_weight;
            saliency.push(s.clamp(0.0, 1.0));
        }
    }

    // Normalização local pelo valor máximo para garantir uso pleno de [0.0, 1.0]
    let max_s = saliency.iter().copied().fold(0.0f32, f32::max);
    if max_s > 1e-4 {
        for s in &mut saliency {
            *s = (*s / max_s).clamp(0.0, 1.0);
        }
    }

    GrayImage::new(w, h, 1, saliency)
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
}
