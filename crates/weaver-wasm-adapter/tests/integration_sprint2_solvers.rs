//! Teste de Integração Sintético da Sprint 2 (`integration_sprint2_solvers.rs`).
//!
//! Valida o pipeline completo de ponta a ponta na Camada 3 (`weaver-wasm-adapter`):
//! 1. Gera uma imagem sintética com círculo e linhas cruzadas (simulando um rosto com óculos);
//! 2. Pré-processa via `weaver-dsp` (enquadramento afim, máscara de tear, CLAHE, Sobel/Canny e mapa W(x,y));
//! 3. Executa os 3 motores de otimização de `weaver-solvers`:
//!    - Iterative Greedy
//!    - Beam Search
//!    - Global NNLS/FISTA + Roteamento Euleriano
//! 4. Comprova formalmente a queda monotônica do erro $\Delta E$ e a redução substancial do RMSE
//!    ao longo dos passos de tecelagem.

use std::sync::Arc;
use weaver_domain::{
    ColorErrorMetric, LinearRgbColor, LoomGeometry, LoomPhysicalSpec, Pixels, RasterizerType,
    SparseChordMatrixCSR, SrgbColor,
};
use weaver_dsp::{
    pipeline::{DspPipeline, DspPipelineConfig},
    ClaheConfig, ImageBuffer, Rgba8Image,
};
use weaver_solvers::{
    optical_models::{OpticalMixModelType, OpticalModelEvaluator, SpoolColor},
    solver_runner::SolverSession,
    solvers::{BeamSearchConfig, GlobalFistaConfig, GreedyConfig},
    spool_scheduler::{SpoolScheduler, SpoolSwitchStrategy},
    state_matrix::CanvasStateSoA,
};

/// Gera a imagem sintética de um rosto com óculos (círculo com linhas cruzadas).
fn create_synthetic_face_with_glasses(width: u32, height: u32) -> Rgba8Image {
    let mut img = ImageBuffer::fill(width, height, 4, 255u8);

    let cx = (width as f32 - 1.0) * 0.5;
    let cy = (height as f32 - 1.0) * 0.5;
    let face_r = width as f32 * 0.38;

    let eye_y = cy - height as f32 * 0.08;
    let left_eye_x = cx - width as f32 * 0.16;
    let right_eye_x = cx + width as f32 * 0.16;
    let lens_r = width as f32 * 0.10;

    let mouth_y = cy + height as f32 * 0.20;
    let mouth_half_w = width as f32 * 0.15;

    for y in 0..height {
        for x in 0..width {
            let dx = x as f32 - cx;
            let dy = y as f32 - cy;
            let dist_center = (dx * dx + dy * dy).sqrt();

            // Fundo externo branco
            if dist_center > face_r {
                continue;
            }

            // Tom base da face (pele cinza média)
            let mut val = 180u8;

            // Contorno do rosto
            if dist_center >= face_r - 2.0 {
                val = 40;
            }

            // Armação dos óculos: aro esquerdo
            let d_left = ((x as f32 - left_eye_x).powi(2) + (y as f32 - eye_y).powi(2)).sqrt();
            if (d_left - lens_r).abs() <= 1.8 {
                val = 20;
            } else if d_left < lens_r {
                val = 140; // Lente
            }

            // Armação dos óculos: aro direito
            let d_right = ((x as f32 - right_eye_x).powi(2) + (y as f32 - eye_y).powi(2)).sqrt();
            if (d_right - lens_r).abs() <= 1.8 {
                val = 20;
            } else if d_right < lens_r {
                val = 140;
            }

            // Ponte horizontal dos óculos (linha cruzada horizontal)
            if (y as f32 - eye_y).abs() <= 1.5
                && x as f32 >= (left_eye_x - lens_r)
                && x as f32 <= (right_eye_x + lens_r)
            {
                val = 15;
            }

            // Haste / cruzamento vertical no centro (linha cruzada vertical / nariz)
            if (x as f32 - cx).abs() <= 1.2
                && y as f32 >= (eye_y - lens_r)
                && y as f32 <= (cy + 4.0)
            {
                val = 25;
            }

            // Boca horizontal
            if (y as f32 - mouth_y).abs() <= 1.5 && (x as f32 - cx).abs() <= mouth_half_w {
                val = 30;
            }

            img.set_pixel(x, y, &[val, val, val, 255]);
        }
    }

    img
}

#[test]
fn test_sprint2_full_integration_dsp_and_three_solvers() {
    let res = 64u32;
    let pin_count = 32usize;

    // 1. Cria a geometria do tear físico e a imagem sintética de rosto com óculos
    let spec = LoomPhysicalSpec::circle(200.0, pin_count, 2.0, 1.5, 10.0);
    let loom = LoomGeometry::new(spec);
    let source_rgba = create_synthetic_face_with_glasses(res, res);

    // 2. Processa a imagem através do pipeline completo de DSP de weaver-dsp
    let mut dsp_config = DspPipelineConfig::default();
    dsp_config.target_resolution = res;
    dsp_config.high_freq_blend = 0.20;
    dsp_config.beta_face = 3.0;
    dsp_config.beta_edge = 2.0;
    dsp_config.clahe = Some(ClaheConfig {
        grid_cols: 8,
        grid_rows: 8,
        clip_limit: 2.5,
        num_bins: 256,
    });

    let mut pipeline = DspPipeline::new(dsp_config);
    let diag = pipeline.execute(&source_rgba, Some(&loom), None);

    // Extrai o alvo preparado e o mapa de importância
    let prepared_target_rgba = &diag.prepared_target_rgba;
    let num_pixels = (res * res) as usize;

    let mut target_linear = Vec::with_capacity(num_pixels);
    for y in 0..res {
        for x in 0..res {
            let px = prepared_target_rgba.get_pixel(x, y);
            target_linear.push(SrgbColor::from_u8(px[0], px[1], px[2]).to_linear());
        }
    }

    let importance_weights: Vec<f32> = diag
        .importance_map_rgba
        .data
        .chunks_exact(4)
        .map(|c| (c[0] as f32) / 255.0 * 3.0 + 1.0)
        .collect();

    // 3. Pré-computa a matriz esparsa CSR
    let matrix = Arc::new(SparseChordMatrixCSR::build(
        &loom,
        Pixels(res),
        3,
        RasterizerType::XiaolinWuAntialiased,
    ));

    let evaluator = OpticalModelEvaluator::new(
        OpticalMixModelType::PorterDuffOcclusion,
        ColorErrorMetric::LinearRgb,
    );
    let spools = vec![SpoolColor::new(0, LinearRgbColor::BLACK, 0.25)];
    let alpha_eff = 0.20f32;

    // ==========================================
    // TESTE DO SOLVER 1: ITERATIVE GREEDY
    // ==========================================
    {
        let canvas = CanvasStateSoA::from_target_and_background(
            res,
            res,
            &target_linear,
            LinearRgbColor::WHITE,
            Some(&importance_weights),
        );
        let scheduler = SpoolScheduler::new(SpoolSwitchStrategy::FreeGreedy, 50, 0);
        let config = GreedyConfig {
            max_steps: 40,
            max_chord_repeats: 2,
            length_exponent_gamma: 1.0,
            start_pin: 0,
            tabu_history_size: 0,
        };

        let mut session = SolverSession::new_greedy(
            config,
            canvas,
            matrix.clone(),
            evaluator,
            scheduler,
            spools.clone(),
            alpha_eff,
        );

        let initial_progress = session.current_progress(Vec::new());
        let initial_delta_e = initial_progress.telemetry.delta_e;
        let mut prev_delta_e = initial_delta_e;

        // Executa 4 lotes de 10 passos (total 40 passos)
        for _ in 0..4 {
            let prog = session.step_batch(10);
            assert!(
                prog.telemetry.delta_e <= prev_delta_e + 1e-5,
                "DeltaE deve diminuir monotonicamente: prev {} vs cur {}",
                prev_delta_e,
                prog.telemetry.delta_e
            );
            prev_delta_e = prog.telemetry.delta_e;
        }

        let final_progress = session.current_progress(Vec::new());
        println!(
            "GREEDY: Initial ΔE = {:.4}, RMSE = {:.4}, SSIM = {:.4} | Final: ΔE = {:.4}, RMSE = {:.4}, SSIM = {:.4}",
            initial_delta_e, initial_progress.telemetry.rmse, initial_progress.telemetry.ssim,
            final_progress.telemetry.delta_e, final_progress.telemetry.rmse, final_progress.telemetry.ssim
        );
        assert!(
            final_progress.telemetry.delta_e < initial_delta_e,
            "DeltaE final deve ser menor que o inicial"
        );
        assert!(
            final_progress.telemetry.rmse < initial_progress.telemetry.rmse,
            "RMSE final deve ser menor que o inicial"
        );
        assert_eq!(session.history_steps.len(), 40);
    }

    // ==========================================
    // TESTE DO SOLVER 2: BEAM SEARCH
    // ==========================================
    {
        let canvas = CanvasStateSoA::from_target_and_background(
            res,
            res,
            &target_linear,
            LinearRgbColor::WHITE,
            Some(&importance_weights),
        );
        let scheduler = SpoolScheduler::new(SpoolSwitchStrategy::FreeGreedy, 30, 0);
        let config = BeamSearchConfig {
            beam_width: 4,
            lookahead_depth: 2,
            max_steps: 25,
            max_chord_repeats: 2,
            length_exponent_gamma: 1.0,
            start_pin: 0,
        };

        let mut session = SolverSession::new_beam_search(
            config,
            canvas,
            matrix.clone(),
            evaluator,
            scheduler,
            spools.clone(),
            alpha_eff,
        );

        let initial_progress = session.current_progress(Vec::new());
        let initial_delta_e = initial_progress.telemetry.delta_e;
        let mut prev_delta_e = initial_delta_e;

        for _ in 0..5 {
            let prog = session.step_batch(5);
            assert!(
                prog.telemetry.delta_e <= prev_delta_e + 1e-5,
                "Beam Search: DeltaE deve diminuir monotonicamente"
            );
            prev_delta_e = prog.telemetry.delta_e;
        }

        let final_progress = session.current_progress(Vec::new());
        println!(
            "BEAM SEARCH: Initial ΔE = {:.4}, RMSE = {:.4}, SSIM = {:.4} | Final: ΔE = {:.4}, RMSE = {:.4}, SSIM = {:.4}",
            initial_delta_e, initial_progress.telemetry.rmse, initial_progress.telemetry.ssim,
            final_progress.telemetry.delta_e, final_progress.telemetry.rmse, final_progress.telemetry.ssim
        );
        assert!(final_progress.telemetry.delta_e < initial_delta_e);
        assert!(final_progress.telemetry.rmse < initial_progress.telemetry.rmse);
        assert_eq!(session.history_steps.len(), 25);
    }

    // ==========================================
    // TESTE DO SOLVER 3: GLOBAL NNLS / FISTA
    // ==========================================
    {
        let canvas = CanvasStateSoA::from_target_and_background(
            res,
            res,
            &target_linear,
            LinearRgbColor::WHITE,
            Some(&importance_weights),
        );
        let scheduler = SpoolScheduler::new(SpoolSwitchStrategy::FreeGreedy, 30, 0);
        let config = GlobalFistaConfig {
            max_steps: 30,
            max_chord_repeats: 2,
            fista_iterations: 40,
            l1_regularization_lambda: 0.03,
            painter_layers_per_color: 2,
            start_pin: 0,
        };

        let mut session = SolverSession::new_global_fista(
            config,
            canvas,
            matrix.clone(),
            evaluator,
            scheduler,
            spools.clone(),
            alpha_eff,
        );

        let initial_progress = session.current_progress(Vec::new());
        let initial_delta_e = initial_progress.telemetry.delta_e;

        // Executa em lotes
        let prog = session.step_batch(30);
        println!(
            "GLOBAL FISTA: Initial ΔE = {:.4}, RMSE = {:.4}, SSIM = {:.4} | Final: ΔE = {:.4}, RMSE = {:.4}, SSIM = {:.4}",
            initial_delta_e, initial_progress.telemetry.rmse, initial_progress.telemetry.ssim,
            prog.telemetry.delta_e, prog.telemetry.rmse, prog.telemetry.ssim
        );

        assert!(
            prog.telemetry.delta_e < initial_delta_e,
            "FISTA: DeltaE final ({}) deve ser menor que inicial ({})",
            prog.telemetry.delta_e,
            initial_delta_e
        );
        assert!(
            prog.telemetry.rmse < initial_progress.telemetry.rmse,
            "FISTA: RMSE final deve ser menor que inicial"
        );
        assert!(!session.history_steps.is_empty(), "FISTA deve tecer passos");
    }
}
