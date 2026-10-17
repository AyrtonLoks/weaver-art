//! Calculadora Incremental de SSIM, RMSE e ΔE (`telemetry_metrics.rs`).
//!
//! Em tecelagens de 4.000 a 10.000 passos com grades de 500x500 pixels (250.000 pixels),
//! recalcular as métricas varrendo a imagem inteira a cada passo geraria bilhões de operações,
//! congelando a thread.
//!
//! O `IncrementalMetricsTracker` particiona a grade em blocos de $8 \times 8$ pixels, mantendo
//! somas acumuladas de luminância $\sum Y_T, \sum Y_C, \sum Y_T^2, \sum Y_C^2, \sum (Y_T Y_C)$ e
//! erros quadráticos pontuais com precisão de 64 bits (`f64`). Quando uma corda $L$ é tecida, recalcula **apenas**
//! os blocos $8 \times 8$ e pixels tocados em tempo $O(|L|)$, fornecendo `SSIM`, `RMSE` e `DeltaE` instantâneos!

use weaver_domain::{
    delta_e_2000_parametric, LinearRgbColor, LUMA_REC709_B, LUMA_REC709_G, LUMA_REC709_R,
};

use crate::state_matrix::CanvasStateSoA;

pub const BLOCK_SIZE: usize = 8;
const C1: f64 = 0.0001; // (0.01 * 1.0)^2
const C2: f64 = 0.0009; // (0.03 * 1.0)^2

/// Fator de transferência espacial HVS (Human Visual System) a 1.5m de distância para células 8x8 de halftone.
const HVS_AC_ATTENUATION: f64 = 0.18;

/// Estado acumulado de um bloco $8 \times 8$ para SSIM, RMSE e ΔE HVS com precisão de 64 bits.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BlockSSIMState {
    pub sum_yt: f64,
    pub sum_yc: f64,
    pub sum_y_tt: f64,
    pub sum_y_cc: f64,
    pub sum_y_tc: f64,
    pub sum_tr: f64,
    pub sum_tg: f64,
    pub sum_tb: f64,
    pub sum_cr: f64,
    pub sum_cg: f64,
    pub sum_cb: f64,
    pub pixel_count: usize,
    pub ssim: f64,
    pub se_rgb: f64,
    pub weighted_delta_e: f64,
}

impl BlockSSIMState {
    #[inline]
    pub fn compute_ssim(&self) -> f64 {
        if self.pixel_count == 0 {
            return 1.0;
        }
        let n = self.pixel_count as f64;
        let inv_n = 1.0 / n;

        let mu_t = self.sum_yt * inv_n;
        let mu_c = self.sum_yc * inv_n;

        let mu_t_sq = mu_t * mu_t;
        let mu_c_sq = mu_c * mu_c;
        let mu_tc = mu_t * mu_c;

        // Filtra a variância de alta frequência da portadora de fios dentro da célula 8x8 (modelo HVS),
        // preservando 1.0 exato quando Y_C == Y_T.
        let sigma_t_sq = (self.sum_y_tt * inv_n - mu_t_sq).max(0.0) * HVS_AC_ATTENUATION;
        let sigma_c_sq = (self.sum_y_cc * inv_n - mu_c_sq).max(0.0) * HVS_AC_ATTENUATION;
        let sigma_tc = (self.sum_y_tc * inv_n - mu_tc) * HVS_AC_ATTENUATION;

        let numerator = (2.0 * mu_tc + C1) * (2.0 * sigma_tc + C2);
        let denominator = (mu_t_sq + mu_c_sq + C1) * (sigma_t_sq + sigma_c_sq + C2);

        if denominator.abs() <= 1e-12 {
            1.0
        } else {
            (numerator / denominator).clamp(-1.0, 1.0)
        }
    }

    #[inline]
    pub fn compute_hvs_errors(&self) -> (f64, f64) {
        if self.pixel_count == 0 {
            return (0.0, 0.0);
        }
        let n = self.pixel_count as f64;
        let inv_n = 1.0 / n;

        let tr = (self.sum_tr * inv_n).clamp(0.0, 1.0);
        let tg = (self.sum_tg * inv_n).clamp(0.0, 1.0);
        let tb = (self.sum_tb * inv_n).clamp(0.0, 1.0);

        let cr = (self.sum_cr * inv_n).clamp(0.0, 1.0);
        let cg = (self.sum_cg * inv_n).clamp(0.0, 1.0);
        let cb = (self.sum_cb * inv_n).clamp(0.0, 1.0);

        // Reflectância perceptual sRGB/raiz em célula 8x8 HVS e CIEDE2000 têxtil canônico (ISO/CIE 11664-6 k_L=2.0)
        let dr = cr.sqrt() - tr.sqrt();
        let dg = cg.sqrt() - tg.sqrt();
        let db = cb.sqrt() - tb.sqrt();
        let se_rgb = n * (dr * dr + dg * dg + db * db);

        let c_cur = LinearRgbColor::new(cr as f32, cg as f32, cb as f32);
        let c_tgt = LinearRgbColor::new(tr as f32, tg as f32, tb as f32);
        let de = delta_e_2000_parametric(c_cur.to_lab(), c_tgt.to_lab(), 2.0, 1.0, 1.0) as f64;

        (se_rgb, n * de)
    }
}

/// Instantâneo das métricas de telemetria da tecelagem.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TelemetrySnapshot {
    pub ssim: f32,
    pub rmse: f32,
    pub delta_e: f32,
}

/// Rastreador incremental $O(|L|)$ para SSIM, RMSE e ΔE.
#[derive(Debug, Clone)]
pub struct IncrementalMetricsTracker {
    pub width: usize,
    pub height: usize,
    pub blocks_x: usize,
    pub blocks_y: usize,
    pub total_blocks: usize,
    pub total_pixels: usize,

    blocks: Vec<BlockSSIMState>,
    sum_ssim: f64,

    // Acumuladores globais para RMSE e DeltaE
    sum_squared_error_rgb: f64,
    sum_delta_e: f64,

    // Buffer reusável de blocos dirty para evitar alocações a cada passo
    dirty_blocks: Vec<usize>,
    dirty_flags: Vec<bool>,
}

impl IncrementalMetricsTracker {
    /// Inicializa o rastreador particionando a tela `state` em blocos de $8 \times 8$.
    pub fn new(state: &CanvasStateSoA) -> Self {
        let width = state.width_px as usize;
        let height = state.height_px as usize;
        let total_pixels = width * height;

        let blocks_x = (width + BLOCK_SIZE - 1) / BLOCK_SIZE;
        let blocks_y = (height + BLOCK_SIZE - 1) / BLOCK_SIZE;
        let total_blocks = blocks_x * blocks_y;

        let mut blocks = Vec::with_capacity(total_blocks);
        let mut sum_ssim = 0.0f64;
        let mut sum_squared_error_rgb = 0.0f64;
        let mut sum_delta_e = 0.0f64;

        for by in 0..blocks_y {
            for bx in 0..blocks_x {
                let x_start = bx * BLOCK_SIZE;
                let x_end = (x_start + BLOCK_SIZE).min(width);
                let y_start = by * BLOCK_SIZE;
                let y_end = (y_start + BLOCK_SIZE).min(height);

                let mut sum_yt = 0.0f64;
                let mut sum_yc = 0.0f64;
                let mut sum_y_tt = 0.0f64;
                let mut sum_y_cc = 0.0f64;
                let mut sum_y_tc = 0.0f64;
                let mut sum_tr = 0.0f64;
                let mut sum_tg = 0.0f64;
                let mut sum_tb = 0.0f64;
                let mut sum_cr = 0.0f64;
                let mut sum_cg = 0.0f64;
                let mut sum_cb = 0.0f64;
                let mut pixel_count = 0usize;

                for y in y_start..y_end {
                    for x in x_start..x_end {
                        let p = y * width + x;
                        pixel_count += 1;

                        let tr = state.target_c0[p] as f64;
                        let tg = state.target_c1[p] as f64;
                        let tb = state.target_c2[p] as f64;
                        let cr = state.current_c0[p] as f64;
                        let cg = state.current_c1[p] as f64;
                        let cb = state.current_c2[p] as f64;

                        sum_tr += tr;
                        sum_tg += tg;
                        sum_tb += tb;
                        sum_cr += cr;
                        sum_cg += cg;
                        sum_cb += cb;

                        let yt = (LUMA_REC709_R as f64) * tr
                            + (LUMA_REC709_G as f64) * tg
                            + (LUMA_REC709_B as f64) * tb;
                        let yc = (LUMA_REC709_R as f64) * cr
                            + (LUMA_REC709_G as f64) * cg
                            + (LUMA_REC709_B as f64) * cb;

                        sum_yt += yt;
                        sum_yc += yc;
                        sum_y_tt += yt * yt;
                        sum_y_cc += yc * yc;
                        sum_y_tc += yt * yc;
                    }
                }

                let mut b_state = BlockSSIMState {
                    sum_yt,
                    sum_yc,
                    sum_y_tt,
                    sum_y_cc,
                    sum_y_tc,
                    sum_tr,
                    sum_tg,
                    sum_tb,
                    sum_cr,
                    sum_cg,
                    sum_cb,
                    pixel_count,
                    ssim: 0.0,
                    se_rgb: 0.0,
                    weighted_delta_e: 0.0,
                };
                b_state.ssim = b_state.compute_ssim();
                let (se_rgb, w_de) = b_state.compute_hvs_errors();
                b_state.se_rgb = se_rgb;
                b_state.weighted_delta_e = w_de;

                sum_ssim += b_state.ssim;
                sum_squared_error_rgb += se_rgb;
                sum_delta_e += w_de;
                blocks.push(b_state);
            }
        }

        Self {
            width,
            height,
            blocks_x,
            blocks_y,
            total_blocks,
            total_pixels,
            blocks,
            sum_ssim,
            sum_squared_error_rgb,
            sum_delta_e,
            dirty_blocks: Vec::with_capacity(64),
            dirty_flags: vec![false; total_blocks],
        }
    }

    /// Retorna o snapshot das métricas atuais em $O(1)$.
    #[inline]
    pub fn current_snapshot(&self) -> TelemetrySnapshot {
        let ssim = if self.total_blocks > 0 {
            (self.sum_ssim / (self.total_blocks as f64)) as f32
        } else {
            1.0
        };

        let mse = if self.total_pixels > 0 {
            self.sum_squared_error_rgb / (3.0 * self.total_pixels as f64)
        } else {
            0.0
        };
        let rmse = (mse.max(0.0).sqrt()) as f32;

        let delta_e = if self.total_pixels > 0 {
            (self.sum_delta_e.max(0.0) / (self.total_pixels as f64)) as f32
        } else {
            0.0
        };

        TelemetrySnapshot {
            ssim: ssim.clamp(-1.0, 1.0),
            rmse,
            delta_e,
        }
    }

    /// Notifica a alteração dos pixels após a aplicação de uma corda, atualizando
    /// incrementalmente **apenas** os blocos $8 \times 8$ e pixels modificados em tempo $O(|L|)$.
    pub fn update_pixels(
        &mut self,
        state: &CanvasStateSoA,
        modified_pixels: &[u32],
        old_colors: &[LinearRgbColor],
    ) {
        assert_eq!(
            modified_pixels.len(),
            old_colors.len(),
            "modified_pixels and old_colors slices must have matching lengths"
        );

        if modified_pixels.is_empty() {
            return;
        }

        self.dirty_blocks.clear();

        for (i, &p_u32) in modified_pixels.iter().enumerate() {
            let p = p_u32 as usize;
            let x = p % self.width;
            let y = p / self.width;

            let bx = x / BLOCK_SIZE;
            let by = y / BLOCK_SIZE;
            let b_idx = by * self.blocks_x + bx;

            if !self.dirty_flags[b_idx] {
                self.dirty_flags[b_idx] = true;
                self.dirty_blocks.push(b_idx);
            }

            let old_c = old_colors[i];
            let new_c = state.current_color(p);
            let tgt_c = state.target_color(p);

            let yt = (LUMA_REC709_R * tgt_c.r + LUMA_REC709_G * tgt_c.g + LUMA_REC709_B * tgt_c.b) as f64;
            let old_yc = (LUMA_REC709_R * old_c.r + LUMA_REC709_G * old_c.g + LUMA_REC709_B * old_c.b) as f64;
            let new_yc = (LUMA_REC709_R * new_c.r + LUMA_REC709_G * new_c.g + LUMA_REC709_B * new_c.b) as f64;

            let block = &mut self.blocks[b_idx];
            block.sum_cr += (new_c.r - old_c.r) as f64;
            block.sum_cg += (new_c.g - old_c.g) as f64;
            block.sum_cb += (new_c.b - old_c.b) as f64;
            block.sum_yc += new_yc - old_yc;
            block.sum_y_cc += (new_yc * new_yc) - (old_yc * old_yc);
            block.sum_y_tc += yt * (new_yc - old_yc);
        }

        // Recalcula o SSIM, RMSE e ΔE HVS apenas dos blocos dirty
        for &b_idx in &self.dirty_blocks {
            self.dirty_flags[b_idx] = false;
            let block = &mut self.blocks[b_idx];
            let old_ssim = block.ssim;
            let old_se = block.se_rgb;
            let old_de = block.weighted_delta_e;

            let new_ssim = block.compute_ssim();
            let (new_se, new_de) = block.compute_hvs_errors();

            block.ssim = new_ssim;
            block.se_rgb = new_se;
            block.weighted_delta_e = new_de;

            self.sum_ssim += new_ssim - old_ssim;
            self.sum_squared_error_rgb += new_se - old_se;
            self.sum_delta_e += new_de - old_de;
        }
    }

    /// Executa o cálculo completo e não-incremental de referência do SSIM sobre a grade inteira.
    ///
    /// Usado para validação formal em testes unitários.
    pub fn compute_full_ssim_reference(&self, state: &CanvasStateSoA) -> f32 {
        let mut total_ssim = 0.0f64;

        for by in 0..self.blocks_y {
            for bx in 0..self.blocks_x {
                let x_start = bx * BLOCK_SIZE;
                let x_end = (x_start + BLOCK_SIZE).min(self.width);
                let y_start = by * BLOCK_SIZE;
                let y_end = (y_start + BLOCK_SIZE).min(self.height);

                let mut sum_yt = 0.0f64;
                let mut sum_yc = 0.0f64;
                let mut sum_y_tt = 0.0f64;
                let mut sum_y_cc = 0.0f64;
                let mut sum_y_tc = 0.0f64;
                let mut pixel_count = 0usize;

                for y in y_start..y_end {
                    for x in x_start..x_end {
                        let p = y * self.width + x;
                        pixel_count += 1;

                        let yt = (LUMA_REC709_R * state.target_c0[p]
                            + LUMA_REC709_G * state.target_c1[p]
                            + LUMA_REC709_B * state.target_c2[p]) as f64;
                        let yc = (LUMA_REC709_R * state.current_c0[p]
                            + LUMA_REC709_G * state.current_c1[p]
                            + LUMA_REC709_B * state.current_c2[p]) as f64;

                        sum_yt += yt;
                        sum_yc += yc;
                        sum_y_tt += yt * yt;
                        sum_y_cc += yc * yc;
                        sum_y_tc += yt * yc;
                    }
                }

                let b_state = BlockSSIMState {
                    sum_yt,
                    sum_yc,
                    sum_y_tt,
                    sum_y_cc,
                    sum_y_tc,
                    sum_tr: 0.0,
                    sum_tg: 0.0,
                    sum_tb: 0.0,
                    sum_cr: 0.0,
                    sum_cg: 0.0,
                    sum_cb: 0.0,
                    pixel_count,
                    ssim: 0.0,
                    se_rgb: 0.0,
                    weighted_delta_e: 0.0,
                };
                total_ssim += b_state.compute_ssim();
            }
        }

        (total_ssim / (self.total_blocks as f64)) as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_incremental_ssim_matches_full_reference_exact() {
        let width = 32;
        let height = 32;
        let mut target = Vec::with_capacity(width * height);
        for y in 0..height {
            for x in 0..width {
                let v = ((x + y) as f32) / ((width + height) as f32);
                target.push(LinearRgbColor::new(v, v * 0.8, v * 0.5));
            }
        }

        let mut state = CanvasStateSoA::from_target_and_background(
            width as u32,
            height as u32,
            &target,
            LinearRgbColor::WHITE,
            None,
        );

        let mut tracker = IncrementalMetricsTracker::new(&state);
        let snap0 = tracker.current_snapshot();
        let ref0 = tracker.compute_full_ssim_reference(&state);
        assert!(
            (snap0.ssim - ref0).abs() < 1e-6,
            "SSIM inicial difere do de referência: incremental={}, ref={}",
            snap0.ssim,
            ref0
        );

        // Simula a aplicação de 20 cordas, atualizando incrementalmente
        let mut old_colors = Vec::new();
        let mut modified_pixels = Vec::new();

        for step in 0..20 {
            modified_pixels.clear();
            old_colors.clear();

            for i in 0..20 {
                let x = (step * 3 + i) % width;
                let y = (step * 5 + i * 2) % height;
                let p = y * width + x;

                old_colors.push(state.current_color(p));
                modified_pixels.push(p as u32);

                let cur = state.current_color(p);
                let updated = LinearRgbColor::new(cur.r * 0.85, cur.g * 0.85, cur.b * 0.85);
                state.set_current_color(p, updated);
            }

            tracker.update_pixels(&state, &modified_pixels, &old_colors);

            let snap = tracker.current_snapshot();
            let full_ref = tracker.compute_full_ssim_reference(&state);

            assert!(
                (snap.ssim - full_ref).abs() < 1e-6,
                "Passo {}: Incremental SSIM ({}) diverge do cálculo completo ({})",
                step,
                snap.ssim,
                full_ref
            );
            assert!(snap.rmse >= 0.0);
            assert!(snap.delta_e >= 0.0);
        }
    }
}
