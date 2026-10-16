//! Camada 4 (`weaver-cli`): Binário CLI para testes e benchmarks nativos de alta performance.
//!
//! Executa o benchmark ponta-a-ponta completo:
//! 1. Pipeline de DSP (Auto-framing, CLAHE, Morfologia, Canny, Saliência $W(x,y)$, Radon)
//! 2. Construção e cache da Matriz Esparsa CSR (ADR-001)
//! 3. Resolução Incremental SIMD de 4.000 cordas (< 2.0 s em Release)
//! 4. Exportação CAM completa (CSV mecânico, G-Code CNC, SVG mestre, PDF 1:1, Artwork SVG e BOM JSON)

use std::sync::Arc;
use std::time::Instant;

use weaver_cam::{
    export_artwork_svg, export_project_json, generate_drilling_gcode, generate_mechanical_csv,
    BlueprintConfig, BlueprintTiler, BomConfig, GcodeDrillingParams, SpoolInfo, SvgArtworkOptions,
    WeavingStep,
};
use weaver_domain::{
    ColorErrorMetric, LinearRgbColor, LoomGeometry, LoomPhysicalSpec, Millimeters, PegSide,
    Pixels, RasterizerType, SparseChordMatrixCSR, WindingDirection,
};
use weaver_dsp::{ClaheConfig, DspPipeline, DspPipelineConfig, Rgba8Image};
use weaver_solvers::{
    compute_effective_alpha, CanvasStateSoA, GreedyConfig, OpticalMixModelType,
    OpticalModelEvaluator, SolverSession, SpoolColor, SpoolScheduler, SpoolSwitchStrategy,
};


fn generate_synthetic_portrait(width: u32, height: u32) -> Rgba8Image {
    let mut data = vec![255u8; (width * height * 4) as usize];
    let cx = width as f32 * 0.5;
    let cy = height as f32 * 0.42;
    let rx = width as f32 * 0.28;
    let ry = height as f32 * 0.38;

    for y in 0..height {
        for x in 0..width {
            let idx = ((y * width + x) * 4) as usize;
            let dx = (x as f32 - cx) / rx;
            let dy = (y as f32 - cy) / ry;
            let dist_sq = dx * dx + dy * dy;

            if dist_sq <= 1.0 {
                // Pele sombreada
                let shade = 180.0 - 50.0 * dist_sq;
                // Olhos
                let eye_y = cy - ry * 0.2;
                let left_eye_x = cx - rx * 0.45;
                let right_eye_x = cx + rx * 0.45;
                let d_left_eye = ((x as f32 - left_eye_x).powi(2) + (y as f32 - eye_y).powi(2)).sqrt();
                let d_right_eye = ((x as f32 - right_eye_x).powi(2) + (y as f32 - eye_y).powi(2)).sqrt();

                if d_left_eye < 12.0 || d_right_eye < 12.0 {
                    data[idx] = 20;
                    data[idx + 1] = 20;
                    data[idx + 2] = 20;
                } else {
                    data[idx] = shade as u8;
                    data[idx + 1] = (shade * 0.85) as u8;
                    data[idx + 2] = (shade * 0.70) as u8;
                }
            } else {
                // Fundo claro
                data[idx] = 245;
                data[idx + 1] = 245;
                data[idx + 2] = 245;
            }
            data[idx + 3] = 255;
        }
    }

    Rgba8Image::new(width, height, 4, data)
}

fn main() {
    println!("================================================================================");
    println!(" WEAVER ART — BENCHMARK NATIVO DE ALTA PERFORMANCE (Sprint 3 / Task 3.3)");
    println!("================================================================================");

    let total_start = Instant::now();

    // 1. Setup Geometria do Tear (600 mm, 200 pinos)
    let spec = LoomPhysicalSpec::circle(600.0, 200, 2.0, 2.0, 10.0);
    let loom = LoomGeometry::new(spec);
    let res = 300u32;
    println!("[1/5] Tear configurado: D={:.1} mm, {} pinos, Grade={}x{} px", spec.diameter_mm, spec.peg_count, res, res);

    // 2. DSP Pipeline
    let dsp_start = Instant::now();
    let src_img = generate_synthetic_portrait(res, res);
    let mut dsp_cfg = DspPipelineConfig::default();
    dsp_cfg.target_resolution = res;
    dsp_cfg.clahe = Some(ClaheConfig {
        clip_limit: 2.0,
        ..Default::default()
    });
    dsp_cfg.beta_face = 3.5;
    dsp_cfg.beta_edge = 1.2;
    dsp_cfg.high_freq_blend = 0.15;
    let mut dsp_pipeline = DspPipeline::new(dsp_cfg);
    let diag = dsp_pipeline.execute(&src_img, Some(&loom), None);
    let dsp_ms = dsp_start.elapsed().as_secs_f64() * 1000.0;
    println!(
        "[2/5] DSP Concluído em {:.2} ms (Prepared={}x{}, Edges={}x{}, Radon={}x{})",
        dsp_ms,
        diag.prepared_target_rgba.width,
        diag.prepared_target_rgba.height,
        diag.edges_rgba.width,
        diag.edges_rgba.height,
        diag.radon_sinogram_rgba.width,
        diag.radon_sinogram_rgba.height,
    );

    // 3. Matriz Esparsa CSR
    let csr_start = Instant::now();
    let matrix = Arc::new(SparseChordMatrixCSR::build(
        &loom,
        Pixels(res),
        15,
        RasterizerType::BresenhamBinary,
    ));
    let csr_ms = csr_start.elapsed().as_secs_f64() * 1000.0;
    println!(
        "[3/5] Matriz CSR construída em {:.2} ms ({} pares, {:.2} MB heap)",
        csr_ms,
        matrix.chord_count(),
        matrix.memory_usage_bytes() as f64 / (1024.0 * 1024.0),
    );

    // 4. Execução do Solver (4.000 cordas)
    let max_lines = 4000;
    let prepared_gray = dsp_pipeline.prepared_gray().unwrap();
    let target_colors = prepared_gray.to_linear_rgb_vec();
    let importance = dsp_pipeline.importance_map().unwrap();
    let canvas = CanvasStateSoA::from_target_and_background(
        res,
        res,
        &target_colors,
        LinearRgbColor::WHITE,
        Some(importance.as_slice()),
    );

    let evaluator = OpticalModelEvaluator::new(
        OpticalMixModelType::PorterDuffOcclusion,
        ColorErrorMetric::LinearRgb,
    );
    let scheduler = SpoolScheduler::new(SpoolSwitchStrategy::FreeGreedy, max_lines, 0);
    let spools = vec![SpoolColor::new(0, LinearRgbColor::BLACK, 0.35)];
    let spool_infos = vec![SpoolInfo::new(0, "Preto", "#000000")];

    let alpha_eff = compute_effective_alpha(
        0.35,
        Millimeters(0.20),
        Pixels(res),
        Millimeters(600.0),
    );

    let solver_config = GreedyConfig {
        max_steps: max_lines,
        max_chord_repeats: 3,
        length_exponent_gamma: 1.0,
        start_pin: 0,
        tabu_history_size: 0,
    };

    let mut session = SolverSession::new_greedy(
        solver_config,
        canvas,
        matrix,
        evaluator,
        scheduler,
        spools,
        alpha_eff,
    );

    let solver_start = Instant::now();
    let batch_size = 100;
    while !session.is_finished() {
        session.step_batch(batch_size);
    }
    let solver_ms = solver_start.elapsed().as_secs_f64() * 1000.0;
    let progress = session.current_progress(Vec::new());

    println!(
        "[4/5] Solver finalizado em {:.2} ms ({:.4} ms/corda) -> {} cordas processadas",
        solver_ms,
        solver_ms / progress.current_step as f64,
        progress.current_step,
    );
    println!(
        "      Métricas Finais: RMSE={:.5}, ΔE={:.4}, SSIM={:.4}, Trocas={}",
        progress.telemetry.rmse,
        progress.telemetry.delta_e,
        progress.telemetry.ssim,
        progress.total_switches,
    );

    // 5. Exportação CAM Completa
    let cam_start = Instant::now();
    let csv = generate_mechanical_csv(&loom);
    let gcode = generate_drilling_gcode(&loom, &GcodeDrillingParams::default());
    let tiler = BlueprintTiler::new(loom.clone(), BlueprintConfig::default());
    let master_svg = tiler.to_master_svg();
    let multipage_pdf = tiler.to_multipage_pdf();

    let steps: Vec<WeavingStep> = session
        .history_steps
        .iter()
        .enumerate()
        .map(|(i, r)| {
            WeavingStep::with_details(
                i,
                r.from_pin,
                r.to_pin,
                r.spool_id,
                match r.departure_winding {
                    PegSide::Clockwise => WindingDirection::Clockwise,
                    PegSide::CounterClockwise => WindingDirection::CounterClockwise,
                },
                match r.arrival_winding {
                    PegSide::Clockwise => WindingDirection::Clockwise,
                    PegSide::CounterClockwise => WindingDirection::CounterClockwise,
                },
                r.score_normalized,
                r.spool_id,
            )
        })
        .collect();

    let artwork_svg = export_artwork_svg(&loom, &steps, &spool_infos, &SvgArtworkOptions::default());
    let bom_json = export_project_json(
        &loom,
        &steps,
        &spool_infos,
        &BomConfig::default(),
        Some("Benchmark Projeto"),
    );
    let cam_ms = cam_start.elapsed().as_secs_f64() * 1000.0;

    println!(
        "[5/5] Exportação CAM concluída em {:.2} ms (CSV: {} B, GCode: {} B, SVG Mestre: {} B, PDF: {} B, Artwork: {} B, BOM: {} B)",
        cam_ms,
        csv.len(),
        gcode.len(),
        master_svg.len(),
        multipage_pdf.len(),
        artwork_svg.len(),
        bom_json.len(),
    );

    let total_ms = total_start.elapsed().as_secs_f64() * 1000.0;
    println!("--------------------------------------------------------------------------------");
    println!(" RESUMO DO BENCHMARK:");
    println!(" - Tempo Total:           {:.2} ms ({:.3} s)", total_ms, total_ms / 1000.0);
    println!(" - Tempo DSP:             {:.2} ms", dsp_ms);
    println!(" - Tempo CSR:             {:.2} ms", csr_ms);
    println!(" - Tempo Solver (4.000):  {:.2} ms ({:.3} s)", solver_ms, solver_ms / 1000.0);
    println!(" - Tempo CAM:             {:.2} ms", cam_ms);
    println!(" - Cordas Totais:         {}", progress.current_step);
    println!(" - Trocas de Carretel:    {}", progress.total_switches);
    println!(" - RMSE Final:            {:.5}", progress.telemetry.rmse);
    println!(" - ΔE Final:              {:.4}", progress.telemetry.delta_e);
    println!(" - SSIM Final:            {:.4}", progress.telemetry.ssim);
    println!("--------------------------------------------------------------------------------");

    if solver_ms < 2000.0 {
        println!(">>> SUCESSO: Velocidade nativa do solver atende ao requisito estrito (< 2.0 s para 4.000 cordas)!");
    } else {
        println!(">>> AVISO: Solver demorou {:.2} ms (> 2000 ms).", solver_ms);
    }
    println!("================================================================================");
}

#[cfg(test)]
mod tests {
    use super::*;
    use weaver_cam::DrillHoleSpec;
    use weaver_dsp::DspGridSpec;

    #[test]
    fn cli_links_all_internal_crates() {
        let grid = DspGridSpec {
            resolution_px: Pixels(500),
        };
        let hole = DrillHoleSpec {
            x_mm: Millimeters(0.0),
            y_mm: Millimeters(300.0),
            drill_diameter_mm: Millimeters(2.0),
        };
        assert_eq!(grid.resolution_px.0, 500);
        assert_eq!(hole.drill_diameter_mm.0, 2.0);
    }
}
