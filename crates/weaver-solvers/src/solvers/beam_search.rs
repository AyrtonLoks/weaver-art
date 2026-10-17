//! Busca em Feixe sem Explosão de Memória (`solvers/beam_search.rs`).
//!
//! Implementa o **Beam Search** parametrizado por largura de feixe $B \in [2, 16]$
//! e profundidade de *lookahead* $d \in [2, 4]$.
//!
//! **Restrição Crítica de Memória:**
//! NÃO clona a matriz da tela para cada candidato avaliado!
//! Utiliza um pool fixo de apenas $2 \times B$ estados (`CanvasStateSoA`) pré-alocados na inicialização.
//! Avalia o ganho diferencial na leitura CSR e só aplica a mutação de pixels nos $B$ estados
//! sobreviventes de cada nível.

use weaver_domain::{LinearRgbColor, PegSide, SparseChordMatrixCSR};

use crate::optical_models::{OpticalModelEvaluator, SpoolColor};
use crate::spool_scheduler::SpoolScheduler;
use crate::state_matrix::CanvasStateSoA;
use crate::telemetry_metrics::IncrementalMetricsTracker;

/// Configuração da Busca em Feixe (Beam Search).
#[derive(Debug, Clone, PartialEq)]
pub struct BeamSearchConfig {
    /// Largura do feixe $B \in [2, 16]$ (número de caminhos mantidos por nível).
    pub beam_width: usize,
    /// Profundidade de antecipação (*lookahead*) $d \in [2, 4]$.
    pub lookahead_depth: usize,
    /// Quantidade máxima de passos/linhas a tecer.
    pub max_steps: usize,
    /// Quantidade máxima de repetições por par de pinos.
    pub max_chord_repeats: usize,
    /// Expoente $\gamma$ de penalização de comprimento.
    pub length_exponent_gamma: f32,
    /// Pino inicial de tecelagem.
    pub start_pin: usize,
}

impl Default for BeamSearchConfig {
    fn default() -> Self {
        Self {
            beam_width: 4,
            lookahead_depth: 2,
            max_steps: 3000,
            max_chord_repeats: 2,
            length_exponent_gamma: 1.0,
            start_pin: 0,
        }
    }
}

/// Representa um movimento atômico de corda no feixe.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BeamMove {
    pub from_pin: usize,
    pub to_pin: usize,
    pub spool_id: u8,
    pub chord_idx: usize,
    pub raw_gain: f32,
    pub score: f32,
}

/// Ramo ativo no feixe durante a busca em profundidade.
#[derive(Debug, Clone, Copy, PartialEq)]
struct BeamBranch {
    current_pin: usize,
    prev_pin: Option<usize>,
    cumulative_score: f32,
    first_move: Option<BeamMove>,
    state_idx: usize,
    depth: usize,
    lookahead_chords: [usize; 4],
}

/// Candidato a expansão do feixe.
#[derive(Debug, Clone, Copy, PartialEq)]
struct CandidateExpansion {
    parent_branch_idx: usize,
    next_move: BeamMove,
    total_score: f32,
}

/// Registro do passo de tecelagem gerado pelo Beam Search.
#[derive(Debug, Clone, PartialEq)]
pub struct BeamStepRecord {
    pub from_pin: u16,
    pub to_pin: u16,
    pub spool_id: u8,
    pub departure_winding: PegSide,
    pub arrival_winding: PegSide,
    pub gain: f32,
    pub score_normalized: u16,
}

/// Solver de Busca em Feixe com pool estrito de $2 \times B$ estados SoA e zero alocações no loop.
pub struct BeamSearchSolver {
    pub config: BeamSearchConfig,
    pub current_pin: usize,
    pub prev_pin: Option<usize>,
    pub step_count: usize,
    chord_usage: Vec<u16>,

    // Pool fixo pré-alocado de exatamente 2 * B estados
    pool_a: Vec<CanvasStateSoA>,
    pool_b: Vec<CanvasStateSoA>,

    // Buffers reutilizáveis para evitar alocações durante a busca
    candidate_expansions: Vec<CandidateExpansion>,
    branches_a: Vec<BeamBranch>,
    branches_b: Vec<BeamBranch>,
    old_colors_buf: Vec<LinearRgbColor>,
}

impl BeamSearchSolver {
    /// Inicializa o solver pré-alocando exatamente $2 \times B$ estados `CanvasStateSoA`.
    pub fn new(
        config: BeamSearchConfig,
        template_canvas: &CanvasStateSoA,
        chord_count: usize,
    ) -> Self {
        let b = config.beam_width.clamp(2, 16);
        let current_pin = config.start_pin;

        let mut pool_a = Vec::with_capacity(b);
        let mut pool_b = Vec::with_capacity(b);

        for _ in 0..b {
            let mut state_a = CanvasStateSoA::new(
                template_canvas.width_px,
                template_canvas.height_px,
                LinearRgbColor::WHITE,
            );
            state_a.target_c0.copy_from_slice(&template_canvas.target_c0);
            state_a.target_c1.copy_from_slice(&template_canvas.target_c1);
            state_a.target_c2.copy_from_slice(&template_canvas.target_c2);
            state_a.base_importance_w.copy_from_slice(&template_canvas.base_importance_w);
            state_a.importance_w.copy_from_slice(&template_canvas.importance_w);
            state_a.edge_map.copy_from_slice(&template_canvas.edge_map);

            let state_b = state_a.clone();
            pool_a.push(state_a);
            pool_b.push(state_b);
        }

        Self {
            config,
            current_pin,
            prev_pin: None,
            step_count: 0,
            chord_usage: vec![0; chord_count],
            pool_a,
            pool_b,
            candidate_expansions: Vec::with_capacity(b * 32),
            branches_a: Vec::with_capacity(b),
            branches_b: Vec::with_capacity(b),
            old_colors_buf: Vec::with_capacity(1024),
        }
    }

    /// Reinicia o solver.
    pub fn reset(&mut self, start_pin: usize) {
        self.current_pin = start_pin;
        self.prev_pin = None;
        self.step_count = 0;
        self.chord_usage.fill(0);
        self.candidate_expansions.clear();
        self.branches_a.clear();
        self.branches_b.clear();
        self.old_colors_buf.clear();
    }

    /// Retorna a contagem de uso da corda $k$.
    #[inline]
    pub fn chord_usage(&self, chord_idx: usize) -> u16 {
        self.chord_usage.get(chord_idx).copied().unwrap_or(0)
    }

    /// Executa a busca em feixe para selecionar o melhor primeiro movimento
    /// com profundidade de lookahead $d$.
    pub fn find_best_move(
        &mut self,
        main_canvas: &CanvasStateSoA,
        matrix: &SparseChordMatrixCSR,
        evaluator: &OpticalModelEvaluator,
        scheduler: &SpoolScheduler,
        spools: &[SpoolColor],
        alpha_eff: f32,
    ) -> Option<BeamMove> {
        let b = self.config.beam_width.clamp(2, 16);
        let d = self.config.lookahead_depth.clamp(2, 4);
        let pin_count = matrix.pin_count;
        if pin_count < 2 {
            return None;
        }

        let allowed_spool_ids = scheduler.allowed_spools(spools);
        if allowed_spool_ids.is_empty() {
            return None;
        }

        // 1. Inicializa o estado raiz em pool_a[0] copiando do main_canvas in-place (sem alocação)
        self.pool_a[0].copy_from(main_canvas);

        self.branches_a.clear();
        self.branches_a.push(BeamBranch {
            current_pin: self.current_pin,
            prev_pin: self.prev_pin,
            cumulative_score: 0.0,
            first_move: None,
            state_idx: 0,
            depth: 0,
            lookahead_chords: [0; 4],
        });

        let gamma = self.config.length_exponent_gamma;
        let max_repeats = self.config.max_chord_repeats;

        // Loop de profundidade 0 .. d-1
        for level in 0..d {
            let (use_a_as_source, source_branch_count) = if level % 2 == 0 {
                (true, self.branches_a.len())
            } else {
                (false, self.branches_b.len())
            };

            if source_branch_count == 0 {
                break;
            }

            self.candidate_expansions.clear();

            for branch_idx in 0..source_branch_count {
                let branch = if use_a_as_source {
                    self.branches_a[branch_idx]
                } else {
                    self.branches_b[branch_idx]
                };

                let source_state = if use_a_as_source {
                    &self.pool_a[branch.state_idx]
                } else {
                    &self.pool_b[branch.state_idx]
                };

                for next_pin in 0..pin_count {
                    if next_pin == branch.current_pin {
                        continue;
                    }
                    if branch.prev_pin == Some(next_pin) {
                        continue;
                    }

                    let chord_idx = match SparseChordMatrixCSR::try_canonical_chord_index(
                        branch.current_pin,
                        next_pin,
                        pin_count,
                    ) {
                        Some(idx) => idx,
                        None => continue,
                    };

                    // Verifica repetições considerando o lookahead deste ramo
                    let branch_repeats = (0..branch.depth)
                        .filter(|&dep| branch.lookahead_chords[dep] == chord_idx)
                        .count();

                    if (self.chord_usage[chord_idx] as usize) + branch_repeats >= max_repeats {
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

                        // Avaliação puramente diferencial e read-only na CSR
                        let raw_gain = evaluator.chord_marginal_gain(
                            source_state,
                            pixel_indices,
                            subpixel_weights,
                            spool,
                            alpha_eff,
                        );

                        if raw_gain <= 0.0 {
                            continue;
                        }

                        let penalty = scheduler.switch_penalty(spool.id);
                        let step_score = (raw_gain / len_factor) - penalty;

                        if step_score <= 0.0 {
                            continue;
                        }

                        let total_score = branch.cumulative_score + step_score;

                        self.candidate_expansions.push(CandidateExpansion {
                            parent_branch_idx: branch_idx,
                            next_move: BeamMove {
                                from_pin: branch.current_pin,
                                to_pin: next_pin,
                                spool_id: spool.id,
                                chord_idx,
                                raw_gain,
                                score: step_score,
                            },
                            total_score,
                        });
                    }
                }
            }

            if self.candidate_expansions.is_empty() {
                break;
            }

            // Ordena deterministamente os candidatos para reter os top B sobreviventes
            self.candidate_expansions.sort_by(|x, y| {
                y.total_score
                    .partial_cmp(&x.total_score)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| x.next_move.to_pin.cmp(&y.next_move.to_pin))
                    .then_with(|| x.next_move.spool_id.cmp(&y.next_move.spool_id))
            });

            let num_survivors = self.candidate_expansions.len().min(b);

            // Aplica mutação de pixels exclusivamente nos B sobreviventes no pool de destino
            if use_a_as_source {
                self.branches_b.clear();
                for i in 0..num_survivors {
                    let cand = self.candidate_expansions[i];
                    let parent_branch = self.branches_a[cand.parent_branch_idx];

                    // Copia estado do pai para o slot i do pool B (zero-allocation)
                    self.pool_b[i].copy_from(&self.pool_a[parent_branch.state_idx]);

                    // Aplica a corda mutando in-place apenas o sobrevivente
                    let (pix, wts) = matrix.chord_slice(cand.next_move.chord_idx);
                    let spool = spools
                        .iter()
                        .find(|s| s.id == cand.next_move.spool_id)
                        .unwrap();
                    evaluator.apply_chord(&mut self.pool_b[i], pix, wts, spool, alpha_eff);

                    let mut lookahead = parent_branch.lookahead_chords;
                    if parent_branch.depth < 4 {
                        lookahead[parent_branch.depth] = cand.next_move.chord_idx;
                    }

                    self.branches_b.push(BeamBranch {
                        current_pin: cand.next_move.to_pin,
                        prev_pin: Some(parent_branch.current_pin),
                        cumulative_score: cand.total_score,
                        first_move: if level == 0 {
                            Some(cand.next_move)
                        } else {
                            parent_branch.first_move
                        },
                        state_idx: i,
                        depth: parent_branch.depth + 1,
                        lookahead_chords: lookahead,
                    });
                }
            } else {
                self.branches_a.clear();
                for i in 0..num_survivors {
                    let cand = self.candidate_expansions[i];
                    let parent_branch = self.branches_b[cand.parent_branch_idx];

                    // Copia estado do pai para o slot i do pool A
                    self.pool_a[i].copy_from(&self.pool_b[parent_branch.state_idx]);

                    // Aplica a corda mutando in-place apenas o sobrevivente
                    let (pix, wts) = matrix.chord_slice(cand.next_move.chord_idx);
                    let spool = spools
                        .iter()
                        .find(|s| s.id == cand.next_move.spool_id)
                        .unwrap();
                    evaluator.apply_chord(&mut self.pool_a[i], pix, wts, spool, alpha_eff);

                    let mut lookahead = parent_branch.lookahead_chords;
                    if parent_branch.depth < 4 {
                        lookahead[parent_branch.depth] = cand.next_move.chord_idx;
                    }

                    self.branches_a.push(BeamBranch {
                        current_pin: cand.next_move.to_pin,
                        prev_pin: Some(parent_branch.current_pin),
                        cumulative_score: cand.total_score,
                        first_move: if level == 0 {
                            Some(cand.next_move)
                        } else {
                            parent_branch.first_move
                        },
                        state_idx: i,
                        depth: parent_branch.depth + 1,
                        lookahead_chords: lookahead,
                    });
                }
            }
        }

        // Determina o melhor ramo final sobrevivente
        let last_branches = if d % 2 == 1 {
            &self.branches_b
        } else {
            &self.branches_a
        };

        let best_branch = last_branches.iter().max_by(|x, y| {
            x.cumulative_score
                .partial_cmp(&y.cumulative_score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| y.current_pin.cmp(&x.current_pin))
        });

        best_branch.and_then(|b| b.first_move)
    }

    /// Executa um passo do Beam Search:
    /// 1. Encontra o melhor movimento com antecipação;
    /// 2. Aplica na tela principal;
    /// 3. Atualiza métricas incrementais em $O(|L|)$;
    /// 4. Retorna o registro do passo.
    pub fn step(
        &mut self,
        canvas: &mut CanvasStateSoA,
        tracker: &mut IncrementalMetricsTracker,
        scheduler: &mut SpoolScheduler,
        matrix: &SparseChordMatrixCSR,
        evaluator: &OpticalModelEvaluator,
        spools: &[SpoolColor],
        alpha_eff: f32,
    ) -> Option<BeamStepRecord> {
        let best_move = self.find_best_move(canvas, matrix, evaluator, scheduler, spools, alpha_eff)?;

        let (pixel_indices, subpixel_weights) = matrix.chord_slice(best_move.chord_idx);
        let spool = spools
            .iter()
            .find(|s| s.id == best_move.spool_id)
            .expect("Spool must exist");

        // Coleta cores antigas para atualização incremental de SSIM/RMSE/DeltaE em O(|L|)
        self.old_colors_buf.clear();
        for &p in pixel_indices {
            self.old_colors_buf.push(canvas.current_color(p as usize));
        }

        // Aplica a corda na tela principal
        evaluator.apply_chord(canvas, pixel_indices, subpixel_weights, spool, alpha_eff);

        // Notifica o tracker incremental
        tracker.update_pixels(canvas, pixel_indices, &self.old_colors_buf);

        // Avança o agendador de carretéis
        scheduler.advance_step(spool.id, spools);
        if self.step_count % 250 == 0 {
            let edge_boost = scheduler.active_edge_boost();
            if edge_boost > 0.0 {
                canvas.apply_edge_importance_boost(edge_boost);
            }
        }

        // Atualiza estado do solver
        self.chord_usage[best_move.chord_idx] += 1;
        let from = self.current_pin;
        let to = best_move.to_pin;
        self.prev_pin = Some(from);
        self.current_pin = to;
        self.step_count += 1;

        let score_norm = ((best_move.score.max(0.0) / (best_move.score.max(0.0) + 1.0)) * 65535.0)
            .clamp(0.0, 65535.0) as u16;

        Some(BeamStepRecord {
            from_pin: from as u16,
            to_pin: to as u16,
            spool_id: best_move.spool_id,
            departure_winding: PegSide::Clockwise,
            arrival_winding: PegSide::Clockwise,
            gain: best_move.raw_gain,
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

    fn setup_beam_test(
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
    fn test_beam_search_pool_allocation_and_reduction() {
        let (matrix, mut canvas, mut tracker, evaluator, mut scheduler, spools) =
            setup_beam_test(24, 48);

        let config = BeamSearchConfig {
            beam_width: 4,
            lookahead_depth: 2,
            max_steps: 15,
            max_chord_repeats: 2,
            length_exponent_gamma: 1.0,
            start_pin: 0,
        };

        let mut solver = BeamSearchSolver::new(config, &canvas, matrix.chord_count());
        assert_eq!(solver.pool_a.len(), 4);
        assert_eq!(solver.pool_b.len(), 4);

        let initial_metrics = tracker.current_snapshot();
        let mut executed = 0;

        for _ in 0..10 {
            if let Some(step) = solver.step(
                &mut canvas,
                &mut tracker,
                &mut scheduler,
                &matrix,
                &evaluator,
                &spools,
                0.2,
            ) {
                assert!(step.gain > 0.0);
                executed += 1;
            } else {
                break;
            }
        }

        assert!(executed >= 5);
        let final_metrics = tracker.current_snapshot();
        assert!(final_metrics.delta_e < initial_metrics.delta_e);
        assert!(final_metrics.rmse < initial_metrics.rmse);
    }
}
