//! Camada 2 (`weaver-solvers`): Solvers Greedy, Beam Search, Global NNLS/FISTA,
//! 5 Estratégias de Carretel e SSIM Incremental.
//!
//! Regra de Dependência da Clean Architecture: depende exclusivamente de `weaver-domain`.

pub mod optical_models;
pub mod solver_runner;
pub mod solvers;
pub mod spool_scheduler;
pub mod state_matrix;
pub mod telemetry_metrics;

use weaver_domain::PegSide;

pub use optical_models::{
    MetricWeights, OpticalMixModelType, OpticalModelEvaluator, SpoolColor,
};
pub use solver_runner::{
    SolverBackend, SolverProgress, SolverSession, SolverStatus, WeaveStepRecord,
};
pub use solvers::{
    BeamMove, BeamSearchConfig, BeamSearchSolver, BeamStepRecord, FistaStepRecord,
    GlobalFistaConfig, GlobalFistaSolver, GreedyChordCandidate, GreedyConfig, GreedySolver,
    GreedyStepRecord,
};
pub use spool_scheduler::{SpoolScheduler, SpoolSwitchStrategy};
pub use state_matrix::{compute_effective_alpha, CanvasStateSoA, SOA_SIMD_LANE_ALIGNMENT};
pub use telemetry_metrics::{
    BlockSSIMState, IncrementalMetricsTracker, TelemetrySnapshot, BLOCK_SIZE,
};

/// Candidate chord step produced by a solver.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CandidateChord {
    pub from_peg: u16,
    pub to_peg: u16,
    pub from_side: PegSide,
    pub to_side: PegSide,
    pub gain: f32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_chord_winding_and_gain() {
        let chord = CandidateChord {
            from_peg: 0,
            to_peg: 100,
            from_side: PegSide::CounterClockwise,
            to_side: PegSide::Clockwise,
            gain: 0.42,
        };
        assert_eq!(chord.from_peg, 0);
        assert_eq!(chord.to_peg, 100);
        assert!(chord.gain > 0.0);
    }
}
