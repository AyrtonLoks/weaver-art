//! Passe de Refinamento do Caminho (`solvers/refine.rs`).
//!
//! O guloso decide cada corda olhando só para o estado atual; cordas iniciais ficam "presas"
//! mesmo quando cordas posteriores tornam-nas prejudiciais. Este passe revisita cada **nó interno**
//! do caminho contínuo $(\dots, a \to p \to b, \dots)$ e testa, com a variação exata do erro:
//!
//! 1. **Realocação**: trocar o pino $p$ por outro $q$, substituindo as cordas $(a,p),(p,b)$ por
//!    $(a,q),(q,b)$ — o fio continua único e contínuo e o número de linhas não muda;
//! 2. **Remoção** (opcional): eliminar o nó, substituindo $(a,p),(p,b)$ pela corda direta $(a,b)$.
//!
//! O movimento só é aceito quando reduz o erro. A implementação é incremental: cada chamada a
//! [`PathRefiner::process`] trata no máximo `budget` nós, mantendo a UI responsiva.

use weaver_domain::SparseChordMatrixCSR;

use crate::optical_models::{OpticalModelEvaluator, SpoolColor};
use crate::solver_runner::WeaveStepRecord;
use crate::state_matrix::CanvasStateSoA;

/// Configuração do passe de refinamento.
#[derive(Debug, Clone, PartialEq)]
pub struct RefineConfig {
    /// Número máximo de varreduras completas do caminho (0 desativa o refinamento).
    pub passes: usize,
    /// Janela de busca de pinos ao redor do pino atual (0 = todos os pinos).
    pub window: usize,
    /// Permite eliminar nós (reduz o número de linhas quando isso melhora a imagem).
    pub allow_removal: bool,
    /// Limite de repetições do mesmo par de pinos (igual ao do guloso).
    pub max_chord_repeats: usize,
}

impl Default for RefineConfig {
    fn default() -> Self {
        Self {
            passes: 2,
            window: 0,
            allow_removal: true,
            max_chord_repeats: 2,
        }
    }
}

/// Estado incremental do refinamento.
#[derive(Debug, Clone)]
pub struct PathRefiner {
    pub config: RefineConfig,
    pub pass: usize,
    node: usize,
    improved_in_pass: usize,
    pub total_moves: usize,
    pub total_removed: usize,
    done: bool,
}

impl PathRefiner {
    pub fn new(config: RefineConfig) -> Self {
        let done = config.passes == 0;
        Self {
            config,
            pass: 0,
            node: 1,
            improved_in_pass: 0,
            total_moves: 0,
            total_removed: 0,
            done,
        }
    }

    #[inline]
    pub fn is_done(&self) -> bool {
        self.done
    }

    /// Progresso aproximado em [0, 1].
    pub fn progress(&self, path_len: usize) -> f32 {
        if self.done || self.config.passes == 0 {
            return 1.0;
        }
        let per_pass = path_len.max(1) as f32;
        ((self.pass as f32 + self.node as f32 / per_pass) / self.config.passes as f32).min(1.0)
    }

    /// Processa até `budget` nós. Retorna `true` se o caminho foi modificado.
    #[allow(clippy::too_many_arguments)]
    pub fn process(
        &mut self,
        steps: &mut Vec<WeaveStepRecord>,
        usage: &mut [u16],
        canvas: &mut CanvasStateSoA,
        matrix: &SparseChordMatrixCSR,
        evaluator: &OpticalModelEvaluator,
        spools: &[SpoolColor],
        coverage: f32,
        budget: usize,
    ) -> bool {
        let mut changed = false;
        let mut processed = 0;
        while !self.done && processed < budget {
            if self.node >= steps.len() {
                self.pass += 1;
                if self.pass >= self.config.passes || self.improved_in_pass == 0 {
                    self.done = true;
                    break;
                }
                self.node = 1;
                self.improved_in_pass = 0;
                continue;
            }
            if self.refine_node(steps, usage, canvas, matrix, evaluator, spools, coverage) {
                changed = true;
                self.improved_in_pass += 1;
            }
            processed += 1;
        }
        changed
    }

    #[allow(clippy::too_many_arguments)]
    fn refine_node(
        &mut self,
        steps: &mut Vec<WeaveStepRecord>,
        usage: &mut [u16],
        canvas: &mut CanvasStateSoA,
        matrix: &SparseChordMatrixCSR,
        evaluator: &OpticalModelEvaluator,
        spools: &[SpoolColor],
        coverage: f32,
    ) -> bool {
        let i = self.node;
        let n_pins = matrix.pin_count;
        let max_rep = self.config.max_chord_repeats.max(1) as u16;
        let (a, p, b) = (
            steps[i - 1].from_pin as usize,
            steps[i - 1].to_pin as usize,
            steps[i].to_pin as usize,
        );
        let spool_id = steps[i - 1].spool_id;
        if steps[i].spool_id != spool_id || steps[i].from_pin as usize != p {
            self.node += 1;
            return false;
        }
        let Some(spool) = spools.iter().find(|s| s.id == spool_id).copied() else {
            self.node += 1;
            return false;
        };
        let chord = |u: usize, v: usize| -> Option<usize> {
            if u == v {
                return None;
            }
            let k = SparseChordMatrixCSR::try_canonical_chord_index(u, v, n_pins)?;
            if matrix.chord_slice(k).0.is_empty() {
                None
            } else {
                Some(k)
            }
        };
        let (Some(ka), Some(kb)) = (chord(a, p), chord(p, b)) else {
            self.node += 1;
            return false;
        };

        // 1. Retira as duas cordas do nó
        let (pa, wa) = matrix.chord_slice(ka);
        let (pb, wb) = matrix.chord_slice(kb);
        evaluator.remove_chord(canvas, pb, wb, &spool, coverage);
        evaluator.remove_chord(canvas, pa, wa, &spool, coverage);
        usage[ka] -= 1;
        usage[kb] -= 1;

        let gain_pair = |canvas: &CanvasStateSoA, k1: usize, k2: usize| -> f32 {
            let (p1, w1) = matrix.chord_slice(k1);
            let (p2, w2) = matrix.chord_slice(k2);
            evaluator.chord_marginal_gain(canvas, p1, w1, &spool, coverage)
                + evaluator.chord_marginal_gain(canvas, p2, w2, &spool, coverage)
        };
        let usage_ok = |usage: &[u16], k1: usize, k2: usize| -> bool {
            if k1 == k2 {
                usage[k1] + 2 <= max_rep
            } else {
                usage[k1] < max_rep && usage[k2] < max_rep
            }
        };

        // 2. Referência: recolocar o nó original
        let original = gain_pair(canvas, ka, kb);
        let mut best_gain = original;
        let mut best_q = p;
        let eps = 1e-7 + original.abs() * 1e-5;

        let window = self.config.window;
        let candidates: Box<dyn Iterator<Item = usize>> = if window == 0 || 2 * window + 1 >= n_pins
        {
            Box::new(0..n_pins)
        } else {
            Box::new((0..=2 * window).map(move |d| (p + n_pins + d - window) % n_pins))
        };
        for q in candidates {
            if q == p || q == a || q == b {
                continue;
            }
            let (Some(k1), Some(k2)) = (chord(a, q), chord(q, b)) else {
                continue;
            };
            if !usage_ok(usage, k1, k2) {
                continue;
            }
            let g = gain_pair(canvas, k1, k2);
            if g > best_gain + eps {
                best_gain = g;
                best_q = q;
            }
        }

        // 3. Remoção do nó: corda direta (a, b)
        let mut remove = false;
        if self.config.allow_removal && a != b {
            if let Some(kd) = chord(a, b) {
                if usage[kd] < max_rep {
                    let (pd, wd) = matrix.chord_slice(kd);
                    let g = evaluator.chord_marginal_gain(canvas, pd, wd, &spool, coverage);
                    if g > best_gain + eps {
                        best_gain = g;
                        remove = true;
                    }
                }
            }
        }

        if remove {
            let kd = chord(a, b).expect("corda direta validada");
            let (pd, wd) = matrix.chord_slice(kd);
            evaluator.apply_chord(canvas, pd, wd, &spool, coverage);
            usage[kd] += 1;
            steps[i - 1].to_pin = b as u16;
            steps[i - 1].gain = best_gain;
            steps.remove(i);
            self.total_removed += 1;
            // o nó seguinte passa a ocupar o índice `i`
            return true;
        }

        let (k1, k2) = if best_q == p {
            (ka, kb)
        } else {
            (chord(a, best_q).unwrap(), chord(best_q, b).unwrap())
        };
        let (p1, w1) = matrix.chord_slice(k1);
        let (p2, w2) = matrix.chord_slice(k2);
        let g1 = evaluator.chord_marginal_gain(canvas, p1, w1, &spool, coverage);
        evaluator.apply_chord(canvas, p1, w1, &spool, coverage);
        let g2 = evaluator.chord_marginal_gain(canvas, p2, w2, &spool, coverage);
        evaluator.apply_chord(canvas, p2, w2, &spool, coverage);
        usage[k1] += 1;
        usage[k2] += 1;
        self.node += 1;

        if best_q != p {
            steps[i - 1].to_pin = best_q as u16;
            steps[i - 1].gain = g1;
            steps[i].from_pin = best_q as u16;
            steps[i].gain = g2;
            self.total_moves += 1;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::optical_models::OpticalMixModelType;
    use crate::solvers::greedy::{GreedyConfig, GreedySolver};
    use crate::spool_scheduler::{SpoolScheduler, SpoolSwitchStrategy};
    use weaver_domain::{
        linear_to_srgb_channel, ColorErrorMetric, LinearRgbColor, LoomGeometry, LoomPhysicalSpec,
        PegSide, Pixels, RasterizerType,
    };

    fn error(c: &CanvasStateSoA) -> f64 {
        (0..c.num_pixels)
            .map(|p| {
                let d = linear_to_srgb_channel(c.current_c0[p])
                    - linear_to_srgb_channel(c.target_c0[p]);
                (d * d) as f64
            })
            .sum()
    }

    #[test]
    fn refinement_never_increases_error_and_keeps_path_continuous() {
        let res = 72u32;
        let loom = LoomGeometry::new(LoomPhysicalSpec::circle(400.0, 48, 2.0, 2.0, 10.0));
        let matrix = SparseChordMatrixCSR::build(
            &loom,
            Pixels(res),
            4,
            RasterizerType::XiaolinWuAntialiased,
        );
        let n = (res * res) as usize;
        let target: Vec<LinearRgbColor> = (0..n)
            .map(|i| {
                let x = (i as u32 % res) as f32 / res as f32 - 0.5;
                let y = (i as u32 / res) as f32 / res as f32 - 0.5;
                let v = if x * x + y * y < 0.06 { 0.08 } else { 0.85 };
                LinearRgbColor::new(v, v, v)
            })
            .collect();
        let mut canvas = CanvasStateSoA::from_target_and_background(
            res,
            res,
            &target,
            LinearRgbColor::WHITE,
            None,
        );
        let eval = OpticalModelEvaluator::new(
            OpticalMixModelType::PorterDuffOcclusion,
            ColorErrorMetric::CielabDeltaE2000,
        )
        .with_luma_only(true);
        let spools = vec![SpoolColor::new(0, LinearRgbColor::BLACK, 1.0)];
        let mut sched = SpoolScheduler::new(SpoolSwitchStrategy::FreeGreedy, 150, 0);
        let cfg = GreedyConfig {
            max_steps: 150,
            max_chord_repeats: 2,
            ..Default::default()
        };
        let mut greedy = GreedySolver::new(cfg, matrix.chord_count());
        let mut steps = Vec::new();
        while let Some(r) = greedy.step(&mut canvas, &mut sched, &matrix, &eval, &spools, 0.4) {
            steps.push(WeaveStepRecord {
                from_pin: r.from_pin,
                to_pin: r.to_pin,
                spool_id: r.spool_id,
                departure_winding: PegSide::Clockwise,
                arrival_winding: PegSide::Clockwise,
                gain: r.gain,
                score_normalized: r.score_normalized,
            });
        }
        let before = error(&canvas);
        let mut usage = greedy.all_chord_usages().to_vec();
        let mut refiner = PathRefiner::new(RefineConfig {
            passes: 3,
            ..Default::default()
        });
        while !refiner.is_done() {
            refiner.process(
                &mut steps,
                &mut usage,
                &mut canvas,
                &matrix,
                &eval,
                &spools,
                0.4,
                25,
            );
        }
        let after = error(&canvas);
        assert!(after <= before + 1e-3, "erro subiu: {before} -> {after}");
        for w in steps.windows(2) {
            assert_eq!(
                w[0].to_pin, w[1].from_pin,
                "caminho deve permanecer contínuo"
            );
        }
        assert!(usage.iter().all(|&u| u <= 2));

        // a tela incremental deve coincidir com a re-simulação do caminho final
        let mut replay = CanvasStateSoA::from_target_and_background(
            res,
            res,
            &target,
            LinearRgbColor::WHITE,
            None,
        );
        for s in &steps {
            let k = SparseChordMatrixCSR::try_canonical_chord_index(
                s.from_pin as usize,
                s.to_pin as usize,
                48,
            )
            .unwrap();
            let (px, wt) = matrix.chord_slice(k);
            eval.apply_chord(&mut replay, px, wt, &spools[0], 0.4);
        }
        for p in 0..n {
            assert!((replay.current_c0[p] - canvas.current_c0[p]).abs() < 1e-3);
        }
    }
}
