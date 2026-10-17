//! Operadores Morfológicos Matemáticos em Escala de Cinza e Canais.
//!
//! Implementa elementos estruturantes configuráveis (disco, quadrado e cruz) e operações
//! fundamentais e derivadas da morfologia matemática:
//! - Erosão (`erode`)
//! - Dilatação (`dilate`)
//! - Abertura (`opening`): elimina ruídos claros isolados
//! - Fechamento (`closing`): fecha pequenos buracos escuros, consolidando armações e pupilas
//! - Gradiente Morfológico (`morph_gradient`): destaca contornos estruturais ($\text{Dilatação} - \text{Erosão}$)
//! - Top-Hat Branco e Preto: isola realces e sombras locais

use crate::image::GrayImage;

/// Elemento estruturante com formato geométrico e raio configurável.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StructuringElement {
    pub radius: u32,
    pub offsets: Vec<(i32, i32)>,
}

impl StructuringElement {
    /// Cria um elemento estruturante circular/disco com raio $r$ ($dx^2 + dy^2 \le r^2$).
    pub fn disc(radius: u32) -> Self {
        let r = radius as i32;
        let r_sq = r * r;
        let mut offsets = Vec::new();

        for dy in -r..=r {
            for dx in -r..=r {
                if dx * dx + dy * dy <= r_sq {
                    offsets.push((dx, dy));
                }
            }
        }

        Self { radius, offsets }
    }

    /// Cria um elemento estruturante quadrado de lado $2r + 1$ ($|dx| \le r, |dy| \le r$).
    pub fn square(radius: u32) -> Self {
        let r = radius as i32;
        let mut offsets = Vec::new();

        for dy in -r..=r {
            for dx in -r..=r {
                offsets.push((dx, dy));
            }
        }

        Self { radius, offsets }
    }

    /// Cria um elemento estruturante em cruz com raio $r$ ao longo dos eixos X e Y.
    pub fn cross(radius: u32) -> Self {
        let r = radius as i32;
        let mut offsets = Vec::new();

        for d in -r..=r {
            offsets.push((d, 0));
            if d != 0 {
                offsets.push((0, d));
            }
        }

        Self { radius, offsets }
    }

    /// Cria um elemento estruturante linear horizontal com raio $r$.
    pub fn horizontal_line(radius: u32) -> Self {
        let r = radius as i32;
        let mut offsets = Vec::new();
        for dx in -r..=r {
            offsets.push((dx, 0));
        }
        Self { radius, offsets }
    }

    /// Cria um elemento estruturante linear vertical com raio $r$.
    pub fn vertical_line(radius: u32) -> Self {
        let r = radius as i32;
        let mut offsets = Vec::new();
        for dy in -r..=r {
            offsets.push((0, dy));
        }
        Self { radius, offsets }
    }
}

/// Aplica o operador de Erosão em escala de cinza: $(f \ominus B)(x, y) = \min_{(dx, dy) \in B} f(x + dx, y + dy)$.
pub fn erode(input: &[f32], width: u32, height: u32, se: &StructuringElement) -> Vec<f32> {
    assert_eq!(input.len(), (width * height) as usize);
    let mut output = vec![0.0f32; input.len()];

    let w = width as i32;
    let h = height as i32;

    for y in 0..h {
        let y_offset = y as usize * width as usize;
        for x in 0..w {
            let mut min_val = f32::INFINITY;

            for &(dx, dy) in &se.offsets {
                let px = (x + dx).clamp(0, w - 1) as usize;
                let py = (y + dy).clamp(0, h - 1) as usize;
                let val = input[py * width as usize + px];
                if val < min_val {
                    min_val = val;
                }
            }

            output[y_offset + x as usize] = min_val;
        }
    }

    output
}

/// Aplica o operador de Dilatação em escala de cinza: $(f \oplus B)(x, y) = \max_{(dx, dy) \in B} f(x + dx, y + dy)$.
pub fn dilate(input: &[f32], width: u32, height: u32, se: &StructuringElement) -> Vec<f32> {
    assert_eq!(input.len(), (width * height) as usize);
    let mut output = vec![0.0f32; input.len()];

    let w = width as i32;
    let h = height as i32;

    for y in 0..h {
        let y_offset = y as usize * width as usize;
        for x in 0..w {
            let mut max_val = f32::NEG_INFINITY;

            for &(dx, dy) in &se.offsets {
                let px = (x + dx).clamp(0, w - 1) as usize;
                let py = (y + dy).clamp(0, h - 1) as usize;
                let val = input[py * width as usize + px];
                if val > max_val {
                    max_val = val;
                }
            }

            output[y_offset + x as usize] = max_val;
        }
    }

    output
}

/// Operador derivado de Abertura: Erosão seguida de Dilatação.
///
/// $f \circ B = (f \ominus B) \oplus B$. Suprime ruídos claros isolados e afina conexões delgadas.
pub fn opening(input: &[f32], width: u32, height: u32, se: &StructuringElement) -> Vec<f32> {
    let eroded = erode(input, width, height, se);
    dilate(&eroded, width, height, se)
}

/// Operador derivado de Fechamento: Dilatação seguida de Erosão.
///
/// $f \bullet B = (f \oplus B) \ominus B$. Preenche pequenos buracos escuros, conectando pupilas e armações de óculos.
pub fn closing(input: &[f32], width: u32, height: u32, se: &StructuringElement) -> Vec<f32> {
    let dilated = dilate(input, width, height, se);
    erode(&dilated, width, height, se)
}

/// Operador derivado de Gradiente Morfológico: $\text{Dilatação} - \text{Erosão}$.
///
/// Realça transições e contornos morfológicos de alta frequência.
pub fn morph_gradient(input: &[f32], width: u32, height: u32, se: &StructuringElement) -> Vec<f32> {
    let dilated = dilate(input, width, height, se);
    let eroded = erode(input, width, height, se);

    dilated
        .iter()
        .zip(eroded.iter())
        .map(|(&d, &e)| (d - e).max(0.0))
        .collect()
}

/// Top-Hat Branco (Realces locais): $f - (f \circ B)$.
pub fn white_tophat(input: &[f32], width: u32, height: u32, se: &StructuringElement) -> Vec<f32> {
    let opened = opening(input, width, height, se);
    input
        .iter()
        .zip(opened.iter())
        .map(|(&x, &op)| (x - op).max(0.0))
        .collect()
}

/// Black-Hat (Sombras locais): $(f \bullet B) - f$.
pub fn black_tophat(input: &[f32], width: u32, height: u32, se: &StructuringElement) -> Vec<f32> {
    let closed = closing(input, width, height, se);
    closed
        .iter()
        .zip(input.iter())
        .map(|(&cl, &x)| (cl - x).max(0.0))
        .collect()
}

/// Aplica Abertura in-place em um `GrayImage`.
pub fn opening_gray(image: &mut GrayImage, se: &StructuringElement) {
    image.data = opening(&image.data, image.width, image.height, se);
}

/// Aplica Fechamento in-place em um `GrayImage`.
pub fn closing_gray(image: &mut GrayImage, se: &StructuringElement) {
    image.data = closing(&image.data, image.width, image.height, se);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_structuring_element_shapes() {
        let disc0 = StructuringElement::disc(0);
        assert_eq!(disc0.offsets, vec![(0, 0)]);

        let disc1 = StructuringElement::disc(1);
        // Raio 1: (0,0), (+-1, 0), (0, +-1) -> 5 pontos (cruz/disco de raio 1)
        assert_eq!(disc1.offsets.len(), 5);

        let square1 = StructuringElement::square(1);
        // Quadrado 3x3: 9 pontos
        assert_eq!(square1.offsets.len(), 9);

        let h_line = StructuringElement::horizontal_line(2);
        assert_eq!(h_line.offsets.len(), 5); // -2, -1, 0, 1, 2
    }

    #[test]
    fn test_tophat_operators() {
        let w = 7u32;
        let h = 7u32;
        let mut img = vec![0.5f32; (w * h) as usize];
        // Adiciona um pico claro de 1 pixel em (3, 3)
        img[3 * w as usize + 3] = 1.0;
        // Adiciona um buraco escuro de 1 pixel em (1, 1)
        img[1 * w as usize + 1] = 0.0;

        let se = StructuringElement::disc(1);

        let w_top = white_tophat(&img, w, h, &se);
        let b_top = black_tophat(&img, w, h, &se);

        // O White Top-Hat isola exatamente o pico claro
        assert!((w_top[3 * w as usize + 3] - 0.5).abs() < 1e-4);
        assert!(w_top[1 * w as usize + 1] < 1e-4);

        // O Black Top-Hat isola exatamente o buraco escuro
        assert!((b_top[1 * w as usize + 1] - 0.5).abs() < 1e-4);
        assert!(b_top[3 * w as usize + 3] < 1e-4);
    }
}
