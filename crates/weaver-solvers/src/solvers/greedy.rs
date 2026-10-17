//! Algoritmo Guloso Iterativo de String Art (`solvers/greedy.rs`).
//!
//! A partir do pino atual e para cada carretel permitido pelo `SpoolScheduler`, avalia todas as
//! cordas candidatas lendo fatias contíguas da `SparseChordMatrixCSR` e escolhe a de maior score:
//!
//! $$\text{Score}(L, k) = \frac{\Delta E(L, k)}{|L|^{\gamma}} - \text{PenalidadeTroca}(k)$$
//!
//! onde $\Delta E$ é a redução **exata** do erro perceptual (`OpticalModelEvaluator`) e $|L|$ é a
//! integral de cobertura sub-pixel da corda. Para quando nenhuma corda reduz o erro.
//! Desempate determinístico pelo menor pino e menor carretel (RNF-02).

use weaver_domain::{PegSide, SparseChordMatrixCSR};

use crate::optical_models::{OpticalModelEvaluator, SpoolColor};
use crate::spool_scheduler::SpoolScheduler;
use crate::state_matrix::CanvasStateSoA;

/// Configuração do Algoritmo Guloso Iterativo.
#[derive(Debug, Clone, PartialEq)]
pub struct GreedyConfig {
    /// Quantidade máxima de passos/linhas a tecer.
    pub max_steps: usize,
    /// Quantidade máxima de vezes que o mesmo par canônico de pinos pode ser tecido.
    pub max_chord_repeats: usize,
    /// Expoente $\gamma$ de normalização por comprimento ($1/|L|^\gamma$; 0 = ganho bruto).
    pub length_exponent_gamma: f32,
    /// Pino inicial de tecelagem (0..N-1).
    pub start_pin: usize,
    /// Tamanho do histórico Tabu de pinos recentes (0 desativa).
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

/// Integral de cobertura sub-pixel de uma corda (comprimento efetivo em pixels).
#[inline]
pub fn chord_coverage_length(weights: &[u8]) -> f32 {
    let sum: u32 = weights.iter().map(|&w| w as u32).sum();
    (sum as f32 / 255.0).max(1.0)
}

/// Converte um score em ponto fixo `u16` para o `WeavingPathBuffer`.
#[inline]
pub fn normalize_score(score: f32) -> u16 {
    let s = score.max(0.0);
    ((s / (s + 1.0)) * 65535.0).clamp(0.0, 65535.0) as u16
}

/// Motor guloso com laço interno sem alocações.
pub struct GreedySolver {
    pub config: GreedyConfig,
    pub current_pin: usize,
    pub step_count: usize,
    chord_usage: Vec<u16>,
    tabu_queue: Vec<usize>,
}

impl GreedySolver {
    pub fn new(config: GreedyConfig, chord_count: usize) -> Self {
        let current_pin = config.start_pin;
        let tabu_cap = config.tabu_history_size;
        Self {
            config,
            current_pin,
            step_count: 0,
            chord_usage: vec![0; chord_count],
            tabu_queue: Vec::with_capacity(tabu_cap),
        }
    }

    pub fn reset(&mut self, start_pin: usize) {
        self.current_pin = start_pin;
        self.step_count = 0;
        self.chord_usage.fill(0);
        self.tabu_queue.clear();
    }

    #[inline]
    pub fn chord_usage(&self, chord_idx: usize) -> u16 {
        self.chord_usage.get(chord_idx).copied().unwrap_or(0)
    }

    #[inline]
    pub fn all_chord_usages(&self) -> &[u16] {
        &self.chord_usage
    }

    /// Acesso mutável às contagens de uso (usado pelo passe de refinamento).
    #[inline]
    pub fn chord_usage_mut(&mut self) -> &mut [u16] {
        &mut self.chord_usage
    }

    #[inline]
    pub fn is_tabu(&self, pin: usize) -> bool {
        self.tabu_queue.contains(&pin)
    }

    fn push_tabu(&mut self, pin: usize) {
        if self.config.tabu_history_size == 0 {
            return;
        }
        if self.tabu_queue.len() >= self.config.tabu_history_size {
            self.tabu_queue.remove(0);
        }
        self.tabu_queue.push(pin);
    }

    /// Avalia todas as cordas a partir de `current_pin` e retorna a melhor com ganho positivo.
    pub fn find_best_chord(
        &self,
        canvas: &CanvasStateSoA,
        matrix: &SparseChordMatrixCSR,
        evaluator: &OpticalModelEvaluator,
        scheduler: &SpoolScheduler,
        spools: &[SpoolColor],
        coverage: f32,
    ) -> Option<GreedyChordCandidate> {
        let pin_count = matrix.pin_count;
        if pin_count < 2 {
            return None;
        }
        let allowed = scheduler.allowed_spools(spools);
        if allowed.is_empty() {
            return None;
        }

        let gamma = self.config.length_exponent_gamma;
        let max_repeats = self.config.max_chord_repeats.max(1);
        let mut best: Option<GreedyChordCandidate> = None;

        for next_pin in 0..pin_count {
            if next_pin == self.current_pin || self.is_tabu(next_pin) {
                continue;
            }
            let Some(chord_idx) = SparseChordMatrixCSR::try_canonical_chord_index(
                self.current_pin,
                next_pin,
                pin_count,
            ) else {
                continue;
            };
            if (self.chord_usage[chord_idx] as usize) >= max_repeats {
                continue;
            }
            let (pixels, weights) = matrix.chord_slice(chord_idx);
            if pixels.is_empty() {
                continue;
            }
            let len = chord_coverage_length(weights);
            let len_factor = if gamma == 0.0 { 1.0 } else { len.powf(gamma) };

            for &spool_id in &allowed {
                let Some(spool) = spools.iter().find(|s| s.id == spool_id) else {
                    continue;
                };
                let raw_gain =
                    evaluator.chord_marginal_gain(canvas, pixels, weights, spool, coverage);
                if raw_gain <= 0.0 {
                    continue;
                }
                let score = raw_gain / len_factor - scheduler.switch_penalty(spool.id);
                if score <= 0.0 {
                    continue;
                }
                let better = match &best {
                    None => true,
                    Some(b) => {
                        score > b.score
                            || ((score - b.score).abs() <= 1e-9
                                && (next_pin, spool.id) < (b.to_pin, b.spool_id))
                    }
                };
                if better {
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

    /// Executa um passo: escolhe, aplica e registra a melhor corda.
    pub fn step(
        &mut self,
        canvas: &mut CanvasStateSoA,
        scheduler: &mut SpoolScheduler,
        matrix: &SparseChordMatrixCSR,
        evaluator: &OpticalModelEvaluator,
        spools: &[SpoolColor],
        coverage: f32,
    ) -> Option<GreedyStepRecord> {
        if self.step_count >= self.config.max_steps {
            return None;
        }
        let cand = self.find_best_chord(canvas, matrix, evaluator, scheduler, spools, coverage)?;
        let spool = spools.iter().find(|s| s.id == cand.spool_id)?;
        let (pixels, weights) = matrix.chord_slice(cand.chord_idx);
        evaluator.apply_chord(canvas, pixels, weights, spool, coverage);
        scheduler.advance_step(spool.id, spools);

        self.chord_usage[cand.chord_idx] += 1;
        let from = self.current_pin;
        self.push_tabu(from);
        self.current_pin = cand.to_pin;
        self.step_count += 1;

        Some(GreedyStepRecord {
            from_pin: from as u16,
            to_pin: cand.to_pin as u16,
            spool_id: cand.spool_id,
            departure_winding: PegSide::Clockwise,
            arrival_winding: PegSide::Clockwise,
            gain: cand.raw_gain,
            score_normalized: normalize_score(cand.score),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::optical_models::OpticalMixModelType;
    use crate::spool_scheduler::SpoolSwitchStrategy;
    use weaver_domain::{
        linear_to_srgb_channel, ColorErrorMetric, LinearRgbColor, LoomGeometry, LoomPhysicalSpec,
        Pixels, RasterizerType,
    };

    fn setup(target_value: f32) -> (SparseChordMatrixCSR, CanvasStateSoA) {
        let res = 64u32;
        let loom = LoomGeometry::new(LoomPhysicalSpec::circle(400.0, 40, 2.0, 2.0, 10.0));
        let matrix = SparseChordMatrixCSR::build(
            &loom,
            Pixels(res),
            4,
            RasterizerType::XiaolinWuAntialiased,
        );
        let n = (res * res) as usize;
        let target: Vec<LinearRgbColor> = (0..n)
            .map(|i| {
                let x = (i as u32 % res) as f32 / res as f32;
                let v = if x < 0.5 { target_value } else { 1.0 };
                LinearRgbColor::new(v, v, v)
            })
            .collect();
        let canvas = CanvasStateSoA::from_target_and_background(
            res,
            res,
            &target,
            LinearRgbColor::WHITE,
            None,
        );
        (matrix, canvas)
    }

    fn error(c: &CanvasStateSoA) -> f32 {
        (0..c.num_pixels)
            .map(|p| {
                let d = linear_to_srgb_channel(c.current_c0[p])
                    - linear_to_srgb_channel(c.target_c0[p]);
                d * d
            })
            .sum()
    }

    fn evaluator() -> OpticalModelEvaluator {
        OpticalModelEvaluator::new(
            OpticalMixModelType::PorterDuffOcclusion,
            ColorErrorMetric::CielabDeltaE2000,
        )
        .with_luma_only(true)
    }

    #[test]
    fn every_step_strictly_reduces_perceptual_error() {
        let (matrix, mut canvas) = setup(0.1);
        let spools = vec![SpoolColor::new(0, LinearRgbColor::BLACK, 1.0)];
        let mut sched = SpoolScheduler::new(SpoolSwitchStrategy::FreeGreedy, 200, 0);
        let cfg = GreedyConfig {
            max_steps: 200,
            max_chord_repeats: 2,
            ..Default::default()
        };
        let mut solver = GreedySolver::new(cfg, matrix.chord_count());
        let eval = evaluator();
        let mut prev = error(&canvas);
        let mut steps = 0;
        while let Some(rec) = solver.step(&mut canvas, &mut sched, &matrix, &eval, &spools, 0.3) {
            assert!(rec.gain > 0.0);
            let e = error(&canvas);
            assert!(e < prev + 1e-4, "erro subiu: {prev} -> {e}");
            prev = e;
            steps += 1;
        }
        assert!(steps > 10);
        assert!(solver.all_chord_usages().iter().all(|&u| u <= 2));
    }

    #[test]
    fn white_target_produces_no_chords() {
        let (matrix, mut canvas) = setup(1.0);
        let spools = vec![SpoolColor::new(0, LinearRgbColor::BLACK, 1.0)];
        let mut sched = SpoolScheduler::new(SpoolSwitchStrategy::FreeGreedy, 50, 0);
        let mut solver = GreedySolver::new(GreedyConfig::default(), matrix.chord_count());
        let r = solver.step(&mut canvas, &mut sched, &matrix, &evaluator(), &spools, 0.3);
        assert!(r.is_none());
    }

    #[test]
    fn solver_is_deterministic() {
        let run = || {
            let (matrix, mut canvas) = setup(0.2);
            let spools = vec![SpoolColor::new(0, LinearRgbColor::BLACK, 1.0)];
            let mut sched = SpoolScheduler::new(SpoolSwitchStrategy::FreeGreedy, 60, 0);
            let cfg = GreedyConfig {
                max_steps: 60,
                tabu_history_size: 4,
                ..Default::default()
            };
            let mut solver = GreedySolver::new(cfg, matrix.chord_count());
            let eval = evaluator();
            let mut path = Vec::new();
            while let Some(r) = solver.step(&mut canvas, &mut sched, &matrix, &eval, &spools, 0.3) {
                path.push((r.from_pin, r.to_pin));
            }
            path
        };
        assert_eq!(run(), run());
    }
}
