//! Interface Unificada de Execução Passo-a-Passo (`solver_runner.rs`).
//!
//! Uma sessão percorre as fases:
//! 1. **Construção** (`Construct`): o backend (guloso, beam search ou FISTA) gera o caminho;
//! 2. **Refinamento** (`Refine`, opcional, só no guloso): [`PathRefiner`] realoca/remove nós;
//! 3. **Preenchimento** (`Fill`): se o refinamento liberou linhas, o guloso continua do fim do
//!    caminho até atingir o limite ou não haver mais ganho;
//! 4. `Done`.
//!
//! Quando o refinamento altera passos já emitidos, `path_revision` é incrementado para que a
//! camada de adaptação reescreva o `WeavingPathBuffer` e o renderer redesenhe do zero.

use std::sync::Arc;
use weaver_domain::{LinearRgbColor, PegSide, SparseChordMatrixCSR};

use crate::optical_models::{OpticalModelEvaluator, SpoolColor};
use crate::solvers::{
    BeamSearchConfig, BeamSearchSolver, GlobalFistaConfig, GlobalFistaSolver, GreedyConfig,
    GreedySolver, PathRefiner, RefineConfig,
};
use crate::spool_scheduler::SpoolScheduler;
use crate::state_matrix::CanvasStateSoA;
use crate::telemetry_metrics::{MetricsTracker, TelemetrySnapshot};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SolverStatus {
    Idle = 0,
    Running = 1,
    Paused = 2,
    Done = 3,
    Aborted = 4,
}

impl SolverStatus {
    #[inline]
    pub const fn as_i32(&self) -> i32 {
        *self as i32
    }
}

/// Fase atual da sessão.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SolverPhase {
    Construct,
    Refine,
    Fill,
    Finished,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WeaveStepRecord {
    pub from_pin: u16,
    pub to_pin: u16,
    pub spool_id: u8,
    pub departure_winding: PegSide,
    pub arrival_winding: PegSide,
    pub gain: f32,
    pub score_normalized: u16,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SolverProgress {
    pub current_step: usize,
    pub total_steps: usize,
    pub status: SolverStatus,
    pub phase: SolverPhase,
    pub telemetry: TelemetrySnapshot,
    pub active_spool_id: u8,
    pub total_switches: usize,
    /// Passos novos anexados ao fim do caminho neste lote.
    pub batch_steps: Vec<WeaveStepRecord>,
    /// Revisão do caminho: muda quando passos anteriores foram reescritos.
    pub path_revision: u32,
}

pub enum SolverBackend {
    Greedy(GreedySolver),
    BeamSearch(BeamSearchSolver),
    GlobalFista(GlobalFistaSolver),
}

pub struct SolverSession {
    pub backend: SolverBackend,
    pub canvas: CanvasStateSoA,
    pub tracker: MetricsTracker,
    pub scheduler: SpoolScheduler,
    pub matrix: Arc<SparseChordMatrixCSR>,
    pub evaluator: OpticalModelEvaluator,
    pub spools: Vec<SpoolColor>,
    /// Cobertura física do fio por pixel (`compute_effective_alpha` com α = 1).
    pub coverage: f32,
    pub status: SolverStatus,
    pub phase: SolverPhase,
    pub history_steps: Vec<WeaveStepRecord>,
    pub max_steps: usize,
    pub refiner: Option<PathRefiner>,
    pub path_revision: u32,
}

fn to_record(
    from_pin: u16,
    to_pin: u16,
    spool_id: u8,
    departure_winding: PegSide,
    arrival_winding: PegSide,
    gain: f32,
    score_normalized: u16,
) -> WeaveStepRecord {
    WeaveStepRecord {
        from_pin,
        to_pin,
        spool_id,
        departure_winding,
        arrival_winding,
        gain,
        score_normalized,
    }
}

impl SolverSession {
    #[allow(clippy::too_many_arguments)]
    fn build(
        backend: SolverBackend,
        canvas: CanvasStateSoA,
        matrix: Arc<SparseChordMatrixCSR>,
        evaluator: OpticalModelEvaluator,
        scheduler: SpoolScheduler,
        spools: Vec<SpoolColor>,
        coverage: f32,
        max_steps: usize,
    ) -> Self {
        let tracker = MetricsTracker::new(&canvas);
        Self {
            backend,
            canvas,
            tracker,
            scheduler,
            matrix,
            evaluator,
            spools,
            coverage,
            status: SolverStatus::Idle,
            phase: SolverPhase::Construct,
            history_steps: Vec::with_capacity(max_steps),
            max_steps,
            refiner: None,
            path_revision: 0,
        }
    }

    pub fn new_greedy(
        config: GreedyConfig,
        canvas: CanvasStateSoA,
        matrix: Arc<SparseChordMatrixCSR>,
        evaluator: OpticalModelEvaluator,
        scheduler: SpoolScheduler,
        spools: Vec<SpoolColor>,
        coverage: f32,
    ) -> Self {
        let max_steps = config.max_steps;
        let solver = GreedySolver::new(config, matrix.chord_count());
        Self::build(
            SolverBackend::Greedy(solver),
            canvas,
            matrix,
            evaluator,
            scheduler,
            spools,
            coverage,
            max_steps,
        )
    }

    pub fn new_beam_search(
        config: BeamSearchConfig,
        canvas: CanvasStateSoA,
        matrix: Arc<SparseChordMatrixCSR>,
        evaluator: OpticalModelEvaluator,
        scheduler: SpoolScheduler,
        spools: Vec<SpoolColor>,
        coverage: f32,
    ) -> Self {
        let max_steps = config.max_steps;
        let solver = BeamSearchSolver::new(config, &canvas, matrix.chord_count());
        Self::build(
            SolverBackend::BeamSearch(solver),
            canvas,
            matrix,
            evaluator,
            scheduler,
            spools,
            coverage,
            max_steps,
        )
    }

    pub fn new_global_fista(
        config: GlobalFistaConfig,
        canvas: CanvasStateSoA,
        matrix: Arc<SparseChordMatrixCSR>,
        evaluator: OpticalModelEvaluator,
        scheduler: SpoolScheduler,
        spools: Vec<SpoolColor>,
        coverage: f32,
    ) -> Self {
        let max_steps = config.max_steps;
        let solver = GlobalFistaSolver::new(config, &canvas, &matrix, &spools);
        Self::build(
            SolverBackend::GlobalFista(solver),
            canvas,
            matrix,
            evaluator,
            scheduler,
            spools,
            coverage,
            max_steps,
        )
    }

    /// Ativa o passe de refinamento após a construção (só para o guloso).
    pub fn with_refinement(mut self, config: RefineConfig) -> Self {
        if config.passes > 0 && matches!(self.backend, SolverBackend::Greedy(_)) {
            self.refiner = Some(PathRefiner::new(config));
        }
        self
    }

    /// Define a imagem de referência das métricas (foto enquadrada sem realces).
    pub fn set_metrics_reference(&mut self, reference: &[LinearRgbColor]) {
        self.tracker.set_reference(reference);
        self.tracker.refresh(&self.canvas);
    }

    fn try_single_step(&mut self) -> Option<WeaveStepRecord> {
        let (canvas, sched, m, e, sp, cov) = (
            &mut self.canvas,
            &mut self.scheduler,
            &*self.matrix,
            &self.evaluator,
            &self.spools[..],
            self.coverage,
        );
        match &mut self.backend {
            SolverBackend::Greedy(s) => s.step(canvas, sched, m, e, sp, cov).map(|r| {
                to_record(
                    r.from_pin,
                    r.to_pin,
                    r.spool_id,
                    r.departure_winding,
                    r.arrival_winding,
                    r.gain,
                    r.score_normalized,
                )
            }),
            SolverBackend::BeamSearch(s) => s.step(canvas, sched, m, e, sp, cov).map(|r| {
                to_record(
                    r.from_pin,
                    r.to_pin,
                    r.spool_id,
                    r.departure_winding,
                    r.arrival_winding,
                    r.gain,
                    r.score_normalized,
                )
            }),
            SolverBackend::GlobalFista(s) => s.step(canvas, sched, m, e, sp, cov).map(|r| {
                to_record(
                    r.from_pin,
                    r.to_pin,
                    r.spool_id,
                    r.departure_winding,
                    r.arrival_winding,
                    r.gain,
                    r.score_normalized,
                )
            }),
        }
    }

    /// Avança a construção/preenchimento em até `batch_size` passos.
    fn construct_batch(&mut self, batch_size: usize, out: &mut Vec<WeaveStepRecord>) -> bool {
        for _ in 0..batch_size {
            if self.history_steps.len() >= self.max_steps {
                return false;
            }
            let mut step = self.try_single_step();
            while step.is_none() && self.scheduler.skip_saturated_spool(&self.spools) {
                step = self.try_single_step();
            }
            match step {
                Some(s) => {
                    self.history_steps.push(s.clone());
                    out.push(s);
                    self.tracker.on_step(&self.canvas);
                    if self.history_steps.len() >= self.max_steps {
                        return false;
                    }
                }
                None => return false,
            }
        }
        true
    }

    fn enter_after_construct(&mut self) {
        if self.refiner.as_ref().is_some_and(|r| !r.is_done()) && self.history_steps.len() > 2 {
            self.phase = SolverPhase::Refine;
        } else {
            self.finish();
        }
    }

    fn enter_fill(&mut self) {
        if let (SolverBackend::Greedy(g), Some(last)) =
            (&mut self.backend, self.history_steps.last())
        {
            g.current_pin = last.to_pin as usize;
            g.step_count = self.history_steps.len();
        }
        self.phase = SolverPhase::Fill;
    }

    fn finish(&mut self) {
        self.phase = SolverPhase::Finished;
        self.status = SolverStatus::Done;
        self.tracker.refresh(&self.canvas);
    }

    pub fn step_batch(&mut self, batch_size: usize) -> SolverProgress {
        if matches!(
            self.status,
            SolverStatus::Paused | SolverStatus::Done | SolverStatus::Aborted
        ) {
            return self.current_progress(Vec::new());
        }
        self.status = SolverStatus::Running;
        let mut batch_steps = Vec::with_capacity(batch_size);

        match self.phase {
            SolverPhase::Construct => {
                if !self.construct_batch(batch_size, &mut batch_steps) {
                    self.enter_after_construct();
                }
            }
            SolverPhase::Refine => {
                let refiner = self.refiner.as_mut().expect("refiner ativo");
                let usage = match &mut self.backend {
                    SolverBackend::Greedy(g) => g.chord_usage_mut(),
                    _ => unreachable!("refinamento só é ativado no guloso"),
                };
                let changed = refiner.process(
                    &mut self.history_steps,
                    usage,
                    &mut self.canvas,
                    &self.matrix,
                    &self.evaluator,
                    &self.spools,
                    self.coverage,
                    batch_size.max(1),
                );
                if changed {
                    self.path_revision = self.path_revision.wrapping_add(1);
                }
                self.tracker.on_step(&self.canvas);
                if refiner.is_done() {
                    self.tracker.refresh(&self.canvas);
                    if self.history_steps.len() < self.max_steps {
                        self.enter_fill();
                    } else {
                        self.finish();
                    }
                }
            }
            SolverPhase::Fill => {
                if !self.construct_batch(batch_size, &mut batch_steps) {
                    self.finish();
                }
            }
            SolverPhase::Finished => self.finish(),
        }

        self.current_progress(batch_steps)
    }

    pub fn pause(&mut self) {
        if self.status == SolverStatus::Running || self.status == SolverStatus::Idle {
            self.status = SolverStatus::Paused;
        }
    }

    pub fn resume(&mut self) {
        if self.status == SolverStatus::Paused {
            self.status = SolverStatus::Running;
        }
    }

    pub fn abort(&mut self) {
        self.status = SolverStatus::Aborted;
    }

    #[inline]
    pub fn is_finished(&self) -> bool {
        self.status == SolverStatus::Done || self.status == SolverStatus::Aborted
    }

    pub fn current_progress(&self, batch_steps: Vec<WeaveStepRecord>) -> SolverProgress {
        SolverProgress {
            current_step: self.history_steps.len(),
            total_steps: self.max_steps,
            status: self.status,
            phase: self.phase,
            telemetry: self.tracker.current_snapshot(),
            active_spool_id: self.scheduler.active_spool_id,
            total_switches: self.scheduler.total_switches,
            batch_steps,
            path_revision: self.path_revision,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::optical_models::OpticalMixModelType;
    use crate::spool_scheduler::SpoolSwitchStrategy;
    use weaver_domain::{ColorErrorMetric, LoomGeometry, LoomPhysicalSpec, Pixels, RasterizerType};

    fn session(max_steps: usize, refine_passes: usize) -> SolverSession {
        let res = 64u32;
        let loom = LoomGeometry::new(LoomPhysicalSpec::circle(300.0, 40, 2.0, 2.0, 10.0));
        let matrix = Arc::new(SparseChordMatrixCSR::build(
            &loom,
            Pixels(res),
            4,
            RasterizerType::XiaolinWuAntialiased,
        ));
        let target: Vec<LinearRgbColor> = (0..res * res)
            .map(|i| {
                let x = (i % res) as f32 / res as f32 - 0.5;
                let y = (i / res) as f32 / res as f32 - 0.5;
                let v = if x.abs() < 0.12 || y.abs() < 0.08 {
                    0.05
                } else {
                    0.9
                };
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
        let evaluator = OpticalModelEvaluator::new(
            OpticalMixModelType::PorterDuffOcclusion,
            ColorErrorMetric::CielabDeltaE2000,
        )
        .with_luma_only(true);
        let cfg = GreedyConfig {
            max_steps,
            max_chord_repeats: 2,
            ..Default::default()
        };
        SolverSession::new_greedy(
            cfg,
            canvas,
            matrix,
            evaluator,
            SpoolScheduler::new(SpoolSwitchStrategy::FreeGreedy, max_steps, 0),
            vec![SpoolColor::new(0, LinearRgbColor::BLACK, 1.0)],
            0.35,
        )
        .with_refinement(RefineConfig {
            passes: refine_passes,
            ..Default::default()
        })
    }

    #[test]
    fn session_runs_all_phases_and_improves_metrics() {
        let mut s = session(120, 2);
        let initial = s.current_progress(Vec::new()).telemetry;
        let mut seen_refine = false;
        let mut guard = 0;
        while !s.is_finished() {
            let p = s.step_batch(16);
            seen_refine |= p.phase == SolverPhase::Refine;
            guard += 1;
            assert!(guard < 10_000, "sessão não terminou");
        }
        let fin = s.current_progress(Vec::new());
        assert!(seen_refine, "fase de refinamento deveria ter ocorrido");
        assert_eq!(fin.phase, SolverPhase::Finished);
        assert!(fin.telemetry.ssim > initial.ssim);
        assert!(fin.telemetry.rmse < initial.rmse);
        assert!(s.history_steps.len() <= 120);
        for w in s.history_steps.windows(2) {
            assert_eq!(w[0].to_pin, w[1].from_pin);
        }
    }

    #[test]
    fn session_without_refinement_never_changes_revision() {
        let mut s = session(60, 0);
        while !s.is_finished() {
            let p = s.step_batch(20);
            assert_eq!(p.path_revision, 0);
            assert_ne!(p.phase, SolverPhase::Refine);
        }
        assert_eq!(s.history_steps.len(), 60);
    }
}
