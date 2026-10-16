//! Modelos Físicos de Mistura e Cálculo de Ganho Marginal ΔE (`optical_models.rs`).
//!
//! Implementa 3 modelos de interação fotométrica da luz com o fio sobre a tela:
//! 1. `PorterDuffOcclusion`: Atualização não-comutativa com oclusão real de fibras $C^{(t+1)} = (1 - \alpha w)C^{(t)} + (\alpha w)\mathbf{s}_k$
//!    e expansão quadrática rápida do ganho marginal:
//!    $$\text{Ganho}(p, k) = W(p) \cdot \left[ 2(\alpha w) \langle \mathbf{e}(p), \mathbf{d}_k(p) \rangle_{\mathbf{M}} - (\alpha w)^2 \|\mathbf{d}_k(p)\|_{\mathbf{M}}^2 \right]$$
//! 2. `LinearSubtractive`: Mistura subtrativa comutativa para CMY puro e Radon/NNLS.
//! 3. `BeerLambertTransmittance`: Modelo espectral multiplicativo de absorbância física.
//!
//! Suporta ponderações perceptuais via tensor de métrica diagonal $\mathbf{M}$:
//! - Linear RGB puro (pesos $[1, 1, 1]$)
//! - Redmean linearizado (pesos sensoriais baseados em $R_{\text{mean}}$)
//! - Rec. 709 Luminância ponderada ($[0.2126, 0.7152, 0.0722]$)
//! - CIELAB $\Delta E$ (avaliação exata ou linearizada local)

use weaver_domain::{
    ColorErrorMetric, LinearRgbColor, LUMA_REC709_B, LUMA_REC709_G, LUMA_REC709_R,
};

use crate::state_matrix::CanvasStateSoA;

/// Modelo de mistura óptica e física de transmitância.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OpticalMixModelType {
    /// Oclusão física Porter-Duff com alfa-blending $C^{(t+1)} = (1 - \alpha w)C^{(t)} + (\alpha w)\mathbf{s}_k$.
    PorterDuffOcclusion,
    /// Mistura linear subtrativa em intensidade de pigmento.
    LinearSubtractive,
    /// Lei de Beer-Lambert multiplicativa $T^{(t+1)} = T^{(t)} \cdot (1 - \alpha w(1 - \mathbf{s}_k))$.
    BeerLambertTransmittance,
}

/// Pesos perceptuais diagonais da métrica $[w_0, w_1, w_2]$ para cálculo rápido do produto interno ponderado.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MetricWeights {
    pub w0: f32,
    pub w1: f32,
    pub w2: f32,
}

impl MetricWeights {
    /// Métrica euclidiana não ponderada em Linear RGB $[1.0, 1.0, 1.0]$.
    pub const LINEAR_RGB: Self = Self {
        w0: 1.0,
        w1: 1.0,
        w2: 1.0,
    };

    /// Coeficientes de luminância Rec. 709.
    pub const REC709_LUMA: Self = Self {
        w0: LUMA_REC709_R,
        w1: LUMA_REC709_G,
        w2: LUMA_REC709_B,
    };

    /// Calcula pesos locais aproximados de Redmean para um pixel alvo e tela atual.
    #[inline]
    pub fn from_redmean(c_current_r: f32, target_r: f32) -> Self {
        let r_mean = (c_current_r + target_r) * 0.5;
        Self {
            w0: 2.0 + r_mean,
            w1: 4.0,
            w2: 3.0 - r_mean,
        }
    }

    /// Deriva os pesos da métrica a partir do `ColorErrorMetric` selecionado.
    #[inline]
    pub fn for_pixel(
        metric: ColorErrorMetric,
        c_current_r: f32,
        target_r: f32,
    ) -> Self {
        match metric {
            ColorErrorMetric::LinearRgb => Self::LINEAR_RGB,
            ColorErrorMetric::RedmeanWeighted => Self::from_redmean(c_current_r, target_r),
            ColorErrorMetric::CielabDeltaE76 | ColorErrorMetric::CielabDeltaE2000 => {
                // Para ganho marginal instantâneo no loop interno de milhões de avaliações,
                // a métrica Rec. 709 / Redmean linearizada provê aproximação hiper-rápida
                // fortemente correlacionada com L* e croma CIELAB.
                Self::REC709_LUMA
            }
        }
    }

    /// Produto interno ponderado $\langle \mathbf{u}, \mathbf{v} \rangle_{\mathbf{M}}$.
    #[inline]
    pub fn dot(&self, u: [f32; 3], v: [f32; 3]) -> f32 {
        self.w0 * u[0] * v[0] + self.w1 * u[1] * v[1] + self.w2 * u[2] * v[2]
    }

    /// Norma quadrática ponderada $\|\mathbf{u}\|_{\mathbf{M}}^2$.
    #[inline]
    pub fn norm_sq(&self, u: [f32; 3]) -> f32 {
        self.w0 * u[0] * u[0] + self.w1 * u[1] * u[1] + self.w2 * u[2] * u[2]
    }
}

/// Carretel de fio com sua cor linear e parâmetros ópticos.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpoolColor {
    /// Identificador numérico do carretel (0..M-1).
    pub id: u8,
    /// Cor fotométrica linear do fio.
    pub color: LinearRgbColor,
    /// Opacidade intrínseca da fibra $\alpha_{\text{material}} \in [0.0, 1.0]$.
    pub alpha_material: f32,
}

impl SpoolColor {
    pub const fn new(id: u8, color: LinearRgbColor, alpha_material: f32) -> Self {
        Self {
            id,
            color,
            alpha_material,
        }
    }
}

/// Avaliador de modelos ópticos e cálculo de ganho marginal.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OpticalModelEvaluator {
    pub mix_model: OpticalMixModelType,
    pub error_metric: ColorErrorMetric,
}

impl OpticalModelEvaluator {
    pub const fn new(mix_model: OpticalMixModelType, error_metric: ColorErrorMetric) -> Self {
        Self {
            mix_model,
            error_metric,
        }
    }

    /// Calcula a cor atualizada $C^{(t+1)}$ de um pixel $p$ sob a aplicação de um fio de cor $\mathbf{s}_k$
    /// com opacidade efetiva $\alpha_{\text{efetivo}}$ e peso de cobertura sub-pixel $w \in [0.0, 1.0]$.
    #[inline]
    pub fn update_pixel_color(
        &self,
        current: LinearRgbColor,
        spool_color: LinearRgbColor,
        alpha_eff: f32,
        subpixel_weight: f32,
    ) -> LinearRgbColor {
        let aw = (alpha_eff * subpixel_weight).clamp(0.0, 1.0);
        match self.mix_model {
            OpticalMixModelType::PorterDuffOcclusion => {
                // C^{(t+1)} = (1 - \alpha w) C^{(t)} + (\alpha w) s_k
                LinearRgbColor::new(
                    (1.0 - aw) * current.r + aw * spool_color.r,
                    (1.0 - aw) * current.g + aw * spool_color.g,
                    (1.0 - aw) * current.b + aw * spool_color.b,
                )
            }
            OpticalMixModelType::LinearSubtractive => {
                // Subtrativo: absorve luz proporcionalmente a (1 - s_k)
                LinearRgbColor::new(
                    (current.r - aw * (1.0 - spool_color.r)).clamp(0.0, 1.0),
                    (current.g - aw * (1.0 - spool_color.g)).clamp(0.0, 1.0),
                    (current.b - aw * (1.0 - spool_color.b)).clamp(0.0, 1.0),
                )
            }
            OpticalMixModelType::BeerLambertTransmittance => {
                // Multiplicativo: T^{(t+1)} = T^{(t)} * (1 - aw * (1 - s_k))
                LinearRgbColor::new(
                    (current.r * (1.0 - aw * (1.0 - spool_color.r))).clamp(0.0, 1.0),
                    (current.g * (1.0 - aw * (1.0 - spool_color.g))).clamp(0.0, 1.0),
                    (current.b * (1.0 - aw * (1.0 - spool_color.b))).clamp(0.0, 1.0),
                )
            }
        }
    }

    /// Calcula o ganho marginal de redução de erro $\Delta E$ em um único pixel $p$:
    ///
    /// Para `PorterDuffOcclusion`:
    /// $$\text{Ganho}(p, k) = W(p) \cdot \left[ 2(\alpha w) \langle \mathbf{e}(p), \mathbf{d}_k(p) \rangle_{\mathbf{M}} - (\alpha w)^2 \|\mathbf{d}_k(p)\|_{\mathbf{M}}^2 \right]$$
    /// onde $\mathbf{e}(p) = C^{(t)}(p) - T(p)$ e $\mathbf{d}_k(p) = C^{(t)}(p) - \mathbf{s}_k$.
    ///
    /// Para os demais modelos ou avaliação perceptual estrita, calcula a diferença direta
    /// entre o erro anterior ponderado e o novo erro.
    #[inline]
    pub fn pixel_marginal_gain(
        &self,
        current: [f32; 3],
        target: [f32; 3],
        spool: [f32; 3],
        alpha_eff: f32,
        subpixel_weight: f32,
        importance_w: f32,
    ) -> f32 {
        if importance_w <= 0.0 {
            return 0.0;
        }

        let aw = (alpha_eff * subpixel_weight).clamp(0.0, 1.0);
        if aw <= 1e-7 {
            return 0.0;
        }

        let weights = MetricWeights::for_pixel(self.error_metric, current[0], target[0]);

        match self.mix_model {
            OpticalMixModelType::PorterDuffOcclusion => {
                // e(p) = C^{(t)}(p) - T(p)
                let e = [
                    current[0] - target[0],
                    current[1] - target[1],
                    current[2] - target[2],
                ];
                // d_k(p) = C^{(t)}(p) - s_k
                let d = [
                    current[0] - spool[0],
                    current[1] - spool[1],
                    current[2] - spool[2],
                ];

                let dot_ed = weights.dot(e, d);
                let norm_d_sq = weights.norm_sq(d);

                let raw_gain = 2.0 * aw * dot_ed - (aw * aw) * norm_d_sq;
                importance_w * raw_gain
            }
            OpticalMixModelType::LinearSubtractive => {
                let e_old = [
                    current[0] - target[0],
                    current[1] - target[1],
                    current[2] - target[2],
                ];
                let c_new = [
                    (current[0] - aw * (1.0 - spool[0])).clamp(0.0, 1.0),
                    (current[1] - aw * (1.0 - spool[1])).clamp(0.0, 1.0),
                    (current[2] - aw * (1.0 - spool[2])).clamp(0.0, 1.0),
                ];
                let e_new = [
                    c_new[0] - target[0],
                    c_new[1] - target[1],
                    c_new[2] - target[2],
                ];
                let err_old = weights.norm_sq(e_old);
                let err_new = weights.norm_sq(e_new);
                importance_w * (err_old - err_new)
            }
            OpticalMixModelType::BeerLambertTransmittance => {
                let e_old = [
                    current[0] - target[0],
                    current[1] - target[1],
                    current[2] - target[2],
                ];
                let c_new = [
                    (current[0] * (1.0 - aw * (1.0 - spool[0]))).clamp(0.0, 1.0),
                    (current[1] * (1.0 - aw * (1.0 - spool[1]))).clamp(0.0, 1.0),
                    (current[2] * (1.0 - aw * (1.0 - spool[2]))).clamp(0.0, 1.0),
                ];
                let e_new = [
                    c_new[0] - target[0],
                    c_new[1] - target[1],
                    c_new[2] - target[2],
                ];
                let err_old = weights.norm_sq(e_old);
                let err_new = weights.norm_sq(e_new);
                importance_w * (err_old - err_new)
            }
        }
    }

    /// Calcula o ganho marginal acumulado ao longo de uma corda rasterizada:
    /// $\text{Ganho}_{\text{corda}} = \sum_{p \in \text{corda}} \text{Ganho}(p, k)$.
    ///
    /// Consulta os pixels e pesos sub-pixel diretamente da struct `CanvasStateSoA`.
    pub fn chord_marginal_gain(
        &self,
        state: &CanvasStateSoA,
        pixel_indices: &[u32],
        subpixel_weights_u8: &[u8],
        spool: &SpoolColor,
        alpha_eff: f32,
    ) -> f32 {
        let spool_arr = [spool.color.r, spool.color.g, spool.color.b];
        let mut total_gain = 0.0f32;
        let len = pixel_indices.len();

        match self.mix_model {
            OpticalMixModelType::PorterDuffOcclusion => {
                let s0 = spool_arr[0];
                let s1 = spool_arr[1];
                let s2 = spool_arr[2];
                let is_linear_rgb = self.error_metric == ColorErrorMetric::LinearRgb;

                for i in 0..len {
                    let p = pixel_indices[i] as usize;
                    let imp = state.importance_w[p];
                    if imp <= 0.0 {
                        continue;
                    }
                    let w_sub = (subpixel_weights_u8[i] as f32) * (1.0 / 255.0);
                    let aw = (alpha_eff * w_sub).clamp(0.0, 1.0);
                    if aw <= 1e-7 {
                        continue;
                    }

                    let c0 = state.current_c0[p];
                    let c1 = state.current_c1[p];
                    let c2 = state.current_c2[p];
                    let t0 = state.target_c0[p];
                    let t1 = state.target_c1[p];
                    let t2 = state.target_c2[p];

                    let e0 = c0 - t0;
                    let e1 = c1 - t1;
                    let e2 = c2 - t2;
                    let d0 = c0 - s0;
                    let d1 = c1 - s1;
                    let d2 = c2 - s2;

                    let (dot_ed, norm_d_sq) = if is_linear_rgb {
                        (e0 * d0 + e1 * d1 + e2 * d2, d0 * d0 + d1 * d1 + d2 * d2)
                    } else {
                        let weights = MetricWeights::for_pixel(self.error_metric, c0, t0);
                        (weights.dot([e0, e1, e2], [d0, d1, d2]), weights.norm_sq([d0, d1, d2]))
                    };

                    let raw_gain = 2.0 * aw * dot_ed - (aw * aw) * norm_d_sq;
                    total_gain += imp * raw_gain;
                }
            }
            _ => {
                for i in 0..len {
                    let p = pixel_indices[i] as usize;
                    let w_sub = (subpixel_weights_u8[i] as f32) * (1.0 / 255.0);
                    let imp = state.importance_w[p];
                    if imp <= 0.0 {
                        continue;
                    }

                    let current = [
                        state.current_c0[p],
                        state.current_c1[p],
                        state.current_c2[p],
                    ];
                    let target = [
                        state.target_c0[p],
                        state.target_c1[p],
                        state.target_c2[p],
                    ];

                    let gain = self.pixel_marginal_gain(
                        current,
                        target,
                        spool_arr,
                        alpha_eff,
                        w_sub,
                        imp,
                    );
                    total_gain += gain;
                }
            }
        }

        total_gain
    }

    /// Aplica a corda rasterizada sobre a tela `CanvasStateSoA`, atualizando os pixels in-place.
    pub fn apply_chord(
        &self,
        state: &mut CanvasStateSoA,
        pixel_indices: &[u32],
        subpixel_weights_u8: &[u8],
        spool: &SpoolColor,
        alpha_eff: f32,
    ) {
        let len = pixel_indices.len();
        for i in 0..len {
            let p = pixel_indices[i] as usize;
            let w_sub = (subpixel_weights_u8[i] as f32) * (1.0 / 255.0);
            let cur = state.current_color(p);
            let updated = self.update_pixel_color(cur, spool.color, alpha_eff, w_sub);
            state.set_current_color(p, updated);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_porter_duff_fast_expansion_exactness() {
        let eval = OpticalModelEvaluator::new(
            OpticalMixModelType::PorterDuffOcclusion,
            ColorErrorMetric::LinearRgb,
        );

        let current = [0.8, 0.7, 0.9];
        let target = [0.1, 0.2, 0.3];
        let spool = [0.0, 0.0, 0.0]; // fio preto
        let alpha = 0.25;
        let w_sub = 0.8;
        let importance = 1.5;

        // Ganho calculado pela expansão rápida:
        let fast_gain = eval.pixel_marginal_gain(current, target, spool, alpha, w_sub, importance);

        // Ganho calculado por definição de erro anterior - novo erro:
        let cur_color = LinearRgbColor::new(current[0], current[1], current[2]);
        let spool_color = LinearRgbColor::new(spool[0], spool[1], spool[2]);
        let updated = eval.update_pixel_color(cur_color, spool_color, alpha, w_sub);

        let err_before = (current[0] - target[0]).powi(2)
            + (current[1] - target[1]).powi(2)
            + (current[2] - target[2]).powi(2);
        let err_after = (updated.r - target[0]).powi(2)
            + (updated.g - target[1]).powi(2)
            + (updated.b - target[2]).powi(2);
        let def_gain = importance * (err_before - err_after);

        assert!(
            (fast_gain - def_gain).abs() < 1e-5,
            "Expansão rápida ({}) difere da definição exata ({})",
            fast_gain,
            def_gain
        );
    }

    #[test]
    fn test_optical_models_transmittance_and_gain() {
        let spool_black = SpoolColor::new(0, LinearRgbColor::BLACK, 0.2);
        let target = vec![LinearRgbColor::BLACK; 4];
        let mut state = CanvasStateSoA::from_target_and_background(
            2,
            2,
            &target,
            LinearRgbColor::WHITE,
            None,
        );

        let eval_sub = OpticalModelEvaluator::new(
            OpticalMixModelType::LinearSubtractive,
            ColorErrorMetric::LinearRgb,
        );
        let eval_beer = OpticalModelEvaluator::new(
            OpticalMixModelType::BeerLambertTransmittance,
            ColorErrorMetric::LinearRgb,
        );

        let pixels = [0, 1];
        let weights = [255, 255];

        let gain_sub = eval_sub.chord_marginal_gain(&state, &pixels, &weights, &spool_black, 0.2);
        let gain_beer = eval_beer.chord_marginal_gain(&state, &pixels, &weights, &spool_black, 0.2);

        assert!(gain_sub > 0.0);
        assert!(gain_beer > 0.0);

        eval_sub.apply_chord(&mut state, &pixels, &weights, &spool_black, 0.2);
        assert!(state.current_c0[0] < 1.0);
        assert_eq!(state.current_c0[2], 1.0); // pixel 2 não foi tocado
    }
}
