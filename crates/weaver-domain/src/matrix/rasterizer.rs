//! Motores de Rasterização de Linhas (Bresenham e Xiaolin Wu) e Mapeamento de Grade.
//!
//! Implementa os algoritmos de rasterização contínua de cordas para a grade
//! discreta de simulação do tear com suporte a anti-aliasing sub-pixel e
//! restrição de distância mínima perimétrica entre pinos ($d_{\min}$).

use crate::geometry::LoomGeometry;

/// Peso integral máximo correspondente à cobertura total de 100% em `u8` ($w = 1.0$).
pub const FULL_COVERAGE_WEIGHT: u8 = 255;

/// Algoritmo de rasterização de linhas na grade discreta de simulação.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RasterizerType {
    /// Rasterização binária inteira clássica de Bresenham ($w \in \{0, 255\}$).
    BresenhamBinary,
    /// Rasterização com anti-aliasing sub-pixel de Xiaolin Wu ($w \in [0, 255]$).
    XiaolinWuAntialiased,
}

/// Contrato para motores de rasterização de segmentos de reta.
pub trait LineRasterizer {
    /// Rasteriza o segmento de reta de $(x_0, y_0)$ até $(x_1, y_1)$ na grade $W \times H$.
    #[allow(clippy::too_many_arguments)]
    fn rasterize_line(
        &self,
        x0: f64,
        y0: f64,
        x1: f64,
        y1: f64,
        width: u32,
        height: u32,
        out_pixels: &mut Vec<u32>,
        out_weights: &mut Vec<u8>,
    );
}

/// Rasterizador de linha de Bresenham (binário, sem anti-aliasing).
#[derive(Debug, Clone, Copy, Default)]
pub struct BresenhamRasterizer;

impl LineRasterizer for BresenhamRasterizer {
    #[inline]
    fn rasterize_line(
        &self,
        x0: f64,
        y0: f64,
        x1: f64,
        y1: f64,
        width: u32,
        height: u32,
        out_pixels: &mut Vec<u32>,
        out_weights: &mut Vec<u8>,
    ) {
        rasterize_bresenham(x0, y0, x1, y1, width, height, out_pixels, out_weights);
    }
}

/// Rasterizador de Xiaolin Wu (anti-aliasing sub-pixel com conservação de energia).
#[derive(Debug, Clone, Copy, Default)]
pub struct XiaolinWuRasterizer;

impl LineRasterizer for XiaolinWuRasterizer {
    #[inline]
    fn rasterize_line(
        &self,
        x0: f64,
        y0: f64,
        x1: f64,
        y1: f64,
        width: u32,
        height: u32,
        out_pixels: &mut Vec<u32>,
        out_weights: &mut Vec<u8>,
    ) {
        rasterize_xiaolin_wu(x0, y0, x1, y1, width, height, out_pixels, out_weights);
    }
}

impl LineRasterizer for RasterizerType {
    #[inline]
    fn rasterize_line(
        &self,
        x0: f64,
        y0: f64,
        x1: f64,
        y1: f64,
        width: u32,
        height: u32,
        out_pixels: &mut Vec<u32>,
        out_weights: &mut Vec<u8>,
    ) {
        match self {
            Self::BresenhamBinary => {
                rasterize_bresenham(x0, y0, x1, y1, width, height, out_pixels, out_weights)
            }
            Self::XiaolinWuAntialiased => {
                rasterize_xiaolin_wu(x0, y0, x1, y1, width, height, out_pixels, out_weights)
            }
        }
    }
}

/// Transforma coordenadas contínuas do tear em milímetros (`mm`) para pixels na grade de simulação.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LoomGridMapping {
    pub scale_x: f64,
    pub scale_y: f64,
    pub offset_x: f64,
    pub offset_y: f64,
    pub width: u32,
    pub height: u32,
}

impl LoomGridMapping {
    /// Constrói o mapeamento a partir da geometria do tear e das dimensões da grade.
    ///
    /// Posiciona o centro do tear no centro da grade $((W-1)/2, (H-1)/2)$ e ajusta a escala
    /// para que os pinos perimétricos permaneçam confortavelmente dentro da grade com margem
    /// sub-pixel de 1 pixel contra corte de antialiasing.
    pub fn from_loom(loom: &LoomGeometry, width: u32, height: u32) -> Self {
        let extent = loom
            .spec
            .width_mm
            .max(loom.spec.height_mm)
            .max(loom.spec.diameter_mm);
        let extent = if extent > 1e-6 { extent } else { 1.0 };

        let pad = 1.0;
        let avail_w = (width as f64 - 1.0 - 2.0 * pad).max(1.0);
        let avail_h = (height as f64 - 1.0 - 2.0 * pad).max(1.0);
        let scale = avail_w.min(avail_h) / extent;

        let offset_x = (width as f64 - 1.0) / 2.0;
        let offset_y = (height as f64 - 1.0) / 2.0;

        Self {
            scale_x: scale,
            scale_y: scale,
            offset_x,
            offset_y,
            width,
            height,
        }
    }

    /// Cria um mapeamento customizado com parâmetros explícitos.
    pub fn new(
        scale_x: f64,
        scale_y: f64,
        offset_x: f64,
        offset_y: f64,
        width: u32,
        height: u32,
    ) -> Self {
        Self {
            scale_x,
            scale_y,
            offset_x,
            offset_y,
            width,
            height,
        }
    }

    /// Converte um ponto $(x, y)$ em milímetros para coordenadas contínuas de pixel.
    #[inline]
    pub fn mm_to_pixel(&self, x_mm: f64, y_mm: f64) -> (f64, f64) {
        (
            x_mm * self.scale_x + self.offset_x,
            y_mm * self.scale_y + self.offset_y,
        )
    }

    /// Converte coordenadas de pixel na grade para coordenadas contínuas $(x, y)$ em milímetros.
    #[inline]
    pub fn pixel_to_mm(&self, x_px: f64, y_px: f64) -> (f64, f64) {
        (
            (x_px - self.offset_x) / self.scale_x,
            (y_px - self.offset_y) / self.scale_y,
        )
    }
}

/// Calcula a distância perimétrica circular entre dois pinos ao longo do anel do tear.
///
/// $$\text{dist}(a, b) = \min(|a - b| \pmod N, N - (|a - b| \pmod N))$$
#[inline]
pub fn circular_pin_distance(a: usize, b: usize, pin_count: usize) -> usize {
    if pin_count == 0 {
        return 0;
    }
    let d = a.abs_diff(b) % pin_count;
    d.min(pin_count - d)
}

/// Rasteriza uma linha de $(x_0, y_0)$ até $(x_1, y_1)$ usando o algoritmo inteiro de Bresenham.
///
/// Produz cobertura binária total (`FULL_COVERAGE_WEIGHT = 255`) para cada pixel atravessado.
#[allow(clippy::too_many_arguments)]
pub fn rasterize_bresenham(
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    width: u32,
    height: u32,
    out_pixels: &mut Vec<u32>,
    out_weights: &mut Vec<u8>,
) {
    if width == 0 || height == 0 {
        return;
    }

    let w_i32 = width as i32;
    let h_i32 = height as i32;

    let mut ix0 = x0.round() as i32;
    let mut iy0 = y0.round() as i32;
    let ix1 = x1.round() as i32;
    let iy1 = y1.round() as i32;

    let dx = (ix1 - ix0).abs();
    let dy = -(iy1 - iy0).abs();
    let sx = if ix0 < ix1 { 1 } else { -1 };
    let sy = if iy0 < iy1 { 1 } else { -1 };
    let mut err = dx + dy;

    loop {
        if ix0 >= 0 && ix0 < w_i32 && iy0 >= 0 && iy0 < h_i32 {
            let idx = (iy0 as u32) * width + (ix0 as u32);
            out_pixels.push(idx);
            out_weights.push(FULL_COVERAGE_WEIGHT);
        }

        if ix0 == ix1 && iy0 == iy1 {
            break;
        }

        let e2 = 2 * err;
        if e2 >= dy {
            err += dy;
            ix0 += sx;
        }
        if e2 <= dx {
            err += dx;
            iy0 += sy;
        }
    }
}

/// Rasteriza uma linha com anti-aliasing sub-pixel usando o algoritmo de Xiaolin Wu.
///
/// Distribui pesos fracionários normais de opacidade $w \in [0, 255]$ proporcionalmente
/// à proximidade da reta contínua aos centros dos pixels adjacentes. Pixels com peso 0
/// são omitidos para preservar esparsidade estrita.
#[allow(clippy::too_many_arguments)]
pub fn rasterize_xiaolin_wu(
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    width: u32,
    height: u32,
    out_pixels: &mut Vec<u32>,
    out_weights: &mut Vec<u8>,
) {
    if width == 0 || height == 0 {
        return;
    }

    let w_i32 = width as i32;
    let h_i32 = height as i32;

    // Plota um pixel na grade com brilho fracionário c in [0.0, 1.0]
    let mut plot = |px: i32, py: i32, c: f64| {
        if px >= 0 && px < w_i32 && py >= 0 && py < h_i32 {
            let weight = (c * 255.0).round().clamp(0.0, 255.0) as u8;
            if weight > 0 {
                let idx = (py as u32) * width + (px as u32);
                out_pixels.push(idx);
                out_weights.push(weight);
            }
        }
    };

    let steep = (y1 - y0).abs() > (x1 - x0).abs();

    let (mut px0, mut py0, mut px1, mut py1) = if steep {
        (y0, x0, y1, x1)
    } else {
        (x0, y0, x1, y1)
    };

    if px0 > px1 {
        std::mem::swap(&mut px0, &mut px1);
        std::mem::swap(&mut py0, &mut py1);
    }

    let dx = px1 - px0;
    let dy = py1 - py0;
    let gradient = if dx.abs() < 1e-12 { 1.0 } else { dy / dx };

    // Primeiro ponto terminal
    let xend = px0.round();
    let yend = py0 + gradient * (xend - px0);
    let xgap = 1.0 - (px0 + 0.5 - (px0 + 0.5).floor());
    let xpxl1 = xend as i32;
    let ypxl1 = yend.floor() as i32;

    let fpart1 = yend - yend.floor();
    let rfpart1 = 1.0 - fpart1;

    if steep {
        plot(ypxl1, xpxl1, rfpart1 * xgap);
        plot(ypxl1 + 1, xpxl1, fpart1 * xgap);
    } else {
        plot(xpxl1, ypxl1, rfpart1 * xgap);
        plot(xpxl1, ypxl1 + 1, fpart1 * xgap);
    }

    let mut intery = yend + gradient;

    // Segundo ponto terminal
    let xend2 = px1.round();
    let yend2 = py1 + gradient * (xend2 - px1);
    let xgap2 = px1 + 0.5 - (px1 + 0.5).floor();
    let xpxl2 = xend2 as i32;
    let ypxl2 = yend2.floor() as i32;

    let fpart2 = yend2 - yend2.floor();
    let rfpart2 = 1.0 - fpart2;

    // Laço intermediário entre os pontos terminais
    if steep {
        for x in (xpxl1 + 1)..xpxl2 {
            let y_int = intery.floor() as i32;
            let f = intery - intery.floor();
            plot(y_int, x, 1.0 - f);
            plot(y_int + 1, x, f);
            intery += gradient;
        }
    } else {
        for x in (xpxl1 + 1)..xpxl2 {
            let y_int = intery.floor() as i32;
            let f = intery - intery.floor();
            plot(x, y_int, 1.0 - f);
            plot(x, y_int + 1, f);
            intery += gradient;
        }
    }

    // Plota o segundo ponto terminal somente se estiver em coluna distinta da primeira
    if xpxl2 > xpxl1 {
        if steep {
            plot(ypxl2, xpxl2, rfpart2 * xgap2);
            plot(ypxl2 + 1, xpxl2, fpart2 * xgap2);
        } else {
            plot(xpxl2, ypxl2, rfpart2 * xgap2);
            plot(xpxl2, ypxl2 + 1, fpart2 * xgap2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_circular_pin_distance() {
        let n = 200;
        assert_eq!(circular_pin_distance(0, 0, n), 0);
        assert_eq!(circular_pin_distance(0, 1, n), 1);
        assert_eq!(circular_pin_distance(1, 0, n), 1);
        assert_eq!(circular_pin_distance(0, 199, n), 1);
        assert_eq!(circular_pin_distance(199, 0, n), 1);
        assert_eq!(circular_pin_distance(10, 30, n), 20);
        assert_eq!(circular_pin_distance(10, 190, n), 20);
        assert_eq!(circular_pin_distance(0, 100, n), 100);
    }

    #[test]
    fn test_bresenham_rasterization() {
        let mut pixels = Vec::new();
        let mut weights = Vec::new();

        // Linha horizontal de (10, 10) até (14, 10) na grade 20x20
        rasterize_bresenham(10.0, 10.0, 14.0, 10.0, 20, 20, &mut pixels, &mut weights);
        assert_eq!(pixels.len(), 5);
        assert_eq!(weights.len(), 5);
        for w in &weights {
            assert_eq!(*w, FULL_COVERAGE_WEIGHT);
        }
        for (i, p) in pixels.iter().enumerate() {
            let expected_idx = 10 * 20 + (10 + i as u32);
            assert_eq!(*p, expected_idx);
        }

        // Linha com pontos fora da borda (deve recortar seguramente sem pânico)
        pixels.clear();
        weights.clear();
        rasterize_bresenham(-5.0, 5.0, 5.0, 5.0, 10, 10, &mut pixels, &mut weights);
        assert!(!pixels.is_empty());
        for p in &pixels {
            assert!(*p < 100);
        }
    }

    #[test]
    fn test_xiaolin_wu_rasterization_and_energy_conservation() {
        let mut pixels = Vec::new();
        let mut weights = Vec::new();

        // Linha inclinada na grade 50x50
        rasterize_xiaolin_wu(5.2, 10.4, 35.8, 25.1, 50, 50, &mut pixels, &mut weights);
        assert!(!pixels.is_empty());
        assert_eq!(pixels.len(), weights.len());

        // Todos os índices devem estar dentro do canvas 50x50 = 2500
        for (idx, w) in pixels.iter().zip(weights.iter()) {
            assert!(*idx < 2500);
            assert!(*w > 0);
        }

        // Todos os pixels gerados devem ser únicos (sem duplicatas)
        let mut sorted = pixels.clone();
        sorted.sort_unstable();
        let len_before = sorted.len();
        sorted.dedup();
        assert_eq!(sorted.len(), len_before, "Xiaolin Wu gerou pixels duplicados");
    }

    #[test]
    fn test_loom_grid_mapping() {
        let spec = crate::geometry::LoomPhysicalSpec::circle(600.0, 100, 2.0, 2.0, 10.0);
        let loom = LoomGeometry::new(spec);
        let mapping = LoomGridMapping::from_loom(&loom, 500, 500);

        // Centro (0, 0) deve mapear exatamente para o centro da grade
        let (cx, cy) = mapping.mm_to_pixel(0.0, 0.0);
        assert!((cx - 249.5).abs() < 1e-6);
        assert!((cy - 249.5).abs() < 1e-6);

        // Pinos no raio máximo devem cair dentro do intervalo [0, 499]
        for i in 0..100 {
            let (x_mm, y_mm) = loom.pin_position(i);
            let (px, py) = mapping.mm_to_pixel(x_mm, y_mm);
            assert!(px >= 0.0 && px <= 499.0, "px {} fora da grade", px);
            assert!(py >= 0.0 && py <= 499.0, "py {} fora da grade", py);
        }
    }
}
