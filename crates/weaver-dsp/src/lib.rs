//! Camada 2 (`weaver-dsp`): Auto-Crop, CLAHE, Morfologia Matemática, Sobel/Canny
//! e Transformada de Radon.
//!
//! Regra de Dependência da Clean Architecture: depende exclusivamente de `weaver-domain`.

pub mod contrast;
pub mod edges;
pub mod framing;
pub mod image;
pub mod importance;
pub mod morphology;
pub mod pipeline;
pub mod radon;

pub use contrast::{
    adjust_radiometry, apply_brightness, apply_gamma, apply_sigmoidal_contrast, apply_unsharp_mask,
    clahe_channel, clahe_gray, clahe_lab, clahe_linear_rgb, compute_channel_entropy, ClaheConfig,
};
pub use edges::{
    canny, compute_multiscale_saliency, edges_to_rgba, fuse_high_frequency, gaussian_blur_5x5,
    gaussian_blur_gray, sobel, CannyConfig, SobelResult,
};
pub use framing::{
    apply_affine_transform, compute_auto_framing, AutoFramingOptions, AutoFramingResult,
    FramingConfig, InterpolationMethod, LoomMask,
};
pub use image::{GrayImage, ImageBuffer, RgbFloatImage, Rgba8Image};
pub use importance::{
    compute_facial_saliency_map, compute_skin_probability, BrushMergeMode, ImportanceMap,
};
pub use morphology::{
    black_tophat, closing, closing_gray, dilate, erode, morph_gradient, opening, opening_gray,
    white_tophat, StructuringElement,
};
pub use pipeline::{DspDiagnosticBuffers, DspPipeline, DspPipelineConfig};
pub use radon::{apply_ramp_filter, compute_radon_transform, RadonOptions, Sinogram};

use weaver_domain::Pixels;

/// Simulation target grid resolution validated by the DSP pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DspGridSpec {
    pub resolution_px: Pixels,
}

#[cfg(test)]
mod tests {
    use super::*;
    use weaver_domain::{LabColor, LinearRgbColor, LoomGeometry, LoomPhysicalSpec};

    #[test]
    fn dsp_grid_spec_preserves_domain_pixels() {
        let spec = DspGridSpec {
            resolution_px: Pixels(500),
        };
        assert_eq!(spec.resolution_px.0, 500);
    }

    #[test]
    fn test_clahe_increases_entropy_and_local_contrast() {
        let width = 64u32;
        let height = 64u32;
        let total = (width * height) as usize;

        // Imagem sintética de baixíssimo contraste comprimida em torno de 0.50 (range [0.48, 0.52])
        let mut low_contrast = Vec::with_capacity(total);
        for y in 0..height {
            for x in 0..width {
                let v = 0.50 + 0.02 * ((x as f32 * 0.1).sin() + (y as f32 * 0.1).cos());
                low_contrast.push(v);
            }
        }

        let entropy_before = compute_channel_entropy(&low_contrast);

        let mut equalized = low_contrast.clone();
        let config = ClaheConfig {
            grid_cols: 4,
            grid_rows: 4,
            clip_limit: 3.0,
            num_bins: 128,
        };
        clahe_channel(&mut equalized, width, height, &config);

        let entropy_after = compute_channel_entropy(&equalized);

        // A entropia após equalização adaptativa deve ser expressivamente maior
        assert!(
            entropy_after > entropy_before + 0.5,
            "CLAHE deve expandir a densidade de informação: antes={:.3}, depois={:.3}",
            entropy_before,
            entropy_after
        );

        // O desvio padrão (contraste local) deve aumentar substancialmente devido à equalização
        let mean_before: f32 = low_contrast.iter().sum::<f32>() / total as f32;
        let std_before = (low_contrast
            .iter()
            .map(|&v| (v - mean_before).powi(2))
            .sum::<f32>()
            / total as f32)
            .sqrt();

        let mean_after: f32 = equalized.iter().sum::<f32>() / total as f32;
        let std_after = (equalized
            .iter()
            .map(|&v| (v - mean_after).powi(2))
            .sum::<f32>()
            / total as f32)
            .sqrt();

        assert!(
            std_after > std_before * 2.0,
            "CLAHE deve multiplicar o contraste local/desvio padrão: antes={:.4}, depois={:.4}",
            std_before,
            std_after
        );

        // A amplitude dinâmica (max - min) deve ser ampliada expressivamente em relação à original
        let min_orig = low_contrast.iter().copied().fold(f32::INFINITY, f32::min);
        let max_orig = low_contrast
            .iter()
            .copied()
            .fold(f32::NEG_INFINITY, f32::max);
        let min_val = equalized.iter().copied().fold(f32::INFINITY, f32::min);
        let max_val = equalized.iter().copied().fold(f32::NEG_INFINITY, f32::max);

        let span_before = max_orig - min_orig;
        let span_after = max_val - min_val;
        assert!(
            span_after > span_before * 2.0,
            "CLAHE deve expandir a amplitude dinâmica local: antes={:.3}, depois={:.3}",
            span_before,
            span_after
        );
    }

    #[test]
    fn test_clahe_lab_preserves_chromaticity() {
        let width = 8u32;
        let height = 8u32;
        let mut pixels = Vec::new();

        for y in 0..height {
            for x in 0..width {
                // Luminância em [40, 60], a* fixo em 25.0, b* fixo em -30.0
                let l = 50.0 + (x as f32 - y as f32);
                pixels.push(LabColor::new(l, 25.0, -30.0));
            }
        }

        let config = ClaheConfig {
            grid_cols: 2,
            grid_rows: 2,
            clip_limit: 2.0,
            num_bins: 64,
        };
        clahe_lab(&mut pixels, width, height, &config);

        // Invariante cromática: canais a* e b* devem permanecer milimetricamente intactos
        for p in &pixels {
            assert_eq!(p.a, 25.0, "Canal a* não pode ser alterado por CLAHE");
            assert_eq!(p.b, -30.0, "Canal b* não pode ser alterado por CLAHE");
            assert!(
                p.l >= 0.0 && p.l <= 100.0,
                "L* deve estar no intervalo CIELAB"
            );
        }
    }

    #[test]
    fn test_clahe_linear_rgb_pipeline() {
        let width = 8u32;
        let height = 8u32;
        let mut pixels = Vec::new();

        for y in 0..height {
            for x in 0..width {
                let v = 0.45 + 0.01 * (x + y) as f32;
                pixels.push(LinearRgbColor::new(v, v, v));
            }
        }

        let config = ClaheConfig {
            grid_cols: 2,
            grid_rows: 2,
            clip_limit: 2.0,
            num_bins: 64,
        };
        clahe_linear_rgb(&mut pixels, width, height, &config);

        for p in &pixels {
            assert!(p.r >= 0.0 && p.r <= 1.0);
            assert!(p.g >= 0.0 && p.g <= 1.0);
            assert!(p.b >= 0.0 && p.b <= 1.0);
        }
    }

    #[test]
    fn test_morphology_idempotence_and_properties() {
        let width = 32u32;
        let height = 32u32;
        let mut img = vec![0.0f32; (width * height) as usize];

        // Insere ruídos claros pontuais (hot pixels) e um bloco estrutural
        img[5 * width as usize + 5] = 1.0;
        img[6 * width as usize + 6] = 0.9;
        for y in 12..20 {
            for x in 12..20 {
                img[(y * width + x) as usize] = 0.8;
            }
        }
        // Buraco escuro no centro do bloco
        img[16 * width as usize + 16] = 0.1;

        let se = StructuringElement::disc(1);

        // 1. Abertura: remove ruídos claros isolados
        let open1 = opening(&img, width, height, &se);
        let open2 = opening(&open1, width, height, &se);

        // Idempotência da Abertura: (f o B) o B == (f o B)
        for (i, (&v1, &v2)) in open1.iter().zip(open2.iter()).enumerate() {
            assert!(
                (v1 - v2).abs() < 1e-5,
                "Idempotência violada na Abertura no índice {}: {:.5} vs {:.5}",
                i,
                v1,
                v2
            );
        }

        // Anti-extensividade da Abertura: (f o B) <= f
        for i in 0..img.len() {
            assert!(
                open1[i] <= img[i] + 1e-5,
                "Anti-extensividade da Abertura violada no índice {}: {:.5} > {:.5}",
                i,
                open1[i],
                img[i]
            );
        }

        // Ruído pontual isolado em (5, 5) deve ter sido eliminado pela abertura
        assert!(
            open1[5 * width as usize + 5] < 0.1,
            "Ruído pontual claro deveria ser suprimido pela abertura"
        );

        // 2. Fechamento: preenche pequenos buracos escuros
        let close1 = closing(&img, width, height, &se);
        let close2 = closing(&close1, width, height, &se);

        // Idempotência do Fechamento: (f . B) . B == (f . B)
        for (i, (&v1, &v2)) in close1.iter().zip(close2.iter()).enumerate() {
            assert!(
                (v1 - v2).abs() < 1e-5,
                "Idempotência violada no Fechamento no índice {}: {:.5} vs {:.5}",
                i,
                v1,
                v2
            );
        }

        // Extensividade do Fechamento: (f . B) >= f
        for i in 0..img.len() {
            assert!(
                close1[i] >= img[i] - 1e-5,
                "Extensividade do Fechamento violada no índice {}: {:.5} < {:.5}",
                i,
                close1[i],
                img[i]
            );
        }

        // Buraco escuro em (16, 16) deve ter sido preenchido
        assert!(
            close1[16 * width as usize + 16] >= 0.75,
            "Buraco escuro interno deveria ser preenchido pelo fechamento"
        );

        // 3. Gradiente Morfológico: Dilatação - Erosão >= 0
        let grad = morph_gradient(&img, width, height, &se);
        for &g in &grad {
            assert!(g >= 0.0, "Gradiente morfológico deve ser não-negativo");
        }
        // No centro plano do bloco (14, 14), o gradiente deve ser zero
        assert!(
            grad[14 * width as usize + 14] < 1e-4,
            "Região homogênea deve apresentar gradiente morfológico nulo"
        );
    }

    #[test]
    fn test_affine_framing_and_circular_loom_mask() {
        let src_w = 40u32;
        let src_h = 40u32;
        let mut src = ImageBuffer::fill(src_w, src_h, 1, 0.2);

        // Círculo central claro
        for y in 10..30 {
            for x in 10..30 {
                src.set_pixel(x, y, &[0.8]);
            }
        }

        let loom_spec = LoomPhysicalSpec::circle(400.0, 50, 2.0, 2.0, 10.0);
        let loom = LoomGeometry::new(loom_spec);
        let mask = LoomMask::from_loom(&loom, 40, 40);

        let config = FramingConfig {
            zoom: 1.0,
            pan_x: 0.0,
            pan_y: 0.0,
            rotation_deg: 0.0,
        };

        let dst = apply_affine_transform(
            &src,
            40,
            40,
            &config,
            InterpolationMethod::Bilinear,
            Some(&mask),
            1.0, // Fundo branco
        );

        // O centro deve ser claro
        assert!((dst.get_pixel(20, 20)[0] - 0.8).abs() < 0.05);

        // Os quatro cantos (fora do tear circular) devem receber o valor do fundo 1.0
        assert_eq!(dst.get_pixel(0, 0)[0], 1.0);
        assert_eq!(dst.get_pixel(39, 0)[0], 1.0);
        assert_eq!(dst.get_pixel(0, 39)[0], 1.0);
        assert_eq!(dst.get_pixel(39, 39)[0], 1.0);
    }

    #[test]
    fn test_auto_framing_locates_head_and_scales_to_target_ratio() {
        let w = 100u32;
        let h = 100u32;
        let mut rgba = ImageBuffer::fill(w, h, 4, 255u8);

        // Fundo neutro
        for y in 0..h {
            for x in 0..w {
                rgba.set_pixel(x, y, &[240, 240, 240, 255]);
            }
        }

        // Simula rosto com tom de pele (R=210, G=150, B=120) centrado em (50, 40) com raio 15
        let center_x = 50.0f32;
        let center_y = 40.0f32;
        let radius = 15.0f32;

        for y in 0..h {
            for x in 0..w {
                let dx = x as f32 - center_x;
                let dy = y as f32 - center_y;
                if dx * dx + dy * dy <= radius * radius {
                    rgba.set_pixel(x, y, &[210, 150, 120, 255]);
                }
            }
        }

        let options = AutoFramingOptions {
            target_ratio: 0.80,
            eye_line_offset_ratio: 0.08,
        };

        let result = compute_auto_framing(&rgba, &options);

        // O centroide detectado deve estar muito próximo de (50, 40)
        assert!(
            (result.centroid.0 - center_x).abs() < 5.0,
            "Centroide X detectado ({:.1}) longe do esperado ({:.1})",
            result.centroid.0,
            center_x
        );
        assert!(
            (result.centroid.1 - center_y).abs() < 5.0,
            "Centroide Y detectado ({:.1}) longe do esperado ({:.1})",
            result.centroid.1,
            center_y
        );

        // Zoom calculado deve ser > 1.0 para aproximar o rosto que ocupa apenas ~30% para a meta de 80%
        assert!(
            result.config.zoom > 1.5,
            "Zoom ideal deve ampliar feições para atingir 80% do tear: zoom={:.2}",
            result.config.zoom
        );

        // A confiança deve ser positiva
        assert!(result.confidence > 0.20);
    }

    #[test]
    fn test_sobel_and_canny_edge_detection_invariants() {
        let w = 24u32;
        let h = 24u32;
        let mut gray = GrayImage::zeros(w, h, 1);

        // Bloco branco central de 8x8 pixels em (8..16, 8..16)
        for y in 8..16 {
            for x in 8..16 {
                gray.set_pixel(x, y, &[1.0]);
            }
        }

        let sobel_res = sobel(&gray);

        // O gradiente deve ser alto na borda do bloco (x=8, y=12)
        let edge_mag = sobel_res.magnitude.get_pixel(8, 12)[0];
        assert!(
            edge_mag > 0.20,
            "Magnitude de Sobel na borda deve ser significativa"
        );

        // O centro do bloco (x=12, y=12) é homogêneo, logo gradiente deve ser nulo
        let center_mag = sobel_res.magnitude.get_pixel(12, 12)[0];
        assert!(
            center_mag < 1e-4,
            "Região homogênea interna deve ter gradiente nulo"
        );

        // Canny detector completo
        let config = CannyConfig {
            low_threshold: 0.05,
            high_threshold: 0.15,
            gaussian_sigma: 1.0,
        };
        let canny_edges = canny(&gray, &config);

        // Borda afinada: na linha y=12, apenas pixels de transição (x=7 ou 8 e x=15 ou 16) devem ser bordas
        let edge_pixels_count: usize = (0..w)
            .filter(|&x| canny_edges.get_pixel(x, 12)[0] > 0.5)
            .count();
        assert_eq!(
            edge_pixels_count, 2,
            "Canny deve produzir bordas finas com espessura de 1 pixel em cada lado"
        );
    }

    #[test]
    fn test_importance_map_composition_and_user_brush() {
        let w = 16u32;
        let h = 16u32;
        let mut face_sal = GrayImage::zeros(w, h, 1);
        face_sal.set_pixel(8, 8, &[0.8]);

        let mut edges = GrayImage::zeros(w, h, 1);
        edges.set_pixel(8, 8, &[0.5]);

        let mut imp = ImportanceMap::compose_auto(w, h, Some(&face_sal), Some(&edges), 3.0, 1.0);

        // W(8, 8) = 1.0 + 3.0 * 0.8 + 1.0 * 0.5 = 3.9
        let expected = 1.0 + 3.0 * 0.8 + 1.0 * 0.5;
        assert!((imp.get(8, 8) - expected).abs() < 1e-4);

        // Ponto não enfatizado mantém peso 1.0
        assert_eq!(imp.get(0, 0), 1.0);

        // Aplicação de pincel manual
        let mut brush = vec![0.0f32; (w * h) as usize];
        // Reforça (8, 8) em +1.1
        brush[(8 * w + 8) as usize] = 1.1;
        // Zera o ponto (0, 0)
        brush[0] = -5.0;

        imp.merge_user_brush(&brush);

        assert!((imp.get(8, 8) - (expected + 1.1)).abs() < 1e-4);
        assert_eq!(
            imp.get(0, 0),
            0.0,
            "Pincel negativo deve permitir zerar a importância"
        );

        // Preview RGBA
        let preview = imp.to_preview_rgba();
        assert_eq!(preview.channels, 4);
        assert_eq!(preview.width, w);
        assert_eq!(preview.height, h);
    }

    #[test]
    fn test_radon_transform_and_ram_lak_ramp_filter() {
        let w = 20u32;
        let h = 20u32;
        let mut gray = GrayImage::fill(w, h, 1, 1.0); // Fundo branco

        // Círculo preto absorvente no centro
        for y in 6..14 {
            for x in 6..14 {
                let dx = x as f32 - 10.0;
                let dy = y as f32 - 10.0;
                if dx * dx + dy * dy <= 16.0 {
                    gray.set_pixel(x, y, &[0.0]);
                }
            }
        }

        let opts = RadonOptions {
            num_angles: 12,
            num_rhos: 16,
            invert_for_absorption: true,
        };

        let sinogram = compute_radon_transform(&gray, &opts);
        assert_eq!(sinogram.num_angles, 12);
        assert_eq!(sinogram.num_rhos, 16);

        // O centro (rho ~ 0, linha 8) deve ter valor alto de projeção
        let center_val = sinogram.get(8, 0);
        assert!(
            center_val > 1.0,
            "Projeção central deve conter densidade absorvida"
        );

        // Aplica o filtro de rampa (Ram-Lak)
        let filtered = apply_ramp_filter(&sinogram, Some(5));
        assert_eq!(filtered.num_angles, 12);
        assert_eq!(filtered.num_rhos, 16);

        let preview = filtered.to_preview_rgba();
        assert_eq!(preview.width, 12);
        assert_eq!(preview.height, 16);
        assert_eq!(preview.channels, 4);
    }

    #[test]
    fn test_dsp_pipeline_end_to_end() {
        let w = 32u32;
        let h = 32u32;
        let mut rgba = Rgba8Image::fill(w, h, 4, 255u8);

        // Região com tom de pele (R=210, G=150, B=120) no terço superior
        for y in 8..18 {
            for x in 10..22 {
                rgba.set_pixel(x, y, &[210, 150, 120, 255]);
            }
        }

        let mut config = DspPipelineConfig::default();
        config.target_resolution = 24;
        config.radon.num_angles = 12;
        config.radon.num_rhos = 12;

        let mut pipeline = DspPipeline::new(config);
        let loom_spec = LoomPhysicalSpec::circle(300.0, 40, 2.0, 2.0, 10.0);
        let loom = LoomGeometry::new(loom_spec);

        let diag = pipeline.execute(&rgba, Some(&loom), None);

        // Valida existência e dimensões dos 4 buffers diagnósticos
        assert_eq!(diag.prepared_target_rgba.width, 24);
        assert_eq!(diag.prepared_target_rgba.height, 24);
        assert_eq!(diag.importance_map_rgba.width, 24);
        assert_eq!(diag.importance_map_rgba.height, 24);
        assert_eq!(diag.edges_rgba.width, 24);
        assert_eq!(diag.edges_rgba.height, 24);
        assert_eq!(diag.radon_sinogram_rgba.width, 12);
        assert_eq!(diag.radon_sinogram_rgba.height, 12);

        // Valida buffer composto lado a lado
        let preview_composite = diag.edge_and_radon_preview_rgba();
        assert_eq!(preview_composite.width, 24 + 12);
        assert_eq!(preview_composite.height, 24);

        // Valida que os caches estão preenchidos
        assert!(pipeline.prepared_gray().is_some());
        assert!(pipeline.importance_map().is_some());
        assert!(pipeline.canny_edges().is_some());
        assert!(pipeline.sobel_result().is_some());
        assert!(pipeline.filtered_sinogram().is_some());
    }
}
