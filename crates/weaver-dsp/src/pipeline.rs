//! Orquestrador do Pipeline de DSP (`DspPipeline`) com Cache de Estágios e Preservação Cromática.

use weaver_domain::{LinearRgbColor, LoomGeometry, SrgbColor};

use crate::contrast::{
    adjust_brightness_contrast_gray, apply_gamma_gray, apply_portrait_tone_shaping,
    apply_unsharp_mask, clahe_gray, ClaheConfig,
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

        // Opera em luminância perceptual sRGB [0.0, 1.0] durante todo o pré-processamento
        // radiométrico (CLAHE, contraste, nitidez e bordas) e converte para Linear RGB uma única vez no final.
        let framed_perceptual_gray = framed_rgba.to_perceptual_luma_gray();
        let framed_gray = framed_rgba.to_gray();

        // 3. Pré-processamento radiométrico e CLAHE em luma perceptual sRGB
        let mut prepared_srgb_luma = framed_perceptual_gray.clone();
        if (self.config.contrast - 1.0).abs() > 1e-3 || self.config.brightness.abs() > 1e-3 {
            adjust_brightness_contrast_gray(
                &mut prepared_srgb_luma,
                self.config.brightness,
                self.config.contrast,
            );
        }
        if (self.config.gamma - 1.0).abs() > 1e-3 {
            apply_gamma_gray(&mut prepared_srgb_luma, self.config.gamma);
        }
        if let Some(clahe_cfg) = &self.config.clahe {
            if clahe_cfg.clip_limit > 0.05 {
                let mut clahe_img = prepared_srgb_luma.clone();
                clahe_gray(&mut clahe_img, clahe_cfg);
                let blend = ((clahe_cfg.clip_limit - 0.8) * 0.20).clamp(0.18, 0.42);
                for (orig, &eq) in prepared_srgb_luma.data.iter_mut().zip(clahe_img.data.iter()) {
                    *orig = (*orig * (1.0 - blend) + eq * blend).clamp(0.0, 1.0);
                }
            }
        }

        // Nitidez unsharp mask e modelagem tonal Vrellis quando houver realce de alta frequência
        if self.config.high_freq_blend > 1e-4 {
            apply_unsharp_mask(&mut prepared_srgb_luma, 1.25, 0.32);
            apply_portrait_tone_shaping(&mut prepared_srgb_luma, 0.14, 0.25);
        }

        // 4. Detecção de bordas Sobel e Canny sobre a imagem realçada
        let sobel_res = sobel(&prepared_srgb_luma);
        let canny_edges = canny(&prepared_srgb_luma, &self.config.canny);

        if self.config.high_freq_blend > 0.0 {
            prepared_srgb_luma = fuse_high_frequency(
                &prepared_srgb_luma,
                &sobel_res.magnitude,
                self.config.high_freq_blend.min(0.35),
            );
        }

        // 5. Reconstrução Cromática contínua e conversão única sRGB -> Linear RGB (IEC 61966-2-1)
        let total_px = (res * res) as usize;
        let mut prepared_linear_rgb = Vec::with_capacity(total_px);
        let mut prepared_linear_gray_data = Vec::with_capacity(total_px);
        let mut prepared_rgba_bytes = Vec::with_capacity(total_px * 4);

        let center = (res as f32 - 1.0) * 0.5;
        let max_r = center.max(1.0);
        let apply_rim_vignette = loom.is_some()
            && (self.config.clahe.is_some() || self.config.high_freq_blend > 1e-4);

        for y in 0..res {
            let dy = (y as f32 - center) / max_r;
            for x in 0..res {
                let dx = (x as f32 - center) / max_r;
                let r_norm = (dx * dx + dy * dy).sqrt();
                let i = (y * res + x) as usize;

                // Suavização suave apenas junto à borda física dos pinos (r > 0.94)
                let vignette = if apply_rim_vignette && r_norm > 0.94 {
                    ((1.0 - r_norm) / 0.06).clamp(0.0, 1.0)
                } else {
                    1.0
                };

                let luma_in = prepared_srgb_luma.data[i].clamp(0.0, 1.0);
                let new_luma = 1.0 - (1.0 - luma_in) * vignette;

                if self.config.monochrome_target {
                    let lin = SrgbColor::new(new_luma, new_luma, new_luma).to_linear();
                    prepared_linear_gray_data.push(lin.luminance());
                    prepared_linear_rgb.push(lin);
                    let u = (new_luma * 255.0).round() as u8;
                    prepared_rgba_bytes.extend_from_slice(&[u, u, u, 255]);
                } else {
                    let r_srgb = framed_rgba.data[i * 4] as f32 / 255.0;
                    let g_srgb = framed_rgba.data[i * 4 + 1] as f32 / 255.0;
                    let b_srgb = framed_rgba.data[i * 4 + 2] as f32 / 255.0;
                    let orig_luma = framed_perceptual_gray.data[i].max(1e-4);

                    let ratio = (luma_in / orig_luma).clamp(0.25, 2.5);
                    let nr = 1.0 - (1.0 - (r_srgb * ratio).clamp(0.0, 1.0)) * vignette;
                    let ng = 1.0 - (1.0 - (g_srgb * ratio).clamp(0.0, 1.0)) * vignette;
                    let nb = 1.0 - (1.0 - (b_srgb * ratio).clamp(0.0, 1.0)) * vignette;

                    let lin = SrgbColor::new(nr, ng, nb).to_linear();
                    prepared_linear_gray_data.push(lin.luminance());
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
        let prepared_linear_gray = GrayImage::new(res, res, 1, prepared_linear_gray_data);

        // 6. Mapa de Importância W(x,y) canônico: W(x,y) = 1.0 + beta_face * M_face + beta_edge * E
        let facial_saliency = compute_facial_saliency_map(&framed_rgba);
        let mut importance_map = ImportanceMap::compose_auto(
            res,
            res,
            Some(&facial_saliency),
            Some(&sobel_res.magnitude),
            self.config.beta_face,
            self.config.beta_edge,
        );

        if self.config.beta_face > 0.0 && self.config.high_freq_blend > 1e-4 {
            importance_map.modulate_portrait_importance(
                &prepared_srgb_luma,
                &facial_saliency,
                &sobel_res.magnitude,
            );
        }

        if let Some(brush) = user_brush_mask {
            importance_map.merge_user_brush(brush);
        }

        // 7. Transformada de Radon e Filtro de Rampa
        let sinogram = compute_radon_transform(&prepared_srgb_luma, &self.config.radon);
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
        self.cached_prepared_gray = Some(prepared_linear_gray);
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

    #[test]
    fn test_mid_gray_no_double_gamma() {
        // Verifica que uma imagem cinza média uniforme (sRGB = 128/255 ≈ 0.502)
        // com contrast=1.0, brightness=0.0, gamma=1.0, clahe=None, high_freq_blend=0.0
        // produz prepared_linear_rgb com luminância linear ≈ 0.2158 (conversão única IEC 61966-2-1),
        // e NÃO ≈ 0.046 (duplo gamma).
        let w = 16u32;
        let h = 16u32;
        let mut source = Rgba8Image::fill(w, h, 4, 128u8);
        for y in 0..h {
            for x in 0..w {
                source.set_pixel(x, y, &[128, 128, 128, 255]);
            }
        }

        let config = DspPipelineConfig {
            target_resolution: 16,
            clahe: None,
            high_freq_blend: 0.0,
            monochrome_target: true,
            contrast: 1.0,
            brightness: 0.0,
            gamma: 1.0,
            ..DspPipelineConfig::default()
        };

        let mut pipeline = DspPipeline::new(config);
        let diag = pipeline.execute(&source, None, None);

        // No buffer sRGB de diagnóstico, cinza médio 128 deve permanecer 128
        let center_rgba = diag.prepared_target_rgba.get_pixel(8, 8);
        assert_eq!(center_rgba[0], 128);
        assert_eq!(center_rgba[1], 128);
        assert_eq!(center_rgba[2], 128);

        // Em Linear RGB, sRGB(128/255 ≈ 0.50196) -> linear ≈ 0.21586
        let lin_rgb = pipeline.prepared_linear_rgb().unwrap();
        let center_lin = lin_rgb[(8 * 16 + 8) as usize].luminance();
        assert!(
            (center_lin - 0.21586).abs() < 0.01,
            "Luminância linear de cinza médio (128) deve ser ~0.216 (sem duplo gamma), obtido: {}",
            center_lin
        );

        // Também verifica que prepared_gray() já contém luminância linear única
        let prep_gray = pipeline.prepared_gray().unwrap();
        let gray_val = prep_gray.get_pixel(8, 8)[0];
        assert!(
            (gray_val - 0.21586).abs() < 0.01,
            "prepared_gray deve conter luminância linear ~0.216, obtido: {}",
            gray_val
        );
    }
}
