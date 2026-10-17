//! Orquestrador do Pipeline de DSP (`DspPipeline`) com Cache de Estágios e Preservação Cromática.

use weaver_domain::{LinearRgbColor, LoomGeometry, SrgbColor};

use crate::contrast::{
    adjust_brightness_contrast_gray, apply_gamma_gray, clahe_gray, ClaheConfig,
};
use crate::edges::{canny, edges_to_rgba, fuse_high_frequency, sobel, CannyConfig, SobelResult};
use crate::framing::{
    apply_affine_transform, compute_auto_framing, AutoFramingOptions, FramingConfig,
    InterpolationMethod, LoomMask,
};
use crate::image::{GrayImage, ImageBuffer, Rgba8Image};
use crate::importance::{compute_facial_saliency_map, ImportanceMap};
use crate::radon::{apply_ramp_filter, compute_radon_transform, RadonOptions, Sinogram};

/// Configuração completa de execução do pipeline de pré-processamento DSP.
#[derive(Debug, Clone, PartialEq)]
pub struct DspPipelineConfig {
    pub target_resolution: u32,
    pub framing: FramingConfig,
    pub interpolation: InterpolationMethod,
    pub clahe: Option<ClaheConfig>,
    pub canny: CannyConfig,
    pub beta_face: f32,
    pub beta_edge: f32,
    pub high_freq_blend: f32,
    pub background_luma: f32,
    pub radon: RadonOptions,
    pub auto_framing: Option<AutoFramingOptions>,
    /// Quando `true`, converte a saída para escala de cinza (Modo Monocromático).
    /// Quando `false`, preserva a cromaticidade RGB original da foto (CMYK / RGB / Custom).
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
            clahe: Some(ClaheConfig::default()),
            canny: CannyConfig::default(),
            beta_face: 3.0,
            beta_edge: 1.0,
            high_freq_blend: 0.15,
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

        let out_w = w1 + w2;
        let out_h = h1.max(h2);
        let mut out = ImageBuffer::fill(out_w, out_h, 4, 0u8);

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
    cached_framed_gray: Option<GrayImage>,
    cached_prepared_gray: Option<GrayImage>,
    cached_prepared_linear_rgb: Option<Vec<LinearRgbColor>>,
    cached_sobel: Option<SobelResult>,
    cached_edges: Option<GrayImage>,
    cached_importance_map: Option<ImportanceMap>,
    cached_sinogram: Option<Sinogram>,
    cached_filtered_sinogram: Option<Sinogram>,
    cached_diagnostics: Option<DspDiagnosticBuffers>,
}

impl DspPipeline {
    pub fn new(config: DspPipelineConfig) -> Self {
        Self {
            config,
            cached_framed_rgba: None,
            cached_framed_gray: None,
            cached_prepared_gray: None,
            cached_prepared_linear_rgb: None,
            cached_sobel: None,
            cached_edges: None,
            cached_importance_map: None,
            cached_sinogram: None,
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

        if let Some(opts) = &self.config.auto_framing {
            let auto = compute_auto_framing(source, opts);
            self.config.framing = auto.config;
        }

        let loom_mask = loom.map(|l| LoomMask::from_loom(l, res, res));

        let src_float_total = (source.width * source.height * 4) as usize;
        let mut src_float_data = Vec::with_capacity(src_float_total);
        for &byte in &source.data {
            src_float_data.push(byte as f32 / 255.0);
        }
        let src_float = ImageBuffer::new(source.width, source.height, 4, src_float_data);

        let framed_float = apply_affine_transform(
            &src_float,
            res,
            res,
            &self.config.framing,
            self.config.interpolation,
            loom_mask.as_ref(),
            self.config.background_luma,
        );

        let mut framed_rgba_data = Vec::with_capacity((res * res * 4) as usize);
        for &f in &framed_float.data {
            framed_rgba_data.push((f.clamp(0.0, 1.0) * 255.0).round() as u8);
        }
        let framed_rgba = Rgba8Image::new(res, res, 4, framed_rgba_data);
        let framed_gray = framed_rgba.to_gray();

        // 3. Pré-processamento radiométrico e CLAHE suave
        let mut prepared_gray = framed_gray.clone();
        if (self.config.contrast - 1.0).abs() > 1e-3 || self.config.brightness.abs() > 1e-3 {
            adjust_brightness_contrast_gray(
                &mut prepared_gray,
                self.config.brightness,
                self.config.contrast,
            );
        }
        if (self.config.gamma - 1.0).abs() > 1e-3 {
            apply_gamma_gray(&mut prepared_gray, self.config.gamma);
        }
        if let Some(clahe_cfg) = &self.config.clahe {
            clahe_gray(&mut prepared_gray, clahe_cfg);
        }

        // 4. Detecção de bordas Sobel e Canny
        let sobel_res = sobel(&prepared_gray);
        let canny_edges = canny(&prepared_gray, &self.config.canny);

        if self.config.high_freq_blend > 0.0 {
            prepared_gray = fuse_high_frequency(
                &prepared_gray,
                &sobel_res.magnitude,
                self.config.high_freq_blend.min(0.25),
            );
        }

        // 5. Reconstrução Cromática contínua (sem degraus artificiais) com suavização na borda do aro
        let total_px = (res * res) as usize;
        let mut prepared_linear_rgb = Vec::with_capacity(total_px);
        let mut prepared_rgba_bytes = Vec::with_capacity(total_px * 4);

        let center = (res as f32 - 1.0) * 0.5;
        let max_r = center.max(1.0);

        for y in 0..res {
            let dy = (y as f32 - center) / max_r;
            for x in 0..res {
                let dx = (x as f32 - center) / max_r;
                let r_norm = (dx * dx + dy * dy).sqrt();
                let i = (y * res + x) as usize;

                // Suaviza suavemente os últimos 10% junto aos pinos e a base do moletom
                // para o algoritmo focar 100% da energia no rosto e óculos
                let mut vignette = if r_norm > 0.88 {
                    ((1.0 - r_norm) / 0.12).clamp(0.0, 1.0)
                } else {
                    1.0
                };
                if dy > 0.55 {
                    vignette *= ((1.0 - dy) / 0.45).clamp(0.15, 1.0);
                }

                let luma_in = prepared_gray.data[i].clamp(0.0, 1.0);
                let new_luma = 1.0 - (1.0 - luma_in) * vignette;

                if self.config.monochrome_target {
                    let lin = SrgbColor::new(new_luma, new_luma, new_luma).to_linear();
                    prepared_linear_rgb.push(lin);
                    let u = (new_luma * 255.0).round() as u8;
                    prepared_rgba_bytes.extend_from_slice(&[u, u, u, 255]);
                } else {
                    let r_srgb = framed_rgba.data[i * 4] as f32 / 255.0;
                    let g_srgb = framed_rgba.data[i * 4 + 1] as f32 / 255.0;
                    let b_srgb = framed_rgba.data[i * 4 + 2] as f32 / 255.0;
                    let orig_luma = framed_gray.data[i].max(1e-4);

                    let ratio = (luma_in / orig_luma).clamp(0.3, 2.2);
                    let nr = 1.0 - (1.0 - (r_srgb * ratio).clamp(0.0, 1.0)) * vignette;
                    let ng = 1.0 - (1.0 - (g_srgb * ratio).clamp(0.0, 1.0)) * vignette;
                    let nb = 1.0 - (1.0 - (b_srgb * ratio).clamp(0.0, 1.0)) * vignette;

                    let lin = SrgbColor::new(nr, ng, nb).to_linear();
                    prepared_linear_rgb.push(lin);

                    prepared_rgba_bytes.extend_from_slice(&[
                        (nr * 255.0).round() as u8,
                        (ng * 255.0).round() as u8,
                        (nb * 255.0).round() as u8,
                        255,
                    ]);
                }
            }
        }

        let prepared_target_rgba = Rgba8Image::new(res, res, 4, prepared_rgba_bytes);

        // 6. Mapa de Importância W(x,y) contínuo e suave (Gaussiana central + Bordas Sobel)
        let facial_saliency = compute_facial_saliency_map(&framed_rgba);
        let mut importance_map = ImportanceMap::compose_auto(
            res,
            res,
            Some(&facial_saliency),
            Some(&sobel_res.magnitude),
            self.config.beta_face,
            self.config.beta_edge * 3.0,
        );

        for y in 0..res {
            let dy = (y as f32 - center) / max_r;
            for x in 0..res {
                let dx = (x as f32 - center) / max_r;
                let r_sq = dx * dx + dy * dy;
                let i = (y * res + x) as usize;
                // Ponderação Gaussiana suave: sem degraus que criem linhas retas artificiais!
                let gaussian_focus = (-1.2 * r_sq).exp();
                importance_map.weights[i] *= 0.25 + 1.75 * gaussian_focus;
            }
        }

        if let Some(brush) = user_brush_mask {
            importance_map.merge_user_brush(brush);
        }

        // 7. Transformada de Radon e Filtro de Rampa
        let sinogram = compute_radon_transform(&prepared_gray, &self.config.radon);
        let filtered_sinogram = apply_ramp_filter(&sinogram, None);

        let importance_map_rgba = importance_map.to_preview_rgba();
        let edges_rgba = edges_to_rgba(&canny_edges);
        let radon_sinogram_rgba = filtered_sinogram.to_preview_rgba();

        let diagnostics = DspDiagnosticBuffers {
            prepared_target_rgba,
            importance_map_rgba,
            edges_rgba,
            radon_sinogram_rgba,
        };

        self.cached_framed_rgba = Some(framed_rgba);
        self.cached_framed_gray = Some(framed_gray);
        self.cached_prepared_gray = Some(prepared_gray);
        self.cached_prepared_linear_rgb = Some(prepared_linear_rgb);
        self.cached_sobel = Some(sobel_res);
        self.cached_edges = Some(canny_edges);
        self.cached_importance_map = Some(importance_map);
        self.cached_sinogram = Some(sinogram);
        self.cached_filtered_sinogram = Some(filtered_sinogram);
        self.cached_diagnostics = Some(diagnostics);

        self.cached_diagnostics.as_ref().unwrap()
    }

    pub fn diagnostics(&self) -> Option<&DspDiagnosticBuffers> {
        self.cached_diagnostics.as_ref()
    }

    pub fn prepared_gray(&self) -> Option<&GrayImage> {
        self.cached_prepared_gray.as_ref()
    }

    /// Retorna o tensor colorido RGB Linear preparado para o solver policromático ou monocromático.
    pub fn prepared_linear_rgb(&self) -> Option<&[LinearRgbColor]> {
        self.cached_prepared_linear_rgb.as_deref()
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
        let w = 40u32;
        let h = 40u32;
        let mut source = Rgba8Image::fill(w, h, 4, 255u8);

        for y in 10..30 {
            for x in 10..30 {
                source.set_pixel(x, y, &[180, 60, 40, 255]);
            }
        }

        let mut config = DspPipelineConfig::default();
        config.target_resolution = 32;
        config.radon.num_angles = 16;
        config.radon.num_rhos = 16;

        let mut pipeline = DspPipeline::new(config);
        let loom_spec = LoomPhysicalSpec::circle(400.0, 50, 2.0, 2.0, 10.0);
        let loom = LoomGeometry::new(loom_spec);

        let mut brush = vec![0.0f32; 32 * 32];
        brush[16 * 32 + 16] = 2.0;

        let diag = pipeline.execute(&source, Some(&loom), Some(&brush));

        assert_eq!(diag.prepared_target_rgba.width, 32);
        assert_eq!(diag.prepared_target_rgba.height, 32);
        assert!(pipeline.prepared_linear_rgb().is_some());

        let imp = pipeline.importance_map().unwrap();
        assert!(imp.get(16, 16) > 2.0);
    }
}
