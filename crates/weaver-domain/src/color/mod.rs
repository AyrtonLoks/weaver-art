//! Módulo de gerenciamento de espaços de cor, métricas perceptuais e gamut mapping.
//!
//! Garante que a simulação óptica opere em Linear RGB e a avaliação de erro
//! perceptual opere em CIELAB (CIEDE2000), além de fornecer Gamut Mapping
//! por projeção no fecho convexo da paleta.

pub mod gamut;
pub mod metrics;
pub mod space;

pub use gamut::{GamutHull, DEFAULT_LUMINANCE_WEIGHT};
pub use metrics::{
    delta_e_2000, delta_e_2000_parametric, delta_e_76, linear_rgb_distance,
    luminance_weighted_distance, redmean_distance, ColorErrorMetric,
};
pub use space::{
    gamma_to_linear_channel, linear_to_gamma_channel, linear_to_srgb_channel,
    srgb_to_linear_channel, ColorParseError, LabColor, LinearRgbColor, SrgbColor, XyzColor,
    D65_XN, D65_YN, D65_ZN, LUMA_REC709_B, LUMA_REC709_G, LUMA_REC709_R,
};
