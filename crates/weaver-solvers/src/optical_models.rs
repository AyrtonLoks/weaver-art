//! Modelo óptico do fio e função objetivo da tecelagem (`optical_models.rs`).
//!
//! Este módulo foi reescrito do zero para ser **simples, exato e testável**:
//!
//! 1. **Física do fio** (por pixel, cobertura sub-pixel `w ∈ [0, 1]`):
//!    - `PorterDuffOcclusion`: $C' = (1 - a)C + a\,\mathbf{s}$
//!    - `BeerLambertTransmittance`: $C' = C\,(1 - a(1 - \mathbf{s}))$
//!    - `LinearSubtractive`: $C' = \max(0, C - a(1 - \mathbf{s}))$
//!
//!    com $a = \text{cobertura} \cdot \alpha_{\text{material}} \cdot w$, onde a cobertura é a fração
//!    física do pixel ocupada pelo fio (`compute_effective_alpha` com $\alpha = 1$) e
//!    $\alpha_{\text{material}}$ é a opacidade da fibra (preto ≈ 1,0).
//!
//! 2. **Função objetivo**: erro quadrático ponderado num espaço **perceptual** (curva sRGB),
//!    $E = \sum_p W(p)\,\sum_c \omega_c\,(\text{enc}(C_c(p)) - \text{enc}(T_c(p)))^2$.
//!    O ganho de uma corda é a **variação exata** $E_{\text{antes}} - E_{\text{depois}}$
//!    (sem aproximações de 1ª ordem e sem constantes empíricas).
//!
//! 3. **Proteção de realces** (opcional, `highlight_protection`): multiplica apenas as parcelas
//!    negativas (pixels sobre-escurecidos) cujo alvo é claro ($T > 0{,}35$).
//!
//! O espaço perceptual é usado para todas as métricas exceto `ColorErrorMetric::LinearRgb`,
//! que mede o erro diretamente em luz linear.

use std::sync::OnceLock;

use weaver_domain::{linear_to_srgb_channel, ColorErrorMetric, LinearRgbColor};

use crate::state_matrix::CanvasStateSoA;

/// Limiar de luminância linear do alvo acima do qual a proteção de realces atua.
pub const HIGHLIGHT_THRESHOLD: f32 = 0.35;

const ENC_LUT_SIZE: usize = 4096;

fn srgb_lut() -> &'static [f32; ENC_LUT_SIZE + 2] {
    static LUT: OnceLock<[f32; ENC_LUT_SIZE + 2]> = OnceLock::new();
    LUT.get_or_init(|| {
        let mut lut = [0.0f32; ENC_LUT_SIZE + 2];
        for (i, v) in lut.iter_mut().enumerate() {
            let x = (i.min(ENC_LUT_SIZE) as f32) / ENC_LUT_SIZE as f32;
            *v = linear_to_srgb_channel(x);
        }
        lut
    })
}

/// Codificação perceptual sRGB (IEC 61966-2-1) via tabela com interpolação linear.
#[inline]
fn encode_srgb(lut: &[f32; ENC_LUT_SIZE + 2], v: f32) -> f32 {
    let x = v.clamp(0.0, 1.0) * ENC_LUT_SIZE as f32;
    let i = x as usize;
    let f = x - i as f32;
    lut[i] + (lut[i + 1] - lut[i]) * f
}

/// Modelo de mistura óptica e física de transmitância.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OpticalMixModelType {
    /// Oclusão física Porter-Duff: $C' = (1 - a)C + a\,\mathbf{s}$.
    PorterDuffOcclusion,
    /// Mistura linear subtrativa: $C' = \max(0, C - a(1 - \mathbf{s}))$.
    LinearSubtractive,
    /// Lei de Beer-Lambert multiplicativa: $C' = C\,(1 - a(1 - \mathbf{s}))$.
    BeerLambertTransmittance,
}

/// Carretel de fio com sua cor linear e opacidade física.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpoolColor {
    /// Identificador numérico do carretel (0..M-1).
    pub id: u8,
    /// Cor fotométrica linear do fio.
    pub color: LinearRgbColor,
    /// Opacidade física da fibra $\alpha_{\text{material}} \in [0, 1]$ (fio preto ≈ 1,0).
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

    /// Indica se o fio é neutro (cinza/preto), permitindo o caminho rápido monocanal.
    #[inline]
    pub fn is_neutral(&self) -> bool {
        let c = self.color;
        (c.r - c.g).abs() < 1e-4 && (c.g - c.b).abs() < 1e-4
    }
}

/// Avaliador do modelo óptico e da função objetivo.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OpticalModelEvaluator {
    pub mix_model: OpticalMixModelType,
    pub error_metric: ColorErrorMetric,
    /// Fator de proteção de realces (0 = desligado).
    pub highlight_protection: f32,
    /// Quando `true`, alvo e tela são neutros (R = G = B) e só o canal 0 é avaliado.
    pub luma_only: bool,
}

impl OpticalModelEvaluator {
    pub const fn new(mix_model: OpticalMixModelType, error_metric: ColorErrorMetric) -> Self {
        Self {
            mix_model,
            error_metric,
            highlight_protection: 0.0,
            luma_only: false,
        }
    }

    pub const fn with_highlight_protection(mut self, highlight_protection: f32) -> Self {
        self.highlight_protection = highlight_protection;
        self
    }

    pub const fn with_luma_only(mut self, luma_only: bool) -> Self {
        self.luma_only = luma_only;
        self
    }

    #[inline]
    fn perceptual(&self) -> bool {
        !matches!(self.error_metric, ColorErrorMetric::LinearRgb)
    }

    /// Aplica o fio de cor `s` com opacidade efetiva `a` a um canal.
    #[inline]
    fn apply_channel(&self, c: f32, s: f32, a: f32) -> f32 {
        match self.mix_model {
            OpticalMixModelType::PorterDuffOcclusion => c + a * (s - c),
            OpticalMixModelType::BeerLambertTransmittance => c * (1.0 - a * (1.0 - s)),
            OpticalMixModelType::LinearSubtractive => (c - a * (1.0 - s)).max(0.0),
        }
    }

    /// Inverte a aplicação do fio (usado pelo passe de refinamento para remover cordas).
    #[inline]
    fn unapply_channel(&self, c: f32, s: f32, a: f32) -> f32 {
        let out = match self.mix_model {
            OpticalMixModelType::PorterDuffOcclusion => {
                let k = (1.0 - a).max(1e-6);
                (c - a * s) / k
            }
            OpticalMixModelType::BeerLambertTransmittance => {
                let k = (1.0 - a * (1.0 - s)).max(1e-6);
                c / k
            }
            OpticalMixModelType::LinearSubtractive => c + a * (1.0 - s),
        };
        out.clamp(0.0, 1.0)
    }

    /// Cor atualizada de um pixel sob um fio com opacidade efetiva total `aw` (já inclui cobertura e peso).
    #[inline]
    pub fn update_pixel_color(
        &self,
        current: LinearRgbColor,
        spool_color: LinearRgbColor,
        aw: f32,
    ) -> LinearRgbColor {
        let a = aw.clamp(0.0, 1.0);
        LinearRgbColor::new(
            self.apply_channel(current.r, spool_color.r, a),
            self.apply_channel(current.g, spool_color.g, a),
            self.apply_channel(current.b, spool_color.b, a),
        )
    }

    /// Variação exata do erro ponderado ao **adicionar** (`remove = false`) ou **remover**
    /// (`remove = true`) uma corda. Valor positivo = o erro diminui.
    fn chord_delta(
        &self,
        state: &CanvasStateSoA,
        pixel_indices: &[u32],
        subpixel_weights_u8: &[u8],
        spool: &SpoolColor,
        coverage: f32,
        remove: bool,
    ) -> f32 {
        let lut = srgb_lut();
        let perceptual = self.perceptual();
        let enc = |v: f32| if perceptual { encode_srgb(lut, v) } else { v };
        let a_scale = coverage * spool.alpha_material * (1.0 / 255.0);
        let hp = self.highlight_protection.max(0.0);
        let (s0, s1, s2) = (spool.color.r, spool.color.g, spool.color.b);
        let mono = self.luma_only && spool.is_neutral();
        let mut total = 0.0f32;

        for (&pi, &wu) in pixel_indices.iter().zip(subpixel_weights_u8.iter()) {
            let p = pi as usize;
            let imp = state.importance_w[p];
            if imp <= 0.0 {
                continue;
            }
            let a = (a_scale * wu as f32).min(1.0);

            let mut px_gain;
            if mono {
                let c = state.current_c0[p];
                let t = enc(state.target_c0[p]);
                let c_new = if remove {
                    self.unapply_channel(c, s0, a)
                } else {
                    self.apply_channel(c, s0, a)
                };
                let e_old = enc(c) - t;
                let e_new = enc(c_new) - t;
                px_gain = e_old * e_old - e_new * e_new;
            } else {
                px_gain = 0.0;
                for (cur, tgt, s) in [
                    (state.current_c0[p], state.target_c0[p], s0),
                    (state.current_c1[p], state.target_c1[p], s1),
                    (state.current_c2[p], state.target_c2[p], s2),
                ] {
                    let t = enc(tgt);
                    let c_new = if remove {
                        self.unapply_channel(cur, s, a)
                    } else {
                        self.apply_channel(cur, s, a)
                    };
                    let e_old = enc(cur) - t;
                    let e_new = enc(c_new) - t;
                    px_gain += e_old * e_old - e_new * e_new;
                }
                px_gain *= 1.0 / 3.0;
            }

            if px_gain < 0.0 && hp > 0.0 {
                let t_luma = if mono {
                    state.target_c0[p]
                } else {
                    0.2126 * state.target_c0[p]
                        + 0.7152 * state.target_c1[p]
                        + 0.0722 * state.target_c2[p]
                };
                if t_luma > HIGHLIGHT_THRESHOLD {
                    px_gain *= 1.0 + hp * (t_luma - HIGHLIGHT_THRESHOLD);
                }
            }
            total += imp * px_gain;
        }
        total
    }

    /// Ganho exato (redução do erro ponderado) ao adicionar a corda com o carretel `spool`.
    pub fn chord_marginal_gain(
        &self,
        state: &CanvasStateSoA,
        pixel_indices: &[u32],
        subpixel_weights_u8: &[u8],
        spool: &SpoolColor,
        coverage: f32,
    ) -> f32 {
        self.chord_delta(
            state,
            pixel_indices,
            subpixel_weights_u8,
            spool,
            coverage,
            false,
        )
    }

    /// Ganho exato ao **remover** uma corda já aplicada (positivo = remover melhora a imagem).
    pub fn chord_removal_gain(
        &self,
        state: &CanvasStateSoA,
        pixel_indices: &[u32],
        subpixel_weights_u8: &[u8],
        spool: &SpoolColor,
        coverage: f32,
    ) -> f32 {
        self.chord_delta(
            state,
            pixel_indices,
            subpixel_weights_u8,
            spool,
            coverage,
            true,
        )
    }

    /// Aplica a corda sobre a tela.
    pub fn apply_chord(
        &self,
        state: &mut CanvasStateSoA,
        pixel_indices: &[u32],
        subpixel_weights_u8: &[u8],
        spool: &SpoolColor,
        coverage: f32,
    ) {
        let a_scale = coverage * spool.alpha_material * (1.0 / 255.0);
        for (&pi, &wu) in pixel_indices.iter().zip(subpixel_weights_u8.iter()) {
            let p = pi as usize;
            let a = (a_scale * wu as f32).min(1.0);
            state.current_c0[p] = self.apply_channel(state.current_c0[p], spool.color.r, a);
            state.current_c1[p] = self.apply_channel(state.current_c1[p], spool.color.g, a);
            state.current_c2[p] = self.apply_channel(state.current_c2[p], spool.color.b, a);
        }
    }

    /// Remove (desfaz) uma corda previamente aplicada sobre a tela.
    pub fn remove_chord(
        &self,
        state: &mut CanvasStateSoA,
        pixel_indices: &[u32],
        subpixel_weights_u8: &[u8],
        spool: &SpoolColor,
        coverage: f32,
    ) {
        let a_scale = coverage * spool.alpha_material * (1.0 / 255.0);
        for (&pi, &wu) in pixel_indices.iter().zip(subpixel_weights_u8.iter()) {
            let p = pi as usize;
            let a = (a_scale * wu as f32).min(1.0);
            state.current_c0[p] = self.unapply_channel(state.current_c0[p], spool.color.r, a);
            state.current_c1[p] = self.unapply_channel(state.current_c1[p], spool.color.g, a);
            state.current_c2[p] = self.unapply_channel(state.current_c2[p], spool.color.b, a);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn perceptual_error(state: &CanvasStateSoA, imp: &[f32]) -> f32 {
        let mut e = 0.0;
        for p in 0..state.num_pixels {
            for (c, t) in [
                (state.current_c0[p], state.target_c0[p]),
                (state.current_c1[p], state.target_c1[p]),
                (state.current_c2[p], state.target_c2[p]),
            ] {
                let d = linear_to_srgb_channel(c) - linear_to_srgb_channel(t);
                e += imp[p] * d * d / 3.0;
            }
        }
        e
    }

    fn small_state() -> CanvasStateSoA {
        let target = vec![
            LinearRgbColor::new(0.05, 0.05, 0.05),
            LinearRgbColor::new(0.2, 0.2, 0.2),
            LinearRgbColor::new(0.9, 0.9, 0.9),
            LinearRgbColor::new(0.5, 0.5, 0.5),
        ];
        CanvasStateSoA::from_target_and_background(2, 2, &target, LinearRgbColor::WHITE, None)
    }

    #[test]
    fn gain_equals_exact_perceptual_error_reduction() {
        let eval = OpticalModelEvaluator::new(
            OpticalMixModelType::PorterDuffOcclusion,
            ColorErrorMetric::CielabDeltaE2000,
        );
        let mut state = small_state();
        let spool = SpoolColor::new(0, LinearRgbColor::new(0.02, 0.02, 0.02), 1.0);
        let pixels = [0u32, 1, 2, 3];
        let weights = [255u8, 128, 200, 64];
        let imp = vec![1.0; 4];

        let before = perceptual_error(&state, &imp);
        let gain = eval.chord_marginal_gain(&state, &pixels, &weights, &spool, 0.3);
        eval.apply_chord(&mut state, &pixels, &weights, &spool, 0.3);
        let after = perceptual_error(&state, &imp);
        assert!(
            (gain - (before - after)).abs() < 2e-3,
            "gain={gain} exact={}",
            before - after
        );
    }

    #[test]
    fn luma_only_matches_three_channel_for_neutral_inputs() {
        let base = OpticalModelEvaluator::new(
            OpticalMixModelType::PorterDuffOcclusion,
            ColorErrorMetric::CielabDeltaE2000,
        );
        let state = small_state();
        let spool = SpoolColor::new(0, LinearRgbColor::new(0.02, 0.02, 0.02), 1.0);
        let pixels = [0u32, 1, 2, 3];
        let weights = [255u8, 255, 255, 255];
        let g3 = base.chord_marginal_gain(&state, &pixels, &weights, &spool, 0.15);
        let g1 = base
            .with_luma_only(true)
            .chord_marginal_gain(&state, &pixels, &weights, &spool, 0.15);
        assert!((g3 - g1).abs() < 1e-5);
    }

    #[test]
    fn opaque_black_thread_darkens_by_coverage() {
        let eval = OpticalModelEvaluator::new(
            OpticalMixModelType::PorterDuffOcclusion,
            ColorErrorMetric::LinearRgb,
        );
        let mut state = small_state();
        let spool = SpoolColor::new(0, LinearRgbColor::BLACK, 1.0);
        eval.apply_chord(&mut state, &[0], &[255], &spool, 0.15);
        assert!((state.current_c0[0] - 0.85).abs() < 1e-6);
        assert_eq!(state.current_c0[1], 1.0);
    }

    #[test]
    fn remove_chord_inverts_apply_for_all_models() {
        for model in [
            OpticalMixModelType::PorterDuffOcclusion,
            OpticalMixModelType::BeerLambertTransmittance,
            OpticalMixModelType::LinearSubtractive,
        ] {
            let eval = OpticalModelEvaluator::new(model, ColorErrorMetric::CielabDeltaE2000);
            let mut state = small_state();
            let spool = SpoolColor::new(0, LinearRgbColor::new(0.1, 0.2, 0.3), 0.9);
            let pixels = [0u32, 1, 2, 3];
            let weights = [255u8, 100, 50, 10];
            eval.apply_chord(&mut state, &pixels, &weights, &spool, 0.2);
            let gain_remove = eval.chord_removal_gain(&state, &pixels, &weights, &spool, 0.2);
            eval.remove_chord(&mut state, &pixels, &weights, &spool, 0.2);
            for p in 0..4 {
                assert!((state.current_c0[p] - 1.0).abs() < 1e-5, "{model:?}");
                assert!((state.current_c2[p] - 1.0).abs() < 1e-5, "{model:?}");
            }
            // remover uma corda sobre alvos escuros piora a imagem
            assert!(gain_remove < 0.0, "{model:?}");
        }
    }

    #[test]
    fn highlight_protection_only_amplifies_overdarkening() {
        let target = vec![LinearRgbColor::new(0.9, 0.9, 0.9); 1];
        let state =
            CanvasStateSoA::from_target_and_background(1, 1, &target, LinearRgbColor::WHITE, None);
        let spool = SpoolColor::new(0, LinearRgbColor::BLACK, 1.0);
        let plain = OpticalModelEvaluator::new(
            OpticalMixModelType::PorterDuffOcclusion,
            ColorErrorMetric::CielabDeltaE2000,
        );
        let protected = plain.with_highlight_protection(3.0);
        let g0 = plain.chord_marginal_gain(&state, &[0], &[255], &spool, 0.5);
        let g1 = protected.chord_marginal_gain(&state, &[0], &[255], &spool, 0.5);
        assert!(g0 < 0.0);
        assert!(g1 < g0);
    }
}
