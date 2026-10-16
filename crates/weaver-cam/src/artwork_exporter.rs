//! Exportadores da Obra de String Art (`artwork_exporter.rs`).
//!
//! Fornece os 3 formatos canônicos de exportação e persistência da obra tecida:
//! 1. Vetor `.svg` da Obra: Agrupado em camadas `<g id="spool-k-epoch-m">` na ordem exata de empilhamento físico,
//!    com espessura real do fio em mm e coordenadas tangenciais contínuas.
//! 2. Instruções `.txt` Legíveis por Humanos: Guia passo a passo estruturado em blocos de cor com numeração clara.
//! 3. Projeto `.json` Completo: Serialização determinística de geometria, diagnóstico mecânico, BOM e passos.

use std::fmt::Write as FmtWrite;
use weaver_domain::{compute_tangent, LoomGeometry, LoomShape, WindingDirection};

use crate::bom_calculator::{calculate_bom, BomConfig, SpoolInfo, WeavingStep};
use crate::resume_codec::compute_project_hash;

/// Opções de renderização do SVG da Obra.
#[derive(Debug, Clone, PartialEq)]
pub struct SvgArtworkOptions {
    /// Margem externa ao redor do tear em milímetros. Padrão: 15.0 mm.
    pub margin_mm: f64,
    /// Cor de fundo da área de tecelagem (ex: "#ffffff"). Padrão: "#ffffff".
    pub background_color: String,
    /// Espessura padrão do fio em milímetros (caso não especificada no carretel). Padrão: 0.20 mm.
    pub default_thread_thickness_mm: f64,
    /// Opacidade padrão do fio em [0.0, 1.0]. Padrão: 0.70.
    pub default_opacity: f32,
    /// Se verdadeiro, desenha os pinos periféricos com raio real e numeração. Padrão: true.
    pub draw_pegs: bool,
    /// Base de numeração dos pinos (1 para numeração física convencional 1..N, ou 0). Padrão: 1.
    pub peg_number_base: usize,
}

impl Default for SvgArtworkOptions {
    fn default() -> Self {
        Self {
            margin_mm: 15.0,
            background_color: "#ffffff".to_string(),
            default_thread_thickness_mm: 0.20,
            default_opacity: 0.70,
            draw_pegs: true,
            peg_number_base: 1,
        }
    }
}

/// Exporta a obra de String Art em formato SVG vetorial 1:1 com camadas na ordem física de empilhamento.
pub fn export_artwork_svg(
    loom: &LoomGeometry,
    steps: &[WeavingStep],
    spools: &[SpoolInfo],
    options: &SvgArtworkOptions,
) -> String {
    let mut out = String::new();

    let half_w = loom.spec.width_mm / 2.0;
    let half_h = loom.spec.height_mm / 2.0;
    let margin = options.margin_mm;

    let vb_x = -half_w - margin;
    let vb_y = -half_h - margin;
    let vb_w = loom.spec.width_mm + 2.0 * margin;
    let vb_h = loom.spec.height_mm + 2.0 * margin;

    writeln!(
        out,
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{:.2}mm" height="{:.2}mm" viewBox="{:.4} {:.4} {:.4} {:.4}">"#,
        vb_w, vb_h, vb_x, vb_y, vb_w, vb_h
    ).unwrap();

    // 1. Fundo do Tear
    writeln!(out, "  <!-- Fundo do Tear -->").unwrap();
    match loom.spec.shape {
        LoomShape::Circular => {
            let r = loom.spec.diameter_mm / 2.0;
            writeln!(
                out,
                r#"  <circle cx="0.0000" cy="0.0000" r="{:.4}" fill="{}" />"#,
                r, options.background_color
            )
            .unwrap();
        }
        LoomShape::Elliptical => {
            writeln!(
                out,
                r#"  <ellipse cx="0.0000" cy="0.0000" rx="{:.4}" ry="{:.4}" fill="{}" />"#,
                half_w, half_h, options.background_color
            )
            .unwrap();
        }
        LoomShape::Rectangular => {
            writeln!(
                out,
                r#"  <rect x="{:.4}" y="{:.4}" width="{:.4}" height="{:.4}" fill="{}" />"#,
                -half_w, -half_h, loom.spec.width_mm, loom.spec.height_mm, options.background_color
            )
            .unwrap();
        }
        LoomShape::RegularPolygon => {
            let pins = loom.pins();
            if !pins.is_empty() {
                let mut points = String::new();
                for p in pins {
                    write!(points, "{:.4},{:.4} ", p.position.0, p.position.1).unwrap();
                }
                writeln!(
                    out,
                    r#"  <polygon points="{}" fill="{}" />"#,
                    points.trim_end(),
                    options.background_color
                )
                .unwrap();
            }
        }
    }

    // 2. Traçado dos fios agrupados por camada/época (<g id="spool-k-epoch-m">)
    // Agrupa passos consecutivos com mesmo spool_id e epoch_id mantendo a ordem estrita de empilhamento
    writeln!(out, "  <!-- Camadas de Fios em Ordem Física de Empilhamento -->").unwrap();

    let pin_radius = loom.spec.pin_diameter_mm / 2.0;
    let mut step_idx = 0;

    while step_idx < steps.len() {
        let first_step = &steps[step_idx];
        let current_spool_id = first_step.spool_id;
        let current_epoch_id = first_step.epoch_id;

        // Metadados do carretel
        let info = spools.iter().find(|s| s.id == current_spool_id);
        let color_hex = info
            .map(|s| s.color_hex.as_str())
            .unwrap_or("#000000");
        let thickness_mm = info
            .and_then(|s| s.thread_thickness_mm)
            .unwrap_or(options.default_thread_thickness_mm);
        let opacity = info
            .and_then(|s| s.opacity)
            .unwrap_or(options.default_opacity);

        writeln!(
            out,
            r#"  <g id="spool-{}-epoch-{}" stroke="{}" stroke-width="{:.4}" stroke-opacity="{:.2}" stroke-linecap="round">"#,
            current_spool_id, current_epoch_id, color_hex, thickness_mm, opacity
        ).unwrap();

        // Acumula os caminhos desta camada
        let mut path_data = String::new();

        while step_idx < steps.len() {
            let s = &steps[step_idx];
            if s.spool_id != current_spool_id || s.epoch_id != current_epoch_id {
                break;
            }

            let p_a = loom.pin_position(s.from_pin as usize);
            let p_b = loom.pin_position(s.to_pin as usize);

            let (p0, p1) = if let Some(tangent) = compute_tangent(
                p_a,
                s.departure_winding,
                p_b,
                s.arrival_winding,
                pin_radius,
            ) {
                (tangent.start, tangent.end)
            } else {
                (p_a, p_b)
            };

            write!(
                path_data,
                "M {:.4} {:.4} L {:.4} {:.4} ",
                p0.0, p0.1, p1.0, p1.1
            )
            .unwrap();

            step_idx += 1;
        }

        if !path_data.is_empty() {
            writeln!(
                out,
                r#"    <path d="{}" fill="none" />"#,
                path_data.trim_end()
            )
            .unwrap();
        }

        writeln!(out, "  </g>").unwrap();
    }

    // 3. Pinos mecânicos e numeração periférica (opcional)
    if options.draw_pegs {
        writeln!(out, "  <!-- Pinos Periféricos e Numeração -->").unwrap();
        writeln!(
            out,
            r##"  <g id="loom-pegs" fill="#666666" stroke="none" font-family="monospace" font-size="2.4" text-anchor="middle" dominant-baseline="central">"##
        ).unwrap();

        for pin in loom.pins() {
            let r_peg = (loom.spec.pin_diameter_mm / 2.0).max(0.5);
            writeln!(
                out,
                r#"    <circle cx="{:.4}" cy="{:.4}" r="{:.4}" />"#,
                pin.position.0, pin.position.1, r_peg
            )
            .unwrap();

            let label_dist = r_peg + 3.0;
            let lx = pin.position.0 + pin.normal.0 * label_dist;
            let ly = pin.position.1 + pin.normal.1 * label_dist;
            let num = pin.index + options.peg_number_base;
            writeln!(
                out,
                r#"    <text x="{:.4}" y="{:.4}">{}</text>"#,
                lx, ly, num
            )
            .unwrap();
        }

        writeln!(out, "  </g>").unwrap();
    }

    writeln!(out, "</svg>").unwrap();
    out
}

/// Opções de geração das instruções textuais para humanos.
#[derive(Debug, Clone, PartialEq)]
pub struct TextInstructionOptions {
    /// Base de numeração dos pinos (1 para numeração física convencional 1..N, ou 0). Padrão: 1.
    pub peg_number_base: usize,
    /// Se verdadeiro, inclui no cabeçalho o resumo de BOM e tempo manual. Padrão: true.
    pub include_bom_summary: bool,
}

impl Default for TextInstructionOptions {
    fn default() -> Self {
        Self {
            peg_number_base: 1,
            include_bom_summary: true,
        }
    }
}

/// Gera o guia textual estruturado em blocos de cor com instruções de tecelagem passo a passo.
pub fn export_instructions_txt(
    loom: &LoomGeometry,
    steps: &[WeavingStep],
    spools: &[SpoolInfo],
    config: &BomConfig,
    options: &TextInstructionOptions,
) -> String {
    let mut out = String::new();
    let base = options.peg_number_base;

    writeln!(out, "================================================================================").unwrap();
    writeln!(out, "                    WEAVER ART — INSTRUÇÕES DE TECELAGEM                        ").unwrap();
    writeln!(out, "================================================================================").unwrap();
    writeln!(out).unwrap();

    // Descrição do Tear
    let shape_desc = match loom.spec.shape {
        LoomShape::Circular => format!("Círculo de {:.1} mm de diâmetro", loom.spec.diameter_mm),
        LoomShape::Elliptical => format!("Elipse de {:.1} × {:.1} mm", loom.spec.width_mm, loom.spec.height_mm),
        LoomShape::Rectangular => format!("Retângulo de {:.1} × {:.1} mm", loom.spec.width_mm, loom.spec.height_mm),
        LoomShape::RegularPolygon => format!("Polígono Regular ({} lados) de {:.1} mm", loom.spec.polygon_sides, loom.spec.diameter_mm),
    };

    writeln!(out, "TEAR: {}, {} pinos", shape_desc, loom.spec.peg_count).unwrap();
    writeln!(
        out,
        "      Pinos: Ø {:.2} mm (Broca: Ø {:.2} mm) · Numeração de {} a {}",
        loom.spec.pin_diameter_mm,
        loom.spec.drill_diameter_mm,
        base,
        loom.spec.peg_count - 1 + base
    ).unwrap();
    writeln!(out).unwrap();

    // Resumo de BOM e Tempo Manual
    if options.include_bom_summary {
        let bom = calculate_bom(loom, steps, config, spools);
        writeln!(out, "ESTIMATIVA DE FABRICAÇÃO E CONSUMO:").unwrap();
        writeln!(
            out,
            "  • Total de Passos / Linhas: {}",
            bom.total_chords
        ).unwrap();
        writeln!(
            out,
            "  • Fio Linear Total: {:.1} m (com margem de segurança +{:.0}%: {:.1} m)",
            bom.total_raw_length_meters,
            config.safety_margin_ratio * 100.0,
            bom.total_length_with_margin_meters
        ).unwrap();
        writeln!(
            out,
            "  • Tempo Manual Estimado: {} ({} tecendo · {} nós e trocas)",
            bom.time_estimate.formatted_total_time,
            bom.time_estimate.formatted_weaving_time,
            bom.time_estimate.formatted_switch_time
        ).unwrap();
        writeln!(
            out,
            "  • Operações de Fio: {} amarrações iniciais e {} trocas de carretel",
            bom.time_estimate.tie_ons,
            bom.time_estimate.total_switches
        ).unwrap();
        writeln!(out).unwrap();

        writeln!(out, "CARRETÉIS / CONSUMO POR COR:").unwrap();
        for s in &bom.spools {
            if s.line_count > 0 {
                writeln!(
                    out,
                    "  - Carretel #{} [{}]: {} linhas | {:.1} m necessários | {} cone(s) ({:.1}% de uso)",
                    s.spool_id,
                    s.spool_name,
                    s.line_count,
                    s.length_with_margin_meters,
                    s.spools_needed,
                    s.spool_usage_percent
                ).unwrap();
            }
        }
        writeln!(out).unwrap();
    }

    writeln!(out, "--------------------------------------------------------------------------------").unwrap();
    writeln!(out, "Sentido = Direção do enrolamento ao contornar o pino, visto de frente.").unwrap();
    writeln!(out, "--------------------------------------------------------------------------------").unwrap();
    writeln!(out).unwrap();

    // Sequência de passos estruturada por blocos/camadas de cor
    let total_steps = steps.len();
    let pad_digits = total_steps.to_string().len().max(4);
    let mut current_spool: Option<u8> = None;
    let mut block_idx = 0;

    for s in steps {
        if Some(s.spool_id) != current_spool {
            current_spool = Some(s.spool_id);
            block_idx += 1;

            let info = spools.iter().find(|sp| sp.id == s.spool_id);
            let name = info
                .map(|sp| sp.name.as_str())
                .unwrap_or("Carretel");
            let hex = info
                .map(|sp| sp.color_hex.as_str())
                .unwrap_or("#000000");

            writeln!(out).unwrap();
            writeln!(
                out,
                "=== CAMADA {}: CARRETEL #{} - {} ({}) · Amarrar no Pino {} ===",
                block_idx,
                s.spool_id,
                name.to_uppercase(),
                hex,
                s.from_pin as usize + base
            ).unwrap();
            writeln!(out).unwrap();
        }

        let from_num = s.from_pin as usize + base;
        let to_num = s.to_pin as usize + base;
        let winding_str = match s.arrival_winding {
            WindingDirection::Clockwise => "Sentido Horário",
            WindingDirection::CounterClockwise => "Sentido Anti-Horário",
        };

        writeln!(
            out,
            "Passo {:0width$} | Pino {:>3} -> Pino {:>3} ({})",
            s.step_index + 1,
            from_num,
            to_num,
            winding_str,
            width = pad_digits
        ).unwrap();
    }

    out
}

/// Escapa caracteres especiais para formatação estrita de strings JSON.
fn escape_json(s: &str) -> String {
    let mut res = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '"' => res.push_str("\\\""),
            '\\' => res.push_str("\\\\"),
            '\n' => res.push_str("\\n"),
            '\r' => res.push_str("\\r"),
            '\t' => res.push_str("\\t"),
            _ => res.push(c),
        }
    }
    res
}

/// Serializa determinística e completamente o projeto em formato JSON padronizado.
pub fn export_project_json(
    loom: &LoomGeometry,
    steps: &[WeavingStep],
    spools: &[SpoolInfo],
    config: &BomConfig,
    project_title: Option<&str>,
) -> String {
    let bom = calculate_bom(loom, steps, config, spools);
    let project_hash = compute_project_hash(loom, steps);
    let diag = loom.drilling_diagnostic();

    let title = project_title.unwrap_or("Weaver Art Project");

    let mut out = String::new();
    writeln!(out, "{{").unwrap();
    writeln!(out, r#"  "schema_version": "1.0","#).unwrap();

    // Metadados
    writeln!(out, r#"  "metadata": {{"#).unwrap();
    writeln!(out, r#"    "title": "{}","#, escape_json(title)).unwrap();
    writeln!(out, r#"    "project_hash": "{}","#, project_hash).unwrap();
    writeln!(out, r#"    "total_steps": {},"#, steps.len()).unwrap();
    writeln!(out, r#"    "total_raw_length_meters": {:.4},"#, bom.total_raw_length_meters).unwrap();
    writeln!(out, r#"    "total_length_with_margin_meters": {:.4}"#, bom.total_length_with_margin_meters).unwrap();
    writeln!(out, r#"  }},"#).unwrap();

    // Tear
    let shape_str = match loom.spec.shape {
        LoomShape::Circular => "circular",
        LoomShape::Elliptical => "elliptical",
        LoomShape::Rectangular => "rectangular",
        LoomShape::RegularPolygon => "regular_polygon",
    };

    writeln!(out, r#"  "loom": {{"#).unwrap();
    writeln!(out, r#"    "shape": "{}","#, shape_str).unwrap();
    writeln!(out, r#"    "diameter_mm": {:.4},"#, loom.spec.diameter_mm).unwrap();
    writeln!(out, r#"    "width_mm": {:.4},"#, loom.spec.width_mm).unwrap();
    writeln!(out, r#"    "height_mm": {:.4},"#, loom.spec.height_mm).unwrap();
    writeln!(out, r#"    "peg_count": {},"#, loom.spec.peg_count).unwrap();
    writeln!(out, r#"    "pin_diameter_mm": {:.4},"#, loom.spec.pin_diameter_mm).unwrap();
    writeln!(out, r#"    "drill_diameter_mm": {:.4},"#, loom.spec.drill_diameter_mm).unwrap();
    writeln!(out, r#"    "margin_mm": {:.4},"#, loom.spec.margin_mm).unwrap();
    writeln!(out, r#"    "polygon_sides": {}"#, loom.spec.polygon_sides).unwrap();
    writeln!(out, r#"  }},"#).unwrap();

    // Diagnóstico Mecânico
    let status_str = match diag.status {
        weaver_domain::DrillingStatus::Safe => "Safe",
        weaver_domain::DrillingStatus::WarningThinWall => "WarningThinWall",
        weaver_domain::DrillingStatus::ErrorCollision => "ErrorCollision",
    };
    writeln!(out, r#"  "mechanical_diagnostic": {{"#).unwrap();
    writeln!(out, r#"    "status": "{}","#, status_str).unwrap();
    writeln!(out, r#"    "min_adjacent_distance_mm": {:.4},"#, diag.min_adjacent_distance_mm).unwrap();
    writeln!(out, r#"    "free_wall_mm": {:.4}"#, diag.free_wall_mm).unwrap();
    writeln!(out, r#"  }},"#).unwrap();

    // BOM e Estimativa de Tempo
    writeln!(out, r#"  "bom": {{"#).unwrap();
    writeln!(out, r#"    "safety_margin_ratio": {:.4},"#, config.safety_margin_ratio).unwrap();
    writeln!(out, r#"    "standard_spool_length_meters": {:.2},"#, config.standard_spool_length_meters).unwrap();
    writeln!(out, r#"    "weaving_time_seconds": {:.2},"#, bom.time_estimate.weaving_time_seconds).unwrap();
    writeln!(out, r#"    "knot_and_switch_time_seconds": {:.2},"#, bom.time_estimate.knot_and_switch_time_seconds).unwrap();
    writeln!(out, r#"    "total_time_seconds": {:.2},"#, bom.time_estimate.total_time_seconds).unwrap();
    writeln!(out, r#"    "formatted_total_time": "{}","#, escape_json(&bom.time_estimate.formatted_total_time)).unwrap();
    writeln!(out, r#"    "tie_ons": {},"#, bom.time_estimate.tie_ons).unwrap();
    writeln!(out, r#"    "total_switches": {},"#, bom.time_estimate.total_switches).unwrap();
    writeln!(out, r#"    "spools": ["#).unwrap();
    for (i, s) in bom.spools.iter().enumerate() {
        let comma = if i + 1 < bom.spools.len() { "," } else { "" };
        writeln!(out, r#"      {{"#).unwrap();
        writeln!(out, r#"        "spool_id": {},"#, s.spool_id).unwrap();
        writeln!(out, r#"        "name": "{}","#, escape_json(&s.spool_name)).unwrap();
        writeln!(out, r#"        "color_hex": "{}","#, escape_json(&s.color_hex)).unwrap();
        writeln!(out, r#"        "line_count": {},"#, s.line_count).unwrap();
        writeln!(out, r#"        "raw_length_meters": {:.4},"#, s.raw_length_meters).unwrap();
        writeln!(out, r#"        "length_with_margin_meters": {:.4},"#, s.length_with_margin_meters).unwrap();
        writeln!(out, r#"        "spools_needed": {},"#, s.spools_needed).unwrap();
        writeln!(out, r#"        "spool_usage_percent": {:.2}"#, s.spool_usage_percent).unwrap();
        writeln!(out, r#"      }}{}"#, comma).unwrap();
    }
    writeln!(out, r#"    ]"#).unwrap();
    writeln!(out, r#"  }},"#).unwrap();

    // Passos de Tecelagem
    writeln!(out, r#"  "steps": ["#).unwrap();
    for (i, s) in steps.iter().enumerate() {
        let comma = if i + 1 < steps.len() { "," } else { "" };
        let dep_str = match s.departure_winding {
            WindingDirection::Clockwise => "CW",
            WindingDirection::CounterClockwise => "CCW",
        };
        let arr_str = match s.arrival_winding {
            WindingDirection::Clockwise => "CW",
            WindingDirection::CounterClockwise => "CCW",
        };
        writeln!(
            out,
            r#"    {{"step": {}, "from": {}, "to": {}, "spool": {}, "epoch": {}, "dep": "{}", "arr": "{}", "score": {}}}{}"#,
            s.step_index + 1,
            s.from_pin,
            s.to_pin,
            s.spool_id,
            s.epoch_id,
            dep_str,
            arr_str,
            s.score_normalized,
            comma
        ).unwrap();
    }
    writeln!(out, r#"  ]"#).unwrap();

    writeln!(out, "}}").unwrap();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use weaver_domain::LoomPhysicalSpec;

    #[test]
    fn test_export_artwork_svg_circle_grouped_layers() {
        let spec = LoomPhysicalSpec::circle(711.2, 200, 2.0, 2.0, 15.0);
        let loom = LoomGeometry::new(spec);

        let spools = vec![
            SpoolInfo::new(0, "Amarelo", "#ffd700"),
            SpoolInfo::new(1, "Preto", "#000000"),
        ];

        let steps = vec![
            WeavingStep::new(0, 0, 100, 0, WindingDirection::Clockwise, WindingDirection::Clockwise),
            WeavingStep::new(1, 100, 20, 0, WindingDirection::Clockwise, WindingDirection::CounterClockwise),
            WeavingStep::new(2, 20, 120, 1, WindingDirection::CounterClockwise, WindingDirection::Clockwise),
        ];

        let opts = SvgArtworkOptions::default();
        let svg = export_artwork_svg(&loom, &steps, &spools, &opts);

        assert!(svg.starts_with("<svg"));
        assert!(svg.contains(r#"<circle cx="0.0000" cy="0.0000""#));
        assert!(svg.contains(r#"id="spool-0-epoch-0""#));
        assert!(svg.contains(r#"id="spool-1-epoch-1""#));
        assert!(svg.contains(r##"stroke="#ffd700""##));
        assert!(svg.contains(r##"stroke="#000000""##));
        assert!(svg.contains(r#"id="loom-pegs""#));
        assert!(svg.ends_with("</svg>\n"));
    }

    #[test]
    fn test_export_instructions_txt() {
        let spec = LoomPhysicalSpec::circle(711.2, 200, 2.0, 2.0, 15.0);
        let loom = LoomGeometry::new(spec);

        let spools = vec![
            SpoolInfo::new(0, "Amarelo", "#ffd700"),
            SpoolInfo::new(1, "Preto", "#000000"),
        ];

        let steps = vec![
            WeavingStep::new(0, 0, 100, 0, WindingDirection::Clockwise, WindingDirection::Clockwise),
            WeavingStep::new(1, 100, 20, 0, WindingDirection::Clockwise, WindingDirection::CounterClockwise),
            WeavingStep::new(2, 20, 120, 1, WindingDirection::CounterClockwise, WindingDirection::Clockwise),
        ];

        let config = BomConfig::default();
        let opts = TextInstructionOptions::default();

        let txt = export_instructions_txt(&loom, &steps, &spools, &config, &opts);

        assert!(txt.contains("WEAVER ART — INSTRUÇÕES DE TECELAGEM"));
        assert!(txt.contains("TEAR: Círculo de 711.2 mm de diâmetro, 200 pinos"));
        assert!(txt.contains("CAMADA 1: CARRETEL #0 - AMARELO"));
        assert!(txt.contains("CAMADA 2: CARRETEL #1 - PRETO"));
        assert!(txt.contains("Passo 0001 | Pino   1 -> Pino 101 (Sentido Horário)"));
        assert!(txt.contains("Passo 0002 | Pino 101 -> Pino  21 (Sentido Anti-Horário)"));
        assert!(txt.contains("Passo 0003 | Pino  21 -> Pino 121 (Sentido Horário)"));
    }

    #[test]
    fn test_export_project_json_determinism() {
        let spec = LoomPhysicalSpec::circle(711.2, 200, 2.0, 2.0, 15.0);
        let loom = LoomGeometry::new(spec);

        let spools = vec![SpoolInfo::new(0, "Preto", "#000000")];
        let steps = vec![
            WeavingStep::new(0, 0, 100, 0, WindingDirection::Clockwise, WindingDirection::Clockwise),
            WeavingStep::new(1, 100, 50, 0, WindingDirection::Clockwise, WindingDirection::Clockwise),
        ];

        let config = BomConfig::default();
        let json1 = export_project_json(&loom, &steps, &spools, &config, Some("Projeto Teste"));
        let json2 = export_project_json(&loom, &steps, &spools, &config, Some("Projeto Teste"));

        // Determinismo estrito bit a bit
        assert_eq!(json1, json2);

        assert!(json1.contains(r#""schema_version": "1.0""#));
        assert!(json1.contains(r#""title": "Projeto Teste""#));
        assert!(json1.contains(r#""shape": "circular""#));
        assert!(json1.contains(r#""peg_count": 200"#));
        assert!(json1.contains(r#""total_steps": 2"#));
        assert!(json1.contains(r#""status": "Safe""#));
        assert!(json1.contains(r#""dep": "CW""#));
    }
}
