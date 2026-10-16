//! Camada 2 (`weaver-cam`): Paginador de Gabarito PDF/SVG A4 1:1, Tabela CSV
//! Mecânica, Gerador G-Code CNC G81/G83, Calculadora de BOM, Exportadores da Obra
//! (.svg, .json, .txt) e Codec de Retomada Stateless.
//!
//! Regra de Dependência da Clean Architecture: depende exclusivamente de `weaver-domain`.

pub mod artwork_exporter;
pub mod blueprint_tiler;
pub mod bom_calculator;
pub mod csv_exporter;
pub mod gcode_exporter;
pub mod pdf;
pub mod resume_codec;

pub use artwork_exporter::{
    export_artwork_svg, export_instructions_txt, export_project_json, SvgArtworkOptions,
    TextInstructionOptions,
};
pub use blueprint_tiler::{BlueprintConfig, BlueprintTiler, PaperOrientation, PaperSize, TileInfo};
pub use bom_calculator::{
    calculate_bom, calculate_single_step_length_mm, format_duration, BomConfig, BomEstimate,
    SpoolBomItem, SpoolInfo, TimeEstimate, WeavingStep,
};
pub use csv_exporter::generate_mechanical_csv;
pub use gcode_exporter::{generate_drilling_gcode, GcodeDrillingParams};
pub use pdf::{PathMode, PdfDocument, PdfPage, TextAlign};
pub use resume_codec::{
    base64url_decode, base64url_encode, compress_steps, compute_project_hash, decompress_steps,
    ProgressToken, ResumeCodecError,
};
use weaver_domain::Millimeters;

/// Physical drilling hole specification in 1:1 scale (`mm`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DrillHoleSpec {
    pub x_mm: Millimeters,
    pub y_mm: Millimeters,
    pub drill_diameter_mm: Millimeters,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;
    use weaver_domain::{LoomGeometry, LoomPhysicalSpec, WindingDirection};

    #[test]
    fn drill_hole_spec_dimensions_mm() {
        let hole = DrillHoleSpec {
            x_mm: Millimeters(10.0),
            y_mm: Millimeters(20.0),
            drill_diameter_mm: Millimeters(2.0),
        };
        assert_eq!(hole.drill_diameter_mm.0, 2.0);
    }

    #[test]
    fn integration_sprint_3_task_3_1_circle_711_2_200_pegs() {
        // Validação integrada da Task 3.1:
        // Aro de 711.2 mm com 200 pinos e broca de 2.0 mm
        let spec = LoomPhysicalSpec::circle(711.2, 200, 2.0, 2.0, 15.0);
        let loom = LoomGeometry::new(spec);

        // 1. Exportação e Validação do CSV Mecânico
        let csv = generate_mechanical_csv(&loom);
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines.len(), 201); // 1 header + 200 pinos
        assert_eq!(
            lines[0],
            "pin_number,angle_deg,arc_length_mm,x_mm,y_mm,normal_x,normal_y,chord_to_next_mm,free_wall_mm"
        );

        let p1: Vec<&str> = lines[1].split(',').collect();
        assert_eq!(p1[0], "1");
        assert_eq!(p1[1], "0.0000");
        assert_eq!(p1[3], "355.6000");
        assert_eq!(p1[4], "0.0000");
        assert_eq!(p1[5], "1.0000");
        assert_eq!(p1[6], "0.0000");

        let p1_chord: f64 = p1[7].parse().unwrap();
        let p1_wall: f64 = p1[8].parse().unwrap();
        assert!((p1_chord - 11.1708).abs() < 0.005);
        assert!((p1_wall - 9.1708).abs() < 0.005);

        // 2. Exportação e Validação do G-Code CNC (Ciclos G83 e G81)
        let gcode_params = GcodeDrillingParams {
            spindle_rpm: 12000,
            plunge_feed_mm_min: 300.0,
            safe_z_mm: 5.0,
            drill_depth_mm: 10.0,
            peck_depth_mm: Some(2.0),
            retract_r_mm: 1.0,
        };
        let gcode = generate_drilling_gcode(&loom, &gcode_params);
        assert!(gcode.contains("G21 ( Unidades em milimetros )"));
        assert!(gcode.contains("G90 ( Coordenadas absolutas )"));
        assert!(gcode.contains("S12000 M03"));
        assert!(gcode.contains("G00 Z5.0000"));
        assert_eq!(
            gcode.lines().filter(|l| l.starts_with("G83")).count(),
            200,
            "Deve conter exatamente 200 ciclos G83"
        );
        assert!(gcode.contains("G80 ( Cancela ciclo enlatado de furacao )"));
        assert!(gcode.contains("M05 ( Desliga fuso )"));
        assert!(gcode.contains("M30 ( Fim do programa e rebobina )"));

        // 3. Paginador de Gabarito 1:1 em Folhas A4
        let tiler_cfg = BlueprintConfig {
            paper_size: PaperSize::A4,
            orientation: PaperOrientation::Portrait,
            printer_margin_mm: 10.0,
            overlap_margin_mm: 15.0,
            rim_width_mm: Some(30.0),
            drill_diameter_mm: Some(2.0),
        };
        let tiler = BlueprintTiler::new(loom, tiler_cfg);

        assert_eq!(tiler.grid_cols, 5);
        assert_eq!(tiler.grid_rows, 3);
        assert_eq!(tiler.tiles.len(), 15);

        // Culling de páginas vazias no vão central
        let empty_interior_tiles = tiler.empty_interior_tiles();
        assert!(
            !empty_interior_tiles.is_empty(),
            "Deve conter páginas identificadas como empty_interior"
        );
        for empty_tile in &empty_interior_tiles {
            assert!(empty_tile.is_empty_interior);
            assert!(!empty_tile.is_active);
            assert!(empty_tile.pin_indices.is_empty());
        }

        // Exportação SVG Mestre 1:1
        let svg = tiler.to_master_svg();
        assert!(svg.starts_with("<svg"));
        assert!(svg.contains("Regua de Afericao de Escala 100.0 mm"));
        assert!(svg.contains("Folha A1"));
        assert!(svg.ends_with("</svg>\n"));

        // Exportação PDF Multi-Páginas 1:1
        let pdf_bytes = tiler.to_multipage_pdf();
        assert!(pdf_bytes.starts_with(b"%PDF-1.4"));
        let pdf_str = String::from_utf8_lossy(&pdf_bytes);
        assert!(pdf_str.contains("WEAVER ART -- GABARITO DE FURACAO 1:1"));
        assert!(pdf_str.contains("Regua de Afericao de Escala 100.0 mm"));
        assert!(pdf_str.contains("trailer\n"));
        assert!(pdf_str.ends_with("%%EOF\n"));
    }

    #[test]
    fn integration_sprint_3_task_3_2_bom_exporters_and_resume_codec() {
        // Validação integrada da Task 3.2:
        // Aro circular de 711.2 mm com 200 pinos e diâmetro de pinos de 2.0 mm
        let spec = LoomPhysicalSpec::circle(711.2, 200, 2.0, 2.0, 15.0);
        let loom = LoomGeometry::new(spec);

        let spools = vec![
            SpoolInfo::new(0, "Amarelo Dourado", "#ffd700"),
            SpoolInfo::new(1, "Preto Intenso", "#000000"),
        ];

        // Sequência realista de 20 passos: 10 passos Amarelo (camada 0) + 10 passos Preto (camada 1)
        let mut steps = Vec::new();
        let mut current_pin = 0u16;
        for i in 0..10 {
            let next_pin = ((current_pin as usize + 97) % 200) as u16;
            steps.push(WeavingStep::with_details(
                i,
                current_pin,
                next_pin,
                0, // Amarelo
                WindingDirection::Clockwise,
                WindingDirection::CounterClockwise,
                12000,
                0,
            ));
            current_pin = next_pin;
        }

        for i in 10..20 {
            let next_pin = ((current_pin as usize + 103) % 200) as u16;
            steps.push(WeavingStep::with_details(
                i,
                current_pin,
                next_pin,
                1, // Preto
                WindingDirection::CounterClockwise,
                WindingDirection::Clockwise,
                25000,
                1,
            ));
            current_pin = next_pin;
        }

        // 1. Validação da Calculadora de BOM e Tempo Manual
        let bom_config = BomConfig {
            safety_margin_ratio: 0.10,
            standard_spool_length_meters: 500.0,
            seconds_per_step: 4.5,
            knot_and_switch_time_seconds: 90.0,
            tail_allowance_per_spool_mm: 300.0,
        };

        let bom = calculate_bom(&loom, &steps, &bom_config, &spools);
        assert_eq!(bom.total_chords, 20);
        assert!(bom.total_raw_length_meters > 14.0 && bom.total_raw_length_meters < 15.0);
        assert!(bom.total_length_with_margin_meters > bom.total_raw_length_meters);

        // Verifica precisão trigonométrica de cada corda (comprimento linear ~ 711 mm + arco pi*1mm)
        for s in &steps {
            let len_mm = calculate_single_step_length_mm(&loom, s);
            let expected_min = (711.2 * 0.95) + PI * 1.0;
            assert!(len_mm > expected_min, "Corda {} mm menor que o esperado", len_mm);
        }

        // Tempo manual: 20 passos * 4.5s = 90s tecendo; 2 amarrações (tie-ons) * 90s = 180s nós/trocas
        assert_eq!(bom.time_estimate.weaving_time_seconds, 90.0);
        assert_eq!(bom.time_estimate.knot_and_switch_time_seconds, 180.0);
        assert_eq!(bom.time_estimate.total_time_seconds, 270.0);
        assert_eq!(bom.time_estimate.formatted_total_time, "4 min");

        // 2. Validação do SVG Vetorial da Obra
        let svg_opts = SvgArtworkOptions::default();
        let svg = export_artwork_svg(&loom, &steps, &spools, &svg_opts);
        assert!(svg.starts_with("<svg"));
        assert!(svg.contains(r#"id="spool-0-epoch-0""#));
        assert!(svg.contains(r#"id="spool-1-epoch-1""#));
        assert!(svg.contains(r##"stroke="#ffd700""##));
        assert!(svg.contains(r##"stroke="#000000""##));
        assert!(svg.contains(r#"id="loom-pegs""#));
        assert!(svg.ends_with("</svg>\n"));

        // 3. Validação do Guia Textual de Instruções .txt
        let txt_opts = TextInstructionOptions::default();
        let txt = export_instructions_txt(&loom, &steps, &spools, &bom_config, &txt_opts);
        assert!(txt.contains("WEAVER ART — INSTRUÇÕES DE TECELAGEM"));
        assert!(txt.contains("CAMADA 1: CARRETEL #0 - AMARELO DOURADO"));
        assert!(txt.contains("CAMADA 2: CARRETEL #1 - PRETO INTENSO"));
        assert!(txt.contains("Passo 0001 | Pino"));
        assert!(txt.contains("Passo 0020 | Pino"));
        assert!(txt.contains("Sentido Anti-Horário"));

        // 4. Validação da Serialização Determinística do Projeto em JSON
        let json = export_project_json(&loom, &steps, &spools, &bom_config, Some("Projeto Vrellis"));
        assert!(json.contains(r#""schema_version": "1.0""#));
        assert!(json.contains(r#""title": "Projeto Vrellis""#));
        assert!(json.contains(r#""shape": "circular""#));
        assert!(json.contains(r#""total_steps": 20"#));
        assert!(json.contains(r#""status": "Safe""#));
        assert!(json.contains(r#""project_hash": ""#));

        // 5. Validação do Token de Progresso Stateless WA1
        let hash = compute_project_hash(&loom, &steps);
        assert_eq!(hash.len(), 16);
        let token = ProgressToken::new(&hash, 1, 15);
        let token_encoded = token.encode();
        assert_eq!(token_encoded, format!("WA1-{}-1-15", hash));
        let token_decoded = ProgressToken::decode(&token_encoded).unwrap();
        assert_eq!(token_decoded, token);

        // 6. Validação do Compressor Binário (Delta + RLE em Base64URL)
        let compressed = compress_steps(&steps, 200);
        assert!(!compressed.is_empty());
        let (decomp_pegs, decomp_steps) = decompress_steps(&compressed).unwrap();
        assert_eq!(decomp_pegs, 200);
        assert_eq!(decomp_steps.len(), steps.len());

        for (orig, dec) in steps.iter().zip(decomp_steps.iter()) {
            assert_eq!(dec.step_index, orig.step_index);
            assert_eq!(dec.from_pin, orig.from_pin);
            assert_eq!(dec.to_pin, orig.to_pin);
            assert_eq!(dec.spool_id, orig.spool_id);
            assert_eq!(dec.departure_winding, orig.departure_winding);
            assert_eq!(dec.arrival_winding, orig.arrival_winding);
            assert_eq!(dec.score_normalized, orig.score_normalized);
        }
    }
}
