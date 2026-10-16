//! Orquestrador do Pipeline de DSP (`DspPipeline`) com Cache de Estágios.
//!
//! Integra os módulos de enquadramento afim, equalização adaptativa CLAHE,
//! detecção de bordas Sobel/Canny, mapa de importância espacial $W(x,y)$,
//! transformada de Radon e filtro em rampa com cache de estágios intermediários
//! e exportação de buffers de diagnóstico visual para a UI.

use weaver_domain::LoomGeometry;

use crate::contrast::{clahe_gray, ClaheConfig};
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
    /// Resolução da grade de simulação quadrada em pixels (ex: 500 ou 600).
    pub target_resolution: u32,
    /// Parâmetros de enquadramento afim (zoom, pan, rotação).
    pub framing: FramingConfig,
    /// Método de interpolação sub-pixel (Bilinear ou Bicúbica).
    pub interpolation: InterpolationMethod,
    /// Configuração opcional de equalização de contraste local CLAHE.
    pub clahe: Option<ClaheConfig>,
    /// Configuração do detector de bordas de Canny.
    pub canny: CannyConfig,
    /// Peso de foco facial $\beta_{\text{face}}$ na composição de $W(x,y)$.
    pub beta_face: f32,
    /// Peso de bordas estruturais $\beta_{\text{borda}}$ na composição de $W(x,y)$.
    pub beta_edge: f32,
    /// Fator de mesclagem de alta frequência na imagem alvo ($0.0$ a $0.5$).
    pub high_freq_blend: f32,
    /// Luminância de fundo neutro fora da moldura do tear ($1.0$ = branco).
    pub background_luma: f32,
    /// Parâmetros da Transformada de Radon e Sinograma.
    pub radon: RadonOptions,
    /// Opção para auto-enquadramento facial prévio se desejado.
    pub auto_framing: Option<AutoFramingOptions>,
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
        }
    }
}

/// Conjunto de buffers de diagnóstico gerados pelo pipeline para inspeção multi-estágio.
#[derive(Debug, Clone, PartialEq)]
pub struct DspDiagnosticBuffers {
    /// Alvo processado final em formato RGBA (`PreparedTargetRGBA`).
    pub prepared_target_rgba: Rgba8Image,
    /// Mapa de calor da importância espacial $W(x,y)$ em formato RGBA (`ImportanceMapRGBA`).
    pub importance_map_rgba: Rgba8Image,
    /// Mapa de bordas estruturais Sobel/Canny em formato RGBA (`EdgesRGBA`).
    pub edges_rgba: Rgba8Image,
    /// Sinograma de Radon filtrado em rampa em formato RGBA (`RadonSinogramRGBA`).
    pub radon_sinogram_rgba: Rgba8Image,
}

impl DspDiagnosticBuffers {
    /// Gera um buffer composto único lado a lado com as Bordas e o Sinograma de Radon (`EdgeAndRadonPreviewRGBA`).
    pub fn edge_and_radon_preview_rgba(&self) -> Rgba8Image {
        let w1 = self.edges_rgba.width;
        let h1 = self.edges_rgba.height;
        let w2 = self.radon_sinogram_rgba.width;
        let h2 = self.radon_sinogram_rgba.height;

        let out_w = w1 + w2;
        let out_h = h1.max(h2);

        let mut out = ImageBuffer::fill(out_w, out_h, 4, 0u8);

        // Copia edges_rgba para o lado esquerdo
        for y in 0..h1 {
            for x in 0..w1 {
                let p = self.edges_rgba.get_pixel(x, y);
                out.set_pixel(x, y, p);
            }
        }

        // Copia radon_sinogram_rgba para o lado direito
        for y in 0..h2 {
            for x in 0..w2 {
                let p = self.radon_sinogram_rgba.get_pixel(x, y);
                out.set_pixel(w1 + x, y, p);
            }
        }

        out
    }
}

/// Orquestrador do pipeline de DSP que armazena em cache estágios intermediários.
pub struct DspPipeline {
    pub config: DspPipelineConfig,

    // Cache de estágios intermediários
    cached_framed_rgba: Option<Rgba8Image>,
    cached_framed_gray: Option<GrayImage>,
    cached_prepared_gray: Option<GrayImage>,
    cached_sobel: Option<SobelResult>,
    cached_edges: Option<GrayImage>,
    cached_importance_map: Option<ImportanceMap>,
    cached_sinogram: Option<Sinogram>,
    cached_filtered_sinogram: Option<Sinogram>,
    cached_diagnostics: Option<DspDiagnosticBuffers>,
}

impl DspPipeline {
    /// Inicializa uma nova instância do pipeline DSP com a configuração fornecida.
    pub fn new(config: DspPipelineConfig) -> Self {
        Self {
            config,
            cached_framed_rgba: None,
            cached_framed_gray: None,
            cached_prepared_gray: None,
            cached_sobel: None,
            cached_edges: None,
            cached_importance_map: None,
            cached_sinogram: None,
            cached_filtered_sinogram: None,
            cached_diagnostics: None,
        }
    }

    /// Executa o pipeline completo sobre a imagem RGBA de entrada.
    ///
    /// Realiza:
    /// 1. Auto-enquadramento opcional e recorte afim 2D com máscara de tear.
    /// 2. Equalização de contraste adaptativo local CLAHE.
    /// 3. Detecção de bordas estruturais Sobel/Canny e fusão de altas frequências.
    /// 4. Saliência facial e composição do mapa de importância $W(x,y)$ com suporte a pincel.
    /// 5. Transformada de Radon e filtro em rampa de Ram-Lak.
    /// 6. Geração e cache dos buffers de diagnóstico visual em formato RGBA.
    pub fn execute(
        &mut self,
        source: &Rgba8Image,
        loom: Option<&LoomGeometry>,
        user_brush_mask: Option<&[f32]>,
    ) -> &DspDiagnosticBuffers {
        let res = self.config.target_resolution;

        // 1. Auto-enquadramento se requisitado
        if let Some(opts) = &self.config.auto_framing {
            let auto = compute_auto_framing(source, opts);
            self.config.framing = auto.config;
        }

        // 2. Enquadramento afim 2D para a resolução alvo
        let loom_mask = loom.map(|l| LoomMask::from_loom(l, res, res));

        // Converte source RGBA para buffer de floats para amostragem contínua precisa
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

        // Reconverte para Rgba8Image enquadrado
        let mut framed_rgba_data = Vec::with_capacity((res * res * 4) as usize);
        for &f in &framed_float.data {
            framed_rgba_data.push((f.clamp(0.0, 1.0) * 255.0).round() as u8);
        }
        let framed_rgba = Rgba8Image::new(res, res, 4, framed_rgba_data);
        let framed_gray = framed_rgba.to_gray();

        // 3. Pré-processamento radiométrico e CLAHE
        let mut prepared_gray = framed_gray.clone();
        if let Some(clahe_cfg) = &self.config.clahe {
            clahe_gray(&mut prepared_gray, clahe_cfg);
        }

        // 4. Detecção de bordas Sobel e Canny
        let sobel_res = sobel(&prepared_gray);
        let canny_edges = canny(&prepared_gray, &self.config.canny);

        // Fusão opcional de altas frequências para intensificar fios nos traços finos
        if self.config.high_freq_blend > 0.0 {
            prepared_gray =
                fuse_high_frequency(&prepared_gray, &canny_edges, self.config.high_freq_blend);
        }

        // 5. Saliência facial e Composição do Mapa de Importância W(x,y)
        let facial_saliency = compute_facial_saliency_map(&framed_rgba);
        let mut importance_map = ImportanceMap::compose_auto(
            res,
            res,
            Some(&facial_saliency),
            Some(&canny_edges),
            self.config.beta_face,
            self.config.beta_edge,
        );

        if let Some(brush) = user_brush_mask {
            importance_map.merge_user_brush(brush);
        }

        // 6. Transformada de Radon e Filtro de Rampa Ram-Lak
        let sinogram = compute_radon_transform(&prepared_gray, &self.config.radon);
        let filtered_sinogram = apply_ramp_filter(&sinogram, None);

        // 7. Geração dos buffers de diagnóstico RGBA
        let prepared_target_rgba =
            Rgba8Image::from_linear_rgb_slice(&prepared_gray.to_linear_rgb_vec(), res, res);
        let importance_map_rgba = importance_map.to_preview_rgba();
        let edges_rgba = edges_to_rgba(&canny_edges);
        let radon_sinogram_rgba = filtered_sinogram.to_preview_rgba();

        let diagnostics = DspDiagnosticBuffers {
            prepared_target_rgba,
            importance_map_rgba,
            edges_rgba,
            radon_sinogram_rgba,
        };

        // Atualiza buffers em cache
        self.cached_framed_rgba = Some(framed_rgba);
        self.cached_framed_gray = Some(framed_gray);
        self.cached_prepared_gray = Some(prepared_gray);
        self.cached_sobel = Some(sobel_res);
        self.cached_edges = Some(canny_edges);
        self.cached_importance_map = Some(importance_map);
        self.cached_sinogram = Some(sinogram);
        self.cached_filtered_sinogram = Some(filtered_sinogram);
        self.cached_diagnostics = Some(diagnostics);

        self.cached_diagnostics.as_ref().unwrap()
    }

    /// Retorna uma referência aos buffers de diagnóstico gerados na última execução.
    pub fn diagnostics(&self) -> Option<&DspDiagnosticBuffers> {
        self.cached_diagnostics.as_ref()
    }

    /// Retorna o alvo preparado em escala de cinza fotométrica.
    pub fn prepared_gray(&self) -> Option<&GrayImage> {
        self.cached_prepared_gray.as_ref()
    }

    /// Retorna o mapa de importância espacial $W(x,y)$ calculado.
    pub fn importance_map(&self) -> Option<&ImportanceMap> {
        self.cached_importance_map.as_ref()
    }

    /// Retorna o mapa de bordas finas de Canny.
    pub fn canny_edges(&self) -> Option<&GrayImage> {
        self.cached_edges.as_ref()
    }

    /// Retorna o resultado do operador de Sobel.
    pub fn sobel_result(&self) -> Option<&SobelResult> {
        self.cached_sobel.as_ref()
    }

    /// Retorna o Sinograma de Radon filtrado em rampa.
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

        // Padrão de teste facial com círculo escuro
        for y in 10..30 {
            for x in 10..30 {
                source.set_pixel(x, y, &[60, 60, 60, 255]);
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
        brush[16 * 32 + 16] = 2.0; // Ponto de pincel reforçado

        let diag = pipeline.execute(&source, Some(&loom), Some(&brush));

        assert_eq!(diag.prepared_target_rgba.width, 32);
        assert_eq!(diag.prepared_target_rgba.height, 32);
        assert_eq!(diag.importance_map_rgba.width, 32);
        assert_eq!(diag.importance_map_rgba.height, 32);
        assert_eq!(diag.edges_rgba.width, 32);
        assert_eq!(diag.edges_rgba.height, 32);
        assert_eq!(diag.radon_sinogram_rgba.width, 16);
        assert_eq!(diag.radon_sinogram_rgba.height, 16);

        // Verifica o buffer composto EdgeAndRadonPreviewRGBA
        let composite = diag.edge_and_radon_preview_rgba();
        assert_eq!(composite.width, 32 + 16);
        assert_eq!(composite.height, 32);

        // Verifica cache de estágios internos
        assert!(pipeline.prepared_gray().is_some());
        assert!(pipeline.importance_map().is_some());
        assert!(pipeline.canny_edges().is_some());
        assert!(pipeline.filtered_sinogram().is_some());

        // Ponto reforçado pelo pincel em (16, 16) deve ter peso > 2.0
        let imp = pipeline.importance_map().unwrap();
        assert!(imp.get(16, 16) > 2.0);
    }
}
