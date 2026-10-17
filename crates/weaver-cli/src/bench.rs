//! `weaver-cli bench`: benchmark de qualidade com foto real.
//!
//! Executa o mesmo caminho do motor Wasm (DSP → matriz CSR → solver → refinamento) sobre uma
//! imagem e grava alvo, tela simulada e mapa de importância em PNG, junto com métricas
//! independentes medidas contra a **foto enquadrada sem realces**.
//!
//! Exemplo:
//! ```text
//! weaver-cli bench --image foto.jpg --pins 288 --lines 4000 --zoom 1.08 --pan-y 40 --out out/
//! ```

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use weaver_domain::{
    linear_to_srgb_channel, ColorErrorMetric, LinearRgbColor, LoomGeometry, LoomPhysicalSpec,
    Millimeters, Pixels, RasterizerType, SparseChordMatrixCSR,
};
use weaver_dsp::{ClaheConfig, DspPipeline, DspPipelineConfig, FramingConfig, Rgba8Image};
use weaver_solvers::{
    compute_effective_alpha, gaussian_blur, inscribed_disc_mask, CanvasStateSoA, GreedyConfig,
    OpticalMixModelType, OpticalModelEvaluator, RefineConfig, SolverSession, SpoolColor,
    SpoolScheduler, SpoolSwitchStrategy,
};

struct Args(HashMap<String, String>);

impl Args {
    fn parse(raw: &[String]) -> Self {
        let mut map = HashMap::new();
        let mut i = 0;
        while i < raw.len() {
            if let Some(key) = raw[i].strip_prefix("--") {
                let val = raw.get(i + 1).filter(|v| !v.starts_with("--")).cloned();
                if val.is_some() {
                    i += 1;
                }
                map.insert(key.to_string(), val.unwrap_or_else(|| "true".into()));
            }
            i += 1;
        }
        Self(map)
    }
    fn f(&self, k: &str, d: f32) -> f32 {
        self.0.get(k).and_then(|v| v.parse().ok()).unwrap_or(d)
    }
    fn u(&self, k: &str, d: usize) -> usize {
        self.0.get(k).and_then(|v| v.parse().ok()).unwrap_or(d)
    }
    fn s(&self, k: &str, d: &str) -> String {
        self.0.get(k).cloned().unwrap_or_else(|| d.to_string())
    }
}

fn save_png(path: &str, w: u32, h: u32, rgb: &[u8]) {
    if let Err(e) = image::save_buffer(path, rgb, w, h, image::ExtendedColorType::Rgb8) {
        eprintln!("falha ao salvar {path}: {e}");
    }
}

fn lin_to_rgb8(c: &[LinearRgbColor]) -> Vec<u8> {
    c.iter()
        .flat_map(|p| {
            [p.r, p.g, p.b]
                .map(|v| (linear_to_srgb_channel(v.clamp(0.0, 1.0)) * 255.0).round() as u8)
        })
        .collect()
}

fn pearson(a: &[f32], b: &[f32], mask: &[bool]) -> f32 {
    let idx: Vec<usize> = (0..a.len()).filter(|&i| mask[i]).collect();
    let n = idx.len().max(1) as f64;
    let ma = idx.iter().map(|&i| a[i] as f64).sum::<f64>() / n;
    let mb = idx.iter().map(|&i| b[i] as f64).sum::<f64>() / n;
    let (mut sab, mut saa, mut sbb) = (0.0, 0.0, 0.0);
    for &i in &idx {
        let (da, db) = (a[i] as f64 - ma, b[i] as f64 - mb);
        sab += da * db;
        saa += da * da;
        sbb += db * db;
    }
    (sab / (saa.sqrt() * sbb.sqrt()).max(1e-12)) as f32
}

pub fn run(raw: &[String]) {
    let a = Args::parse(raw);
    let image_path = a.s("image", "");
    if image_path.is_empty() {
        eprintln!(
            "uso: weaver-cli bench --image <arquivo> [--pins 288] [--lines 4000] [--out dir] ..."
        );
        std::process::exit(2);
    }
    let out_dir = a.s("out", "bench-out");
    let label = a.s("label", "run");
    std::fs::create_dir_all(&out_dir).ok();

    let img = image::open(&image_path)
        .expect("não foi possível abrir a imagem")
        .to_rgba8();
    let (iw, ih) = img.dimensions();
    let src = Rgba8Image::new(iw, ih, 4, img.into_raw());

    let res = a.u("res", 500) as u32;
    let pins = a.u("pins", 288);
    let diameter = a.f("diameter", 600.0);
    let thread_mm = a.f("thread", 0.18);
    let max_lines = a.u("lines", 4000);
    let repeats = a.u("repeats", 3);
    let min_gap = if a.0.contains_key("gap-exact") {
        a.u("gap-exact", 12)
    } else {
        a.u("gap", 12).max(pins / 12).max(16)
    };
    let opacity = a.f("opacity", 1.0);
    let hp = a.f("hp", 0.0);
    let gamma_len = a.f("len-gamma", 1.0);
    let tabu = a.u("tabu", 12);
    let refine_passes = a.u("refine", 0);
    let refine_window = a.u("window", 0);
    let refine_removal = a.s("removal", "true") == "true";
    let metric = if a.s("metric", "perceptual") == "linear" {
        ColorErrorMetric::LinearRgb
    } else {
        ColorErrorMetric::CielabDeltaE2000
    };

    let mut dsp_cfg = DspPipelineConfig {
        target_resolution: res,
        monochrome_target: true,
        framing: FramingConfig {
            zoom: a.f("zoom", 1.0),
            pan_x: a.f("pan-x", 0.0) / 100.0,
            pan_y: a.f("pan-y", 0.0) / 100.0,
            rotation_deg: 0.0,
        },
        beta_face: a.f("face", 2.0),
        beta_edge: a.f("edge", 0.0),
        high_freq_blend: a.f("hfb", 0.0),
        sharpen_amount: a.f("sharpen", 0.0),
        contrast: a.f("contrast", 1.0),
        gamma: a.f("gamma", 1.0),
        ..DspPipelineConfig::default()
    };
    let clahe = a.f("clahe", 0.0);
    if clahe > 0.0 {
        dsp_cfg.clahe = Some(ClaheConfig {
            clip_limit: clahe,
            ..Default::default()
        });
    }

    let loom = LoomGeometry::new(LoomPhysicalSpec::circle(
        diameter as f64,
        pins,
        2.0,
        2.0,
        15.0,
    ));
    let mut dsp = DspPipeline::new(dsp_cfg);
    dsp.execute(&src, Some(&loom), None);
    let target = dsp.prepared_linear_rgb().unwrap().to_vec();
    let reference = dsp.reference_linear_rgb().unwrap().to_vec();
    let importance = dsp.importance_map().unwrap().weights.clone();

    let matrix = Arc::new(SparseChordMatrixCSR::build(
        &loom,
        Pixels(res),
        min_gap,
        RasterizerType::XiaolinWuAntialiased,
    ));
    let canvas = CanvasStateSoA::from_target_and_background(
        res,
        res,
        &target,
        LinearRgbColor::WHITE,
        Some(&importance),
    );
    let coverage = compute_effective_alpha(
        1.0,
        Millimeters(thread_mm),
        Pixels(res),
        Millimeters(diameter),
    );
    let evaluator = OpticalModelEvaluator::new(OpticalMixModelType::PorterDuffOcclusion, metric)
        .with_highlight_protection(hp)
        .with_luma_only(true);
    let spools = vec![SpoolColor::new(
        0,
        LinearRgbColor::new(0.02, 0.02, 0.02),
        opacity,
    )];
    let scheduler = SpoolScheduler::new(SpoolSwitchStrategy::FreeGreedy, max_lines, 0);
    let cfg = GreedyConfig {
        max_steps: max_lines,
        max_chord_repeats: repeats,
        length_exponent_gamma: gamma_len,
        start_pin: 0,
        tabu_history_size: tabu,
    };
    let mut session =
        SolverSession::new_greedy(cfg, canvas, matrix, evaluator, scheduler, spools, coverage)
            .with_refinement(RefineConfig {
                passes: refine_passes,
                window: refine_window,
                allow_removal: refine_removal,
                max_chord_repeats: repeats,
            });
    session.set_metrics_reference(&reference);

    let t0 = Instant::now();
    let mut construct_lines = 0;
    let mut construct_secs = 0.0;
    while !session.is_finished() {
        let before = session.phase;
        session.step_batch(200);
        if before == weaver_solvers::SolverPhase::Construct
            && session.phase != weaver_solvers::SolverPhase::Construct
        {
            construct_lines = session.history_steps.len();
            construct_secs = t0.elapsed().as_secs_f64();
        }
    }
    let secs = t0.elapsed().as_secs_f64();
    let snap = session.current_progress(Vec::new()).telemetry;

    // Métricas adicionais: correlação estrutural à distância e brilho médio
    let n = (res * res) as usize;
    let w = res as usize;
    let mask = inscribed_disc_mask(w, w);
    let cur: Vec<LinearRgbColor> = (0..n).map(|p| session.canvas.current_color(p)).collect();
    let luma = |c: &[LinearRgbColor]| -> Vec<f32> {
        c.iter()
            .map(|p| linear_to_srgb_channel(p.luminance().clamp(0.0, 1.0)))
            .collect()
    };
    let (lc, lr) = (luma(&cur), luma(&reference));
    let sigma = (res as f32 / 250.0).max(0.8);
    let corr_dist = pearson(
        &gaussian_blur(&lc, w, w, sigma),
        &gaussian_blur(&lr, w, w, sigma),
        &mask,
    );
    let mean = |v: &[f32]| {
        v.iter()
            .zip(&mask)
            .filter(|(_, &m)| m)
            .map(|(x, _)| *x)
            .sum::<f32>()
            / mask.iter().filter(|&&m| m).count() as f32
    };

    let (removed, moved) = session
        .refiner
        .as_ref()
        .map(|r| (r.total_removed, r.total_moves))
        .unwrap_or((0, 0));

    println!(
        "{label:<28} linhas={:<5} (constr. {:<5}) t={:>6.1}s (constr. {:>5.1}s) | SSIM={:.4} RMSE={:.4} ΔE={:.2} corr={:.4} | brilho={:.3} (foto {:.3}) | refino: {moved} realoc., {removed} remoções",
        session.history_steps.len(),
        construct_lines,
        secs,
        construct_secs,
        snap.ssim,
        snap.rmse,
        snap.delta_e,
        corr_dist,
        mean(&lc),
        mean(&lr),
    );

    save_png(
        &format!("{out_dir}/{label}_canvas.png"),
        res,
        res,
        &lin_to_rgb8(&cur),
    );
    save_png(
        &format!("{out_dir}/{label}_target.png"),
        res,
        res,
        &lin_to_rgb8(&target),
    );
    let imp_max = importance.iter().copied().fold(1.0f32, f32::max);
    let imp_rgb: Vec<u8> = importance
        .iter()
        .flat_map(|&v| {
            let u = ((v / imp_max).clamp(0.0, 1.0) * 255.0) as u8;
            [u, u, u]
        })
        .collect();
    save_png(
        &format!("{out_dir}/{label}_importance.png"),
        res,
        res,
        &imp_rgb,
    );
}
