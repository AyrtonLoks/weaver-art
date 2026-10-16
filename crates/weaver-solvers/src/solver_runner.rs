//! Interface Unificada de Execução Passo-a-Passo (`solver_runner.rs`).
//!
//! Fornece a máquina de execução incremental `SolverSession`, encapsulando qualquer um dos
//! três motores de otimização (Greedy, Beam Search ou Global FISTA) com interface uniforme
//! para Web Workers (WASM) e CLI nativo.
//!
//! Permite processar em lotes (`step_batch`), despachar métricas em tempo real e reagir
//! atomicamente a interrupções `PAUSE` ou `ABORT`.

use std::sync::Arc;
use weaver_domain::{PegSide, SparseChordMatrixCSR};

use crate::optical_models::{OpticalModelEvaluator, SpoolColor};
use crate::solvers::{
    BeamSearchConfig, BeamSearchSolver, GlobalFistaConfig, GlobalFistaSolver,
    GreedyConfig, GreedySolver,
};
use crate::spool_scheduler::SpoolScheduler;
use crate::state_matrix::CanvasStateSoA;
use crate::telemetry_metrics::{IncrementalMetricsTracker, TelemetrySnapshot};

/// Estado do ciclo de vida da execução do solver.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SolverStatus {
    Idle = 0,
    Running = 1,
    Paused = 2,
    Done = 3,
    Aborted = 4,
}

impl SolverStatus {
    /// Converte para o valor numérico inteiro canônico (ADR-003 / SharedArrayBuffer).
    #[inline]
    pub const fn as_i32(&self) -> i32 {
        *self as i32
    }
}

/// Registro de um passo individual de corda executado pelo solver.
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

/// Progresso emitido ao final de cada lote de passos processados.
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

/// Motores de resolução suportados pelo `SolverSession`.
pub enum SolverBackend {
    Greedy(GreedySolver),
    BeamSearch(BeamSearchSolver),
    GlobalFista(GlobalFistaSolver),
}

/// Sessão orquestradora de execução do solver com suporte a lotes incrementais.
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
    /// Cria uma nova sessão com o backend Iterative Greedy.
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

    /// Cria uma nova sessão com o backend Beam Search.
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

    /// Cria uma nova sessão com o backend Global FISTA + Roteador Euleriano.
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

    /// Executa um lote de até `batch_size` passos, atualizando métricas e retornando o progresso.
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

            let step_opt: Option<WeaveStepRecord> = match &mut self.backend {
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
            };

            match step_opt {
                Some(step) => {
                    self.history_steps.push(step.clone());
                    batch_steps.push(step);
                }
                None => {
                    // Não há mais cordas válidas com ganho positivo
                    self.status = SolverStatus::Done;
                    break;
                }
            }

            // Verifica se houve sinal de interrupção durante o lote
            if self.status == SolverStatus::Paused || self.status == SolverStatus::Aborted {
                break;
            }
        }

        if self.history_steps.len() >= self.max_steps && self.status == SolverStatus::Running {
            self.status = SolverStatus::Done;
        }

        self.current_progress(batch_steps)
    }

    /// Pausa a execução incremental da sessão.
    pub fn pause(&mut self) {
        if self.status == SolverStatus::Running || self.status == SolverStatus::Idle {
            self.status = SolverStatus::Paused;
        }
    }

    /// Retoma uma sessão pausada.
    pub fn resume(&mut self) {
        if self.status == SolverStatus::Paused {
            self.status = SolverStatus::Running;
        }
    }

    /// Aborta permanentemente a sessão.
    pub fn abort(&mut self) {
        self.status = SolverStatus::Aborted;
    }

    /// Verifica se o processo foi concluído ou abortado.
    #[inline]
    pub fn is_finished(&self) -> bool {
        self.status == SolverStatus::Done || self.status == SolverStatus::Aborted
    }

    /// Retorna o snapshot de progresso atual com o lote fornecido.
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

#[cfg(test)]
mod tests {
    use super::*;
    use weaver_domain::{
        ColorErrorMetric, LinearRgbColor, LoomGeometry, LoomPhysicalSpec, Pixels,
        RasterizerType,
    };
    use crate::optical_models::OpticalMixModelType;
    use crate::spool_scheduler::SpoolSwitchStrategy;

    fn setup_runner_test(
        pin_count: usize,
        res: u32,
    ) -> (
        Arc<SparseChordMatrixCSR>,
        CanvasStateSoA,
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
        let matrix = Arc::new(SparseChordMatrixCSR::build(
            &loom,
            Pixels(res),
            3,
            RasterizerType::BresenhamBinary,
        ));

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
        let evaluator = OpticalModelEvaluator::new(
            OpticalMixModelType::PorterDuffOcclusion,
            ColorErrorMetric::LinearRgb,
        );
        let scheduler = SpoolScheduler::new(SpoolSwitchStrategy::FreeGreedy, 100, 0);
        let spools = vec![SpoolColor::new(0, LinearRgbColor::BLACK, 0.3)];

        (matrix, canvas, evaluator, scheduler, spools)
    }

    #[test]
    fn test_solver_session_step_batch_and_pause_resume() {
        let (matrix, canvas, evaluator, scheduler, spools) = setup_runner_test(24, 48);

        let config = GreedyConfig {
            max_steps: 30,
            max_chord_repeats: 2,
            length_exponent_gamma: 1.0,
            start_pin: 0,
            tabu_history_size: 0,
        };

        let mut session = SolverSession::new_greedy(
            config, canvas, matrix, evaluator, scheduler, spools, 0.2,
        );

        // Lote 1: 10 passos
        let prog1 = session.step_batch(10);
        assert_eq!(prog1.batch_steps.len(), 10);
        assert_eq!(prog1.current_step, 10);
        assert_eq!(session.status, SolverStatus::Running);

        // Pausa
        session.pause();
        assert_eq!(session.status, SolverStatus::Paused);

        // Tentativa de executar com status Paused não avança
        let prog_paused = session.step_batch(5);
        assert_eq!(prog_paused.batch_steps.len(), 0);
        assert_eq!(prog_paused.current_step, 10);

        // Retoma
        session.resume();
        assert_eq!(session.status, SolverStatus::Running);

        // Lote 2: mais 10 passos
        let prog2 = session.step_batch(10);
        assert_eq!(prog2.batch_steps.len(), 10);
        assert_eq!(prog2.current_step, 20);
    }
}
