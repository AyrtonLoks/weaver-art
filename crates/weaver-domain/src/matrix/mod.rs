//! Módulo de Matriz Esparsa CSR e Rasterização de Cordas (Bresenham e Xiaolin Wu).
//!
//! Implementa a estrutura de dados estática e contígua em memória que armazena todas
//! as cordas possíveis do tear, eliminando alocações dinâmicas e garantindo localidade
//! de cache L1/L2 para os motores de resolução (ADR-001 e RNF-03).

pub mod csr;
pub mod rasterizer;

pub use csr::SparseChordMatrixCSR;
pub use rasterizer::{
    circular_pin_distance, rasterize_bresenham, rasterize_xiaolin_wu, BresenhamRasterizer,
    LineRasterizer, LoomGridMapping, RasterizerType, XiaolinWuRasterizer,
    FULL_COVERAGE_WEIGHT,
};
