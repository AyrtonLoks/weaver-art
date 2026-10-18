//! Motores de Otimização e Solvers de String Art (`crates/weaver-solvers/src/solvers/`).
//!
//! Contém os motores sobre a `SparseChordMatrixCSR` e o `CanvasStateSoA`:
//! 1. `greedy`: Algoritmo Guloso Iterativo com normalização por comprimento e desempate determinístico (RNF-02).
//! 2. `beam_search`: Busca em Feixe com pool fixo de $2 \times B$ estados e zero alocações na heap.

pub mod beam_search;
pub mod greedy;
pub mod refine;

pub use beam_search::{BeamMove, BeamSearchConfig, BeamSearchSolver, BeamStepRecord};
pub use greedy::{GreedyChordCandidate, GreedyConfig, GreedySolver, GreedyStepRecord};
pub use refine::{PathRefiner, RefineConfig};

