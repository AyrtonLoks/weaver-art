//! Gerador de G-Code CNC para Furação do Aro (ISO / GRBL / Mach3).
//!
//! Suporta ciclo de furação simples `G81` e ciclo de furação profunda com quebra de cavaco / pica-pau `G83`.

use weaver_domain::LoomGeometry;

/// Parâmetros de usinagem CNC para furação do aro.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GcodeDrillingParams {
    /// Rotação do fuso (Spindle) em RPM (ex: 12000).
    pub spindle_rpm: u32,
    /// Avanço de penetração (Plunge feedrate) em mm/min (ex: 300.0).
    pub plunge_feed_mm_min: f64,
    /// Altura de plano de segurança Z em mm acima da peça (ex: 5.0).
    pub safe_z_mm: f64,
    /// Profundidade total de penetração do furo em mm (ex: 10.0 ou 12.0).
    pub drill_depth_mm: f64,
    /// Incremento de corte por picada (Peck depth) em mm para ciclo `G83`.
    /// Se `None` ou `<= 0.0`, utiliza ciclo simples `G81`.
    pub peck_depth_mm: Option<f64>,
    /// Altura do plano de retração R em mm acima da peça (ex: 1.0 ou 2.0).
    pub retract_r_mm: f64,
}

impl Default for GcodeDrillingParams {
    fn default() -> Self {
        Self {
            spindle_rpm: 12000,
            plunge_feed_mm_min: 300.0,
            safe_z_mm: 5.0,
            drill_depth_mm: 10.0,
            peck_depth_mm: Some(2.0),
            retract_r_mm: 1.0,
        }
    }
}

/// Gera o programa G-Code completo padronizado ISO/GRBL/Mach3 para furação CNC do aro.
///
/// A furação percorre todos os pinos em ordem sequencial perimétrica ($0 \dots N-1$),
/// minimizando os deslocamentos em vazio do cabeçote da máquina.
pub fn generate_drilling_gcode(loom: &LoomGeometry, params: &GcodeDrillingParams) -> String {
    let pins = loom.pins();
    let n = pins.len();

    let safe_z = params.safe_z_mm.abs();
    let z_depth = params.drill_depth_mm.abs();
    let r_plane = params.retract_r_mm.abs();
    let feed = params.plunge_feed_mm_min;

    let use_peck = match params.peck_depth_mm {
        Some(q) => q > 0.0,
        None => false,
    };
    let peck_q = params.peck_depth_mm.unwrap_or(0.0).abs();

    let cycle_name = if use_peck {
        format!("G83 Ciclo Pica-Pau (Q = {:.2} mm)", peck_q)
    } else {
        "G81 Ciclo de Furacao Simples".to_string()
    };

    let mut out = String::with_capacity(n * 80 + 512);

    // Cabeçalho de segurança e metadados
    out.push_str("( ========================================================= )\n");
    out.push_str("( Weaver Art -- Programa CNC de Furacao do Aro             )\n");
    out.push_str(&format!(
        "( Total de Furos: {}, Broca: Ø {:.2} mm, Pinos: {} )\n",
        n, loom.spec.drill_diameter_mm, loom.spec.peg_count
    ));
    out.push_str(&format!(
        "( Fuso: {} RPM, Avanco: {:.1} mm/min, Ciclo: {} )\n",
        params.spindle_rpm, feed, cycle_name
    ));
    out.push_str(&format!(
        "( Z Seguro: {:.2} mm, Profundidade Z: -{:.2} mm, Plano R: {:.2} mm )\n",
        safe_z, z_depth, r_plane
    ));
    out.push_str("( ========================================================= )\n\n");

    // Inicialização da máquina
    out.push_str("G21 ( Unidades em milimetros )\n");
    out.push_str("G90 ( Coordenadas absolutas )\n");
    out.push_str("G17 ( Plano de trabalho XY )\n");
    out.push_str("G94 ( Avanco em mm/min )\n");
    out.push_str(&format!("S{} M03 ( Liga fuso sentido horario )\n", params.spindle_rpm));
    out.push_str(&format!("G00 Z{:.4} ( Posiciona em Z seguro )\n\n", safe_z));

    // Ciclo de furação sequencial
    if n > 0 {
        out.push_str("( --- Inicio da Furacao Perimetrica Sequencial --- )\n");
        for (i, pin) in pins.iter().enumerate() {
            let x = pin.position.0;
            let y = pin.position.1;

            if use_peck {
                out.push_str(&format!(
                    "G83 X{:.4} Y{:.4} Z-{:.4} R{:.4} Q{:.4} F{:.1} ( Furo {}/{} )\n",
                    x,
                    y,
                    z_depth,
                    r_plane,
                    peck_q,
                    feed,
                    i + 1,
                    n
                ));
            } else {
                out.push_str(&format!(
                    "G81 X{:.4} Y{:.4} Z-{:.4} R{:.4} F{:.1} ( Furo {}/{} )\n",
                    x,
                    y,
                    z_depth,
                    r_plane,
                    feed,
                    i + 1,
                    n
                ));
            }
        }
        out.push_str("( --- Fim da Sequencia de Furacao --- )\n\n");
    }

    // Encerramento seguro
    out.push_str("G80 ( Cancela ciclo enlatado de furacao )\n");
    out.push_str(&format!("G00 Z{:.4} ( Retrai para Z seguro )\n", safe_z));
    out.push_str("M05 ( Desliga fuso )\n");
    out.push_str("M30 ( Fim do programa e rebobina )\n");

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use weaver_domain::LoomPhysicalSpec;

    #[test]
    fn test_generate_drilling_gcode_g83_circle_711_2() {
        let spec = LoomPhysicalSpec::circle(711.2, 200, 2.0, 2.0, 15.0);
        let loom = LoomGeometry::new(spec);

        let params = GcodeDrillingParams {
            spindle_rpm: 12000,
            plunge_feed_mm_min: 300.0,
            safe_z_mm: 5.0,
            drill_depth_mm: 10.0,
            peck_depth_mm: Some(2.0),
            retract_r_mm: 1.0,
        };

        let gcode = generate_drilling_gcode(&loom, &params);

        // Cabeçalho de segurança
        assert!(gcode.contains("G21 ( Unidades em milimetros )"));
        assert!(gcode.contains("G90 ( Coordenadas absolutas )"));
        assert!(gcode.contains("G17 ( Plano de trabalho XY )"));
        assert!(gcode.contains("G94 ( Avanco em mm/min )"));
        assert!(gcode.contains("S12000 M03"));
        assert!(gcode.contains("G00 Z5.0000"));

        // Ciclo G83
        assert!(gcode.contains("G83 X355.6000 Y0.0000 Z-10.0000 R1.0000 Q2.0000 F300.0"));

        // Contagem de furos
        let g83_count = gcode.lines().filter(|l| l.starts_with("G83")).count();
        assert_eq!(g83_count, 200);

        // Encerramento de segurança
        assert!(gcode.contains("G80 ( Cancela ciclo enlatado de furacao )"));
        assert!(gcode.contains("M05 ( Desliga fuso )"));
        assert!(gcode.contains("M30 ( Fim do programa e rebobina )"));
    }

    #[test]
    fn test_generate_drilling_gcode_g81_simple() {
        let spec = LoomPhysicalSpec::circle(400.0, 50, 2.0, 2.0, 10.0);
        let loom = LoomGeometry::new(spec);

        let params = GcodeDrillingParams {
            spindle_rpm: 15000,
            plunge_feed_mm_min: 400.0,
            safe_z_mm: 8.0,
            drill_depth_mm: 12.5,
            peck_depth_mm: None, // Sem peck -> G81
            retract_r_mm: 2.0,
        };

        let gcode = generate_drilling_gcode(&loom, &params);
        assert!(!gcode.contains("G83"));
        assert!(gcode.contains("G81"));
        let g81_count = gcode.lines().filter(|l| l.starts_with("G81")).count();
        assert_eq!(g81_count, 50);
        assert!(gcode.contains("Z-12.5000"));
        assert!(gcode.contains("R2.0000"));
        assert!(gcode.contains("F400.0"));
    }
}
