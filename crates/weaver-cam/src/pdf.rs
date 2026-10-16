//! Gerador vetorial minimalista e puro de PDF 1.4 (zero dependências externas).
//!
//! Produz documentos PDF 1.4 válidos com tabela xref exata por offset de bytes,
//! fontes Helvetica / Helvetica-Bold integradas e operadores de desenho vetorial 1:1.

use std::f64::consts::PI;

/// Modo de renderização de caminho geométrico.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathMode {
    /// Apenas traço (Stroke).
    Stroke,
    /// Apenas preenchimento (Fill).
    Fill,
    /// Preenchimento e traço (Fill and Stroke).
    FillAndStroke,
}

impl PathMode {
    #[inline]
    pub fn pdf_op(self) -> &'static str {
        match self {
            Self::Stroke => "S",
            Self::Fill => "f",
            Self::FillAndStroke => "B",
        }
    }
}

/// Alinhamento horizontal de texto.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextAlign {
    Left,
    Center,
    Right,
}

/// Página individual em um documento PDF.
#[derive(Debug, Clone)]
pub struct PdfPage {
    pub width_mm: f64,
    pub height_mm: f64,
    pub width_pt: f64,
    pub height_pt: f64,
    ops: Vec<String>,
}

impl PdfPage {
    pub fn new(width_mm: f64, height_mm: f64) -> Self {
        let width_pt = (width_mm * 72.0) / 25.4;
        let height_pt = (height_mm * 72.0) / 25.4;
        Self {
            width_mm,
            height_mm,
            width_pt,
            height_pt,
            ops: Vec::new(),
        }
    }

    #[inline]
    fn to_pt_x(&self, x_mm: f64) -> f64 {
        (x_mm * 72.0) / 25.4
    }

    #[inline]
    fn to_pt_y(&self, y_mm: f64) -> f64 {
        self.height_pt - (y_mm * 72.0) / 25.4
    }

    /// Define a espessura da linha em milímetros (`mm`).
    pub fn set_line_width(&mut self, mm: f64) -> &mut Self {
        let pt = (mm * 72.0) / 25.4;
        self.ops.push(format!("{:.3} w", pt));
        self
    }

    /// Define o tom de cinza do traço (0.0 = preto, 1.0 = branco).
    pub fn set_stroke_gray(&mut self, gray: f64) -> &mut Self {
        self.ops.push(format!("{:.3} G", gray.clamp(0.0, 1.0)));
        self
    }

    /// Define o tom de cinza do preenchimento (0.0 = preto, 1.0 = branco).
    pub fn set_fill_gray(&mut self, gray: f64) -> &mut Self {
        self.ops.push(format!("{:.3} g", gray.clamp(0.0, 1.0)));
        self
    }

    /// Define a cor RGB do traço no espaço sRGB normalizado [0.0, 1.0].
    pub fn set_stroke_rgb(&mut self, r: f64, g: f64, b: f64) -> &mut Self {
        self.ops.push(format!(
            "{:.3} {:.3} {:.3} RG",
            r.clamp(0.0, 1.0),
            g.clamp(0.0, 1.0),
            b.clamp(0.0, 1.0)
        ));
        self
    }

    /// Define a cor RGB de preenchimento no espaço sRGB normalizado [0.0, 1.0].
    pub fn set_fill_rgb(&mut self, r: f64, g: f64, b: f64) -> &mut Self {
        self.ops.push(format!(
            "{:.3} {:.3} {:.3} rg",
            r.clamp(0.0, 1.0),
            g.clamp(0.0, 1.0),
            b.clamp(0.0, 1.0)
        ));
        self
    }

    /// Define o padrão de linha tracejada (em mm). Passe lista vazia para linha contínua.
    pub fn set_dash(&mut self, dash_mm: &[f64], phase_mm: f64) -> &mut Self {
        if dash_mm.is_empty() {
            self.ops.push("[] 0 d".to_string());
        } else {
            let pts: Vec<String> = dash_mm
                .iter()
                .map(|&d| format!("{:.3}", (d * 72.0) / 25.4))
                .collect();
            let phase_pt = (phase_mm * 72.0) / 25.4;
            self.ops.push(format!("[{}] {:.3} d", pts.join(" "), phase_pt));
        }
        self
    }

    /// Salva o estado gráfico atual (`q`).
    pub fn save_graphics_state(&mut self) -> &mut Self {
        self.ops.push("q".to_string());
        self
    }

    /// Restaura o estado gráfico anterior (`Q`).
    pub fn restore_graphics_state(&mut self) -> &mut Self {
        self.ops.push("Q".to_string());
        self
    }

    /// Move para as coordenadas $(X, Y)$ em mm (origem no topo-esquerdo da folha).
    pub fn move_to(&mut self, x_mm: f64, y_mm: f64) -> &mut Self {
        self.ops
            .push(format!("{:.3} {:.3} m", self.to_pt_x(x_mm), self.to_pt_y(y_mm)));
        self
    }

    /// Desenha segmento linear até $(X, Y)$ em mm.
    pub fn line_to(&mut self, x_mm: f64, y_mm: f64) -> &mut Self {
        self.ops
            .push(format!("{:.3} {:.3} l", self.to_pt_x(x_mm), self.to_pt_y(y_mm)));
        self
    }

    /// Desenha curva cúbica de Bézier até $(X_2, Y_2)$ com pontos de controle $(C_{1x}, C_{1y})$ e $(C_{2x}, C_{2y})$.
    pub fn curve_to(
        &mut self,
        c1x_mm: f64,
        c1y_mm: f64,
        c2x_mm: f64,
        c2y_mm: f64,
        x2_mm: f64,
        y2_mm: f64,
    ) -> &mut Self {
        self.ops.push(format!(
            "{:.3} {:.3} {:.3} {:.3} {:.3} {:.3} c",
            self.to_pt_x(c1x_mm),
            self.to_pt_y(c1y_mm),
            self.to_pt_x(c2x_mm),
            self.to_pt_y(c2y_mm),
            self.to_pt_x(x2_mm),
            self.to_pt_y(y2_mm)
        ));
        self
    }

    /// Fecha o sub-caminho atual (`h`).
    pub fn close_path(&mut self) -> &mut Self {
        self.ops.push("h".to_string());
        self
    }

    /// Traça o caminho atual (`S`).
    pub fn stroke(&mut self) -> &mut Self {
        self.ops.push("S".to_string());
        self
    }

    /// Preenche o caminho atual (`f`).
    pub fn fill(&mut self) -> &mut Self {
        self.ops.push("f".to_string());
        self
    }

    /// Preenche e traça o caminho atual (`B`).
    pub fn fill_and_stroke(&mut self) -> &mut Self {
        self.ops.push("B".to_string());
        self
    }

    /// Desenha um retângulo com dimensões $(W, H)$ em mm a partir de $(X, Y)$.
    pub fn rect(&mut self, x_mm: f64, y_mm: f64, w_mm: f64, h_mm: f64, mode: PathMode) -> &mut Self {
        let pt_x = self.to_pt_x(x_mm);
        let pt_y = self.to_pt_y(y_mm + h_mm);
        let pt_w = (w_mm * 72.0) / 25.4;
        let pt_h = (h_mm * 72.0) / 25.4;
        self.ops.push(format!(
            "{:.3} {:.3} {:.3} {:.3} re\n{}",
            pt_x,
            pt_y,
            pt_w,
            pt_h,
            mode.pdf_op()
        ));
        self
    }

    /// Define uma região retangular de corte (clipping path `re W n`).
    pub fn clip_rect(&mut self, x_mm: f64, y_mm: f64, w_mm: f64, h_mm: f64) -> &mut Self {
        let pt_x = self.to_pt_x(x_mm);
        let pt_y = self.to_pt_y(y_mm + h_mm);
        let pt_w = (w_mm * 72.0) / 25.4;
        let pt_h = (h_mm * 72.0) / 25.4;
        self.ops
            .push(format!("{:.3} {:.3} {:.3} {:.3} re W n", pt_x, pt_y, pt_w, pt_h));
        self
    }

    /// Desenha um círculo centrado em $(cx, cy)$ com raio $r$ em mm.
    pub fn circle(&mut self, cx_mm: f64, cy_mm: f64, r_mm: f64, mode: PathMode) -> &mut Self {
        const K: f64 = 0.5522847498;
        let d = r_mm * K;

        // 4 cúbicas de Bézier aproximando o círculo
        let p0 = (cx_mm + r_mm, cy_mm);
        let c1a = (cx_mm + r_mm, cy_mm + d);
        let c1b = (cx_mm + d, cy_mm + r_mm);
        let p1 = (cx_mm, cy_mm + r_mm);

        let c2a = (cx_mm - d, cy_mm + r_mm);
        let c2b = (cx_mm - r_mm, cy_mm + d);
        let p2 = (cx_mm - r_mm, cy_mm);

        let c3a = (cx_mm - r_mm, cy_mm - d);
        let c3b = (cx_mm - d, cy_mm - r_mm);
        let p3 = (cx_mm, cy_mm - r_mm);

        let c4a = (cx_mm + d, cy_mm - r_mm);
        let c4b = (cx_mm + r_mm, cy_mm - d);

        self.move_to(p0.0, p0.1);
        self.curve_to(c1a.0, c1a.1, c1b.0, c1b.1, p1.0, p1.1);
        self.curve_to(c2a.0, c2a.1, c2b.0, c2b.1, p2.0, p2.1);
        self.curve_to(c3a.0, c3a.1, c3b.0, c3b.1, p3.0, p3.1);
        self.curve_to(c4a.0, c4a.1, c4b.0, c4b.1, p0.0, p0.1);
        self.close_path();
        self.ops.push(mode.pdf_op().to_string());
        self
    }

    /// Desenha um arco circular centrado em $(cx, cy)$ de raio $r$ do ângulo `start_rad` até `end_rad` (sentido horário em tela).
    pub fn arc(
        &mut self,
        cx_mm: f64,
        cy_mm: f64,
        r_mm: f64,
        start_rad: f64,
        end_rad: f64,
    ) -> &mut Self {
        let diff = (end_rad - start_rad).abs();
        let segments = ((diff / (PI / 2.0)).ceil() as usize).max(1);
        let d_theta = (end_rad - start_rad) / segments as f64;

        let start_x = cx_mm + r_mm * start_rad.cos();
        let start_y = cy_mm + r_mm * start_rad.sin();
        self.move_to(start_x, start_y);

        for i in 0..segments {
            let theta1 = start_rad + i as f64 * d_theta;
            let theta2 = theta1 + d_theta;
            let alpha = (theta2 - theta1).abs();
            let k = (4.0 / 3.0) * (alpha / 4.0).tan();

            let p0 = (cx_mm + r_mm * theta1.cos(), cy_mm + r_mm * theta1.sin());
            let p3 = (cx_mm + r_mm * theta2.cos(), cy_mm + r_mm * theta2.sin());

            let sign = if d_theta >= 0.0 { 1.0 } else { -1.0 };
            let c1 = (
                p0.0 - sign * k * r_mm * theta1.sin(),
                p0.1 + sign * k * r_mm * theta1.cos(),
            );
            let c2 = (
                p3.0 + sign * k * r_mm * theta2.sin(),
                p3.1 - sign * k * r_mm * theta2.cos(),
            );

            self.curve_to(c1.0, c1.1, c2.0, c2.1, p3.0, p3.1);
        }
        self.stroke();
        self
    }

    /// Renderiza texto em fonte Helvetica / Helvetica-Bold com tamanho em pontos (`pt`).
    pub fn text(
        &mut self,
        x_mm: f64,
        y_mm: f64,
        size_pt: f64,
        text_content: &str,
        align: TextAlign,
        bold: bool,
    ) -> &mut Self {
        let font_tag = if bold { "/F2" } else { "/F1" };
        let mut pt_x = self.to_pt_x(x_mm);
        let pt_y = self.to_pt_y(y_mm);

        if align != TextAlign::Left {
            let text_width = estimate_text_width_pt(text_content, size_pt, bold);
            if align == TextAlign::Center {
                pt_x -= text_width / 2.0;
            } else if align == TextAlign::Right {
                pt_x -= text_width;
            }
        }

        let encoded = encode_win_ansi(text_content);
        self.ops.push("BT".to_string());
        self.ops.push(format!("{} {:.3} Tf", font_tag, size_pt));
        self.ops.push(format!("{:.3} {:.3} Td", pt_x, pt_y));
        self.ops.push(format!("({}) Tj", encoded));
        self.ops.push("ET".to_string());
        self
    }

    /// Retorna o conteúdo do fluxo de operadores gráficos da página.
    pub fn get_stream_content(&self) -> String {
        let mut out = self.ops.join("\n");
        out.push('\n');
        out
    }
}

/// Documento PDF 1.4 multi-páginas de alta precisão.
#[derive(Debug, Default, Clone)]
pub struct PdfDocument {
    pages: Vec<PdfPage>,
}

impl PdfDocument {
    pub fn new() -> Self {
        Self { pages: Vec::new() }
    }

    /// Adiciona uma nova página ao documento com dimensões em milímetros (`mm`).
    pub fn add_page(&mut self, width_mm: f64, height_mm: f64) -> &mut PdfPage {
        self.pages.push(PdfPage::new(width_mm, height_mm));
        self.pages.last_mut().unwrap()
    }

    /// Quantidade de páginas adicionadas.
    #[inline]
    pub fn page_count(&self) -> usize {
        self.pages.len()
    }

    /// Gera a sequência final de bytes do documento PDF 1.4 com tabela xref indexada.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut output: Vec<u8> = Vec::with_capacity(4096);
        let mut offsets: Vec<usize> = Vec::new();

        // Cabeçalho PDF 1.4 com marca binária padrão (> 127)
        output.extend_from_slice(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

        let num_pages = self.pages.len();
        let total_objs = 4 + 2 * num_pages;
        offsets.resize(total_objs + 1, 0);

        let mut record_obj = |num: usize, content: &str, out: &mut Vec<u8>| {
            offsets[num] = out.len();
            let obj_str = format!("{} 0 obj\n{}\nendobj\n", num, content);
            out.extend_from_slice(obj_str.as_bytes());
        };

        // Objeto 1: Catalog
        record_obj(1, "<< /Type /Catalog /Pages 2 0 R >>", &mut output);

        // Objeto 2: Pages Tree
        let kids_str: Vec<String> = (0..num_pages)
            .map(|i| format!("{} 0 R", 5 + 2 * i))
            .collect();
        record_obj(
            2,
            &format!(
                "<< /Type /Pages /Kids [ {} ] /Count {} >>",
                kids_str.join(" "),
                num_pages
            ),
            &mut output,
        );

        // Objeto 3: Fonte Regular (Helvetica)
        record_obj(
            3,
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
            &mut output,
        );

        // Objeto 4: Fonte Negrito (Helvetica-Bold)
        record_obj(
            4,
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
            &mut output,
        );

        // Páginas e seus fluxos de conteúdo
        for (i, page) in self.pages.iter().enumerate() {
            let page_obj_num = 5 + 2 * i;
            let content_obj_num = 6 + 2 * i;
            let stream_content = page.get_stream_content();
            let stream_bytes_len = stream_content.len();

            let page_def = format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 {:.3} {:.3} ] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents {} 0 R >>",
                page.width_pt, page.height_pt, content_obj_num
            );
            record_obj(page_obj_num, &page_def, &mut output);

            let stream_def = format!(
                "<< /Length {} >>\nstream\n{}endstream",
                stream_bytes_len, stream_content
            );
            record_obj(content_obj_num, &stream_def, &mut output);
        }

        let start_xref = output.len();

        // Tabela XREF (cada entrada tem exatamente 20 bytes: 10 dígitos + ' ' + 5 dígitos + ' ' + 'n'/'f' + ' \r\n')
        let mut xref_buf = String::with_capacity(64 + total_objs * 20);
        xref_buf.push_str("xref\n");
        xref_buf.push_str(&format!("0 {}\n", total_objs + 1));
        xref_buf.push_str("0000000000 65535 f \r\n");
        for i in 1..=total_objs {
            xref_buf.push_str(&format!("{:010} 00000 n \r\n", offsets[i]));
        }

        // Trailer
        xref_buf.push_str(&format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
            total_objs + 1,
            start_xref
        ));

        output.extend_from_slice(xref_buf.as_bytes());

        output
    }
}

/// Estima a largura de um texto em pontos para Helvetica.
fn estimate_text_width_pt(text: &str, size_pt: f64, bold: bool) -> f64 {
    let mut total_units = 0.0;
    for ch in text.chars() {
        let u = match ch {
            '0'..='9' => 556.0,
            ' ' | ',' | '.' | ':' | ';' => 278.0,
            '-' => 333.0,
            'A'..='Z' => {
                if bold {
                    720.0
                } else {
                    667.0
                }
            }
            'a'..='z' => {
                if bold {
                    556.0
                } else {
                    500.0
                }
            }
            _ => 500.0,
        };
        total_units += u;
    }
    (total_units / 1000.0) * size_pt
}

/// Codifica caracteres Unicode para a tabela WinAnsi do PDF.
fn encode_win_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 16);
    for ch in s.chars() {
        match ch {
            '(' => out.push_str("\\("),
            ')' => out.push_str("\\)"),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '—' => out.push_str("--"),
            '–' => out.push('-'),
            '→' => out.push_str("->"),
            '←' => out.push_str("<-"),
            ' '..='~' => out.push(ch),
            _ => {
                let code = ch as u32;
                if (0xA0..=0xFF).contains(&code) {
                    out.push_str(&format!("\\{:03o}", code));
                } else if ch == 'Ø' {
                    out.push_str("\\330");
                } else if ch == 'ø' {
                    out.push_str("\\370");
                } else if ch == '°' {
                    out.push_str("\\260");
                } else {
                    out.push('?');
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pdf_generation_validity() {
        let mut pdf = PdfDocument::new();
        let page = pdf.add_page(210.0, 297.0); // A4

        page.set_line_width(0.5);
        page.set_stroke_gray(0.2);
        page.rect(10.0, 10.0, 190.0, 277.0, PathMode::Stroke);
        page.text(20.0, 30.0, 12.0, "Teste Weaver Art 1:1", TextAlign::Left, true);
        page.circle(105.0, 148.5, 50.0, PathMode::Stroke);

        let bytes = pdf.to_bytes();
        assert!(bytes.starts_with(b"%PDF-1.4\n"));
        let pdf_str = String::from_utf8_lossy(&bytes);
        assert!(pdf_str.contains("/Type /Catalog"));
        assert!(pdf_str.contains("/Type /Pages"));
        assert!(pdf_str.contains("/Type /Page"));
        assert!(pdf_str.contains("xref\n"));
        assert!(pdf_str.contains("trailer\n"));
        assert!(pdf_str.ends_with("%%EOF\n"));
    }
}
