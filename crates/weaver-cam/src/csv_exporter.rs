//! Exportador de Coordenadas Mecânicas (`.csv`) para manufatura e inspeção de furação.

use weaver_domain::LoomGeometry;

/// Exporta a tabela de coordenadas mecânicas do tear em formato CSV de alta precisão (4 casas decimais).
///
/// Colunas geradas:
/// `pin_number,angle_deg,arc_length_mm,x_mm,y_mm,normal_x,normal_y,chord_to_next_mm,free_wall_mm`
pub fn generate_mechanical_csv(loom: &LoomGeometry) -> String {
    let mut out = String::from(
        "pin_number,angle_deg,arc_length_mm,x_mm,y_mm,normal_x,normal_y,chord_to_next_mm,free_wall_mm\n",
    );

    let pins = loom.pins();
    let n = pins.len();
    if n == 0 {
        return out;
    }

    let drill_diameter = loom.spec.drill_diameter_mm;

    for i in 0..n {
        let pin = &pins[i];
        let next_pin = &pins[(i + 1) % n];

        let chord_to_next_mm = if n > 1 {
            let dx = next_pin.position.0 - pin.position.0;
            let dy = next_pin.position.1 - pin.position.1;
            (dx * dx + dy * dy).sqrt()
        } else {
            0.0
        };

        let free_wall_mm = if n > 1 {
            chord_to_next_mm - drill_diameter
        } else {
            0.0
        };

        out.push_str(&format!(
            "{},{:.4},{:.4},{:.4},{:.4},{:.4},{:.4},{:.4},{:.4}\n",
            pin.index + 1,
            pin.angle_deg,
            pin.arc_length_mm,
            pin.position.0,
            pin.position.1,
            pin.normal.0,
            pin.normal.1,
            chord_to_next_mm,
            free_wall_mm
        ));
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use weaver_domain::LoomPhysicalSpec;

    #[test]
    fn test_generate_mechanical_csv_circle_711_2() {
        let spec = LoomPhysicalSpec::circle(711.2, 200, 2.0, 2.0, 15.0);
        let loom = LoomGeometry::new(spec);
        let csv = generate_mechanical_csv(&loom);

        let lines: Vec<&str> = csv.lines().collect();
        // 1 cabeçalho + 200 pinos = 201 linhas
        assert_eq!(lines.len(), 201);
        assert_eq!(
            lines[0],
            "pin_number,angle_deg,arc_length_mm,x_mm,y_mm,normal_x,normal_y,chord_to_next_mm,free_wall_mm"
        );

        // Pino 1: índice 0, ângulo 0°, x = 355.6, y = 0.0, normal = (1.0, 0.0)
        let p1_cols: Vec<&str> = lines[1].split(',').collect();
        assert_eq!(p1_cols[0], "1");
        assert_eq!(p1_cols[1], "0.0000");
        assert_eq!(p1_cols[2], "0.0000");
        assert_eq!(p1_cols[3], "355.6000");
        assert_eq!(p1_cols[4], "0.0000");
        assert_eq!(p1_cols[5], "1.0000");
        assert_eq!(p1_cols[6], "0.0000");

        let chord_1: f64 = p1_cols[7].parse().unwrap();
        let wall_1: f64 = p1_cols[8].parse().unwrap();

        // Corda teórica para N=200 em D=711.2: 2 * 355.6 * sin(0.9°) ≈ 11.1708 mm
        assert!((chord_1 - 11.1708).abs() < 0.005);
        // Parede livre: chord - 2.0 mm ≈ 9.1708 mm
        assert!((wall_1 - 9.1708).abs() < 0.005);
        assert!((wall_1 - (chord_1 - 2.0)).abs() < 1e-4);

        // Último pino (pino 200)
        let p200_cols: Vec<&str> = lines[200].split(',').collect();
        assert_eq!(p200_cols[0], "200");
    }
}
