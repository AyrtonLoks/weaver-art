//! Paginador de Gabarito de Furação em Escala Real 1:1 (`blueprint_tiler.rs`).
//!
//! Calcula a matriz de folhas necessária para cobrir a Bounding Box completa do aro,
//! realiza culling automático de páginas do vão central vazio (`is_empty_interior = true`),
//! projeta furos com cruzetas de punção (0.2 mm) e numeração normalizada para fora,
//! desenha cruzetas fiduciais (+), réguas de aferição de 100.0 mm e exporta SVG mestre e PDF 1:1.

use crate::pdf::{PathMode, PdfDocument, TextAlign};
use weaver_domain::{LoomGeometry, LoomShape};

/// Tamanhos padrão de papel para impressão mecânica.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PaperSize {
    A4,
    A3,
    Letter,
}

impl PaperSize {
    /// Dimensões nominais (largura_mm, altura_mm) no modo Retrato (Portrait).
    #[inline]
    pub fn dimensions_mm(&self) -> (f64, f64) {
        match self {
            PaperSize::A4 => (210.0, 297.0),
            PaperSize::A3 => (297.0, 420.0),
            PaperSize::Letter => (215.9, 279.4),
        }
    }
}

/// Orientação da folha para impressão.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PaperOrientation {
    Portrait,
    Landscape,
    Auto,
}

/// Configuração do paginador de gabarito técnico 1:1.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BlueprintConfig {
    /// Formato do papel.
    pub paper_size: PaperSize,
    /// Orientação da folha.
    pub orientation: PaperOrientation,
    /// Margem não imprimível da impressora em mm (padrão: 10.0 mm).
    pub printer_margin_mm: f64,
    /// Faixa de sobreposição para colagem entre folhas adjacentes em mm (padrão: 15.0 mm).
    pub overlap_margin_mm: f64,
    /// Largura total da parede do aro em mm (se `None`, usa `2.0 * margin_mm`).
    pub rim_width_mm: Option<f64>,
    /// Diâmetro da broca em mm (se `None`, usa `loom.spec.drill_diameter_mm`).
    pub drill_diameter_mm: Option<f64>,
}

impl Default for BlueprintConfig {
    fn default() -> Self {
        Self {
            paper_size: PaperSize::A4,
            orientation: PaperOrientation::Portrait,
            printer_margin_mm: 10.0,
            overlap_margin_mm: 15.0,
            rim_width_mm: None,
            drill_diameter_mm: None,
        }
    }
}

/// Metadados e geometria de uma folha (telha/tile) na grade matricial 1:1.
#[derive(Debug, Clone, PartialEq)]
pub struct TileInfo {
    /// Índice da linha na grade (0..grid_rows - 1).
    pub row: usize,
    /// Índice da coluna na grade (0..grid_cols - 1).
    pub col: usize,
    /// Código amigável da folha (ex: "A1", "B2", "C3").
    pub code: String,
    /// Coordenadas da Bounding Box no espaço mundial do tear em mm: `(min_x, min_y, max_x, max_y)`.
    pub world_bounds_mm: (f64, f64, f64, f64),
    /// Indica se a folha cai inteiramente no vão central vazio do aro (economizando papel/tinta).
    pub is_empty_interior: bool,
    /// Indica se a folha cai inteiramente fora do perímetro externo do aro.
    pub is_empty_exterior: bool,
    /// Indica se a folha deve ser impressa (folha ativa com conteúdo físico relevante).
    pub is_active: bool,
    /// Índices dos pinos que intersectam esta folha.
    pub pin_indices: Vec<usize>,
    /// Código da folha vizinha à direita (para instruções de colagem).
    pub neighbor_right: Option<String>,
    /// Código da folha vizinha abaixo (para instruções de colagem).
    pub neighbor_bottom: Option<String>,
    /// Código da folha vizinha à esquerda.
    pub neighbor_left: Option<String>,
    /// Código da folha vizinha acima.
    pub neighbor_top: Option<String>,
}

/// Paginador e gerador de gabaritos físicos de furação em escala real 1:1.
#[derive(Debug, Clone)]
pub struct BlueprintTiler {
    pub loom: LoomGeometry,
    pub config: BlueprintConfig,
    pub paper_width_mm: f64,
    pub paper_height_mm: f64,
    pub printable_width_mm: f64,
    pub printable_height_mm: f64,
    pub step_x_mm: f64,
    pub step_y_mm: f64,
    pub grid_cols: usize,
    pub grid_rows: usize,
    pub tiles: Vec<TileInfo>,
    pub outer_radius_mm: f64,
    pub inner_radius_mm: f64,
    pub pitch_radius_mm: f64,
    pub drill_diameter_mm: f64,
}

impl BlueprintTiler {
    /// Constrói o paginador calculando a malha de folhas, dimensões físicas e culling de vazios.
    pub fn new(loom: LoomGeometry, config: BlueprintConfig) -> Self {
        let (raw_w, raw_h) = config.paper_size.dimensions_mm();

        // Determina orientação do papel
        let (paper_w, paper_h) = match config.orientation {
            PaperOrientation::Portrait => (raw_w.min(raw_h), raw_w.max(raw_h)),
            PaperOrientation::Landscape => (raw_w.max(raw_h), raw_w.min(raw_h)),
            PaperOrientation::Auto => {
                // Testa qual orientação produz menos folhas no total
                let p_tiles = Self::compute_tile_count(
                    &loom,
                    raw_w.min(raw_h),
                    raw_w.max(raw_h),
                    config.printer_margin_mm,
                    config.overlap_margin_mm,
                    config.rim_width_mm,
                );
                let l_tiles = Self::compute_tile_count(
                    &loom,
                    raw_w.max(raw_h),
                    raw_w.min(raw_h),
                    config.printer_margin_mm,
                    config.overlap_margin_mm,
                    config.rim_width_mm,
                );
                if l_tiles < p_tiles {
                    (raw_w.max(raw_h), raw_w.min(raw_h))
                } else {
                    (raw_w.min(raw_h), raw_w.max(raw_h))
                }
            }
        };

        let print_w = (paper_w - 2.0 * config.printer_margin_mm).max(10.0);
        let print_h = (paper_h - 2.0 * config.printer_margin_mm).max(10.0);
        let step_x = (print_w - config.overlap_margin_mm).max(5.0);
        let step_y = (print_h - config.overlap_margin_mm).max(5.0);

        let pitch_r = match loom.spec.shape {
            LoomShape::Circular | LoomShape::RegularPolygon => loom.spec.diameter_mm / 2.0,
            LoomShape::Elliptical | LoomShape::Rectangular => {
                loom.spec.width_mm.max(loom.spec.height_mm) / 2.0
            }
        };

        let rim_w = config
            .rim_width_mm
            .unwrap_or(2.0 * loom.spec.margin_mm)
            .max(loom.spec.margin_mm);
        let half_rim = rim_w / 2.0;

        let outer_r = pitch_r + half_rim;
        let inner_r = (pitch_r - half_rim).max(0.0);

        let drill_diameter_mm = config
            .drill_diameter_mm
            .unwrap_or(loom.spec.drill_diameter_mm)
            .max(0.5);

        // Bounding box mundial do aro
        let (bb_min_x, bb_max_x, bb_min_y, bb_max_y) = match loom.spec.shape {
            LoomShape::Circular | LoomShape::RegularPolygon => {
                (-outer_r, outer_r, -outer_r, outer_r)
            }
            LoomShape::Elliptical | LoomShape::Rectangular => {
                let hx = loom.spec.width_mm / 2.0 + half_rim;
                let hy = loom.spec.height_mm / 2.0 + half_rim;
                (-hx, hx, -hy, hy)
            }
        };

        let bb_w = bb_max_x - bb_min_x;
        let bb_h = bb_max_y - bb_min_y;

        let grid_cols = if bb_w <= print_w {
            1
        } else {
            1 + ((bb_w - print_w) / step_x).ceil() as usize
        };

        let grid_rows = if bb_h <= print_h {
            1
        } else {
            1 + ((bb_h - print_h) / step_y).ceil() as usize
        };

        let grid_total_w = print_w + (grid_cols - 1) as f64 * step_x;
        let grid_total_h = print_h + (grid_rows - 1) as f64 * step_y;

        // Centraliza a grade sobre a Bounding Box do aro
        let start_x = bb_min_x - (grid_total_w - bb_w) / 2.0;
        let start_y = bb_min_y - (grid_total_h - bb_h) / 2.0;

        let mut tiles = Vec::with_capacity(grid_rows * grid_cols);

        for r in 0..grid_rows {
            let row_letter = (b'A' + (r % 26) as u8) as char;
            for c in 0..grid_cols {
                let code = format!("{}{}", row_letter, c + 1);
                let x0 = start_x + c as f64 * step_x;
                let x1 = x0 + print_w;
                let y0 = start_y + r as f64 * step_y;
                let y1 = y0 + print_h;

                // Identifica pinos no tile
                let mut pin_indices = Vec::new();
                for pin in loom.pins() {
                    let px = pin.position.0;
                    let py = pin.position.1;
                    if px >= x0 && px <= x1 && py >= y0 && py <= y1 {
                        pin_indices.push(pin.index);
                    }
                }

                // Avaliação de distâncias para culling do vão central e externo
                let corners = [(x0, y0), (x1, y0), (x0, y1), (x1, y1)];
                let mut d_max: f64 = 0.0;

                for &(cx, cy) in &corners {
                    let d = (cx * cx + cy * cy).sqrt();
                    if d > d_max {
                        d_max = d;
                    }
                }

                // Distância mínima da origem até o retângulo [x0, x1] x [y0, y1]
                let dx_min = if 0.0 < x0 {
                    x0
                } else if 0.0 > x1 {
                    -x1
                } else {
                    0.0
                };
                let dy_min = if 0.0 < y0 {
                    y0
                } else if 0.0 > y1 {
                    -y1
                } else {
                    0.0
                };
                let d_min = (dx_min * dx_min + dy_min * dy_min).sqrt();

                // Culling do vão central: se toda a folha estiver estritamente dentro do raio interno
                let is_empty_interior = inner_r > 1.0 && d_max < inner_r && pin_indices.is_empty();

                // Culling exterior: se toda a folha estiver estritamente fora do raio externo
                let is_empty_exterior = d_min > outer_r && pin_indices.is_empty();

                let is_active = !is_empty_interior && !is_empty_exterior;

                let neighbor_right = if c + 1 < grid_cols {
                    Some(format!("{}{}", row_letter, c + 2))
                } else {
                    None
                };

                let neighbor_bottom = if r + 1 < grid_rows {
                    let next_letter = (b'A' + ((r + 1) % 26) as u8) as char;
                    Some(format!("{}{}", next_letter, c + 1))
                } else {
                    None
                };

                let neighbor_left = if c > 0 {
                    Some(format!("{}{}", row_letter, c))
                } else {
                    None
                };

                let neighbor_top = if r > 0 {
                    let prev_letter = (b'A' + ((r - 1) % 26) as u8) as char;
                    Some(format!("{}{}", prev_letter, c + 1))
                } else {
                    None
                };

                tiles.push(TileInfo {
                    row: r,
                    col: c,
                    code,
                    world_bounds_mm: (x0, y0, x1, y1),
                    is_empty_interior,
                    is_empty_exterior,
                    is_active,
                    pin_indices,
                    neighbor_right,
                    neighbor_bottom,
                    neighbor_left,
                    neighbor_top,
                });
            }
        }

        Self {
            loom,
            config,
            paper_width_mm: paper_w,
            paper_height_mm: paper_h,
            printable_width_mm: print_w,
            printable_height_mm: print_h,
            step_x_mm: step_x,
            step_y_mm: step_y,
            grid_cols,
            grid_rows,
            tiles,
            outer_radius_mm: outer_r,
            inner_radius_mm: inner_r,
            pitch_radius_mm: pitch_r,
            drill_diameter_mm,
        }
    }

    /// Função auxiliar interna para estimar a quantidade de telhas em uma dada orientação.
    fn compute_tile_count(
        loom: &LoomGeometry,
        paper_w: f64,
        paper_h: f64,
        margin_mm: f64,
        overlap_mm: f64,
        rim_width_mm: Option<f64>,
    ) -> usize {
        let print_w = (paper_w - 2.0 * margin_mm).max(10.0);
        let print_h = (paper_h - 2.0 * margin_mm).max(10.0);
        let step_x = (print_w - overlap_mm).max(5.0);
        let step_y = (print_h - overlap_mm).max(5.0);

        let pitch_r = loom.spec.diameter_mm / 2.0;
        let rim_w = rim_width_mm.unwrap_or(2.0 * loom.spec.margin_mm);
        let outer_r = pitch_r + rim_w / 2.0;
        let bb_w = 2.0 * outer_r;
        let bb_h = 2.0 * outer_r;

        let cols = if bb_w <= print_w {
            1
        } else {
            1 + ((bb_w - print_w) / step_x).ceil() as usize
        };
        let rows = if bb_h <= print_h {
            1
        } else {
            1 + ((bb_h - print_h) / step_y).ceil() as usize
        };
        cols * rows
    }

    /// Retorna todas as folhas ativas a serem impressas.
    pub fn active_tiles(&self) -> Vec<&TileInfo> {
        self.tiles.iter().filter(|t| t.is_active).collect()
    }

    /// Retorna as folhas internas do vão central cullerizadas para economia.
    pub fn empty_interior_tiles(&self) -> Vec<&TileInfo> {
        self.tiles.iter().filter(|t| t.is_empty_interior).collect()
    }

    /// Gera o SVG mestre 1:1 completo com toda a geometria do aro, furos, numeração e grade de folhas.
    pub fn to_master_svg(&self) -> String {
        let margin = 20.0;
        let total_w = 2.0 * self.outer_radius_mm + 2.0 * margin;
        let total_h = 2.0 * self.outer_radius_mm + 2.0 * margin;
        let ox = self.outer_radius_mm + margin;
        let oy = self.outer_radius_mm + margin;

        let mut svg = String::with_capacity(32768);
        svg.push_str(&format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{:.2}mm\" height=\"{:.2}mm\" viewBox=\"0 0 {:.2} {:.2}\">\n",
            total_w, total_h, total_w, total_h
        ));
        svg.push_str("  <rect width=\"100%\" height=\"100%\" fill=\"#ffffff\"/>\n");

        // Contorno externo
        svg.push_str(&format!(
            "  <circle cx=\"{:.3}\" cy=\"{:.3}\" r=\"{:.3}\" fill=\"none\" stroke=\"#111827\" stroke-width=\"0.6\"/>\n",
            ox, oy, self.outer_radius_mm
        ));

        // Linha primitiva de furação (tracejada)
        svg.push_str(&format!(
            "  <circle cx=\"{:.3}\" cy=\"{:.3}\" r=\"{:.3}\" fill=\"none\" stroke=\"#6b7280\" stroke-width=\"0.4\" stroke-dasharray=\"4,4\"/>\n",
            ox, oy, self.pitch_radius_mm
        ));

        // Contorno interno
        if self.inner_radius_mm > 0.0 {
            svg.push_str(&format!(
                "  <circle cx=\"{:.3}\" cy=\"{:.3}\" r=\"{:.3}\" fill=\"none\" stroke=\"#111827\" stroke-width=\"0.6\"/>\n",
                ox, oy, self.inner_radius_mm
            ));
        }

        // Centro (0, 0)
        svg.push_str(&format!(
            "  <line x1=\"{:.3}\" y1=\"{:.3}\" x2=\"{:.3}\" y2=\"{:.3}\" stroke=\"#9ca3af\" stroke-width=\"0.4\"/>\n",
            ox - 10.0, oy, ox + 10.0, oy
        ));
        svg.push_str(&format!(
            "  <line x1=\"{:.3}\" y1=\"{:.3}\" x2=\"{:.3}\" y2=\"{:.3}\" stroke=\"#9ca3af\" stroke-width=\"0.4\"/>\n",
            ox, oy - 10.0, ox, oy + 10.0
        ));

        // Grade de folhas sobreposta
        svg.push_str("  <!-- Grade de Folhas Paginadas 1:1 -->\n");
        for tile in &self.tiles {
            let tx = ox + tile.world_bounds_mm.0;
            let ty = oy + tile.world_bounds_mm.1;
            let tw = tile.world_bounds_mm.2 - tile.world_bounds_mm.0;
            let th = tile.world_bounds_mm.3 - tile.world_bounds_mm.1;

            let stroke_col = if tile.is_empty_interior {
                "#e5e7eb"
            } else {
                "#3b82f6"
            };
            let fill_col = if tile.is_empty_interior {
                "none"
            } else {
                "rgba(59, 130, 246, 0.03)"
            };

            svg.push_str(&format!(
                "  <rect x=\"{:.3}\" y=\"{:.3}\" width=\"{:.3}\" height=\"{:.3}\" fill=\"{}\" stroke=\"{}\" stroke-width=\"0.3\" stroke-dasharray=\"6,3\"/>\n",
                tx, ty, tw, th, fill_col, stroke_col
            ));

            svg.push_str(&format!(
                "  <text x=\"{:.3}\" y=\"{:.3}\" font-family=\"sans-serif\" font-size=\"6\" font-weight=\"bold\" fill=\"{}\">Folha {}</text>\n",
                tx + 4.0, ty + 10.0, stroke_col, tile.code
            ));
        }

        // Pinos: furos, cruzeta de centro e número
        let drill_r = self.drill_diameter_mm / 2.0;
        let label_dist = drill_r + 4.0;

        svg.push_str("  <!-- Furos e Marcacoes de Puncao -->\n");
        for pin in self.loom.pins() {
            let px = ox + pin.position.0;
            let py = oy + pin.position.1;

            // Cruzeta de centro de punção de 0.2 mm de espessura
            svg.push_str(&format!(
                "  <line x1=\"{:.3}\" y1=\"{:.3}\" x2=\"{:.3}\" y2=\"{:.3}\" stroke=\"#dc2626\" stroke-width=\"0.2\"/>\n",
                px - 1.5, py, px + 1.5, py
            ));
            svg.push_str(&format!(
                "  <line x1=\"{:.3}\" y1=\"{:.3}\" x2=\"{:.3}\" y2=\"{:.3}\" stroke=\"#dc2626\" stroke-width=\"0.2\"/>\n",
                px, py - 1.5, px, py + 1.5
            ));

            // Círculo no diâmetro exato da broca
            svg.push_str(&format!(
                "  <circle cx=\"{:.3}\" cy=\"{:.3}\" r=\"{:.3}\" fill=\"none\" stroke=\"#111827\" stroke-width=\"0.3\"/>\n",
                px, py, drill_r
            ));

            // Rótulo numérico projetado ao longo da normal voltada para fora
            let lx = px + pin.normal.0 * label_dist;
            let ly = py + pin.normal.1 * label_dist;
            let pin_num = pin.index + 1;
            let is_major = pin_num % 10 == 0;
            let font_weight = if is_major { "bold" } else { "normal" };
            let font_size = if is_major { "3.5" } else { "2.5" };
            let fill = if is_major { "#111827" } else { "#4b5563" };

            svg.push_str(&format!(
                "  <text x=\"{:.3}\" y=\"{:.3}\" font-family=\"sans-serif\" font-size=\"{}\" font-weight=\"{}\" fill=\"{}\" text-anchor=\"middle\" dominant-baseline=\"central\">{}</text>\n",
                lx, ly, font_size, font_weight, fill, pin_num
            ));
        }

        // Régua de Aferição de Escala de 100.0 mm
        let ruler_x = ox - 50.0;
        let ruler_y = total_h - 12.0;
        svg.push_str("  <!-- Regua de Afericao de 100.0 mm -->\n");
        svg.push_str(&format!(
            "  <line x1=\"{:.3}\" y1=\"{:.3}\" x2=\"{:.3}\" y2=\"{:.3}\" stroke=\"#111827\" stroke-width=\"0.5\"/>\n",
            ruler_x, ruler_y, ruler_x + 100.0, ruler_y
        ));
        for m in 0..=100 {
            if m % 5 == 0 || m == 100 {
                let tick_h = if m % 10 == 0 { 4.0 } else { 2.5 };
                svg.push_str(&format!(
                    "  <line x1=\"{:.3}\" y1=\"{:.3}\" x2=\"{:.3}\" y2=\"{:.3}\" stroke=\"#111827\" stroke-width=\"0.3\"/>\n",
                    ruler_x + m as f64, ruler_y, ruler_x + m as f64, ruler_y - tick_h
                ));
            }
        }
        svg.push_str(&format!(
            "  <text x=\"{:.3}\" y=\"{:.3}\" font-family=\"sans-serif\" font-size=\"2.8\" text-anchor=\"middle\">0 mm</text>\n",
            ruler_x, ruler_y + 4.0
        ));
        svg.push_str(&format!(
            "  <text x=\"{:.3}\" y=\"{:.3}\" font-family=\"sans-serif\" font-size=\"2.8\" text-anchor=\"middle\">50 mm</text>\n",
            ruler_x + 50.0, ruler_y + 4.0
        ));
        svg.push_str(&format!(
            "  <text x=\"{:.3}\" y=\"{:.3}\" font-family=\"sans-serif\" font-size=\"2.8\" text-anchor=\"middle\">100 mm</text>\n",
            ruler_x + 100.0, ruler_y + 4.0
        ));
        svg.push_str(&format!(
            "  <text x=\"{:.3}\" y=\"{:.3}\" font-family=\"sans-serif\" font-size=\"3.0\" font-weight=\"bold\" text-anchor=\"middle\">Regua de Afericao de Escala 100.0 mm (Meça com paquimetro para validar impressao 1:1)</text>\n",
            ruler_x + 50.0, ruler_y - 6.0
        ));

        svg.push_str("</svg>\n");
        svg
    }

    /// Gera o Documento PDF Multi-Páginas 1:1 completo pronto para impressão física.
    ///
    /// Inclui folha de capa com visão geral e matriz de folhas, seguida estritamente
    /// pelas folhas ativas (economizando as páginas que caem no vão central vazio).
    pub fn to_multipage_pdf(&self) -> Vec<u8> {
        let mut pdf = PdfDocument::new();

        // -------------------------------------------------------------
        // PÁGINA 1: CAPA TÉCNICA E MAPA DE MONTAGEM
        // -------------------------------------------------------------
        let cover = pdf.add_page(self.paper_width_mm, self.paper_height_mm);
        let m = self.config.printer_margin_mm;

        // Cabeçalho
        cover.text(
            m,
            m + 8.0,
            16.0,
            "WEAVER ART -- GABARITO DE FURACAO 1:1",
            TextAlign::Left,
            true,
        );
        cover.text(
            m,
            m + 15.0,
            10.0,
            "Especificacoes de Engenharia e Guia de Montagem Multi-Folhas",
            TextAlign::Left,
            false,
        );

        // Alerta de Impressão 1:1 Obrigatória
        cover.set_stroke_rgb(0.85, 0.15, 0.15);
        cover.set_fill_rgb(0.99, 0.95, 0.95);
        cover.set_line_width(0.6);
        cover.rect(m, m + 22.0, self.printable_width_mm, 20.0, PathMode::FillAndStroke);

        cover.set_stroke_rgb(0.1, 0.1, 0.1);
        cover.text(
            m + 5.0,
            m + 29.0,
            9.5,
            "ATENCAO CRITICA: Imprima em Escala 100% / Tamanho Real.",
            TextAlign::Left,
            true,
        );
        cover.text(
            m + 5.0,
            m + 35.0,
            8.0,
            "NUNCA use opcoes como 'Ajustar a Pagina' (Fit to Page) ou 'Reduzir para Caber'.",
            TextAlign::Left,
            false,
        );
        cover.text(
            m + 5.0,
            m + 39.5,
            8.0,
            "Sempre utilize a Regua de 100.0 mm no rodape de cada folha para conferir com paquimetro.",
            TextAlign::Left,
            false,
        );

        // Resumo de Especificações
        let active_count = self.active_tiles().len();
        let empty_count = self.empty_interior_tiles().len();
        let total_tiles = self.tiles.len();

        let shape_name = match self.loom.spec.shape {
            LoomShape::Circular => "Circular",
            LoomShape::Elliptical => "Eliptico",
            LoomShape::Rectangular => "Retangular",
            LoomShape::RegularPolygon => "Poligono Regular",
        };

        cover.text(m, m + 50.0, 10.0, "Dados do Projeto:", TextAlign::Left, true);
        cover.text(
            m + 4.0,
            m + 56.0,
            8.5,
            &format!("* Formato do Aro: {}", shape_name),
            TextAlign::Left,
            false,
        );
        cover.text(
            m + 4.0,
            m + 61.0,
            8.5,
            &format!(
                "* Diametro Primitivo de Furacao: {:.1} mm (Raio: {:.1} mm)",
                self.loom.spec.diameter_mm, self.pitch_radius_mm
            ),
            TextAlign::Left,
            false,
        );
        cover.text(
            m + 4.0,
            m + 66.0,
            8.5,
            &format!(
                "* Diametros do Aro: Externo Ø {:.1} mm | Interno Ø {:.1} mm",
                2.0 * self.outer_radius_mm,
                2.0 * self.inner_radius_mm
            ),
            TextAlign::Left,
            false,
        );
        cover.text(
            m + 4.0,
            m + 71.0,
            8.5,
            &format!(
                "* Quantidade de Pinos: {} furos perimetricos",
                self.loom.spec.peg_count
            ),
            TextAlign::Left,
            false,
        );
        cover.text(
            m + 4.0,
            m + 76.0,
            8.5,
            &format!(
                "* Diametro Nominal da Broca: Ø {:.2} mm",
                self.drill_diameter_mm
            ),
            TextAlign::Left,
            false,
        );
        cover.text(
            m + 4.0,
            m + 81.0,
            8.5,
            &format!(
                "* Grade de Folhas: {} colunas x {} linhas (Total: {} folhas)",
                self.grid_cols, self.grid_rows, total_tiles
            ),
            TextAlign::Left,
            false,
        );
        cover.text(
            m + 4.0,
            m + 86.0,
            8.5,
            &format!(
                "* Folhas Ativas Impressas: {} | Folhas Centrais Economizadas: {}",
                active_count, empty_count
            ),
            TextAlign::Left,
            true,
        );

        // Diagrama em escala reduzida da grade matricial na capa
        let diag_box_y = m + 96.0;
        let diag_box_h = self.paper_height_mm - diag_box_y - m - 20.0;
        let diag_box_w = self.printable_width_mm;

        let scale_w = (diag_box_w - 20.0) / (2.0 * self.outer_radius_mm);
        let scale_h = (diag_box_h - 20.0) / (2.0 * self.outer_radius_mm);
        let scale = scale_w.min(scale_h);

        let diag_cx = m + diag_box_w / 2.0;
        let diag_cy = diag_box_y + diag_box_h / 2.0;

        // Círculos no diagrama
        cover.set_line_width(0.3);
        cover.set_stroke_gray(0.5);
        cover.circle(diag_cx, diag_cy, self.outer_radius_mm * scale, PathMode::Stroke);
        cover.set_dash(&[2.0, 2.0], 0.0);
        cover.circle(diag_cx, diag_cy, self.pitch_radius_mm * scale, PathMode::Stroke);
        cover.set_dash(&[], 0.0);
        if self.inner_radius_mm > 0.0 {
            cover.circle(diag_cx, diag_cy, self.inner_radius_mm * scale, PathMode::Stroke);
        }

        // Retângulos das folhas na capa
        for tile in &self.tiles {
            let tx = diag_cx + tile.world_bounds_mm.0 * scale;
            let ty = diag_cy + tile.world_bounds_mm.1 * scale;
            let tw = (tile.world_bounds_mm.2 - tile.world_bounds_mm.0) * scale;
            let th = (tile.world_bounds_mm.3 - tile.world_bounds_mm.1) * scale;

            if tile.is_empty_interior {
                cover.set_stroke_gray(0.8);
                cover.set_fill_gray(0.96);
                cover.rect(tx, ty, tw, th, PathMode::FillAndStroke);
                cover.text(
                    tx + tw / 2.0,
                    ty + th / 2.0,
                    6.0,
                    &format!("{}(Vazio)", tile.code),
                    TextAlign::Center,
                    false,
                );
            } else if tile.is_active {
                cover.set_stroke_rgb(0.2, 0.4, 0.8);
                cover.set_fill_rgb(0.9, 0.94, 1.0);
                cover.rect(tx, ty, tw, th, PathMode::FillAndStroke);
                cover.text(
                    tx + tw / 2.0,
                    ty + th / 2.0,
                    7.0,
                    &tile.code,
                    TextAlign::Center,
                    true,
                );
            }
        }

        // Rodapé da capa
        cover.text(
            m,
            self.paper_height_mm - m,
            8.0,
            "Weaver Art CAM Engine -- Paginador Tecnico 1:1",
            TextAlign::Left,
            false,
        );

        // -------------------------------------------------------------
        // PÁGINAS ATIVAS 1:1
        // -------------------------------------------------------------
        let active_tiles = self.active_tiles();
        for tile in active_tiles {
            let page = pdf.add_page(self.paper_width_mm, self.paper_height_mm);
            let pm = self.config.printer_margin_mm;
            let x0 = tile.world_bounds_mm.0;
            let y0 = tile.world_bounds_mm.1;

            // 1. Área Útil e Recorte (Clipping)
            page.save_graphics_state();
            page.clip_rect(pm, pm, self.printable_width_mm, self.printable_height_mm);

            // Centro do tear nas coordenadas da folha
            let cx = pm + (0.0 - x0);
            let cy = pm + (0.0 - y0);

            // Traçado dos arcos do aro e linha de furação
            page.set_line_width(0.5);
            page.set_stroke_gray(0.2);
            page.circle(cx, cy, self.outer_radius_mm, PathMode::Stroke);

            page.set_line_width(0.35);
            page.set_stroke_gray(0.45);
            page.set_dash(&[4.0, 3.0], 0.0);
            page.circle(cx, cy, self.pitch_radius_mm, PathMode::Stroke);
            page.set_dash(&[], 0.0);

            if self.inner_radius_mm > 0.0 {
                page.set_line_width(0.5);
                page.set_stroke_gray(0.2);
                page.circle(cx, cy, self.inner_radius_mm, PathMode::Stroke);
            }

            // Projeção dos furos pertencentes à região desta folha
            let drill_r = self.drill_diameter_mm / 2.0;
            let label_dist = drill_r + 4.0;

            for &pin_idx in &tile.pin_indices {
                let pin = self.loom.pin(pin_idx);
                let hx = pm + (pin.position.0 - x0);
                let hy = pm + (pin.position.1 - y0);

                // Cruzeta central de punção de 0.2 mm
                page.set_line_width(0.2);
                page.set_stroke_rgb(0.85, 0.1, 0.1); // Vermelho de centro
                page.move_to(hx - 1.8, hy);
                page.line_to(hx + 1.8, hy);
                page.stroke();
                page.move_to(hx, hy - 1.8);
                page.line_to(hx, hy + 1.8);
                page.stroke();

                // Círculo no diâmetro exato da broca
                page.set_line_width(0.3);
                page.set_stroke_gray(0.1);
                page.circle(hx, hy, drill_r, PathMode::Stroke);

                // Rótulo numérico posicionado ao longo da normal voltada para fora
                let lx = hx + pin.normal.0 * label_dist;
                let ly = hy + pin.normal.1 * label_dist;
                let pin_num = pin.index + 1;
                let is_major = pin_num % 10 == 0;
                let font_size = if is_major { 8.0 } else { 6.5 };

                page.text(
                    lx,
                    ly + 1.0,
                    font_size,
                    &format!("{}", pin_num),
                    TextAlign::Center,
                    is_major,
                );
            }

            // Restaura o clipping para desenhar marcas de registro e moldura externa
            page.restore_graphics_state();

            // 2. Cruzetas Fiduciais de Registro (+) nos 4 Cantos da Área Útil de Colagem
            let corner_cross = |p: &mut crate::pdf::PdfPage, x: f64, y: f64| {
                p.set_line_width(0.3);
                p.set_stroke_gray(0.15);
                p.move_to(x - 4.0, y);
                p.line_to(x + 4.0, y);
                p.stroke();
                p.move_to(x, y - 4.0);
                p.line_to(x, y + 4.0);
                p.stroke();
            };

            let x_left = pm;
            let x_right = pm + self.printable_width_mm;
            let y_top = pm;
            let y_bottom = pm + self.printable_height_mm;

            corner_cross(page, x_left, y_top);
            corner_cross(page, x_right, y_top);
            corner_cross(page, x_left, y_bottom);
            corner_cross(page, x_right, y_bottom);

            // 3. Linhas Tracejadas de Sobreposição para Colagem
            let ov = self.config.overlap_margin_mm;
            if tile.neighbor_right.is_some() {
                let ox_line = x_right - ov;
                page.set_line_width(0.25);
                page.set_stroke_gray(0.4);
                page.set_dash(&[3.0, 3.0], 0.0);
                page.move_to(ox_line, y_top);
                page.line_to(ox_line, y_bottom);
                page.stroke();
                page.set_dash(&[], 0.0);
            }

            if tile.neighbor_bottom.is_some() {
                let oy_line = y_bottom - ov;
                page.set_line_width(0.25);
                page.set_stroke_gray(0.4);
                page.set_dash(&[3.0, 3.0], 0.0);
                page.move_to(x_left, oy_line);
                page.line_to(x_right, oy_line);
                page.stroke();
                page.set_dash(&[], 0.0);
            }

            // 4. Código da Folha e Instruções de Colagem no Cabeçalho
            let mut glue_instructions = Vec::new();
            if let Some(ref r) = tile.neighbor_right {
                glue_instructions.push(format!("Colar a direita com {}", r));
            }
            if let Some(ref b) = tile.neighbor_bottom {
                glue_instructions.push(format!("Colar abaixo com {}", b));
            }
            let glue_text = if glue_instructions.is_empty() {
                "Borda externa final".to_string()
            } else {
                glue_instructions.join(" | ")
            };

            page.text(
                pm,
                pm - 3.5,
                9.0,
                &format!("Folha {} -- {}", tile.code, glue_text),
                TextAlign::Left,
                true,
            );

            page.text(
                x_right,
                pm - 3.5,
                7.5,
                &format!(
                    "Tear Ø {:.1} mm · Broca Ø {:.2} mm · Escala 1:1",
                    self.loom.spec.diameter_mm, self.drill_diameter_mm
                ),
                TextAlign::Right,
                false,
            );

            // 5. Régua de Aferição de Escala de 100.0 mm no Rodapé
            let rx = pm + 5.0;
            let ry = self.paper_height_mm - pm + 6.0;

            page.set_line_width(0.4);
            page.set_stroke_gray(0.15);
            page.move_to(rx, ry);
            page.line_to(rx + 100.0, ry);
            page.stroke();

            for m in 0..=100 {
                if m % 5 == 0 || m == 100 {
                    let tick_h = if m % 10 == 0 { 3.5 } else { 2.0 };
                    page.move_to(rx + m as f64, ry);
                    page.line_to(rx + m as f64, ry - tick_h);
                    page.stroke();
                }
            }

            page.text(rx, ry + 2.5, 5.0, "0", TextAlign::Center, false);
            page.text(rx + 50.0, ry + 2.5, 5.0, "50 mm", TextAlign::Center, false);
            page.text(rx + 100.0, ry + 2.5, 5.0, "100 mm", TextAlign::Center, false);

            page.text(
                rx + 50.0,
                ry - 5.0,
                5.5,
                "Regua de Afericao de Escala 100.0 mm (Meça com paquimetro apos imprimir -- Escala 100% real)",
                TextAlign::Center,
                true,
            );
        }

        pdf.to_bytes()
    }

    /// Gera o código SVG de uma folha individual 1:1.
    pub fn to_tile_svg(&self, tile: &TileInfo) -> String {
        let pm = self.config.printer_margin_mm;
        let x0 = tile.world_bounds_mm.0;
        let y0 = tile.world_bounds_mm.1;
        let pw = self.paper_width_mm;
        let ph = self.paper_height_mm;

        let mut svg = String::with_capacity(8192);
        svg.push_str(&format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{:.2}mm\" height=\"{:.2}mm\" viewBox=\"0 0 {:.2} {:.2}\">\n",
            pw, ph, pw, ph
        ));
        svg.push_str("  <rect width=\"100%\" height=\"100%\" fill=\"#ffffff\"/>\n");

        let cx = pm + (0.0 - x0);
        let cy = pm + (0.0 - y0);
        let drill_r = self.drill_diameter_mm / 2.0;

        // Clip path para a área útil
        svg.push_str("  <defs>\n");
        svg.push_str(&format!(
            "    <clipPath id=\"print-area\"><rect x=\"{:.2}\" y=\"{:.2}\" width=\"{:.2}\" height=\"{:.2}\"/></clipPath>\n",
            pm, pm, self.printable_width_mm, self.printable_height_mm
        ));
        svg.push_str("  </defs>\n");

        svg.push_str("  <g clip-path=\"url(#print-area)\">\n");
        svg.push_str(&format!(
            "    <circle cx=\"{:.3}\" cy=\"{:.3}\" r=\"{:.3}\" fill=\"none\" stroke=\"#111827\" stroke-width=\"0.5\"/>\n",
            cx, cy, self.outer_radius_mm
        ));
        svg.push_str(&format!(
            "    <circle cx=\"{:.3}\" cy=\"{:.3}\" r=\"{:.3}\" fill=\"none\" stroke=\"#6b7280\" stroke-width=\"0.35\" stroke-dasharray=\"4,3\"/>\n",
            cx, cy, self.pitch_radius_mm
        ));
        if self.inner_radius_mm > 0.0 {
            svg.push_str(&format!(
                "    <circle cx=\"{:.3}\" cy=\"{:.3}\" r=\"{:.3}\" fill=\"none\" stroke=\"#111827\" stroke-width=\"0.5\"/>\n",
                cx, cy, self.inner_radius_mm
            ));
        }

        for &pin_idx in &tile.pin_indices {
            let pin = self.loom.pin(pin_idx);
            let hx = pm + (pin.position.0 - x0);
            let hy = pm + (pin.position.1 - y0);

            svg.push_str(&format!(
                "    <line x1=\"{:.3}\" y1=\"{:.3}\" x2=\"{:.3}\" y2=\"{:.3}\" stroke=\"#dc2626\" stroke-width=\"0.2\"/>\n",
                hx - 1.8, hy, hx + 1.8, hy
            ));
            svg.push_str(&format!(
                "    <line x1=\"{:.3}\" y1=\"{:.3}\" x2=\"{:.3}\" y2=\"{:.3}\" stroke=\"#dc2626\" stroke-width=\"0.2\"/>\n",
                hx, hy - 1.8, hx, hy + 1.8
            ));
            svg.push_str(&format!(
                "    <circle cx=\"{:.3}\" cy=\"{:.3}\" r=\"{:.3}\" fill=\"none\" stroke=\"#111827\" stroke-width=\"0.3\"/>\n",
                hx, hy, drill_r
            ));

            let lx = hx + pin.normal.0 * (drill_r + 4.0);
            let ly = hy + pin.normal.1 * (drill_r + 4.0);
            svg.push_str(&format!(
                "    <text x=\"{:.3}\" y=\"{:.3}\" font-family=\"sans-serif\" font-size=\"2.8\" text-anchor=\"middle\" dominant-baseline=\"central\">{}</text>\n",
                lx, ly, pin.index + 1
            ));
        }
        svg.push_str("  </g>\n");

        // Régua 100 mm no rodapé
        let rx = pm + 5.0;
        let ry = ph - pm + 5.0;
        svg.push_str(&format!(
            "  <line x1=\"{:.3}\" y1=\"{:.3}\" x2=\"{:.3}\" y2=\"{:.3}\" stroke=\"#111827\" stroke-width=\"0.4\"/>\n",
            rx, ry, rx + 100.0, ry
        ));
        svg.push_str(&format!(
            "  <text x=\"{:.3}\" y=\"{:.3}\" font-family=\"sans-serif\" font-size=\"2.5\">Regua de Afericao 100.0 mm</text>\n",
            rx + 25.0, ry - 3.0
        ));

        svg.push_str("</svg>\n");
        svg
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use weaver_domain::LoomPhysicalSpec;

    #[test]
    fn test_blueprint_tiler_a4_circle_711_2() {
        let spec = LoomPhysicalSpec::circle(711.2, 200, 2.0, 2.0, 15.0);
        let loom = LoomGeometry::new(spec);

        let config = BlueprintConfig {
            paper_size: PaperSize::A4,
            orientation: PaperOrientation::Portrait,
            printer_margin_mm: 10.0,
            overlap_margin_mm: 15.0,
            rim_width_mm: Some(30.0), // 15 mm para dentro e 15 mm para fora
            drill_diameter_mm: Some(2.0),
        };

        let tiler = BlueprintTiler::new(loom, config);

        // Dimensões A4 Portrait: 210 x 297 mm
        assert_eq!(tiler.paper_width_mm, 210.0);
        assert_eq!(tiler.paper_height_mm, 297.0);

        // Área útil: 190 x 277 mm
        assert_eq!(tiler.printable_width_mm, 190.0);
        assert_eq!(tiler.printable_height_mm, 277.0);

        // Passo de telhamento com sobreposição de 15 mm
        assert_eq!(tiler.step_x_mm, 175.0);
        assert_eq!(tiler.step_y_mm, 262.0);

        // Raio externo = 355.6 + 15 = 370.6 mm -> Diâmetro total = 741.2 mm
        assert_eq!(tiler.pitch_radius_mm, 355.6);
        assert_eq!(tiler.outer_radius_mm, 370.6);
        assert_eq!(tiler.inner_radius_mm, 340.6);

        // Para cobrir 741.2 mm:
        // Colunas: 1 + ceil((741.2 - 190) / 175) = 1 + ceil(3.149) = 5 colunas
        // Linhas: 1 + ceil((741.2 - 277) / 262) = 1 + ceil(1.771) = 3 linhas
        assert_eq!(tiler.grid_cols, 5);
        assert_eq!(tiler.grid_rows, 3);
        assert_eq!(tiler.tiles.len(), 15);

        // Validação de culling de páginas do vão central vazio:
        // As folhas centrais na linha 1 (B2, B3, B4 ou colunas 1, 2, 3) devem ser cullerizadas!
        let empty_interior_count = tiler.empty_interior_tiles().len();
        assert!(
            empty_interior_count > 0,
            "Deveria identificar ao menos uma folha de vao central vazio, encontrou {}",
            empty_interior_count
        );

        // A folha central (linha 1, coluna 2 - B3) deve ser estritamente empty_interior
        let center_tile = tiler
            .tiles
            .iter()
            .find(|t| t.row == 1 && t.col == 2)
            .expect("Telha central deve existir");
        assert!(
            center_tile.is_empty_interior,
            "Telha central B3 deveria ter is_empty_interior = true"
        );
        assert!(
            !center_tile.is_active,
            "Telha central vazia nao deveria ser ativa"
        );
        assert!(
            center_tile.pin_indices.is_empty(),
            "Telha central nao deve conter pinos"
        );

        // Folhas ativas devem somar menos que o total de 15 folhas
        let active_count = tiler.active_tiles().len();
        assert_eq!(active_count, 15 - empty_interior_count);

        // Todos os 200 pinos devem estar cobertos pelas folhas ativas
        let mut covered_pins = std::collections::HashSet::new();
        for tile in tiler.active_tiles() {
            for &idx in &tile.pin_indices {
                covered_pins.insert(idx);
            }
        }
        assert_eq!(
            covered_pins.len(),
            200,
            "Todos os 200 pinos devem estar cobertos nas folhas ativas"
        );

        // Validação da exportação do SVG mestre
        let svg = tiler.to_master_svg();
        assert!(svg.starts_with("<svg"));
        assert!(svg.contains("Regua de Afericao de Escala 100.0 mm"));
        assert!(svg.contains("Folha A1"));
        assert!(svg.ends_with("</svg>\n"));

        // Validação da exportação do PDF Multi-páginas
        let pdf_bytes = tiler.to_multipage_pdf();
        assert!(pdf_bytes.starts_with(b"%PDF-1.4"));
        let pdf_str = String::from_utf8_lossy(&pdf_bytes);
        assert!(pdf_str.contains("WEAVER ART -- GABARITO DE FURACAO 1:1"));
        assert!(pdf_str.contains("Regua de Afericao de Escala 100.0 mm"));
        assert!(pdf_str.contains("trailer\n"));
        assert!(pdf_str.ends_with("%%EOF\n"));
    }
}
