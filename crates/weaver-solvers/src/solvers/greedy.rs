//! Algoritmo Guloso Iterativo de String Art (`solvers/greedy.rs`).
//!
//! A partir do pino atual $p_{\text{atual}}$ e para cada cor permitida pelo `SpoolScheduler`,
//! avalia todos os pinos candidatos $p_{\text{prox}}$ lendo fatias contíguas da `SparseChordMatrixCSR`.
//!
//! Normaliza o score pelo comprimento da corda:
//! $$\text{Score}(L, k) = \frac{1}{|L|^\gamma} \sum_{p \in L} \text{Ganho}(p, k) - \text{PenalidadeTroca}(k)$$
//!
//! Garante desempate estritamente determinístico pelo menor índice de pino e menor índice de carretel (RNF-02).
//! Mantém histórico recente (Tabu list) e controle de repetições máximas por par de pinos.

use weaver_domain::{LinearRgbColor, PegSide, SparseChordMatrixCSR};

use crate::optical_models::{OpticalModelEvaluator, SpoolColor};
use crate::spool_scheduler::SpoolScheduler;
use crate::state_matrix::CanvasStateSoA;
use crate::telemetry_metrics::IncrementalMetricsTracker;

/// Configuração do Algoritmo Guloso Iterativo.
#[derive(Debug, Clone, PartialEq)]
pub struct GreedyConfig {
    /// Quantidade máxima de passos/linhas a tecer.
    pub max_steps: usize,
    /// Quantidade máxima de vezes que o mesmo par canônico de pinos $(a, b)$ pode ser tecido.
    pub max_chord_repeats: usize,
    /// Expoente $\gamma$ de penalização/normalização de comprimento ($1 / |L|^\gamma$).
    /// Se 0.0, não normaliza por comprimento (ganho bruto). Padrão: 1.0 (ganho por pixel médio).
    pub length_exponent_gamma: f32,
    /// Pino inicial de tecelagem (0..N-1).
    pub start_pin: usize,
    /// Tamanho do histórico Tabu recente para evitar ciclos ou vaivém imediato (0 desativa).
    pub tabu_history_size: usize,
}

impl Default for GreedyConfig {
    fn default() -> Self {
        Self {
            max_steps: 3000,
            max_chord_repeats: 2,
            length_exponent_gamma: 1.0,
            start_pin: 0,
            tabu_history_size: 0,
        }
    }
}

/// Candidato avaliado pelo solver guloso.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GreedyChordCandidate {
    pub from_pin: usize,
    pub to_pin: usize,
    pub spool_id: u8,
    pub chord_idx: usize,
    pub raw_gain: f32,
    pub score: f32,
}

/// Registro do passo de tecelagem gerado.
#[derive(Debug, Clone, PartialEq)]
pub struct GreedyStepRecord {
    pub from_pin: u16,
    pub to_pin: u16,
    pub spool_id: u8,
    pub departure_winding: PegSide,
    pub arrival_winding: PegSide,
    pub gain: f32,
    pub score_normalized: u16,
}

/// Motor de otimização Iterative Greedy com zero alocações na heap no laço interno.
pub struct GreedySolver {
    pub config: GreedyConfig,
    pub current_pin: usize,
    pub step_count: usize,
    chord_usage: Vec<u16>,
    tabu_queue: Vec<usize>,
    old_colors_buf: Vec<LinearRgbColor>,
}

impl GreedySolver {
    /// Inicializa um novo solver guloso com buffers pré-alocados para a matriz CSR dada.
    pub fn new(config: GreedyConfig, chord_count: usize) -> Self {
        let current_pin = config.start_pin;
        let tabu_cap = config.tabu_history_size;
        Self {
            config,
            current_pin,
            step_count: 0,
            chord_usage: vec![0; chord_count],
            tabu_queue: Vec::with_capacity(tabu_cap),
            old_colors_buf: Vec::with_capacity(1024),
        }
    }

    /// Reinicia o solver mantendo a memória alocada nos buffers.
    pub fn reset(&mut self, start_pin: usize) {
        self.current_pin = start_pin;
        self.step_count = 0;
        self.chord_usage.fill(0);
        self.tabu_queue.clear();
        self.old_colors_buf.clear();
    }

    /// Retorna o número de vezes que a corda de índice canônico $k$ foi utilizada.
    #[inline]
    pub fn chord_usage(&self, chord_idx: usize) -> u16 {
        self.chord_usage.get(chord_idx).copied().unwrap_or(0)
    }

    /// Retorna uma referência imutável a todo o vetor de contagem de uso de cordas.
    #[inline]
    pub fn all_chord_usages(&self) -> &[u16] {
        &self.chord_usage
    }

    /// Verifica se um pino está na lista Tabu recente.
    #[inline]
    pub fn is_tabu(&self, pin: usize) -> bool {
        self.tabu_queue.contains(&pin)
    }

    /// Registra um pino na fila Tabu FIFO.
    fn push_tabu(&mut self, pin: usize) {
        if self.config.tabu_history_size == 0 {
            return;
        }
        if self.tabu_queue.len() >= self.config.tabu_history_size {
            self.tabu_queue.remove(0);
        }
        self.tabu_queue.push(pin);
    }

    /// Avalia todos os pinos candidatos $p_{\text{prox}}$ a partir de `current_pin`
    /// para cada carretel permitido pelo `SpoolScheduler` e seleciona o melhor acorde.
    ///
    /// Aplica desempate estritamente determinístico:
    /// - Maior score;
    /// - Em caso de empate: menor índice de pino `to_pin`;
    /// - Em caso de novo empate: menor índice `spool_id`.
    pub fn find_best_chord(
        &self,
        canvas: &CanvasStateSoA,
        matrix: &SparseChordMatrixCSR,
        evaluator: &OpticalModelEvaluator,
        scheduler: &SpoolScheduler,
        spools: &[SpoolColor],
        alpha_eff: f32,
    ) -> Option<GreedyChordCandidate> {
        let pin_count = matrix.pin_count;
        if pin_count < 2 {
            return None;
        }

        let allowed_spool_ids = scheduler.allowed_spools(spools);
        if allowed_spool_ids.is_empty() {
            return None;
        }

        let mut best: Option<GreedyChordCandidate> = None;
        let gamma = self.config.length_exponent_gamma;
        let max_repeats = self.config.max_chord_repeats;

        for next_pin in 0..pin_count {
            if next_pin == self.current_pin {
                continue;
            }

            if self.is_tabu(next_pin) {
                continue;
            }

            let chord_idx = match SparseChordMatrixCSR::try_canonical_chord_index(
                self.current_pin,
                next_pin,
                pin_count,
            ) {
                Some(idx) => idx,
                None => continue,
            };

            if (self.chord_usage[chord_idx] as usize) >= max_repeats {
                continue;
            }

            let (pixel_indices, subpixel_weights) = matrix.chord_slice(chord_idx);
            if pixel_indices.is_empty() {
                continue;
            }

            // Usa a integral de cobertura sub-pixel real da corda em vez de pixel_indices.len(),
            // eliminando o viés geométrico de 41% entre linhas verticais e diagonais em Xiaolin Wu!
            let weight_sum: u32 = subpixel_weights.iter().map(|&w| w as u32).sum();
            let chord_len = ((weight_sum as f32) * (1.0 / 255.0)).max(1.0);
            let len_factor = if gamma == 1.0 {
                chord_len
            } else if gamma == 0.0 {
                1.0
            } else {
                chord_len.powf(gamma).max(1e-5)
            };

            for &spool_id in &allowed_spool_ids {
                let spool = match spools.iter().find(|s| s.id == spool_id) {
                    Some(s) => s,
                    None => continue,
                };

                let raw_gain = evaluator.chord_marginal_gain(
                    canvas,
                    pixel_indices,
                    subpixel_weights,
                    spool,
                    alpha_eff,
                );

                // Apenas cordas que efetivamente reduzem o erro óptico são candidatas válidas
                if raw_gain <= 0.0 {
                    continue;
                }

                let penalty = scheduler.switch_penalty(spool.id);
                let score = (raw_gain / len_factor) - penalty;

                if score <= 0.0 {
                    continue;
                }

                let is_better = match &best {
                    None => true,
                    Some(b) => {
                        if score > b.score {
                            true
                        } else if (score - b.score).abs() <= 1e-7 {
                            // Desempate determinístico (RNF-02)
                            if next_pin < b.to_pin {
                                true
                            } else if next_pin == b.to_pin {
                                spool.id < b.spool_id
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    }
                };

                if is_better {
                    best = Some(GreedyChordCandidate {
                        from_pin: self.current_pin,
                        to_pin: next_pin,
                        spool_id: spool.id,
                        chord_idx,
                        raw_gain,
                        score,
                    });
                }
            }
        }

        best
    }

    /// Executa um único passo de tecelagem gulosa:
    /// 1. Seleciona a melhor corda candidata determinística;
    /// 2. Salva as cores antigas no buffer reusável sem alocações;
    /// 3. Aplica a corda sobre `canvas`;
    /// 4. Atualiza incrementalmente o `tracker` em tempo $O(|L|)$;
    /// 5. Avança o `scheduler` e aplica reforço dinâmico de bordas se necessário;
    /// 6. Atualiza uso de cordas, pino atual e fila tabu;
    /// 7. Retorna o registro do passo.
    pub fn step(
        &mut self,
        canvas: &mut CanvasStateSoA,
        tracker: &mut IncrementalMetricsTracker,
        scheduler: &mut SpoolScheduler,
        matrix: &SparseChordMatrixCSR,
        evaluator: &OpticalModelEvaluator,
        spools: &[SpoolColor],
        alpha_eff: f32,
    ) -> Option<GreedyStepRecord> {
        let candidate = self.find_best_chord(canvas, matrix, evaluator, scheduler, spools, alpha_eff)?;

        let (pixel_indices, subpixel_weights) = matrix.chord_slice(candidate.chord_idx);
        let spool = spools
            .iter()
            .find(|s| s.id == candidate.spool_id)
            .expect("Spool must exist");

        // 1. Coleta cores antigas para atualização incremental de telemetria O(|L|)
        self.old_colors_buf.clear();
        for &p in pixel_indices {
            self.old_colors_buf.push(canvas.current_color(p as usize));
        }

        // 2. Aplica a corda in-place no CanvasStateSoA
        evaluator.apply_chord(canvas, pixel_indices, subpixel_weights, spool, alpha_eff);

        // 3. Notifica o tracker incremental
        tracker.update_pixels(canvas, pixel_indices, &self.old_colors_buf);

        // 4. Avança o agendador de carretéis
        scheduler.advance_step(spool.id, spools);
        // Aplica o boost de bordas apenas UMA única vez na transição de época (evita 250.000 cópias por linha!)
        if self.step_count % 250 == 0 {
            let edge_boost = scheduler.active_edge_boost();
            if edge_boost > 0.0 {
                canvas.apply_edge_importance_boost(edge_boost);
            }
        }

        // 5. Atualiza estado do solver
        self.chord_usage[candidate.chord_idx] += 1;
        let from = self.current_pin;
        let to = candidate.to_pin;
        self.push_tabu(from);
        self.current_pin = to;
        self.step_count += 1;

        let score_norm = ((candidate.score.max(0.0) / (candidate.score.max(0.0) + 1.0)) * 65535.0)
            .clamp(0.0, 65535.0) as u16;

        Some(GreedyStepRecord {
            from_pin: from as u16,
            to_pin: to as u16,
            spool_id: candidate.spool_id,
            departure_winding: PegSide::Clockwise,
            arrival_winding: PegSide::Clockwise,
            gain: candidate.raw_gain,
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

    fn setup_test_environment(
        pin_count: usize,
        res: u32,
    ) -> (
        LoomGeometry,
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

        // Canvas com fundo branco e alvo com círculo escuro no centro
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

        (loom, matrix, canvas, tracker, evaluator, scheduler, spools)
    }

    #[test]
    fn test_greedy_solver_monotonic_improvement() {
        let (_loom, matrix, mut canvas, mut tracker, evaluator, mut scheduler, spools) =
            setup_test_environment(32, 64);

        let config = GreedyConfig {
            max_steps: 20,
            max_chord_repeats: 2,
            length_exponent_gamma: 1.0,
            start_pin: 0,
            tabu_history_size: 0,
        };

        let mut solver = GreedySolver::new(config, matrix.chord_count());
        let initial_metrics = tracker.current_snapshot();

        let mut steps_taken = 0;
        for _ in 0..15 {
            if let Some(step) = solver.step(
                &mut canvas,
                &mut tracker,
                &mut scheduler,
                &matrix,
                &evaluator,
                &spools,
                0.2,
            ) {
                assert!(step.gain > 0.0, "Ganho deve ser estritamente positivo");
                steps_taken += 1;
            } else {
                break;
            }
        }

        assert!(steps_taken >= 10, "Deve executar pelo menos 10 passos");
        let final_metrics = tracker.current_snapshot();
        assert!(
            final_metrics.delta_e < initial_metrics.delta_e,
            "DeltaE deve diminuir: inicial {} vs final {}",
            initial_metrics.delta_e,
            final_metrics.delta_e
        );
        assert!(
            final_metrics.rmse < initial_metrics.rmse,
            "RMSE deve diminuir: inicial {} vs final {}",
            initial_metrics.rmse,
            final_metrics.rmse
        );
    }

    #[test]
    fn test_greedy_tie_breaking_determinism() {
        let (_loom, matrix, canvas, _tracker, evaluator, scheduler, spools) =
            setup_test_environment(16, 40);

        let config = GreedyConfig {
            max_steps: 10,
            max_chord_repeats: 1,
            length_exponent_gamma: 1.0,
            start_pin: 0,
            tabu_history_size: 0,
        };

        let solver1 = GreedySolver::new(config.clone(), matrix.chord_count());
        let solver2 = GreedySolver::new(config, matrix.chord_count());

        let cand1 = solver1.find_best_chord(&canvas, &matrix, &evaluator, &scheduler, &spools, 0.2);
        let cand2 = solver2.find_best_chord(&canvas, &matrix, &evaluator, &scheduler, &spools, 0.2);

        assert_eq!(cand1, cand2, "Resultados devem ser 100% idênticos e determinísticos");
    }

    #[test]
    fn test_greedy_max_chord_repeats_respected() {
        let (_loom, matrix, mut canvas, mut tracker, evaluator, mut scheduler, spools) =
            setup_test_environment(16, 40);

        let max_repeats = 2;
        let config = GreedyConfig {
            max_steps: 30,
            max_chord_repeats: max_repeats,
            length_exponent_gamma: 0.0,
            start_pin: 0,
            tabu_history_size: 0,
        };

        let mut solver = GreedySolver::new(config, matrix.chord_count());

        for _ in 0..25 {
            if solver
                .step(
                    &mut canvas,
                    &mut tracker,
                    &mut scheduler,
                    &matrix,
                    &evaluator,
                    &spools,
                    0.2,
                )
                .is_none()
            {
                break;
            }
        }

        for &usage in solver.all_chord_usages() {
            assert!(
                (usage as usize) <= max_repeats,
                "Nenhuma corda pode ultrapassar max_chord_repeats"
            );
        }
    }

    #[test]
    fn test_greedy_coarse_to_fine_cmyk() {
        let (_loom, matrix, mut canvas, mut tracker, evaluator, _, _) =
            setup_test_environment(32, 64);
        let spools = vec![
            SpoolColor::new(0, LinearRgbColor::new(1.0, 1.0, 0.0), 0.25),
            SpoolColor::new(1, LinearRgbColor::new(1.0, 0.0, 1.0), 0.25),
            SpoolColor::new(2, LinearRgbColor::new(0.0, 1.0, 1.0), 0.25),
            SpoolColor::new(3, LinearRgbColor::BLACK, 0.35),
        ];
        let strat = SpoolSwitchStrategy::CoarseToFineEpochs {
            base_ratio: 0.50,
            refine_ratio: 0.35,
            detail_top_ratio: 0.15,
            black_spool_id: 3,
            white_spool_id: None,
            edge_importance_boost: 2.0,
        };
        let mut scheduler = SpoolScheduler::new(strat, 100, 0);
        let config = GreedyConfig {
            max_steps: 100,
            max_chord_repeats: 3,
            length_exponent_gamma: 1.0,
            start_pin: 0,
            tabu_history_size: 0,
        };
        let mut solver = GreedySolver::new(config, matrix.chord_count());
        let mut steps_taken = 0;
        for _ in 0..10 {
            if let Some(_step) = solver.step(&mut canvas, &mut tracker, &mut scheduler, &matrix, &evaluator, &spools, 0.2) {
                steps_taken += 1;
            } else {
                break;
            }
        }
        println!("Steps taken: {}", steps_taken);
        assert!(steps_taken > 0, "Deveria ter executado passos!");
    }

    #[test]
    fn test_greedy_portrait_4000_lines_highlight_protection_and_rmse() {
        use crate::state_matrix::compute_effective_alpha;
        use weaver_domain::Millimeters;

        let pin_count = 160;
        let res = 160u32;
        let diameter_mm = 600.0;
        let spec = LoomPhysicalSpec::circle(diameter_mm, pin_count, 2.0, 1.5, 10.0);
        let loom = LoomGeometry::new(spec);
        let matrix = SparseChordMatrixCSR::build(
            &loom,
            Pixels(res),
            10,
            RasterizerType::XiaolinWuAntialiased,
        );

        let bg = LinearRgbColor::WHITE;
        let mut target = vec![bg; (res * res) as usize];
        let mut importance = vec![1.0f32; (res * res) as usize];
        let center = (res as f32 - 1.0) * 0.5;
        let r_loom = center;

        for y in 0..res {
            for x in 0..res {
                let nx = (x as f32 - center) / r_loom;
                let ny = (y as f32 - center) / r_loom;
                let r = (nx * nx + ny * ny).sqrt();
                let idx = (y * res + x) as usize;

                if r > 0.96 {
                    importance[idx] = 0.0;
                    continue;
                }

                // Cabeça oval ocupando ~75% do diâmetro útil
                let head_dist = (nx / 0.52).powi(2) + ((ny + 0.04) / 0.65).powi(2);
                if head_dist <= 1.0 {
                    // Pele iluminada com realces nas bochechas/testa (T ~ 0.65) e sombra lateral (T ~ 0.25)
                    let shading = (0.68 - 0.32 * head_dist - 0.10 * nx.abs()).clamp(0.18, 0.78);
                    target[idx] = LinearRgbColor::new(shading, shading, shading);
                    importance[idx] = 2.5;

                    // Olhos escuros no terço superior
                    let eye_l = ((nx + 0.18) / 0.09).powi(2) + ((ny + 0.16) / 0.05).powi(2);
                    let eye_r = ((nx - 0.18) / 0.09).powi(2) + ((ny + 0.16) / 0.05).powi(2);
                    // Sobrancelhas e boca
                    let mouth = (nx / 0.18).powi(2) + ((ny - 0.24) / 0.04).powi(2);
                    // Cabelo escuro no topo
                    let hair = ny < -0.32 && head_dist > 0.45;
                    if eye_l <= 1.0 || eye_r <= 1.0 || mouth <= 1.0 || hair {
                        target[idx] = LinearRgbColor::new(0.05, 0.05, 0.05);
                        importance[idx] = 4.0;
                    }
                }
            }
        }

        let mut canvas =
            CanvasStateSoA::from_target_and_background(res, res, &target, bg, Some(&importance));
        let mut tracker = IncrementalMetricsTracker::new(&canvas);
        let evaluator = OpticalModelEvaluator::new(
            OpticalMixModelType::PorterDuffOcclusion,
            ColorErrorMetric::CielabDeltaE2000,
        )
        .with_highlight_protection(2.8);

        let spools = vec![SpoolColor::new(
            0,
            LinearRgbColor::new(0.02, 0.02, 0.02),
            0.35,
        )];
        let alpha_eff = compute_effective_alpha(
            0.35,
            Millimeters(0.15),
            Pixels(res),
            Millimeters(diameter_mm as f32),
        );

        let mut scheduler = SpoolScheduler::new(SpoolSwitchStrategy::FreeGreedy, 4000, 0);
        let config = GreedyConfig {
            max_steps: 4000,
            max_chord_repeats: 2,
            length_exponent_gamma: 1.0,
            start_pin: 0,
            tabu_history_size: 8,
        };
        let mut solver = GreedySolver::new(config, matrix.chord_count());

        let initial_rmse = tracker.current_snapshot().rmse;
        let mut rmse_at_1000 = initial_rmse;

        let mut steps_executed = 0;
        for step_idx in 0..4000 {
            if solver
                .step(
                    &mut canvas,
                    &mut tracker,
                    &mut scheduler,
                    &matrix,
                    &evaluator,
                    &spools,
                    alpha_eff,
                )
                .is_some()
            {
                steps_executed += 1;
                if step_idx + 1 == 1000 {
                    rmse_at_1000 = tracker.current_snapshot().rmse;
                }
            } else {
                break;
            }
        }

        let final_snap = tracker.current_snapshot();
        assert!(
            steps_executed >= 800,
            "Deve tecer número substancial de cordas para o retrato, obtido: {}",
            steps_executed
        );
        assert!(
            rmse_at_1000 < initial_rmse,
            "RMSE em 1000 linhas ({}) deve ser menor que o inicial ({})",
            rmse_at_1000,
            initial_rmse
        );
        assert!(
            final_snap.rmse <= rmse_at_1000 + 1e-4 && final_snap.rmse < initial_rmse * 0.65,
            "RMSE final ({}) deve convergir sem degradar a imagem (inicial={})",
            final_snap.rmse,
            initial_rmse
        );

        // Verifica que o fundo branco e os realces da testa não sofreram "buraco negro"
        let bg_sample_idx = (15 * res + 15) as usize;
        assert!(
            canvas.current_c0[bg_sample_idx] > 0.70,
            "Fundo claro deve permanecer limpo (> 0.70), obtido: {}",
            canvas.current_c0[bg_sample_idx]
        );
    }
}

