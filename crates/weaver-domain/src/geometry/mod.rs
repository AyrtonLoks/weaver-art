//! Módulo de Geometria Computacional do Tear, Validação de Furação e Tangentes.

pub mod drilling;
pub mod loom;
pub mod tangents;

pub use drilling::{DrillHole, DrillingDiagnostic, DrillingStatus, DEFAULT_MIN_WALL_THRESHOLD_MM};
pub use loom::{
    CircularContour, LoomContour, LoomGeometry, LoomPhysicalSpec, LoomPin,
    LoomShape, PolygonContour,
};
pub use tangents::{
    compute_all_tangents, compute_tangent, PegTangents, TangentLine, WindingDirection,
};

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    #[test]
    fn circular_loom_perimeter_and_hole_spacing() {
        // Validação estrita solicitada na Task 1.1:
        // D = 711.2 mm, N = 200 pinos -> Perímetro = pi * D, Distância adjacente ~ 11.17 mm
        let spec = LoomPhysicalSpec::circle(711.2, 200, 2.0, 2.0, 15.0);
        let loom = LoomGeometry::new(spec);

        let expected_perimeter = PI * 711.2;
        assert!(
            (loom.perimeter() - expected_perimeter).abs() < 1e-9,
            "Perímetro calculado {} difere de pi * D {}",
            loom.perimeter(),
            expected_perimeter
        );

        let diag = loom.drilling_diagnostic();
        // Distância entre furos adjacentes para N = 200 pinos em círculo D = 711.2 mm:
        // d = D * sin(pi / N) = 711.2 * sin(pi / 200) = 11.17104... mm
        assert!(
            (diag.min_adjacent_distance_mm - 11.171).abs() < 0.01,
            "Distância adjacente {} esperada ~ 11.17 mm",
            diag.min_adjacent_distance_mm
        );
        assert_eq!(diag.status, DrillingStatus::Safe);
        assert!(diag.free_wall_mm > 9.0);
        assert_eq!(diag.holes.len(), 200);

        // Verifica que todos os pinos estão sobre a circunferência de raio R = 355.6 mm
        let r = 711.2 / 2.0;
        for i in 0..200 {
            let pos = loom.pin_position(i);
            let dist_from_center = (pos.0 * pos.0 + pos.1 * pos.1).sqrt();
            assert!(
                (dist_from_center - r).abs() < 1e-9,
                "Pino {} fora do raio da circunferência: dist = {}",
                i,
                dist_from_center
            );

            let normal = loom.normal_vector(i);
            let normal_len = (normal.0 * normal.0 + normal.1 * normal.1).sqrt();
            assert!((normal_len - 1.0).abs() < 1e-9);

            // Em um círculo centrado em (0,0), a normal externa é pos / |pos|
            assert!((normal.0 - pos.0 / r).abs() < 1e-9);
            assert!((normal.1 - pos.1 / r).abs() < 1e-9);
        }
    }

    #[test]
    fn square_loom_geometry() {
        let side = 500.0;
        let spec = LoomPhysicalSpec::square(side, 80, 2.0, 2.0, 10.0);
        let loom = LoomGeometry::new(spec);

        let expected_perimeter = 4.0 * side;
        assert!((loom.perimeter() - expected_perimeter).abs() < 1e-9);

        // Verifica pinos sobre o quadrado
        let h = side / 2.0;
        for i in 0..80 {
            let (x, y) = loom.pin_position(i);
            let on_v_edge = (x.abs() - h).abs() < 1e-6 && y.abs() <= h + 1e-6;
            let on_h_edge = (y.abs() - h).abs() < 1e-6 && x.abs() <= h + 1e-6;
            assert!(
                on_v_edge || on_h_edge,
                "Pino {} em ({}, {}) fora da borda quadrada",
                i,
                x,
                y
            );
        }
    }

    #[test]
    fn drilling_validation_warning_and_collision() {
        // Caso 1: Seguro (Safe)
        let spec_safe = LoomPhysicalSpec::circle(711.2, 200, 2.0, 2.0, 15.0);
        let loom_safe = LoomGeometry::new(spec_safe);
        let diag_safe = loom_safe.drilling_diagnostic();
        assert_eq!(diag_safe.status, DrillingStatus::Safe);
        assert!(diag_safe.is_safe());
        assert!(!diag_safe.is_collision());

        // Caso 2: Aviso de parede delgada (WarningThinWall)
        // 100 pinos num círculo de 50 mm -> Perímetro ~ 157 mm -> Passo ~ 1.57 mm. Broca de 1.0 mm -> Parede livre ~ 0.57 mm < 1.5 mm
        let spec_thin = LoomPhysicalSpec::circle(50.0, 100, 1.0, 1.0, 5.0);
        let loom_thin = LoomGeometry::new(spec_thin);
        let diag_thin = loom_thin.drilling_diagnostic();
        assert_eq!(diag_thin.status, DrillingStatus::WarningThinWall);
        assert!(!diag_thin.is_safe());
        assert!(!diag_thin.is_collision());

        // Caso 3: Colisão de broca (ErrorCollision)
        // 200 pinos num círculo de 50 mm -> Passo ~ 0.78 mm. Broca de 1.5 mm -> Parede livre negativa!
        let spec_collision = LoomPhysicalSpec::circle(50.0, 200, 1.5, 1.5, 5.0);
        let loom_collision = LoomGeometry::new(spec_collision);
        let diag_collision = loom_collision.drilling_diagnostic();
        assert_eq!(diag_collision.status, DrillingStatus::ErrorCollision);
        assert!(diag_collision.is_collision());
        assert!(diag_collision.free_wall_mm < 0.0);
    }

    #[test]
    fn exact_cylindrical_tangents_geometry() {
        let pin_radius = 1.0; // Broca/pino de diâmetro 2 mm -> raio 1.0 mm
        let c_a = (0.0, 0.0);
        let c_b = (100.0, 0.0); // Distância D = 100 mm

        let tangents = compute_all_tangents(c_a, c_b, pin_radius).expect("Tangentes válidas");

        // 1. Tangentes externas paralelas (CW->CW e CCW->CCW):
        // Devem ter comprimento exatamente igual a D = 100.0 mm
        assert!((tangents.outer_cw_cw.length - 100.0).abs() < 1e-9);
        assert!((tangents.outer_ccw_ccw.length - 100.0).abs() < 1e-9);

        // Direção deve ser exatamente horizontal (1.0, 0.0)
        assert!((tangents.outer_cw_cw.dir.0 - 1.0).abs() < 1e-9);
        assert!(tangents.outer_cw_cw.dir.1.abs() < 1e-9);

        // Pontos de contato na superfície do pino (distância do centro deve ser exatamente r_p)
        let dist_start_cw = ((tangents.outer_cw_cw.start.0 - c_a.0).powi(2)
            + (tangents.outer_cw_cw.start.1 - c_a.1).powi(2))
        .sqrt();
        assert!((dist_start_cw - pin_radius).abs() < 1e-9);

        let dist_end_cw = ((tangents.outer_cw_cw.end.0 - c_b.0).powi(2)
            + (tangents.outer_cw_cw.end.1 - c_b.1).powi(2))
        .sqrt();
        assert!((dist_end_cw - pin_radius).abs() < 1e-9);

        // 2. Tangentes internas cruzadas (CW->CCW e CCW->CW):
        // Comprimento teórico = sqrt(D^2 - (2*r_p)^2) = sqrt(10000 - 4) = sqrt(9996) ~ 99.979998 mm
        let expected_inner_len = (100.0 * 100.0 - 4.0 * pin_radius * pin_radius).sqrt();
        assert!(
            (tangents.inner_cw_ccw.length - expected_inner_len).abs() < 1e-9,
            "Comprimento da tangente cruzada {} difere de {}",
            tangents.inner_cw_ccw.length,
            expected_inner_len
        );
        assert!(
            (tangents.inner_ccw_cw.length - expected_inner_len).abs() < 1e-9,
            "Comprimento da tangente cruzada {} difere de {}",
            tangents.inner_ccw_cw.length,
            expected_inner_len
        );

        // Ângulo de desvio Delta phi = asin(2*r_p / D) = asin(2 / 100) = asin(0.02) ~ 0.020001 rad
        let expected_delta_phi = (2.0 * pin_radius / 100.0).asin();
        let actual_cos_phi = tangents.inner_cw_ccw.dir.0;
        let actual_sin_phi = tangents.inner_cw_ccw.dir.1.abs();
        assert!((actual_sin_phi - (2.0 * pin_radius / 100.0)).abs() < 1e-9);
        assert!((actual_cos_phi - expected_delta_phi.cos()).abs() < 1e-9);

        // Pontos de contato na tangente interna também devem estar na superfície de raio r_p
        let dist_inner_a = ((tangents.inner_cw_ccw.start.0 - c_a.0).powi(2)
            + (tangents.inner_cw_ccw.start.1 - c_a.1).powi(2))
        .sqrt();
        assert!((dist_inner_a - pin_radius).abs() < 1e-9);

        let dist_inner_b = ((tangents.inner_cw_ccw.end.0 - c_b.0).powi(2)
            + (tangents.inner_cw_ccw.end.1 - c_b.1).powi(2))
        .sqrt();
        assert!((dist_inner_b - pin_radius).abs() < 1e-9);

        // Vetor raio no ponto de contato deve ser ortogonal à direção da corda (produto escalar nulo)
        let radius_vec_a = (
            tangents.inner_cw_ccw.start.0 - c_a.0,
            tangents.inner_cw_ccw.start.1 - c_a.1,
        );
        let dot_a = radius_vec_a.0 * tangents.inner_cw_ccw.dir.0
            + radius_vec_a.1 * tangents.inner_cw_ccw.dir.1;
        assert!(
            dot_a.abs() < 1e-9,
            "Vetor raio no ponto A não é ortogonal à tangente: dot = {}",
            dot_a
        );

        // 3. Reciprocidade / Inversão de sentido
        let reversed = tangents.outer_cw_cw.reversed();
        assert_eq!(reversed.from_direction, WindingDirection::CounterClockwise);
        assert_eq!(reversed.to_direction, WindingDirection::CounterClockwise);
        assert_eq!(reversed.start, tangents.outer_cw_cw.end);
        assert_eq!(reversed.end, tangents.outer_cw_cw.start);
    }
}
