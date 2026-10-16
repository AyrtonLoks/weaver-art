//! Interface Unificada de Execução Passo-a-Passo (`solver_runner.rs`).

use std::sync::Arc;
use weaver_domain::{PegSide, SparseChordMatrixCSR};

use crate::optical_models::{OpticalModelEvaluator, SpoolColor};
use crate::solvers::{
    BeamSearchConfig, BeamSearchSolver, GlobalFistaConfig, GlobalFistaSolver, GreedyConfig,
    GreedySolver,
};
use crate::spool_scheduler::SpoolScheduler;
use crate::state_matrix::CanvasStateSoA;
use crate::telemetry_metrics::{IncrementalMetricsTracker, TelemetrySnapshot};

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
    pub telemetry: TelemetrySnapshot,
    pub active_spool_id: u8,
    pub total_switches: usize,
    pub batch_steps: Vec<WeaveStepRecord>,
}

pub enum SolverBackend {
    Greedy(GreedySolver),
    BeamSearch(BeamSearchSolver),
    GlobalFista(GlobalFistaSolver),
}

pub struct SolverSession {
    pub backend: SolverBackend,
    pub canvas: CanvasStateSoA,
    pub tracker: IncrementalMetricsTracker,
    pub scheduler: SpoolScheduler,
    pub matrix: Arc<SparseChordMatrixCSR>,
    pub evaluator: OpticalModelEvaluator,
    pub spools: Vec<SpoolColor>,
    pub alpha_eff: f32,
    pub status: SolverStatus,
    pub history_steps: Vec<WeaveStepRecord>,
    pub max_steps: usize,
}

impl SolverSession {
    pub fn new_greedy(
        config: GreedyConfig,
        canvas: CanvasStateSoA,
        matrix: Arc<SparseChordMatrixCSR>,
        evaluator: OpticalModelEvaluator,
        scheduler: SpoolScheduler,
        spools: Vec<SpoolColor>,
        alpha_eff: f32,
    ) -> Self {
        let max_steps = config.max_steps;
        let tracker = IncrementalMetricsTracker::new(&canvas);
        let solver = GreedySolver::new(config, matrix.chord_count());

        Self {
            backend: SolverBackend::Greedy(solver),
            canvas,
            tracker,
            scheduler,
            matrix,
            evaluator,
            spools,
            alpha_eff,
            status: SolverStatus::Idle,
            history_steps: Vec::with_capacity(max_steps),
            max_steps,
        }
    }

    pub fn new_beam_search(
        config: BeamSearchConfig,
        canvas: CanvasStateSoA,
        matrix: Arc<SparseChordMatrixCSR>,
        evaluator: OpticalModelEvaluator,
        scheduler: SpoolScheduler,
        spools: Vec<SpoolColor>,
        alpha_eff: f32,
    ) -> Self {
        let max_steps = config.max_steps;
        let tracker = IncrementalMetricsTracker::new(&canvas);
        let solver = BeamSearchSolver::new(config, &canvas, matrix.chord_count());

        Self {
            backend: SolverBackend::BeamSearch(solver),
            canvas,
            tracker,
            scheduler,
            matrix,
            evaluator,
            spools,
            alpha_eff,
            status: SolverStatus::Idle,
            history_steps: Vec::with_capacity(max_steps),
            max_steps,
        }
    }

    pub fn new_global_fista(
        config: GlobalFistaConfig,
        canvas: CanvasStateSoA,
        matrix: Arc<SparseChordMatrixCSR>,
        evaluator: OpticalModelEvaluator,
        scheduler: SpoolScheduler,
        spools: Vec<SpoolColor>,
        alpha_eff: f32,
    ) -> Self {
        let max_steps = config.max_steps;
        let tracker = IncrementalMetricsTracker::new(&canvas);
        let solver = GlobalFistaSolver::new(config, &canvas, &matrix, &spools);

        Self {
            backend: SolverBackend::GlobalFista(solver),
            canvas,
            tracker,
            scheduler,
            matrix,
            evaluator,
            spools,
            alpha_eff,
            status: SolverStatus::Idle,
            history_steps: Vec::with_capacity(max_steps),
            max_steps,
        }
    }

    fn try_single_step(&mut self) -> Option<WeaveStepRecord> {
        match &mut self.backend {
            SolverBackend::Greedy(s) => s
                .step(
                    &mut self.canvas,
                    &mut self.tracker,
                    &mut self.scheduler,
                    &self.matrix,
                    &self.evaluator,
                    &self.spools,
                    self.alpha_eff,
                )
                .map(|r| WeaveStepRecord {
                    from_pin: r.from_pin,
                    to_pin: r.to_pin,
                    spool_id: r.spool_id,
                    departure_winding: r.departure_winding,
                    arrival_winding: r.arrival_winding,
                    gain: r.gain,
                    score_normalized: r.score_normalized,
                }),
            SolverBackend::BeamSearch(s) => s
                .step(
                    &mut self.canvas,
                    &mut self.tracker,
                    &mut self.scheduler,
                    &self.matrix,
                    &self.evaluator,
                    &self.spools,
                    self.alpha_eff,
                )
                .map(|r| WeaveStepRecord {
                    from_pin: r.from_pin,
                    to_pin: r.to_pin,
                    spool_id: r.spool_id,
                    departure_winding: r.departure_winding,
                    arrival_winding: r.arrival_winding,
                    gain: r.gain,
                    score_normalized: r.score_normalized,
                }),
            SolverBackend::GlobalFista(s) => s
                .step(
                    &mut self.canvas,
                    &mut self.tracker,
                    &mut self.scheduler,
                    &self.matrix,
                    &self.evaluator,
                    &self.spools,
                    self.alpha_eff,
                )
                .map(|r| WeaveStepRecord {
                    from_pin: r.from_pin,
                    to_pin: r.to_pin,
                    spool_id: r.spool_id,
                    departure_winding: r.departure_winding,
                    arrival_winding: r.arrival_winding,
                    gain: r.gain,
                    score_normalized: r.score_normalized,
                }),
        }
    }

    pub fn step_batch(&mut self, batch_size: usize) -> SolverProgress {
        if self.status == SolverStatus::Paused
            || self.status == SolverStatus::Done
            || self.status == SolverStatus::Aborted
        {
            return self.current_progress(Vec::new());
        }

        self.status = SolverStatus::Running;
        let mut batch_steps = Vec::with_capacity(batch_size);

        for _ in 0..batch_size {
            if self.history_steps.len() >= self.max_steps {
                self.status = SolverStatus::Done;
                break;
            }

            let mut step_opt = self.try_single_step();

            // Se o carretel da época atual saturou (ex: Amarelo já cobriu onde precisava),
            // avança para o próximo carretel no agendador (ex: Magenta -> Ciano -> Preto)
            while step_opt.is_none() && self.scheduler.skip_saturated_spool(&self.spools) {
                step_opt = self.try_single_step();
            }

            match step_opt {
                Some(step) => {
                    self.history_steps.push(step.clone());
                    batch_steps.push(step);
                }
                None => {
                    self.status = SolverStatus::Done;
                    break;
                }
            }

            if self.status == SolverStatus::Paused || self.status == SolverStatus::Aborted {
                break;
            }
        }

        if self.history_steps.len() >= self.max_steps && self.status == SolverStatus::Running {
            self.status = SolverStatus::Done;
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
            telemetry: self.tracker.current_snapshot(),
            active_spool_id: self.scheduler.active_spool_id,
            total_switches: self.scheduler.total_switches,
            batch_steps,
        }
    }
}
