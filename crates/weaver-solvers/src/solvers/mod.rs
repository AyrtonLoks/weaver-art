//! Motores de Otimização e Solvers de String Art (`crates/weaver-solvers/src/solvers/`).
//!
//! Contém os três motores fundamentais sobre a `SparseChordMatrixCSR` e o `CanvasStateSoA`:
//! 1. `greedy`: Algoritmo Guloso Iterativo com normalização por comprimento e desempate determinístico (RNF-02).
//! 2. `beam_search`: Busca em Feixe com pool fixo de $2 \times B$ estados e zero alocações na heap.
//! 3. `global_fista`: Otimização Global NNLS/FISTA Livre de Matriz + Roteamento Contínuo Euleriano e sub-camadas de Pintor.

pub mod beam_search;
pub mod global_fista;
pub mod greedy;
pub mod refine;

pub use beam_search::{BeamMove, BeamSearchConfig, BeamSearchSolver, BeamStepRecord};
pub use global_fista::{
    estimate_lipschitz_constant, matrix_free_adjoint, matrix_free_forward, quantize_chord_weights,
    route_eulerian_continuous_path, solve_fista_channel, FistaStepRecord, GlobalFistaConfig,
    GlobalFistaSolver,
};
pub use greedy::{GreedyChordCandidate, GreedyConfig, GreedySolver, GreedyStepRecord};
pub use refine::{PathRefiner, RefineConfig};
