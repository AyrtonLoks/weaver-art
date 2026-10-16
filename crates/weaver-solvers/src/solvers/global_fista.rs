//! Otimização Global Contínua NNLS/FISTA + Roteamento Euleriano (`solvers/global_fista.rs`).
//!
//! Formule o problema global:
//! $$\min_{w \ge 0} \frac{1}{2} \|Aw - b\|_2^2 + \lambda_1 \|w\|_1$$
//! para cada canal/cor usando o algoritmo **FISTA (*Fast Iterative Shrinkage-Thresholding Algorithm*)
//! Livre de Matriz (*Matrix-Free*)**.
//!
//! - O operador direto $A w$ (projeção de cordas para imagem) e o operador adjunto $A^T r$
//!   (retroprojeção do resíduo para o espaço de cordas/Radon) operam diretamente sobre a `SparseChordMatrixCSR`,
//!   sem jamais instanciar uma matriz densa!
//! - Após a convergência do vetor de pesos contínuos $w \in \mathbb{R}_+^M$, quantiza os pesos para contagens
//!   inteiras de fios e executa um **Roteador de Caminho Contínuo (Hierholzer / Nearest-Neighbor Eulerian Stitching)**
//!   que conecta todas as cordas ativas em uma sequência contínua de pinos $(p_1, p_2, \dots, p_K)$.
//! - As cores são intercaladas em sub-camadas de Pintor (*Painter's Algorithm*) para evitar que a última cor
//!   domine fisicamente a obra.

use weaver_domain::{LinearRgbColor, PegSide, SparseChordMatrixCSR};

use crate::optical_models::{OpticalModelEvaluator, SpoolColor};
use crate::spool_scheduler::SpoolScheduler;
use crate::state_matrix::CanvasStateSoA;
use crate::telemetry_metrics::IncrementalMetricsTracker;

/// Configuração do Solver Global FISTA + Roteamento Euleriano.
#[derive(Debug, Clone, PartialEq)]
pub struct GlobalFistaConfig {
    /// Quantidade máxima de passos/linhas no projeto.
    pub max_steps: usize,
    /// Quantidade máxima de repetições por par de pinos.
    pub max_chord_repeats: usize,
    /// Número de iterações do algoritmo FISTA (padrão: 50 a 100).
    pub fista_iterations: usize,
    /// Parâmetro de regularização $\ell_1$ (sparsity / LASSO penalization).
    pub l1_regularization_lambda: f32,
    /// Quantidade de sub-camadas de Pintor (*Painter's layers*) por cor (padrão: 3).
    pub painter_layers_per_color: usize,
    /// Pino inicial de tecelagem.
    pub start_pin: usize,
}

impl Default for GlobalFistaConfig {
    fn default() -> Self {
        Self {
            max_steps: 3000,
            max_chord_repeats: 2,
            fista_iterations: 60,
            l1_regularization_lambda: 0.05,
            painter_layers_per_color: 3,
            start_pin: 0,
        }
    }
}

/// Registro de um passo agendado pelo roteador FISTA.
#[derive(Debug, Clone, PartialEq)]
pub struct FistaStepRecord {
    pub from_pin: u16,
    pub to_pin: u16,
    pub spool_id: u8,
    pub departure_winding: PegSide,
    pub arrival_winding: PegSide,
    pub gain: f32,
    pub score_normalized: u16,
}

/// Distância perimétrica circular entre dois pinos em um tear com $N$ pinos.
#[inline]
fn circular_pin_dist(a: usize, b: usize, pin_count: usize) -> usize {
    let diff = (a as isize - b as isize).unsigned_abs();
    diff.min(pin_count.saturating_sub(diff))
}

/// Operador direto matriz-livre $A w$: mapeia do espaço de cordas para o espaço de pixels
/// lendo diretamente a `SparseChordMatrixCSR` sem alocações.
pub fn matrix_free_forward(
    matrix: &SparseChordMatrixCSR,
    weights: &[f32],
    out_image: &mut [f32],
) {
    out_image.fill(0.0);
    let chord_count = matrix.chord_count();
    for k in 0..chord_count {
        let w = weights[k];
        if w > 1e-7 {
            let (pixels, sub_weights) = matrix.chord_slice(k);
            for (&p, &wt) in pixels.iter().zip(sub_weights.iter()) {
                out_image[p as usize] += w * ((wt as f32) * (1.0 / 255.0));
            }
        }
    }
}

/// Operador adjunto matriz-livre $A^T r$: retroprojeção (Radon discreto) do resíduo de imagem
/// para o espaço de cordas lendo diretamente a `SparseChordMatrixCSR` sem alocações.
pub fn matrix_free_adjoint(
    matrix: &SparseChordMatrixCSR,
    residual: &[f32],
    out_grad: &mut [f32],
) {
    let chord_count = matrix.chord_count();
    for k in 0..chord_count {
        let (pixels, sub_weights) = matrix.chord_slice(k);
        if pixels.is_empty() {
            out_grad[k] = 0.0;
            continue;
        }
        let mut sum = 0.0f32;
        for (&p, &wt) in pixels.iter().zip(sub_weights.iter()) {
            sum += residual[p as usize] * ((wt as f32) * (1.0 / 255.0));
        }
        out_grad[k] = sum;
    }
}

/// Estima o raio espectral / constante de Lipschitz $L = \|A^T A\|_2$
/// através de 5 iterações do método das potências sobre a CSR.
pub fn estimate_lipschitz_constant(
    matrix: &SparseChordMatrixCSR,
    num_pixels: usize,
    iterations: usize,
) -> f32 {
    let chord_count = matrix.chord_count();
    if chord_count == 0 {
        return 1.0;
    }
    let mut v = vec![1.0f32 / (chord_count as f32).sqrt(); chord_count];
    let mut img_buf = vec![0.0f32; num_pixels];
    let mut v_next = vec![0.0f32; chord_count];

    let mut norm = 1.0f32;
    for _ in 0..iterations.max(3) {
        matrix_free_forward(matrix, &v, &mut img_buf);
        matrix_free_adjoint(matrix, &img_buf, &mut v_next);

        let sum_sq: f32 = v_next.iter().map(|&x| x * x).sum();
        norm = sum_sq.sqrt().max(1e-6);
        let inv_norm = 1.0 / norm;
        for i in 0..chord_count {
            v[i] = v_next[i] * inv_norm;
        }
    }

    // Margem de segurança de 10% para garantir convergência monotônica estrita
    norm * 1.10
}

/// Computa o vetor de densidade alvo $b \ge 0$ para um carretel específico a partir do canvas.
pub fn compute_target_density(
    canvas: &CanvasStateSoA,
    spool: &SpoolColor,
    out_b: &mut [f32],
) {
    let num_pixels = canvas.num_pixels;
    out_b[..num_pixels].fill(0.0);

    let abs_r = (1.0 - spool.color.r).max(0.0);
    let abs_g = (1.0 - spool.color.g).max(0.0);
    let abs_b = (1.0 - spool.color.b).max(0.0);
    let spool_strength = (abs_r * abs_r + abs_g * abs_g + abs_b * abs_b).sqrt().max(1e-4);

    for p in 0..num_pixels {
        let imp = canvas.importance_w[p];
        if imp <= 0.0 {
            continue;
        }
        let target_abs_r = (1.0 - canvas.target_c0[p]).max(0.0);
        let target_abs_g = (1.0 - canvas.target_c1[p]).max(0.0);
        let target_abs_b = (1.0 - canvas.target_c2[p]).max(0.0);

        let proj = (target_abs_r * abs_r + target_abs_g * abs_g + target_abs_b * abs_b) / spool_strength;
        out_b[p] = (proj.max(0.0) * imp).clamp(0.0, 10.0);
    }
}

/// Executa a otimização global contínua FISTA com projeção não-negativa e penalidade $\ell_1$.
pub fn solve_fista_channel(
    matrix: &SparseChordMatrixCSR,
    target_density_b: &[f32],
    iterations: usize,
    lambda1: f32,
    lipschitz_l: f32,
    num_pixels: usize,
    out_weights: &mut [f32],
) {
    let chord_count = matrix.chord_count();
    let tau = 1.0 / lipschitz_l.max(1e-4);

    let mut w = vec![0.0f32; chord_count];
    let mut w_prev = vec![0.0f32; chord_count];
    let mut y = vec![0.0f32; chord_count];
    let mut residual = vec![0.0f32; num_pixels];
    let mut grad = vec![0.0f32; chord_count];

    let mut t = 1.0f32;

    for _ in 0..iterations {
        // 1. Resíduo r = A y - b
        matrix_free_forward(matrix, &y, &mut residual);
        for p in 0..num_pixels {
            residual[p] -= target_density_b[p];
        }

        // 2. Gradiente g = A^T r
        matrix_free_adjoint(matrix, &residual, &mut grad);

        // 3. Passo proximal não-negativo com penalidade L1 (soft-thresholding)
        let threshold = tau * lambda1;
        for k in 0..chord_count {
            let step_val = y[k] - tau * grad[k];
            w[k] = (step_val - threshold).max(0.0);
        }

        // 4. Momentum de aceleração de Nesterov (FISTA)
        let t_next = (1.0 + (1.0 + 4.0 * t * t).sqrt()) * 0.5;
        let beta = (t - 1.0) / t_next;
        for k in 0..chord_count {
            y[k] = (w[k] + beta * (w[k] - w_prev[k])).max(0.0);
        }

        t = t_next;
        w_prev.copy_from_slice(&w);
    }

    out_weights[..chord_count].copy_from_slice(&w);
}

/// Quantiza os pesos contínuos para contagens discretas de fios utilizando o método dos maiores restos.
pub fn quantize_chord_weights(
    continuous_weights: &[f32],
    target_lines: usize,
    max_chord_repeats: usize,
) -> Vec<u16> {
    let chord_count = continuous_weights.len();
    let sum_w: f32 = continuous_weights.iter().sum();
    if sum_w <= 1e-6 || target_lines == 0 {
        return vec![0; chord_count];
    }

    let scale = (target_lines as f32) / sum_w;
    let mut counts = vec![0u16; chord_count];
    let mut remainders: Vec<(usize, f32)> = Vec::with_capacity(chord_count);
    let mut assigned = 0usize;

    for k in 0..chord_count {
        let scaled = continuous_weights[k] * scale;
        let floor_val = (scaled.floor() as usize).min(max_chord_repeats);
        counts[k] = floor_val as u16;
        assigned += floor_val;
        remainders.push((k, scaled - scaled.floor()));
    }

    if assigned < target_lines {
        remainders.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let to_fill = target_lines - assigned;
        let mut filled = 0;
        for &(k, _) in &remainders {
            if filled >= to_fill {
                break;
            }
            if (counts[k] as usize) < max_chord_repeats {
                counts[k] += 1;
                filled += 1;
            }
        }
    }

    counts
}

/// Roteador de Caminho Contínuo (Hierholzer / Nearest-Neighbor Eulerian Stitching):
/// Conecta o conjunto de cordas ativas em uma sequência ininterrupta de pinos $(p_0, p_1, \dots, p_K)$.
pub fn route_eulerian_continuous_path(
    matrix: &SparseChordMatrixCSR,
    mut chord_counts: Vec<u16>,
    start_pin: usize,
) -> Vec<(usize, usize, usize)> {
    let pin_count = matrix.pin_count;
    let total_chords: usize = chord_counts.iter().map(|&c| c as usize).sum();
    if total_chords == 0 {
        return Vec::new();
    }

    let mut path = Vec::with_capacity(total_chords);
    let mut cur_pin = start_pin;
    let mut remaining = total_chords;

    while remaining > 0 {
        // 1. Procura corda ativa incidente ao pino atual
        let mut best_next: Option<(usize, usize, u16)> = None;

        for next_pin in 0..pin_count {
            if next_pin == cur_pin {
                continue;
            }
            if let Some(chord_idx) =
                SparseChordMatrixCSR::try_canonical_chord_index(cur_pin, next_pin, pin_count)
            {
                let count = chord_counts[chord_idx];
                if count > 0 {
                    let is_better = match best_next {
                        None => true,
                        Some((best_p, _, best_c)) => {
                            if count > best_c {
                                true
                            } else if count == best_c {
                                next_pin < best_p
                            } else {
                                false
                            }
                        }
                    };
                    if is_better {
                        best_next = Some((next_pin, chord_idx, count));
                    }
                }
            }
        }

        if let Some((next_pin, chord_idx, _)) = best_next {
            chord_counts[chord_idx] -= 1;
            remaining -= 1;
            path.push((cur_pin, next_pin, chord_idx));
            cur_pin = next_pin;
        } else {
            // 2. Nenhum acorde incidente: conecta ao pino ativo mais próximo
            let mut nearest_target: Option<usize> = None;
            let mut min_dist = usize::MAX;

            for k in 0..matrix.chord_count() {
                if chord_counts[k] > 0 {
                    let (u, v) = SparseChordMatrixCSR::canonical_chord_pins(k, pin_count);
                    for p_cand in [u, v] {
                        let dist = circular_pin_dist(cur_pin, p_cand, pin_count);
                        if dist < min_dist
                            || (dist == min_dist && p_cand < nearest_target.unwrap_or(usize::MAX))
                        {
                            min_dist = dist;
                            nearest_target = Some(p_cand);
                        }
                    }
                }
            }

            match nearest_target {
                Some(target_pin) => {
                    if target_pin != cur_pin {
                        if let Some(bridge_k) = SparseChordMatrixCSR::try_canonical_chord_index(
                            cur_pin, target_pin, pin_count,
                        ) {
                            path.push((cur_pin, target_pin, bridge_k));
                        }
                        cur_pin = target_pin;
                    } else {
                        break;
                    }
                }
                None => break,
            }
        }
    }

    path
}

/// Passo planejado na fila de execução do Global FISTA.
#[derive(Debug, Clone, Copy, PartialEq)]
struct ScheduledStep {
    from_pin: usize,
    to_pin: usize,
    spool_id: u8,
    chord_idx: usize,
}

/// Solver Global FISTA com roteamento Euleriano contínuo e sub-camadas de Pintor.
pub struct GlobalFistaSolver {
    pub config: GlobalFistaConfig,
    pub current_pin: usize,
    pub step_count: usize,
    scheduled_steps: Vec<ScheduledStep>,
    old_colors_buf: Vec<LinearRgbColor>,
}

impl GlobalFistaSolver {
    /// Inicializa e planeja o percurso global contínuo via FISTA e Roteamento Euleriano.
    pub fn new(
        config: GlobalFistaConfig,
        canvas: &CanvasStateSoA,
        matrix: &SparseChordMatrixCSR,
        spools: &[SpoolColor],
    ) -> Self {
        let current_pin = config.start_pin;
        let mut solver = Self {
            config,
            current_pin,
            step_count: 0,
            scheduled_steps: Vec::new(),
            old_colors_buf: Vec::with_capacity(1024),
        };

        solver.plan_all_paths(canvas, matrix, spools);
        solver
    }

    /// Reinicia o solver.
    pub fn reset(&mut self, start_pin: usize) {
        self.current_pin = start_pin;
        self.step_count = 0;
        self.scheduled_steps.clear();
        self.old_colors_buf.clear();
    }

    /// Executa o planejamento global com FISTA, quantização e sub-camadas de Pintor.
    fn plan_all_paths(
        &mut self,
        canvas: &CanvasStateSoA,
        matrix: &SparseChordMatrixCSR,
        spools: &[SpoolColor],
    ) {
        let num_pixels = canvas.num_pixels;
        let chord_count = matrix.chord_count();
        if spools.is_empty() || chord_count == 0 {
            return;
        }

        let lipschitz_l = estimate_lipschitz_constant(matrix, num_pixels, 5);
        let num_spools = spools.len();
        let lines_per_spool = self.config.max_steps / num_spools;

        let mut color_paths: Vec<(u8, Vec<(usize, usize, usize)>)> = Vec::with_capacity(num_spools);
        let mut b_buffer = vec![0.0f32; num_pixels];
        let mut w_buffer = vec![0.0f32; chord_count];

        for spool in spools {
            compute_target_density(canvas, spool, &mut b_buffer);
            solve_fista_channel(
                matrix,
                &b_buffer,
                self.config.fista_iterations,
                self.config.l1_regularization_lambda,
                lipschitz_l,
                num_pixels,
                &mut w_buffer,
            );

            let counts = quantize_chord_weights(
                &w_buffer,
                lines_per_spool,
                self.config.max_chord_repeats,
            );

            let path = route_eulerian_continuous_path(matrix, counts, self.current_pin);
            color_paths.push((spool.id, path));
        }

        // Intercala em sub-camadas de Pintor (*Painter's Algorithm*)
        let num_layers = self.config.painter_layers_per_color.max(1);
        self.scheduled_steps.clear();

        for layer in 0..num_layers {
            for (spool_id, path) in &color_paths {
                let total = path.len();
                if total == 0 {
                    continue;
                }
                let start_idx = (layer * total) / num_layers;
                let end_idx = ((layer + 1) * total) / num_layers;

                for i in start_idx..end_idx {
                    let (from, to, chord_idx) = path[i];
                    self.scheduled_steps.push(ScheduledStep {
                        from_pin: from,
                        to_pin: to,
                        spool_id: *spool_id,
                        chord_idx,
                    });
                }
            }
        }
    }

    /// Executa um passo do percurso planejado pelo Global FISTA.
    pub fn step(
        &mut self,
        canvas: &mut CanvasStateSoA,
        tracker: &mut IncrementalMetricsTracker,
        scheduler: &mut SpoolScheduler,
        matrix: &SparseChordMatrixCSR,
        evaluator: &OpticalModelEvaluator,
        spools: &[SpoolColor],
        alpha_eff: f32,
    ) -> Option<FistaStepRecord> {
        if self.step_count >= self.scheduled_steps.len() {
            return None;
        }

        let scheduled = self.scheduled_steps[self.step_count];
        let (pixel_indices, subpixel_weights) = matrix.chord_slice(scheduled.chord_idx);
        let spool = spools
            .iter()
            .find(|s| s.id == scheduled.spool_id)
            .expect("Spool must exist");

        // Calcula o ganho marginal para telemetria
        let raw_gain = evaluator.chord_marginal_gain(
            canvas,
            pixel_indices,
            subpixel_weights,
            spool,
            alpha_eff,
        );

        // Coleta cores antigas para atualização incremental em O(|L|)
        self.old_colors_buf.clear();
        for &p in pixel_indices {
            self.old_colors_buf.push(canvas.current_color(p as usize));
        }

        // Aplica a corda
        evaluator.apply_chord(canvas, pixel_indices, subpixel_weights, spool, alpha_eff);

        // Atualiza telemetria incremental
        tracker.update_pixels(canvas, pixel_indices, &self.old_colors_buf);

        // Avança scheduler
        scheduler.advance_step(spool.id, spools);
        let boost = scheduler.active_edge_boost();
        if boost > 0.0 {
            canvas.apply_edge_importance_boost(boost);
        }

        self.current_pin = scheduled.to_pin;
        self.step_count += 1;

        let score_norm = ((raw_gain.max(0.0) / (raw_gain.max(0.0) + 1.0)) * 65535.0).clamp(0.0, 65535.0) as u16;

        Some(FistaStepRecord {
            from_pin: scheduled.from_pin as u16,
            to_pin: scheduled.to_pin as u16,
            spool_id: scheduled.spool_id,
            departure_winding: PegSide::Clockwise,
            arrival_winding: PegSide::Clockwise,
            gain: raw_gain,
            score_normalized: score_norm,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use weaver_domain::{
        ColorErrorMetric, LinearRgbColor, LoomGeometry, LoomPhysicalSpec, Pixels,
        RasterizerType,
    };
    use crate::optical_models::OpticalMixModelType;
    use crate::spool_scheduler::SpoolSwitchStrategy;

    fn setup_fista_test(
        pin_count: usize,
        res: u32,
    ) -> (
        SparseChordMatrixCSR,
        CanvasStateSoA,
        IncrementalMetricsTracker,
        OpticalModelEvaluator,
        SpoolScheduler,
        Vec<SpoolColor>,
    ) {
        let spec = LoomPhysicalSpec::circle(
            200.0,
            pin_count,
            2.0,
            1.5,
            10.0,
        );
        let loom = LoomGeometry::new(spec);
        let matrix = SparseChordMatrixCSR::build(&loom, Pixels(res), 3, RasterizerType::BresenhamBinary);

        let bg = LinearRgbColor::WHITE;
        let mut target = vec![bg; (res * res) as usize];
        let center = (res as f32 - 1.0) * 0.5;
        let radius = res as f32 * 0.35;
        for y in 0..res {
            for x in 0..res {
                let dx = x as f32 - center;
                let dy = y as f32 - center;
                if (dx * dx + dy * dy).sqrt() <= radius {
                    target[(y * res + x) as usize] = LinearRgbColor::new(0.1, 0.1, 0.1);
                }
            }
        }

        let canvas = CanvasStateSoA::from_target_and_background(res, res, &target, bg, None);
        let tracker = IncrementalMetricsTracker::new(&canvas);
        let evaluator = OpticalModelEvaluator::new(
            OpticalMixModelType::PorterDuffOcclusion,
            ColorErrorMetric::LinearRgb,
        );
        let scheduler = SpoolScheduler::new(SpoolSwitchStrategy::FreeGreedy, 100, 0);
        let spools = vec![SpoolColor::new(0, LinearRgbColor::BLACK, 0.3)];

        (matrix, canvas, tracker, evaluator, scheduler, spools)
    }

    #[test]
    fn test_matrix_free_operators_consistency() {
        let (matrix, canvas, _, _, _, _) = setup_fista_test(16, 32);
        let chord_count = matrix.chord_count();
        let num_pixels = canvas.num_pixels;

        let test_chord = (0..chord_count)
            .find(|&k| matrix.chord_len(k) > 0)
            .expect("Deve haver pelo menos uma corda não vazia");

        let mut w = vec![0.0f32; chord_count];
        w[test_chord] = 1.0;
        let mut img = vec![0.0f32; num_pixels];

        matrix_free_forward(&matrix, &w, &mut img);
        let active_pixels = img.iter().filter(|&&v| v > 0.0).count();
        assert!(active_pixels > 0, "Forward projection deve ativar pixels");

        let mut grad = vec![0.0f32; chord_count];
        matrix_free_adjoint(&matrix, &img, &mut grad);
        assert!(grad[test_chord] > 0.0, "Retroprojeção deve ter ganho positivo na corda testada");
    }

    #[test]
    fn test_fista_solver_end_to_end_improvement() {
        let (matrix, mut canvas, mut tracker, evaluator, mut scheduler, spools) =
            setup_fista_test(24, 48);

        let config = GlobalFistaConfig {
            max_steps: 20,
            max_chord_repeats: 2,
            fista_iterations: 30,
            l1_regularization_lambda: 0.02,
            painter_layers_per_color: 2,
            start_pin: 0,
        };

        let mut solver = GlobalFistaSolver::new(config, &canvas, &matrix, &spools);
        let initial_metrics = tracker.current_snapshot();

        let mut executed = 0;
        for _ in 0..15 {
            if let Some(_) = solver.step(
                &mut canvas,
                &mut tracker,
                &mut scheduler,
                &matrix,
                &evaluator,
                &spools,
                0.2,
            ) {
                executed += 1;
            } else {
                break;
            }
        }

        assert!(executed >= 5, "Deve executar passos planejados pelo FISTA");
        let final_metrics = tracker.current_snapshot();
        assert!(final_metrics.delta_e < initial_metrics.delta_e);
        assert!(final_metrics.rmse < initial_metrics.rmse);
    }
}
