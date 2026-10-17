//! Matriz de Estado da Tela em Layout SoA (*Struct of Arrays*) e Compensação Automática
//! de Resolução vs. Espessura Física (RF-2.3).
//!
//! Projetada segundo princípios de *Data-Oriented Design* (DoD) para maximizar localidade
//! espacial em cache L1/L2 e permitir vetorização SIMD (f32x4 / f32x8) sem ponteiros indiretos.

use weaver_domain::{LinearRgbColor, Millimeters, Pixels};

/// Alinhamento de padding em elementos `f32` (múltiplo de 16 floats = 64 bytes, linha de cache / AVX-512).
pub const SOA_SIMD_LANE_ALIGNMENT: usize = 16;

/// Calcula a **Compensação Automática de Resolução vs. Espessura Física** (RF-2.3):
///
/// $$\alpha_{\text{efetivo}} = \alpha_{\text{material}} \cdot \min\left(1.0, \frac{t_f \cdot R_{\text{px}}}{D_{\text{mm}}}\right)$$
///
/// Onde:
/// - $\alpha_{\text{material}} \in [0.0, 1.0]$ é a opacidade intrínseca da fibra/fio.
/// - $t_f$ (`thread_thickness_mm`) é a espessura física do fio em milímetros.
/// - $R_{\text{px}}$ (`resolution_px`) é a resolução discreta da malha em pixels.
/// - $D_{\text{mm}}$ (`loom_diameter_mm`) é a dimensão característica física do tear em milímetros.
///
/// Isso garante invariância fotométrica entre diferentes resoluções de simulação: quando um pixel
/// físico é mais largo que o fio ($D_{\text{mm}} / R_{\text{px}} > t_f$), a cobertura sub-pixel é
/// reduzida proporcionalmente.
#[inline]
pub fn compute_effective_alpha(
    alpha_material: f32,
    thread_thickness_mm: Millimeters,
    resolution_px: Pixels,
    loom_diameter_mm: Millimeters,
) -> f32 {
    let alpha_mat = alpha_material.clamp(0.0, 1.0);
    let d_mm = loom_diameter_mm.0;
    if d_mm <= 1e-6 || resolution_px.0 == 0 {
        return alpha_mat;
    }
    let subpixel_ratio = (thread_thickness_mm.0 * (resolution_px.0 as f32)) / d_mm;
    let scale = subpixel_ratio.clamp(0.0, 1.0);
    alpha_mat * scale
}

/// Matriz de estado da tela em layout *Struct of Arrays* (SoA).
///
/// Todos os canais cromáticos e pesos de importância residem em vetores `Vec<f32>` planos,
/// separados por canal e preenchidos até múltiplo de `SOA_SIMD_LANE_ALIGNMENT` (16 floats = 64 bytes)
/// para permitir loops vetorizados limpos sem *tail-loops* escalares ou desvios condicionais.
#[derive(Debug, Clone, PartialEq)]
pub struct CanvasStateSoA {
    /// Largura da grade de simulação em pixels.
    pub width_px: u32,
    /// Altura da grade de simulação em pixels.
    pub height_px: u32,
    /// Número real de pixels ativos ($W \times H$).
    pub num_pixels: usize,
    /// Capacidade alinhada para SIMD (múltiplo de `SOA_SIMD_LANE_ALIGNMENT`).
    pub aligned_len: usize,

    /// Canal 0 (R linear ou C) da imagem alvo $T_0(p) \in [0.0, 1.0]$.
    pub target_c0: Vec<f32>,
    /// Canal 1 (G linear ou M) da imagem alvo $T_1(p) \in [0.0, 1.0]$.
    pub target_c1: Vec<f32>,
    /// Canal 2 (B linear ou Y) da imagem alvo $T_2(p) \in [0.0, 1.0]$.
    pub target_c2: Vec<f32>,

    /// Canal 0 (R linear ou C) do estado atual da tela $C_0^{(t)}(p) \in [0.0, 1.0]$.
    pub current_c0: Vec<f32>,
    /// Canal 1 (G linear ou M) do estado atual da tela $C_1^{(t)}(p) \in [0.0, 1.0]$.
    pub current_c1: Vec<f32>,
    /// Canal 2 (B linear ou Y) do estado atual da tela $C_2^{(t)}(p) \in [0.0, 1.0]$.
    pub current_c2: Vec<f32>,

    /// Mapa de importância espacial $W(p) \ge 0.0$ (saliência facial + bordas + pincel).
    pub importance_w: Vec<f32>,
    /// Mapa base de importância espacial (preservado para restaurar o pincel do usuário).
    pub base_importance_w: Vec<f32>,
}

impl CanvasStateSoA {
    /// Calcula o comprimento arredondado para o próximo múltiplo de `SOA_SIMD_LANE_ALIGNMENT`.
    #[inline]
    pub const fn align_len(n: usize) -> usize {
        let rem = n % SOA_SIMD_LANE_ALIGNMENT;
        if rem == 0 {
            n
        } else {
            n + (SOA_SIMD_LANE_ALIGNMENT - rem)
        }
    }

    /// Cria uma nova matriz de estado SoA inicializada com uma cor de fundo uniforme.
    pub fn new(width_px: u32, height_px: u32, background: LinearRgbColor) -> Self {
        let num_pixels = (width_px as usize) * (height_px as usize);
        let aligned_len = Self::align_len(num_pixels);

        let mut current_c0 = vec![0.0; aligned_len];
        let mut current_c1 = vec![0.0; aligned_len];
        let mut current_c2 = vec![0.0; aligned_len];

        current_c0[..num_pixels].fill(background.r);
        current_c1[..num_pixels].fill(background.g);
        current_c2[..num_pixels].fill(background.b);

        let mut importance_w = vec![0.0; aligned_len];
        importance_w[..num_pixels].fill(1.0);
        let base_importance_w = importance_w.clone();

        Self {
            width_px,
            height_px,
            num_pixels,
            aligned_len,
            target_c0: vec![background.r; aligned_len],
            target_c1: vec![background.g; aligned_len],
            target_c2: vec![background.b; aligned_len],
            current_c0,
            current_c1,
            current_c2,
            importance_w,
            base_importance_w,
        }
    }

    /// Cria uma matriz de estado SoA a partir de fatias de cores lineares do alvo,
    /// cor de fundo e mapa de importância espacial opcional.
    pub fn from_target_and_background(
        width_px: u32,
        height_px: u32,
        target_pixels: &[LinearRgbColor],
        background: LinearRgbColor,
        importance: Option<&[f32]>,
    ) -> Self {
        let num_pixels = (width_px as usize) * (height_px as usize);
        assert_eq!(
            target_pixels.len(),
            num_pixels,
            "target_pixels length must match width_px * height_px"
        );

        let mut state = Self::new(width_px, height_px, background);

        for (i, px) in target_pixels.iter().enumerate() {
            state.target_c0[i] = px.r;
            state.target_c1[i] = px.g;
            state.target_c2[i] = px.b;
        }

        if let Some(imp) = importance {
            assert_eq!(
                imp.len(),
                num_pixels,
                "importance slice length must match width_px * height_px"
            );
            for (i, &w) in imp.iter().enumerate() {
                let w_clamped = w.max(0.0);
                state.importance_w[i] = w_clamped;
                state.base_importance_w[i] = w_clamped;
            }
        }

        // Padding elements beyond num_pixels have weight 0.0 so SIMD lanes never affect sums.
        for i in num_pixels..state.aligned_len {
            state.importance_w[i] = 0.0;
            state.base_importance_w[i] = 0.0;
        }

        state
    }

    /// Restaura o estado atual da tela para uma cor uniforme de fundo.
    pub fn reset_current(&mut self, background: LinearRgbColor) {
        self.current_c0[..self.num_pixels].fill(background.r);
        self.current_c1[..self.num_pixels].fill(background.g);
        self.current_c2[..self.num_pixels].fill(background.b);
    }

    /// Copia o estado simulado e mapas de outro `CanvasStateSoA` de mesmas dimensões
    /// in-place sem alocações na heap (zero-allocation).
    pub fn copy_from(&mut self, other: &CanvasStateSoA) {
        assert_eq!(self.width_px, other.width_px, "Larguras devem coincidir");
        assert_eq!(self.height_px, other.height_px, "Alturas devem coincidir");
        assert_eq!(
            self.aligned_len, other.aligned_len,
            "Aligned len deve coincidir"
        );

        self.current_c0[..self.aligned_len].copy_from_slice(&other.current_c0[..self.aligned_len]);
        self.current_c1[..self.aligned_len].copy_from_slice(&other.current_c1[..self.aligned_len]);
        self.current_c2[..self.aligned_len].copy_from_slice(&other.current_c2[..self.aligned_len]);
        self.importance_w[..self.aligned_len]
            .copy_from_slice(&other.importance_w[..self.aligned_len]);
        self.base_importance_w[..self.aligned_len]
            .copy_from_slice(&other.base_importance_w[..self.aligned_len]);
    }

    /// Obtém a cor alvo linear no índice de pixel `p`.
    #[inline]
    pub fn target_color(&self, p: usize) -> LinearRgbColor {
        LinearRgbColor::new(self.target_c0[p], self.target_c1[p], self.target_c2[p])
    }

    /// Obtém a cor atual simulada na tela no índice de pixel `p`.
    #[inline]
    pub fn current_color(&self, p: usize) -> LinearRgbColor {
        LinearRgbColor::new(self.current_c0[p], self.current_c1[p], self.current_c2[p])
    }

    /// Define a cor atual simulada na tela no índice de pixel `p`.
    #[inline]
    pub fn set_current_color(&mut self, p: usize, color: LinearRgbColor) {
        self.current_c0[p] = color.r;
        self.current_c1[p] = color.g;
        self.current_c2[p] = color.b;
    }

    /// Retorna o erro residual direto $\mathbf{e}(p) = C^{(t)}(p) - T(p)$ por canal.
    #[inline]
    pub fn residual_error(&self, p: usize) -> [f32; 3] {
        [
            self.current_c0[p] - self.target_c0[p],
            self.current_c1[p] - self.target_c1[p],
            self.current_c2[p] - self.target_c2[p],
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_effective_alpha_resolution_compensation() {
        // Quando t_f * R_px < D_mm, alpha_efetivo reduz proporcionalmente
        // Ex: fio 0.15 mm, res 500 px, tear 600 mm -> 0.15 * 500 / 600 = 75 / 600 = 0.125
        let alpha_eff =
            compute_effective_alpha(0.8, Millimeters(0.15), Pixels(500), Millimeters(600.0));
        let expected = 0.8 * (0.15 * 500.0 / 600.0);
        assert!((alpha_eff - expected).abs() < 1e-6);

        // Quando t_f * R_px >= D_mm (resolução muito alta onde o fio cobre >= 1 pixel inteiro),
        // o fator satura em 1.0 e alpha_efetivo == alpha_material
        let alpha_saturated =
            compute_effective_alpha(0.85, Millimeters(0.5), Pixels(2000), Millimeters(500.0));
        assert!((alpha_saturated - 0.85).abs() < 1e-6);
    }

    #[test]
    fn test_canvas_state_soa_layout_and_alignment() {
        let target = vec![LinearRgbColor::new(0.2, 0.4, 0.6); 10 * 10];
        let imp = vec![1.5f32; 100];
        let state = CanvasStateSoA::from_target_and_background(
            10,
            10,
            &target,
            LinearRgbColor::WHITE,
            Some(&imp),
        );

        assert_eq!(state.num_pixels, 100);
        // 100 arredondado para múltiplo de 16 = 112
        assert_eq!(state.aligned_len, 112);
        assert_eq!(state.target_c0.len(), 112);
        assert_eq!(state.current_c0.len(), 112);
        assert_eq!(state.importance_w[0], 1.5);
        // Padding deve ter peso zero
        assert_eq!(state.importance_w[100], 0.0);
        assert_eq!(state.importance_w[111], 0.0);
    }
}
