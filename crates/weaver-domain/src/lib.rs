//! Camada 1 (`weaver-domain`): Geometria polimórfica, Tangentes CW/CCW, Furação,
//! Cores CIELAB/LinearRGB e Matriz Esparsa CSR.
//!
//! Regra de Dependência da Clean Architecture: este crate não depende de nenhum
//! outro crate interno.

pub mod color;
pub mod geometry;
pub mod matrix;

pub use color::{
    delta_e_2000, delta_e_2000_parametric, delta_e_76, gamma_to_linear_channel,
    linear_rgb_distance, linear_to_gamma_channel, linear_to_srgb_channel,
    luminance_weighted_distance, redmean_distance, srgb_to_linear_channel, ColorErrorMetric,
    ColorParseError, GamutHull, LabColor, LinearRgbColor, SrgbColor, XyzColor,
    DEFAULT_LUMINANCE_WEIGHT, D65_XN, D65_YN, D65_ZN, LUMA_REC709_B, LUMA_REC709_G, LUMA_REC709_R,
};

pub use geometry::{
    compute_all_tangents, compute_tangent, CircularContour, DrillHole, DrillingDiagnostic,
    DrillingStatus, EllipticalContour, LoomContour, LoomGeometry, LoomPhysicalSpec, LoomPin,
    LoomShape, PegTangents, PolygonContour, TangentLine, WindingDirection,
    DEFAULT_MIN_WALL_THRESHOLD_MM,
};

pub use matrix::{
    circular_pin_distance, rasterize_bresenham, rasterize_xiaolin_wu, BresenhamRasterizer,
    LineRasterizer, LoomGridMapping, RasterizerType, SparseChordMatrixCSR, XiaolinWuRasterizer,
    FULL_COVERAGE_WEIGHT,
};

/// Physical dimension in millimetres (`mm`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Millimeters(pub f32);

impl Millimeters {
    #[inline]
    pub fn as_f64(self) -> f64 {
        self.0 as f64
    }
}

impl From<f32> for Millimeters {
    #[inline]
    fn from(val: f32) -> Self {
        Self(val)
    }
}

impl From<f64> for Millimeters {
    #[inline]
    fn from(val: f64) -> Self {
        Self(val as f32)
    }
}

/// Discrete simulation grid dimension in pixels (`Px`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pixels(pub u32);

/// Tangency winding side around a cylindrical peg (`+1` CCW, `-1` CW).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(i8)]
pub enum PegSide {
    CounterClockwise = 1,
    Clockwise = -1,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_units_and_peg_side() {
        let d = Millimeters(600.0);
        let res = Pixels(500);
        assert_eq!(d.0, 600.0);
        assert_eq!(d.as_f64(), 600.0);
        assert_eq!(res.0, 500);
        assert_eq!(PegSide::CounterClockwise as i8, 1);
        assert_eq!(PegSide::Clockwise as i8, -1);

        // Conversão bidirecional entre PegSide e WindingDirection
        let w_cw: WindingDirection = PegSide::Clockwise.into();
        assert_eq!(w_cw, WindingDirection::Clockwise);
        let s_cw: PegSide = w_cw.into();
        assert_eq!(s_cw, PegSide::Clockwise);

        let w_ccw: WindingDirection = PegSide::CounterClockwise.into();
        assert_eq!(w_ccw, WindingDirection::CounterClockwise);
        let s_ccw: PegSide = w_ccw.into();
        assert_eq!(s_ccw, PegSide::CounterClockwise);
    }

    #[test]
    fn integration_csr_matrix_test_loom_n50() {
        // Validação da Task 1.3:
        // Tear de teste pequeno com N = 50 pinos, diâmetro de 400 mm e resolução 200x200 px.
        let n = 50;
        let res = Pixels(200);
        let min_gap = 5;
        let spec = LoomPhysicalSpec::circle(400.0, n, 2.0, 2.0, 10.0);
        let loom = LoomGeometry::new(spec);

        // 1. Constrói com Xiaolin Wu (anti-aliasing)
        let matrix_wu =
            SparseChordMatrixCSR::build(&loom, res, min_gap, RasterizerType::XiaolinWuAntialiased);

        // 2. Constrói com Bresenham (binário)
        let matrix_bres =
            SparseChordMatrixCSR::build(&loom, res, min_gap, RasterizerType::BresenhamBinary);

        let total_pairs = (n * (n - 1)) / 2;
        assert_eq!(matrix_wu.chord_count(), total_pairs);
        assert_eq!(matrix_bres.chord_count(), total_pairs);
        assert_eq!(matrix_wu.chord_offsets.len(), total_pairs + 1);
        assert_eq!(matrix_bres.chord_offsets.len(), total_pairs + 1);

        // Número de pares pulados:
        // Para cada pino a, pinos b com circular_pin_distance(a, b, 50) < 5 são:
        // distâncias 1, 2, 3, 4 em ambos os sentidos -> 8 pinos por pino -> 50 * 8 / 2 = 200 pares.
        let skipped_pairs = (n * (min_gap - 1) * 2) / 2;
        let expected_active = total_pairs - skipped_pairs;
        assert_eq!(matrix_wu.non_empty_chord_count(), expected_active);
        assert_eq!(matrix_bres.non_empty_chord_count(), expected_active);

        let grid_total_pixels = 200 * 200;

        // Validação para cada corda
        for a in 0..n {
            for b in (a + 1)..n {
                let dist = circular_pin_distance(a, b, n);
                let (wu_pixels, wu_weights) = matrix_wu.get_chord(a, b);
                let (bres_pixels, bres_weights) = matrix_bres.get_chord(a, b);

                if dist < min_gap {
                    assert!(
                        wu_pixels.is_empty(),
                        "Corda ({}, {}) com dist {} < {} deveria ser vazia",
                        a,
                        b,
                        dist,
                        min_gap
                    );
                    assert!(bres_pixels.is_empty());
                } else {
                    assert!(
                        !wu_pixels.is_empty(),
                        "Corda ativa ({}, {}) não deveria ser vazia",
                        a,
                        b
                    );
                    assert!(!bres_pixels.is_empty());

                    // Reciprocidade: get_chord(a, b) == get_chord(b, a)
                    assert_eq!((wu_pixels, wu_weights), matrix_wu.get_chord(b, a));
                    assert_eq!((bres_pixels, bres_weights), matrix_bres.get_chord(b, a));

                    // Limites da grade
                    for &p in wu_pixels {
                        assert!(p < grid_total_pixels);
                    }
                    for &p in bres_pixels {
                        assert!(p < grid_total_pixels);
                    }

                    // Pesos de Bresenham devem ser todos 255 (binário)
                    for &w in bres_weights {
                        assert_eq!(w, FULL_COVERAGE_WEIGHT);
                    }

                    // Pesos de Xiaolin Wu devem ser positivos em [1, 255]
                    for &w in wu_weights {
                        assert!(w > 0);
                    }
                }
            }
        }

        // Wu produz mais amostras por corda que Bresenham devido ao antialiasing sub-pixel
        assert!(
            matrix_wu.total_pixel_entries() > matrix_bres.total_pixel_entries(),
            "Xiaolin Wu deveria gerar mais entradas de sub-pixel que Bresenham"
        );

        // Validação de iterador
        let iter_count = matrix_wu.iter_chords().count();
        assert_eq!(iter_count, expected_active);
    }
}
