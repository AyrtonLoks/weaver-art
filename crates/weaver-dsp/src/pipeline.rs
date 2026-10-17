//! Orquestrador do Pipeline de DSP (`DspPipeline`).
//!
//! Fluxo (reescrito para ser previsível e medível):
//!
//! 1. Enquadramento afim (zoom / pan / rotação) + máscara do tear;
//! 2. Luminância fotométrica **linear** $Y$ (Rec. 709) → referência das métricas;
//! 3. Espaço de trabalho perceptual $L = \text{sRGB}(Y)$, onde atuam **apenas** os ajustes pedidos:
//!    brilho/contraste/gama do usuário e, se habilitados, CLAHE, nitidez (unsharp) e fusão de bordas;
//! 4. Conversão **única** de volta para luz linear (alvo do solver).
//!
//! O mapa de importância é suave e limitado: $W = 1 + \beta_f M_{\text{face}} + \beta_e E + \beta_{ft} F$,
//! com $M_{\text{face}}, E, F \in [0, 1]$ desfocados ($F$ = feições escuras pequenas) — logo $W \ge 1$ (exceto onde o pincel do usuário reduz).

use weaver_domain::{linear_to_srgb_channel, srgb_to_linear_channel, LinearRgbColor, LoomGeometry};

use crate::contrast::{
    adjust_brightness_contrast_gray, apply_gamma_gray, apply_unsharp_mask, clahe_gray, ClaheConfig,
};
use crate::edges::{
    canny, edges_to_rgba, fuse_high_frequency, gaussian_blur_gray, sobel, CannyConfig, SobelResult,
};
use crate::framing::{
    apply_affine_transform, compute_auto_framing, AutoFramingOptions, FramingConfig,
    InterpolationMethod, LoomMask,
};
use crate::image::{GrayImage, ImageBuffer, Rgba8Image};
use crate::importance::{compute_dark_feature_map, compute_facial_saliency_map, ImportanceMap};
use crate::radon::{apply_ramp_filter, compute_radon_transform, RadonOptions, Sinogram};

/// Configuração completa de execução do pipeline de pré-processamento DSP.
#[derive(Debug, Clone, PartialEq)]
pub struct DspPipelineConfig {
    pub target_resolution: u32,
    pub framing: FramingConfig,
    pub interpolation: InterpolationMethod,
    /// Equalização local CLAHE no espaço perceptual (`None` = desligada).
    pub clahe: Option<ClaheConfig>,
    pub canny: CannyConfig,
    /// Peso da saliência facial no mapa de importância (0 = desligado).
    pub beta_face: f32,
    /// Peso das bordas no mapa de importância (0 = desligado).
    pub beta_edge: f32,
    /// Peso das feições escuras pequenas (olhos, sobrancelhas, boca) no mapa de importância.
    pub beta_feature: f32,
    /// Clareia os meios-tons altos (pele) preservando os escuros, em [0, 1] (0 = desligado).
    pub skin_lift: f32,
    /// Fusão de alta frequência: escurece bordas no alvo (0 = desligada).
    pub high_freq_blend: f32,
    /// Intensidade da máscara de nitidez (unsharp) no alvo (0 = desligada).
    pub sharpen_amount: f32,
    /// Raio gaussiano da máscara de nitidez, em pixels.
    pub sharpen_sigma: f32,
    pub background_luma: f32,
    pub radon: RadonOptions,
    pub auto_framing: Option<AutoFramingOptions>,
    /// `true`: alvo em escala de cinza (monocromático). `false`: preserva a cromaticidade.
    pub monochrome_target: bool,
    pub contrast: f32,
    pub brightness: f32,
    pub gamma: f32,
}

impl Default for DspPipelineConfig {
    fn default() -> Self {
        Self {
            target_resolution: 500,
            framing: FramingConfig::default(),
            interpolation: InterpolationMethod::Bilinear,
            clahe: None,
            canny: CannyConfig::default(),
            beta_face: 0.0,
            beta_edge: 0.0,
            beta_feature: 0.0,
            skin_lift: 0.0,
            high_freq_blend: 0.0,
            sharpen_amount: 0.0,
            sharpen_sigma: 1.2,
            background_luma: 1.0,
            radon: RadonOptions::default(),
            auto_framing: None,
            monochrome_target: false,
            contrast: 1.0,
            brightness: 0.0,
            gamma: 1.0,
        }
    }
}

/// Conjunto de buffers de diagnóstico gerados pelo pipeline para inspeção multi-estágio.
#[derive(Debug, Clone, PartialEq)]
pub struct DspDiagnosticBuffers {
    pub prepared_target_rgba: Rgba8Image,
    pub importance_map_rgba: Rgba8Image,
    pub edges_rgba: Rgba8Image,
    pub radon_sinogram_rgba: Rgba8Image,
}

impl DspDiagnosticBuffers {
    pub fn edge_and_radon_preview_rgba(&self) -> Rgba8Image {
        let w1 = self.edges_rgba.width;
        let h1 = self.edges_rgba.height;
        let w2 = self.radon_sinogram_rgba.width;
        let h2 = self.radon_sinogram_rgba.height;

        let mut out = ImageBuffer::fill(w1 + w2, h1.max(h2), 4, 0u8);
        for y in 0..h1 {
            for x in 0..w1 {
                out.set_pixel(x, y, self.edges_rgba.get_pixel(x, y));
            }
        }
        for y in 0..h2 {
            for x in 0..w2 {
                out.set_pixel(w1 + x, y, self.radon_sinogram_rgba.get_pixel(x, y));
            }
        }
        out
    }
}

pub struct DspPipeline {
    pub config: DspPipelineConfig,
    cached_framed_rgba: Option<Rgba8Image>,
    cached_prepared_gray: Option<GrayImage>,
    cached_prepared_linear_rgb: Option<Vec<LinearRgbColor>>,
    cached_reference_linear_rgb: Option<Vec<LinearRgbColor>>,
    cached_sobel: Option<SobelResult>,
    cached_edges: Option<GrayImage>,
    cached_importance_map: Option<ImportanceMap>,
    cached_filtered_sinogram: Option<Sinogram>,
    cached_diagnostics: Option<DspDiagnosticBuffers>,
}

impl DspPipeline {
    pub fn new(config: DspPipelineConfig) -> Self {
        Self {
            config,
            cached_framed_rgba: None,
            cached_prepared_gray: None,
            cached_prepared_linear_rgb: None,
            cached_reference_linear_rgb: None,
            cached_sobel: None,
            cached_edges: None,
            cached_importance_map: None,
            cached_filtered_sinogram: None,
            cached_diagnostics: None,
        }
    }

    pub fn execute(
        &mut self,
        source: &Rgba8Image,
        loom: Option<&LoomGeometry>,
        user_brush_mask: Option<&[f32]>,
    ) -> &DspDiagnosticBuffers {
        let res = self.config.target_resolution;
        let total_px = (res * res) as usize;

        if let Some(opts) = &self.config.auto_framing {
            self.config.framing = compute_auto_framing(source, opts).config;
        }

        // 1. Enquadramento afim + máscara do tear
        let loom_mask = loom.map(|l| LoomMask::from_loom(l, res, res));
        let src_float = ImageBuffer::new(
            source.width,
            source.height,
            4,
            source.data.iter().map(|&b| b as f32 / 255.0).collect(),
        );
        let framed_float = apply_affine_transform(
            &src_float,
            res,
            res,
            &self.config.framing,
            self.config.interpolation,
            loom_mask.as_ref(),
            self.config.background_luma,
        );
        let framed_rgba = Rgba8Image::new(
            res,
            res,
            4,
            framed_float
                .data
                .iter()
                .map(|&f| (f.clamp(0.0, 1.0) * 255.0).round() as u8)
                .collect(),
        );

        // 2. Luminância linear Y e referência das métricas
        let framed_y = framed_rgba.to_gray();
        let framed_lin: Vec<LinearRgbColor> = framed_rgba.to_linear_rgb_vec();
        let reference: Vec<LinearRgbColor> = if self.config.monochrome_target {
            framed_y
                .data
                .iter()
                .map(|&y| LinearRgbColor::new(y, y, y))
                .collect()
        } else {
            framed_lin.clone()
        };

        // 3. Espaço perceptual L = sRGB(Y) e ajustes solicitados
        let base_l: Vec<f32> = framed_y
            .data
            .iter()
            .map(|&y| linear_to_srgb_channel(y))
            .collect();
        let mut work = GrayImage::new(res, res, 1, base_l.clone());
        if (self.config.contrast - 1.0).abs() > 1e-3 || self.config.brightness.abs() > 1e-3 {
            adjust_brightness_contrast_gray(
                &mut work,
                self.config.brightness,
                self.config.contrast,
            );
        }
        if (self.config.gamma - 1.0).abs() > 1e-3 {
            apply_gamma_gray(&mut work, self.config.gamma);
        }
        if self.config.skin_lift > 1e-4 {
            let lift = self.config.skin_lift.clamp(0.0, 1.0);
            for v in work.data.iter_mut() {
                // Curva suave: não altera pretos (v ≤ 0,25) nem o branco; clareia a pele
                *v = (*v + lift * 2.0 * *v * (1.0 - *v) * (*v - 0.25).max(0.0)).clamp(0.0, 1.0);
            }
        }
        if let Some(clahe_cfg) = &self.config.clahe {
            if clahe_cfg.clip_limit > 0.05 {
                clahe_gray(&mut work, clahe_cfg);
            }
        }
        if self.config.sharpen_amount > 1e-4 {
            apply_unsharp_mask(
                &mut work,
                self.config.sharpen_sigma,
                self.config.sharpen_amount,
            );
        }

        let sobel_res = sobel(&work);
        let canny_edges = canny(&work, &self.config.canny);
        if self.config.high_freq_blend > 1e-4 {
            work = fuse_high_frequency(&work, &sobel_res.magnitude, self.config.high_freq_blend);
        }

        // 4. Conversão única para luz linear
        let mut prepared_linear_rgb = Vec::with_capacity(total_px);
        let mut prepared_gray_data = Vec::with_capacity(total_px);
        let mut prepared_rgba_bytes = Vec::with_capacity(total_px * 4);
        for i in 0..total_px {
            let l = work.data[i].clamp(0.0, 1.0);
            if self.config.monochrome_target {
                let y = srgb_to_linear_channel(l);
                prepared_linear_rgb.push(LinearRgbColor::new(y, y, y));
                prepared_gray_data.push(y);
                let u = (l * 255.0).round() as u8;
                prepared_rgba_bytes.extend_from_slice(&[u, u, u, 255]);
            } else {
                // Preserva a cromaticidade: escala as componentes sRGB pela razão L_novo / L_original
                let ratio = if base_l[i] > 1e-4 {
                    (l / base_l[i]).clamp(0.0, 4.0)
                } else {
                    1.0
                };
                let px = &framed_rgba.data[i * 4..i * 4 + 3];
                let enc = [
                    (px[0] as f32 / 255.0 * ratio).clamp(0.0, 1.0),
                    (px[1] as f32 / 255.0 * ratio).clamp(0.0, 1.0),
                    (px[2] as f32 / 255.0 * ratio).clamp(0.0, 1.0),
                ];
                let lin = LinearRgbColor::new(
                    srgb_to_linear_channel(enc[0]),
                    srgb_to_linear_channel(enc[1]),
                    srgb_to_linear_channel(enc[2]),
                );
                prepared_gray_data.push(lin.luminance());
                prepared_linear_rgb.push(lin);
                prepared_rgba_bytes.extend_from_slice(&[
                    (enc[0] * 255.0).round() as u8,
                    (enc[1] * 255.0).round() as u8,
                    (enc[2] * 255.0).round() as u8,
                    255,
                ]);
            }
        }

        // 5. Mapa de importância suave W = 1 + βf·M_face + βe·E
        let blur_sigma = (res as f32 * 0.01).max(0.8);
        let face = if self.config.beta_face.abs() > 1e-6 {
            Some(compute_facial_saliency_map(&framed_rgba))
        } else {
            None
        };
        let edge_map = if self.config.beta_edge.abs() > 1e-6 {
            let mut e = gaussian_blur_gray(&sobel_res.magnitude, blur_sigma);
            let max_e = e.data.iter().copied().fold(0.0f32, f32::max);
            if max_e > 1e-6 {
                e.data
                    .iter_mut()
                    .for_each(|v| *v = (*v / max_e).clamp(0.0, 1.0));
            }
            Some(e)
        } else {
            None
        };
        let feature_map = if self.config.beta_feature > 1e-6 {
            Some(compute_dark_feature_map(&work, &framed_rgba))
        } else {
            None
        };
        let mut importance_map = ImportanceMap::compose_auto(
            res,
            res,
            face.as_ref(),
            edge_map.as_ref(),
            self.config.beta_face.max(0.0),
            self.config.beta_edge.max(0.0),
        );
        if let Some(fm) = &feature_map {
            let beta = self.config.beta_feature;
            for (wt, f) in importance_map.weights.iter_mut().zip(&fm.data) {
                *wt += beta * f;
            }
        }
        if let Some(brush) = user_brush_mask {
            importance_map.merge_user_brush(brush);
        }

        // 6. Transformada de Radon (diagnóstico)
        let sinogram = compute_radon_transform(&work, &self.config.radon);
        let filtered_sinogram = apply_ramp_filter(&sinogram, None);

        let diagnostics = DspDiagnosticBuffers {
            prepared_target_rgba: Rgba8Image::new(res, res, 4, prepared_rgba_bytes),
            importance_map_rgba: importance_map.to_preview_rgba(),
            edges_rgba: edges_to_rgba(&canny_edges),
            radon_sinogram_rgba: filtered_sinogram.to_preview_rgba(),
        };

        self.cached_framed_rgba = Some(framed_rgba);
        self.cached_prepared_gray = Some(GrayImage::new(res, res, 1, prepared_gray_data));
        self.cached_prepared_linear_rgb = Some(prepared_linear_rgb);
        self.cached_reference_linear_rgb = Some(reference);
        self.cached_sobel = Some(sobel_res);
        self.cached_edges = Some(canny_edges);
        self.cached_importance_map = Some(importance_map);
        self.cached_filtered_sinogram = Some(filtered_sinogram);
        self.cached_diagnostics = Some(diagnostics);

        self.cached_diagnostics.as_ref().unwrap()
    }

    pub fn diagnostics(&self) -> Option<&DspDiagnosticBuffers> {
        self.cached_diagnostics.as_ref()
    }

    /// Foto enquadrada (bytes sRGB RGBA) antes de qualquer ajuste.
    pub fn framed_rgba(&self) -> Option<&Rgba8Image> {
        self.cached_framed_rgba.as_ref()
    }

    /// Luminância linear do alvo preparado.
    pub fn prepared_gray(&self) -> Option<&GrayImage> {
        self.cached_prepared_gray.as_ref()
    }

    /// Alvo do solver em luz linear.
    pub fn prepared_linear_rgb(&self) -> Option<&[LinearRgbColor]> {
        self.cached_prepared_linear_rgb.as_deref()
    }

    /// Referência das métricas: foto enquadrada sem ajustes nem realces, em luz linear.
    pub fn reference_linear_rgb(&self) -> Option<&[LinearRgbColor]> {
        self.cached_reference_linear_rgb.as_deref()
    }

    pub fn importance_map(&self) -> Option<&ImportanceMap> {
        self.cached_importance_map.as_ref()
    }

    pub fn canny_edges(&self) -> Option<&GrayImage> {
        self.cached_edges.as_ref()
    }

    pub fn sobel_result(&self) -> Option<&SobelResult> {
        self.cached_sobel.as_ref()
    }

    pub fn filtered_sinogram(&self) -> Option<&Sinogram> {
        self.cached_filtered_sinogram.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use weaver_domain::{LoomGeometry, LoomPhysicalSpec};

    #[test]
    fn test_dsp_pipeline_full_execution_and_caching() {
        let mut source = Rgba8Image::fill(40, 40, 4, 255u8);
        for y in 10..30 {
            for x in 10..30 {
                source.set_pixel(x, y, &[180, 60, 40, 255]);
            }
        }
        let mut config = DspPipelineConfig::default();
        config.target_resolution = 32;
        config.radon.num_angles = 16;
        config.radon.num_rhos = 16;
        config.beta_face = 2.0;

        let mut pipeline = DspPipeline::new(config);
        let loom = LoomGeometry::new(LoomPhysicalSpec::circle(400.0, 50, 2.0, 2.0, 10.0));
        let mut brush = vec![0.0f32; 32 * 32];
        brush[16 * 32 + 16] = 2.0;

        let diag = pipeline.execute(&source, Some(&loom), Some(&brush));
        assert_eq!(diag.prepared_target_rgba.width, 32);
        assert_eq!(diag.prepared_target_rgba.height, 32);
        assert!(pipeline.prepared_linear_rgb().is_some());
        assert!(pipeline.reference_linear_rgb().is_some());

        let imp = pipeline.importance_map().unwrap();
        assert!(imp.get(16, 16) > 2.0);
        // sem pincel, o mapa nunca fica abaixo de 1
        assert!(imp.as_slice().iter().all(|&w| w >= 1.0 - 1e-6));
    }

    #[test]
    fn test_mid_gray_single_linear_conversion() {
        let source = Rgba8Image::fill(16, 16, 4, 128u8);
        let config = DspPipelineConfig {
            target_resolution: 16,
            monochrome_target: true,
            ..DspPipelineConfig::default()
        };
        let mut pipeline = DspPipeline::new(config);
        let diag = pipeline.execute(&source, None, None);

        let center_rgba = diag.prepared_target_rgba.get_pixel(8, 8);
        assert_eq!(center_rgba[0], 128);

        // sRGB(128/255) -> linear ≈ 0.2159 (conversão única IEC 61966-2-1)
        let lin = pipeline.prepared_linear_rgb().unwrap()[8 * 16 + 8].luminance();
        assert!((lin - 0.21586).abs() < 0.005, "obtido {lin}");
        let prep = pipeline.prepared_gray().unwrap().get_pixel(8, 8)[0];
        assert!((prep - 0.21586).abs() < 0.005);
    }

    #[test]
    fn test_neutral_pipeline_target_equals_reference() {
        let mut source = Rgba8Image::fill(24, 24, 4, 255u8);
        for y in 0..24 {
            for x in 0..24 {
                let v = (x * 10) as u8;
                source.set_pixel(x, y, &[v, v / 2, 255 - v, 255]);
            }
        }
        for mono in [true, false] {
            let config = DspPipelineConfig {
                target_resolution: 24,
                monochrome_target: mono,
                ..DspPipelineConfig::default()
            };
            let mut pipeline = DspPipeline::new(config);
            pipeline.execute(&source, None, None);
            let t = pipeline.prepared_linear_rgb().unwrap();
            let r = pipeline.reference_linear_rgb().unwrap();
            for (a, b) in t.iter().zip(r) {
                assert!(
                    (a.r - b.r).abs() < 0.01
                        && (a.g - b.g).abs() < 0.01
                        && (a.b - b.b).abs() < 0.01
                );
            }
        }
    }
}
