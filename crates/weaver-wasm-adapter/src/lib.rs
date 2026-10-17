//! Camada 3 (`weaver-wasm-adapter`): Ponte `wasm-bindgen` e `SharedArrayBuffer` RingBuffer.

use std::sync::Arc;
use wasm_bindgen::prelude::*;

use weaver_cam::{
    export_artwork_svg, export_project_json, generate_drilling_gcode, generate_mechanical_csv,
    BlueprintConfig, BlueprintTiler, BomConfig, GcodeDrillingParams, SpoolInfo, SvgArtworkOptions,
    WeavingStep,
};
use weaver_domain::{
    ColorErrorMetric, LinearRgbColor, LoomGeometry, LoomPhysicalSpec, Millimeters, PegSide, Pixels,
    RasterizerType, SparseChordMatrixCSR, WindingDirection,
};
use weaver_dsp::{
    compute_auto_framing, AutoFramingOptions, ClaheConfig, DspPipeline, DspPipelineConfig,
    FramingConfig, ImportanceMap, Rgba8Image,
};
use weaver_solvers::{
    compute_effective_alpha, BeamSearchConfig, CanvasStateSoA, GlobalFistaConfig, GreedyConfig,
    OpticalMixModelType, OpticalModelEvaluator, SolverSession, SolverStatus, SpoolColor,
    SpoolScheduler, SpoolSwitchStrategy,
};

pub use weaver_cam::DrillHoleSpec;
pub use weaver_dsp::DspGridSpec;
pub use weaver_solvers::CandidateChord;

pub const RING_BUFFER_HEADER_WORDS: usize = 4;

pub const CTRL_INT32_STATUS_FLAG: usize = 0;
pub const CTRL_INT32_CURRENT_STEP: usize = 1;
pub const CTRL_INT32_ACTIVE_SPOOL: usize = 2;
pub const CTRL_INT32_TOTAL_SWITCHES: usize = 3;

pub const CTRL_FLOAT32_RMSE: usize = 0;
pub const CTRL_FLOAT32_DELTA_E: usize = 1;
pub const CTRL_FLOAT32_SSIM: usize = 2;
pub const CTRL_FLOAT32_TOTAL_METERS: usize = 3;
pub const CTRL_FLOAT32_SPOOL_METERS_BASE: usize = 4;

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasmFramingConfig {
    #[serde(default = "default_zoom")]
    pub zoom: f32,
    #[serde(default)]
    pub pan_x_percent: f32,
    #[serde(default)]
    pub pan_y_percent: f32,
    #[serde(default)]
    pub rotation_deg: f32,
    #[serde(default = "default_auto_face")]
    pub auto_face_target_ratio: f32,
}

fn default_zoom() -> f32 {
    1.0
}
fn default_auto_face() -> f32 {
    0.80
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasmWeaverConfig {
    #[serde(default = "default_shape")]
    pub shape: String,
    #[serde(default = "default_pin_count")]
    pub pin_count: usize,
    #[serde(default = "default_diameter_mm")]
    pub diameter_mm: f64,
    #[serde(default = "default_diameter_mm")]
    pub width_mm: f64,
    #[serde(default = "default_diameter_mm")]
    pub height_mm: f64,
    #[serde(default = "default_polygon_sides")]
    pub polygon_sides: usize,
    #[serde(default = "default_pin_d_mm")]
    pub pin_diameter_mm: f64,
    #[serde(default = "default_thread_thickness_mm")]
    pub thread_thickness_mm: f32,
    #[serde(default = "default_drill_bit_mm")]
    pub drill_bit_mm: f64,
    #[serde(default = "default_edge_margin_mm")]
    pub edge_margin_mm: f64,

    #[serde(default = "default_palette_mode")]
    pub palette_mode: String,
    #[serde(default = "default_optical_mix")]
    pub optical_mix_model: String,
    #[serde(default = "default_error_metric")]
    pub error_metric: String,

    #[serde(default = "default_solver")]
    pub solver: String,
    #[serde(default = "default_max_lines")]
    pub max_lines: usize,
    #[serde(default = "default_min_gap")]
    pub min_peg_gap: usize,
    #[serde(default = "default_max_repeats")]
    pub max_chord_repeats: usize,

    #[serde(default = "default_spool_strategy")]
    pub spool_strategy: String,
    #[serde(default)]
    pub switch_penalty_lambda: f32,
    #[serde(default = "default_min_run_length")]
    pub min_run_length: usize,

    #[serde(default = "default_rasterizer")]
    pub rasterizer: String,
    #[serde(default = "default_clahe_clip")]
    pub clahe_clip_limit: f32,
    #[serde(default = "default_face_weight")]
    pub face_importance_weight: f32,
    #[serde(default = "default_edge_blend")]
    pub edge_blend_weight: f32,
    #[serde(default = "default_one")]
    pub contrast: f32,
    #[serde(default)]
    pub brightness: f32,
    #[serde(default = "default_one")]
    pub gamma: f32,

    #[serde(default)]
    pub framing: Option<WasmFramingConfig>,
    #[serde(default = "default_resolution")]
    pub target_resolution: u32,
}

fn default_shape() -> String { "CIRCULAR".to_string() }
fn default_pin_count() -> usize { 200 }
fn default_diameter_mm() -> f64 { 600.0 }
fn default_polygon_sides() -> usize { 6 }
fn default_pin_d_mm() -> f64 { 2.0 }
fn default_thread_thickness_mm() -> f32 { 0.20 }
fn default_drill_bit_mm() -> f64 { 2.0 }
fn default_edge_margin_mm() -> f64 { 10.0 }
fn default_palette_mode() -> String { "MONOCHROME".to_string() }
fn default_optical_mix() -> String { "PORTER_DUFF_OCCLUSION".to_string() }
fn default_error_metric() -> String { "LINEAR_RGB".to_string() }
fn default_solver() -> String { "ITERATIVE_GREEDY".to_string() }
fn default_max_lines() -> usize { 4000 }
fn default_min_gap() -> usize { 12 }
fn default_max_repeats() -> usize { 3 }
fn default_spool_strategy() -> String { "FREE_GREEDY".to_string() }
fn default_min_run_length() -> usize { 100 }
fn default_rasterizer() -> String { "XIAOLIN_WU_ANTIALIASED".to_string() }
fn default_clahe_clip() -> f32 { 2.0 }
fn default_face_weight() -> f32 { 3.0 }
fn default_edge_blend() -> f32 { 0.15 }
fn default_one() -> f32 { 1.0 }
fn default_resolution() -> u32 { 500 }

impl Default for WasmWeaverConfig {
    fn default() -> Self {
        Self {
            shape: default_shape(),
            pin_count: default_pin_count(),
            diameter_mm: default_diameter_mm(),
            width_mm: default_diameter_mm(),
            height_mm: default_diameter_mm(),
            polygon_sides: default_polygon_sides(),
            pin_diameter_mm: default_pin_d_mm(),
            thread_thickness_mm: default_thread_thickness_mm(),
            drill_bit_mm: default_drill_bit_mm(),
            edge_margin_mm: default_edge_margin_mm(),
            palette_mode: default_palette_mode(),
            optical_mix_model: default_optical_mix(),
            error_metric: default_error_metric(),
            solver: default_solver(),
            max_lines: default_max_lines(),
            min_peg_gap: default_min_gap(),
            max_chord_repeats: default_max_repeats(),
            spool_strategy: default_spool_strategy(),
            switch_penalty_lambda: 0.0,
            min_run_length: default_min_run_length(),
            rasterizer: default_rasterizer(),
            clahe_clip_limit: default_clahe_clip(),
            face_importance_weight: default_face_weight(),
            edge_blend_weight: default_edge_blend(),
            contrast: 1.0,
            brightness: 0.0,
            gamma: 1.0,
            framing: None,
            target_resolution: default_resolution(),
        }
    }
}

#[wasm_bindgen]
pub struct WasmWeavingEngine {
    is_shared: bool,
    capacity_steps: usize,

    control_int32: js_sys::Int32Array,
    control_float32: js_sys::Float32Array,
    path_uint8: js_sys::Uint8Array,

    dsp_pipeline: DspPipeline,
    loom: Option<LoomGeometry>,
    last_source_rgba: Option<Rgba8Image>,
    base_importance_weights: Vec<f32>,
    current_importance_weights: Vec<f32>,

    cached_matrix: Option<(LoomPhysicalSpec, Pixels, u16, RasterizerType, Arc<SparseChordMatrixCSR>)>,
    solver_session: Option<SolverSession>,
    spool_infos: Vec<SpoolInfo>,

    diagnostic_prepared_rgba: Vec<u8>,
    diagnostic_importance_rgba: Vec<u8>,
    diagnostic_edges_rgba: Vec<u8>,
    diagnostic_radon_rgba: Vec<u8>,
    diagnostic_dimensions: [u32; 8],

    total_thread_meters: f32,
    spool_thread_meters: [f32; 16],
}

#[wasm_bindgen]
impl WasmWeavingEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(shared_buffer: JsValue) -> Result<WasmWeavingEngine, JsValue> {
        let byte_length = js_sys::Reflect::get(&shared_buffer, &JsValue::from_str("byteLength"))
            .map_err(|_| JsValue::from_str("Invalid buffer: missing byteLength"))?
            .as_f64()
            .ok_or_else(|| JsValue::from_str("byteLength is not a number"))? as usize;

        if byte_length < 128 {
            return Err(JsValue::from_str("Buffer is smaller than 128-byte ControlBlock"));
        }

        let capacity_steps = (byte_length - 128) / 8;

        let is_shared = js_sys::Reflect::get(&shared_buffer, &JsValue::from_str("constructor"))
            .ok()
            .and_then(|c| js_sys::Reflect::get(&c, &JsValue::from_str("name")).ok())
            .and_then(|n| n.as_string())
            .map(|name| name == "SharedArrayBuffer")
            .unwrap_or(false);

        let control_int32 = js_sys::Int32Array::new_with_byte_offset_and_length(&shared_buffer, 0, 8);
        let control_float32 = js_sys::Float32Array::new_with_byte_offset_and_length(&shared_buffer, 32, 24);
        let path_uint8 = js_sys::Uint8Array::new_with_byte_offset_and_length(
            &shared_buffer,
            128,
            (capacity_steps * 8) as u32,
        );

        let dsp_pipeline = DspPipeline::new(DspPipelineConfig::default());

        Ok(Self {
            is_shared,
            capacity_steps,
            control_int32,
            control_float32,
            path_uint8,
            dsp_pipeline,
            loom: None,
            last_source_rgba: None,
            base_importance_weights: Vec::new(),
            current_importance_weights: Vec::new(),
            cached_matrix: None,
            solver_session: None,
            spool_infos: Vec::new(),
            diagnostic_prepared_rgba: Vec::new(),
            diagnostic_importance_rgba: Vec::new(),
            diagnostic_edges_rgba: Vec::new(),
            diagnostic_radon_rgba: Vec::new(),
            diagnostic_dimensions: [0; 8],
            total_thread_meters: 0.0,
            spool_thread_meters: [0.0; 16],
        })
    }

    pub fn load_and_prepare_image(
        &mut self,
        raw_rgba: &[u8],
        width: u32,
        height: u32,
        config_json: &str,
    ) -> Result<String, JsValue> {
        let config: WasmWeaverConfig = if config_json.trim().is_empty() {
            WasmWeaverConfig::default()
        } else {
            serde_json::from_str(config_json)
                .map_err(|e| JsValue::from_str(&format!("JSON deserialize error: {}", e)))?
        };

        let loom = build_loom_from_config(&config);
        let res = config.target_resolution;

        let mut dsp_config = DspPipelineConfig::default();
        dsp_config.target_resolution = res;
        dsp_config.beta_face = config.face_importance_weight;
        dsp_config.beta_edge = config.edge_blend_weight;
        dsp_config.high_freq_blend = config.edge_blend_weight.min(0.35);
        dsp_config.monochrome_target = config.palette_mode.eq_ignore_ascii_case("MONOCHROME");
        dsp_config.contrast = config.contrast;
        dsp_config.brightness = config.brightness;
        dsp_config.gamma = config.gamma;

        if config.clahe_clip_limit > 0.0 {
            dsp_config.clahe = Some(ClaheConfig {
                clip_limit: config.clahe_clip_limit,
                ..Default::default()
            });
        } else {
            dsp_config.clahe = None;
        }

        if let Some(f) = &config.framing {
            dsp_config.framing = FramingConfig {
                zoom: f.zoom,
                pan_x: f.pan_x_percent / 100.0,
                pan_y: f.pan_y_percent / 100.0,
                rotation_deg: f.rotation_deg,
            };
            dsp_config.auto_framing = None;
        }

        self.dsp_pipeline = DspPipeline::new(dsp_config);
        let src_img = Rgba8Image::new(width, height, 4, raw_rgba.to_vec());

        let diag = self.dsp_pipeline.execute(&src_img, Some(&loom), None);

        self.diagnostic_prepared_rgba = diag.prepared_target_rgba.data.clone();
        self.diagnostic_importance_rgba = diag.importance_map_rgba.data.clone();
        self.diagnostic_edges_rgba = diag.edges_rgba.data.clone();
        self.diagnostic_radon_rgba = diag.radon_sinogram_rgba.data.clone();

        self.diagnostic_dimensions = [
            diag.prepared_target_rgba.width,
            diag.prepared_target_rgba.height,
            diag.importance_map_rgba.width,
            diag.importance_map_rgba.height,
            diag.edges_rgba.width,
            diag.edges_rgba.height,
            diag.radon_sinogram_rgba.width,
            diag.radon_sinogram_rgba.height,
        ];

        let base_imp = self.dsp_pipeline.importance_map().unwrap().weights.clone();
        self.base_importance_weights = base_imp.clone();
        self.current_importance_weights = base_imp;

        self.loom = Some(loom);
        self.last_source_rgba = Some(src_img);

        let summary = format!(
            r#"{{"preparedWidth":{},"preparedHeight":{},"importanceWidth":{},"importanceHeight":{},"edgesWidth":{},"edgesHeight":{},"radonWidth":{},"radonHeight":{}}}"#,
            self.diagnostic_dimensions[0],
            self.diagnostic_dimensions[1],
            self.diagnostic_dimensions[2],
            self.diagnostic_dimensions[3],
            self.diagnostic_dimensions[4],
            self.diagnostic_dimensions[5],
            self.diagnostic_dimensions[6],
            self.diagnostic_dimensions[7]
        );

        Ok(summary)
    }

    pub fn apply_user_importance_brush(&mut self, brush_weights: &[f32]) {
        if self.base_importance_weights.is_empty()
            || self.base_importance_weights.len() != brush_weights.len()
        {
            return;
        }

        let mut updated = self.base_importance_weights.clone();
        for i in 0..updated.len() {
            updated[i] = (updated[i] + brush_weights[i]).max(0.0);
        }

        let res = self.diagnostic_dimensions[2];
        let imp_map = ImportanceMap::new(res, res, updated.clone());
        self.diagnostic_importance_rgba = imp_map.to_preview_rgba().data;
        self.current_importance_weights = updated;

        if let Some(session) = &mut self.solver_session {
            for (i, &w) in self.current_importance_weights.iter().enumerate() {
                if i < session.canvas.importance_w.len() {
                    session.canvas.importance_w[i] = w;
                }
            }
        }
    }

    pub fn init_solver(&mut self, config_json: &str) -> Result<(), JsValue> {
        let config: WasmWeaverConfig = if config_json.trim().is_empty() {
            WasmWeaverConfig::default()
        } else {
            serde_json::from_str(config_json)
                .map_err(|e| JsValue::from_str(&format!("JSON deserialize error: {}", e)))?
        };

        let loom = self
            .loom
            .as_ref()
            .cloned()
            .unwrap_or_else(|| build_loom_from_config(&config));
        let res = config.target_resolution;

        let rasterizer = match config.rasterizer.to_uppercase().as_str() {
            "BRESENHAM_BINARY" => RasterizerType::BresenhamBinary,
            _ => RasterizerType::XiaolinWuAntialiased,
        };

        // Garante que nenhuma corda curta fique colada à borda do aro (mínimo de ~8% do aro)
        let min_gap = config.min_peg_gap.max(config.pin_count / 12).max(16) as u16;

        let matrix: Arc<SparseChordMatrixCSR> = match &self.cached_matrix {
            Some((spec, r, gap, rast, m))
                if *spec == loom.spec && r.0 == res && *gap == min_gap && *rast == rasterizer =>
            {
                m.clone()
            }
            _ => {
                let m = Arc::new(SparseChordMatrixCSR::build(
                    &loom,
                    Pixels(res),
                    min_gap as usize,
                    rasterizer,
                ));
                self.cached_matrix =
                    Some((loom.spec.clone(), Pixels(res), min_gap, rasterizer, m.clone()));
                m
            }
        };

        // CORREÇÃO CRÍTICA: Usa o tensor RGB Linear colorido preparado pelo DSP!
        let target_colors: Vec<LinearRgbColor> = match self.dsp_pipeline.prepared_linear_rgb() {
            Some(rgb) if rgb.len() == (res * res) as usize => rgb.to_vec(),
            _ => self
                .dsp_pipeline
                .prepared_gray()
                .cloned()
                .unwrap_or_else(|| weaver_dsp::GrayImage::fill(res, res, 1, 0.5))
                .to_linear_rgb_vec(),
        };

        let importance_slice = if !self.current_importance_weights.is_empty()
            && self.current_importance_weights.len() == (res * res) as usize
        {
            Some(self.current_importance_weights.as_slice())
        } else {
            None
        };

        let mut canvas = CanvasStateSoA::from_target_and_background(
            res,
            res,
            &target_colors,
            LinearRgbColor::WHITE,
            importance_slice,
        );

        if let Some(sobel) = self.dsp_pipeline.sobel_result() {
            if sobel.magnitude.data.len() == (res * res) as usize {
                canvas.set_edge_map(&sobel.magnitude.data);
            }
        }

        let mix_model = match config.optical_mix_model.to_uppercase().as_str() {
            "LINEAR_SUBTRACTIVE" => OpticalMixModelType::LinearSubtractive,
            "BEER_LAMBERT" => OpticalMixModelType::BeerLambertTransmittance,
            _ => OpticalMixModelType::PorterDuffOcclusion,
        };

        let err_metric = match config.error_metric.to_uppercase().as_str() {
            "REDMEAN_WEIGHTED" => ColorErrorMetric::RedmeanWeighted,
            "CIELAB_DELTA_E2000" => ColorErrorMetric::CielabDeltaE2000,
            _ => ColorErrorMetric::LinearRgb,
        };

        let evaluator = OpticalModelEvaluator::new(mix_model, err_metric)
            .with_highlight_protection(2.8);
        let (spools, spool_infos) = build_spools(&config);
        self.spool_infos = spool_infos;

        let strat = match config.spool_strategy.to_uppercase().as_str() {
            "HYSTERESIS_PENALTY" => SpoolSwitchStrategy::HysteresisPenalty {
                penalty_lambda: if config.switch_penalty_lambda > 0.0 {
                    config.switch_penalty_lambda
                } else {
                    0.05
                },
            },
            "MIN_RUN_LENGTH" => SpoolSwitchStrategy::MinRunLength {
                min_run_length: config.min_run_length.max(10),
            },
            "COARSE_TO_FINE_EPOCHS" => SpoolSwitchStrategy::CoarseToFineEpochs {
                base_ratio: 0.55,
                refine_ratio: 0.25,
                detail_top_ratio: 0.20,
                black_spool_id: if spools.len() > 1 {
                    (spools.len() - 1) as u8
                } else {
                    0
                },
                white_spool_id: None,
                edge_importance_boost: 2.5,
            },
            "SEPARATED_CHANNELS" => {
                let n = spools.len();
                let quotas = if n == 4 {
                    vec![0.18, 0.22, 0.22, 0.38] // Y, M, C, K (Preto com 38% no topo!)
                } else {
                    vec![1.0 / (n as f32); n]
                };
                SpoolSwitchStrategy::SeparatedChannels {
                    quotas,
                    occlusion_compensation: 1.25,
                }
            }
            _ => SpoolSwitchStrategy::FreeGreedy,
        };

        let scheduler = SpoolScheduler::new(strat, config.max_lines, 0);

        // Calibra alpha_eff fisicamente a partir da opacidade do fio, espessura (mm), resolução (px) e diâmetro (mm)
        let primary_alpha = spools
            .last()
            .map(|s| s.alpha_material)
            .unwrap_or(0.35);
        let loom_extent_mm = loom
            .spec
            .diameter_mm
            .max(loom.spec.width_mm)
            .max(loom.spec.height_mm)
            .max(100.0);
        let alpha_eff = compute_effective_alpha(
            primary_alpha,
            Millimeters(config.thread_thickness_mm.max(0.05)),
            Pixels(res),
            Millimeters(loom_extent_mm as f32),
        )
        .clamp(0.012, 0.085);

        let session = match config.solver.to_uppercase().as_str() {
            "BEAM_SEARCH" => {
                let b_cfg = BeamSearchConfig {
                    max_steps: config.max_lines,
                    beam_width: 6,
                    lookahead_depth: 2,
                    max_chord_repeats: config.max_chord_repeats.clamp(1, 3),
                    length_exponent_gamma: 1.0,
                    start_pin: 0,
                };
                SolverSession::new_beam_search(
                    b_cfg, canvas, matrix, evaluator, scheduler, spools, alpha_eff,
                )
            }
            "GLOBAL_NNLS_FISTA" => {
                let f_cfg = GlobalFistaConfig {
                    max_steps: config.max_lines,
                    fista_iterations: 40,
                    l1_regularization_lambda: 0.01,
                    painter_layers_per_color: 2,
                    max_chord_repeats: config.max_chord_repeats.clamp(1, 3),
                    start_pin: 0,
                };
                SolverSession::new_global_fista(
                    f_cfg, canvas, matrix, evaluator, scheduler, spools, alpha_eff,
                )
            }
            _ => {
                let g_cfg = GreedyConfig {
                    max_steps: config.max_lines,
                    max_chord_repeats: config.max_chord_repeats.clamp(1, 3),
                    length_exponent_gamma: 1.0,
                    start_pin: 0,
                    tabu_history_size: 12,
                };
                SolverSession::new_greedy(
                    g_cfg, canvas, matrix, evaluator, scheduler, spools, alpha_eff,
                )
            }
        };

        self.solver_session = Some(session);
        self.loom = Some(loom);
        self.total_thread_meters = 0.0;
        self.spool_thread_meters = [0.0; 16];

        self.write_status(SolverStatus::Idle);
        self.write_step_index(0);
        self.write_active_spool(0);
        self.write_total_switches(0);

        Ok(())
    }

    pub fn compute_smart_framing_wasm(
        &self,
        raw_rgba: &[u8],
        width: u32,
        height: u32,
        target_ratio: f32,
    ) -> Result<String, JsValue> {
        let expected_len = (width as usize) * (height as usize) * 4;
        if raw_rgba.len() != expected_len || width == 0 || height == 0 {
            return Err(JsValue::from_str("Invalid RGBA dimensions for smart framing"));
        }
        let img = Rgba8Image::new(width, height, 4, raw_rgba.to_vec());
        let opts = AutoFramingOptions {
            target_ratio: target_ratio.clamp(0.50, 0.92),
            ..AutoFramingOptions::default()
        };
        let res = compute_auto_framing(&img, &opts);
        let json = serde_json::json!({
            "zoom": res.config.zoom,
            "panXPercent": res.config.pan_x * 100.0,
            "panYPercent": res.config.pan_y * 100.0,
            "confidence": res.confidence,
        });
        Ok(json.to_string())
    }

    pub fn step_solver_batch(&mut self, batch_size: u32) -> bool {
        if self.solver_session.is_none() {
            return false;
        }

        let current_status_code = self.read_status_code();
        if current_status_code == 4 {
            if let Some(session) = &mut self.solver_session {
                session.abort();
            }
            self.write_status(SolverStatus::Aborted);
            return false;
        } else if current_status_code == 2 {
            if let Some(session) = &mut self.solver_session {
                session.pause();
            }
            self.write_status(SolverStatus::Paused);
            return false;
        }

        let session = self.solver_session.as_mut().unwrap();
        let prev_step = session.history_steps.len();
        let progress = session.step_batch(batch_size as usize);
        let batch_len = progress.batch_steps.len();

        let loom_ref = self.loom.as_ref();
        let pin_d = loom_ref.map(|l| l.spec.pin_diameter_mm).unwrap_or(2.0);

        if batch_len > 0 {
            let mut packed_bytes = Vec::with_capacity(batch_len * 8);

            for (idx, step) in progress.batch_steps.iter().enumerate() {
                let step_idx = prev_step + idx;
                if step_idx >= self.capacity_steps {
                    break;
                }

                let from_bytes = step.from_pin.to_le_bytes();
                let to_bytes = step.to_pin.to_le_bytes();
                let spool_byte = step.spool_id;
                let dep_flag = if step.departure_winding == PegSide::CounterClockwise {
                    1u8
                } else {
                    0u8
                };
                let arr_flag = if step.arrival_winding == PegSide::CounterClockwise {
                    2u8
                } else {
                    0u8
                };
                let flags = dep_flag | arr_flag;
                let score_bytes = step.score_normalized.to_le_bytes();

                packed_bytes.push(from_bytes[0]);
                packed_bytes.push(from_bytes[1]);
                packed_bytes.push(to_bytes[0]);
                packed_bytes.push(to_bytes[1]);
                packed_bytes.push(spool_byte);
                packed_bytes.push(flags);
                packed_bytes.push(score_bytes[0]);
                packed_bytes.push(score_bytes[1]);

                let chord_len_mm = if let Some(loom) = loom_ref {
                    let p_a = loom.pin_position(step.from_pin as usize);
                    let p_b = loom.pin_position(step.to_pin as usize);
                    let dx = p_a.0 - p_b.0;
                    let dy = p_a.1 - p_b.1;
                    (dx * dx + dy * dy).sqrt() + std::f64::consts::PI * pin_d
                } else {
                    500.0
                };
                let chord_meters = (chord_len_mm / 1000.0) as f32;
                self.total_thread_meters += chord_meters;
                let s_id = step.spool_id as usize;
                if s_id < 16 {
                    self.spool_thread_meters[s_id] += chord_meters;
                }
            }

            let start_byte_offset = (prev_step * 8) as u32;
            let end_byte_offset = start_byte_offset + packed_bytes.len() as u32;
            self.path_uint8
                .subarray(start_byte_offset, end_byte_offset)
                .copy_from(&packed_bytes);
        }

        self.write_step_index(progress.current_step as i32);
        self.write_active_spool(progress.active_spool_id as i32);
        self.write_total_switches(progress.total_switches as i32);
        self.write_status(progress.status);

        self.control_float32
            .set_index(CTRL_FLOAT32_RMSE as u32, progress.telemetry.rmse);
        self.control_float32
            .set_index(CTRL_FLOAT32_DELTA_E as u32, progress.telemetry.delta_e);
        self.control_float32
            .set_index(CTRL_FLOAT32_SSIM as u32, progress.telemetry.ssim);
        self.control_float32
            .set_index(CTRL_FLOAT32_TOTAL_METERS as u32, self.total_thread_meters);

        for (i, &meters) in self.spool_thread_meters.iter().enumerate().take(16) {
            self.control_float32
                .set_index((CTRL_FLOAT32_SPOOL_METERS_BASE + i) as u32, meters);
        }

        progress.status == SolverStatus::Running
    }

    pub fn get_prepared_target_rgba(&self) -> Vec<u8> {
        self.diagnostic_prepared_rgba.clone()
    }

    pub fn get_importance_map_rgba(&self) -> Vec<u8> {
        self.diagnostic_importance_rgba.clone()
    }

    pub fn get_edges_rgba(&self) -> Vec<u8> {
        self.diagnostic_edges_rgba.clone()
    }

    pub fn get_radon_sinogram_rgba(&self) -> Vec<u8> {
        self.diagnostic_radon_rgba.clone()
    }

    pub fn get_diagnostics_dimensions(&self) -> Vec<u32> {
        self.diagnostic_dimensions.to_vec()
    }

    pub fn generate_drilling_blueprint_svg(&self) -> Result<String, JsValue> {
        let loom = self
            .loom
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Loom not initialized"))?;
        let tiler = BlueprintTiler::new(loom.clone(), BlueprintConfig::default());
        Ok(tiler.to_master_svg())
    }

    pub fn generate_drilling_blueprint_pdf(&self) -> Result<Vec<u8>, JsValue> {
        let loom = self
            .loom
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Loom not initialized"))?;
        let tiler = BlueprintTiler::new(loom.clone(), BlueprintConfig::default());
        Ok(tiler.to_multipage_pdf())
    }

    pub fn generate_drilling_csv(&self) -> Result<String, JsValue> {
        let loom = self
            .loom
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Loom not initialized"))?;
        Ok(generate_mechanical_csv(loom))
    }

    pub fn generate_cnc_gcode(&self) -> Result<String, JsValue> {
        let loom = self
            .loom
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Loom not initialized"))?;
        Ok(generate_drilling_gcode(
            loom,
            &GcodeDrillingParams::default(),
        ))
    }

    pub fn generate_artwork_svg(&self) -> Result<String, JsValue> {
        let loom = self
            .loom
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Loom not initialized"))?;
        let steps = self.collect_weaving_steps();
        Ok(export_artwork_svg(
            loom,
            &steps,
            &self.spool_infos,
            &SvgArtworkOptions::default(),
        ))
    }

    pub fn get_bom_summary_json(&self) -> Result<String, JsValue> {
        let loom = self
            .loom
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Loom not initialized"))?;
        let steps = self.collect_weaving_steps();
        let json = export_project_json(
            loom,
            &steps,
            &self.spool_infos,
            &BomConfig::default(),
            Some("Weaver Art Project"),
        );
        Ok(json)
    }

    fn read_status_code(&self) -> i32 {
        if self.is_shared {
            js_sys::Atomics::load(&self.control_int32, CTRL_INT32_STATUS_FLAG as u32).unwrap_or(0)
        } else {
            self.control_int32.get_index(CTRL_INT32_STATUS_FLAG as u32)
        }
    }

    fn write_status(&self, status: SolverStatus) {
        let val = status.as_i32();
        if self.is_shared {
            let _ = js_sys::Atomics::store(&self.control_int32, CTRL_INT32_STATUS_FLAG as u32, val);
        } else {
            self.control_int32
                .set_index(CTRL_INT32_STATUS_FLAG as u32, val);
        }
    }

    fn write_step_index(&self, step: i32) {
        if self.is_shared {
            let _ = js_sys::Atomics::store(
                &self.control_int32,
                CTRL_INT32_CURRENT_STEP as u32,
                step,
            );
        } else {
            self.control_int32
                .set_index(CTRL_INT32_CURRENT_STEP as u32, step);
        }
    }

    fn write_active_spool(&self, spool: i32) {
        if self.is_shared {
            let _ = js_sys::Atomics::store(
                &self.control_int32,
                CTRL_INT32_ACTIVE_SPOOL as u32,
                spool,
            );
        } else {
            self.control_int32
                .set_index(CTRL_INT32_ACTIVE_SPOOL as u32, spool);
        }
    }

    fn write_total_switches(&self, switches: i32) {
        if self.is_shared {
            let _ = js_sys::Atomics::store(
                &self.control_int32,
                CTRL_INT32_TOTAL_SWITCHES as u32,
                switches,
            );
        } else {
            self.control_int32
                .set_index(CTRL_INT32_TOTAL_SWITCHES as u32, switches);
        }
    }

    fn collect_weaving_steps(&self) -> Vec<WeavingStep> {
        let session = match &self.solver_session {
            Some(s) => s,
            None => return Vec::new(),
        };

        session
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
            .collect()
    }
}

fn build_loom_from_config(cfg: &WasmWeaverConfig) -> LoomGeometry {
    let shape = cfg.shape.to_uppercase();
    let spec = if shape == "ELLIPTICAL" {
        LoomPhysicalSpec::ellipse(
            cfg.width_mm,
            cfg.height_mm,
            cfg.pin_count,
            cfg.pin_diameter_mm,
            cfg.drill_bit_mm,
            cfg.edge_margin_mm,
        )
    } else if shape == "RECTANGULAR" {
        LoomPhysicalSpec::rectangle(
            cfg.width_mm,
            cfg.height_mm,
            cfg.pin_count,
            cfg.pin_diameter_mm,
            cfg.drill_bit_mm,
            cfg.edge_margin_mm,
        )
    } else if shape == "REGULAR_POLYGON" {
        LoomPhysicalSpec::regular_polygon(
            cfg.polygon_sides,
            cfg.diameter_mm,
            cfg.pin_count,
            cfg.pin_diameter_mm,
            cfg.drill_bit_mm,
            cfg.edge_margin_mm,
        )
    } else {
        LoomPhysicalSpec::circle(
            cfg.diameter_mm,
            cfg.pin_count,
            cfg.pin_diameter_mm,
            cfg.drill_bit_mm,
            cfg.edge_margin_mm,
        )
    };
    LoomGeometry::new(spec)
}

fn build_spools(cfg: &WasmWeaverConfig) -> (Vec<SpoolColor>, Vec<SpoolInfo>) {
    match cfg.palette_mode.to_uppercase().as_str() {
        "CMYK_SUBTRACTIVE" => {
            // Pigmentos CMYK reais calibrados em Linear RGB (evitando neon sintético)
            let spools = vec![
                SpoolColor::new(0, LinearRgbColor::new(0.95, 0.85, 0.02), 0.22), // Amarelo
                SpoolColor::new(1, LinearRgbColor::new(0.82, 0.04, 0.45), 0.24), // Magenta
                SpoolColor::new(2, LinearRgbColor::new(0.02, 0.58, 0.85), 0.24), // Ciano
                SpoolColor::new(3, LinearRgbColor::new(0.02, 0.02, 0.02), 0.35), // Preto (K)
            ];
            let infos = vec![
                SpoolInfo::new(0, "Amarelo", "#f5dd05"),
                SpoolInfo::new(1, "Magenta", "#d90a75"),
                SpoolInfo::new(2, "Ciano", "#0594d9"),
                SpoolInfo::new(3, "Preto", "#141414"),
            ];
            (spools, infos)
        }
        "RGB_OCCLUSIVE" => {
            let spools = vec![
                SpoolColor::new(0, LinearRgbColor::new(0.85, 0.05, 0.05), 0.28),
                SpoolColor::new(1, LinearRgbColor::new(0.05, 0.75, 0.10), 0.28),
                SpoolColor::new(2, LinearRgbColor::new(0.05, 0.15, 0.85), 0.28),
                SpoolColor::new(3, LinearRgbColor::new(0.02, 0.02, 0.02), 0.35),
            ];
            let infos = vec![
                SpoolInfo::new(0, "Vermelho", "#e01010"),
                SpoolInfo::new(1, "Verde", "#10c020"),
                SpoolInfo::new(2, "Azul", "#1030e0"),
                SpoolInfo::new(3, "Preto", "#141414"),
            ];
            (spools, infos)
        }
        _ => {
            let spools = vec![SpoolColor::new(0, LinearRgbColor::new(0.02, 0.02, 0.02), 0.35)];
            let infos = vec![SpoolInfo::new(0, "Preto", "#141414")];
            (spools, infos)
        }
    }
}
