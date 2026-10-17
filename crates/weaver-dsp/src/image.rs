//! Representação de buffers de imagem e rotinas de amostragem sub-pixel.
//!
//! Fornece tipos unificados e desacoplados para processamento de sinais de imagem,
//! conversão entre espaços de cor do `weaver-domain` e amostragem contínua bilinear e bicúbica.

use weaver_domain::{
    srgb_to_linear_channel, LabColor, LinearRgbColor, LUMA_REC709_B, LUMA_REC709_G, LUMA_REC709_R,
};

/// Buffer de imagem multidimensional contíguo e puro em memória.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageBuffer<T> {
    pub width: u32,
    pub height: u32,
    pub channels: usize,
    pub data: Vec<T>,
}

pub type GrayImage = ImageBuffer<f32>;
pub type Rgba8Image = ImageBuffer<u8>;
pub type RgbFloatImage = ImageBuffer<f32>;

impl<T: Clone + Default> ImageBuffer<T> {
    /// Cria um novo buffer alocado com dimensões e contagem de canais especificadas.
    pub fn new(width: u32, height: u32, channels: usize, data: Vec<T>) -> Self {
        assert_eq!(
            data.len(),
            width as usize * height as usize * channels,
            "Tamanho do vetor de dados não corresponde às dimensões da imagem"
        );
        Self {
            width,
            height,
            channels,
            data,
        }
    }

    /// Cria um novo buffer preenchido com zeros/valores padrão.
    pub fn zeros(width: u32, height: u32, channels: usize) -> Self {
        let total = width as usize * height as usize * channels;
        Self {
            width,
            height,
            channels,
            data: vec![T::default(); total],
        }
    }

    /// Cria um buffer preenchido com um valor constante em todos os elementos.
    pub fn fill(width: u32, height: u32, channels: usize, val: T) -> Self {
        let total = width as usize * height as usize * channels;
        Self {
            width,
            height,
            channels,
            data: vec![val; total],
        }
    }

    /// Retorna uma fatia imutável do pixel nas coordenadas inteiras $(x, y)$.
    #[inline]
    pub fn get_pixel(&self, x: u32, y: u32) -> &[T] {
        let idx = (y as usize * self.width as usize + x as usize) * self.channels;
        &self.data[idx..idx + self.channels]
    }

    /// Retorna uma fatia mutável do pixel nas coordenadas inteiras $(x, y)$.
    #[inline]
    pub fn get_pixel_mut(&mut self, x: u32, y: u32) -> &mut [T] {
        let idx = (y as usize * self.width as usize + x as usize) * self.channels;
        &mut self.data[idx..idx + self.channels]
    }

    /// Sobrescreve o pixel nas coordenadas $(x, y)$.
    #[inline]
    pub fn set_pixel(&mut self, x: u32, y: u32, pixel: &[T]) {
        assert_eq!(pixel.len(), self.channels);
        let idx = (y as usize * self.width as usize + x as usize) * self.channels;
        self.data[idx..idx + self.channels].clone_from_slice(pixel);
    }
}

impl ImageBuffer<f32> {
    /// Amostragem contínua bilinear com clamping de borda.
    pub fn sample_bilinear(&self, u: f32, v: f32, out: &mut [f32]) {
        assert_eq!(out.len(), self.channels);
        if self.width == 0 || self.height == 0 {
            return;
        }

        let u_clamped = u.clamp(0.0, (self.width - 1) as f32);
        let v_clamped = v.clamp(0.0, (self.height - 1) as f32);

        let x0 = u_clamped.floor() as u32;
        let y0 = v_clamped.floor() as u32;
        let x1 = (x0 + 1).min(self.width - 1);
        let y1 = (y0 + 1).min(self.height - 1);

        let fx = u_clamped - x0 as f32;
        let fy = v_clamped - y0 as f32;

        let w00 = (1.0 - fx) * (1.0 - fy);
        let w10 = fx * (1.0 - fy);
        let w01 = (1.0 - fx) * fy;
        let w11 = fx * fy;

        let p00 = self.get_pixel(x0, y0);
        let p10 = self.get_pixel(x1, y0);
        let p01 = self.get_pixel(x0, y1);
        let p11 = self.get_pixel(x1, y1);

        for c in 0..self.channels {
            out[c] = w00 * p00[c] + w10 * p10[c] + w01 * p01[c] + w11 * p11[c];
        }
    }

    /// Amostragem contínua bicúbica (Catmull-Rom spline, $a = -0.5$) em vizinhança $4 \times 4$.
    pub fn sample_bicubic(&self, u: f32, v: f32, out: &mut [f32]) {
        assert_eq!(out.len(), self.channels);
        if self.width == 0 || self.height == 0 {
            return;
        }

        let u_clamped = u.clamp(0.0, (self.width - 1) as f32);
        let v_clamped = v.clamp(0.0, (self.height - 1) as f32);

        let x_int = u_clamped.floor() as i32;
        let y_int = v_clamped.floor() as i32;

        let fx = u_clamped - x_int as f32;
        let fy = v_clamped - y_int as f32;

        let mut wx = [0.0f32; 4];
        let mut wy = [0.0f32; 4];
        for i in 0..4 {
            let dx = fx - (i as f32 - 1.0);
            wx[i] = cubic_kernel(dx);
            let dy = fy - (i as f32 - 1.0);
            wy[i] = cubic_kernel(dy);
        }

        // Normalização de pesos
        let sum_wx: f32 = wx.iter().sum();
        let sum_wy: f32 = wy.iter().sum();
        if sum_wx.abs() > 1e-6 {
            for w in &mut wx {
                *w /= sum_wx;
            }
        }
        if sum_wy.abs() > 1e-6 {
            for w in &mut wy {
                *w /= sum_wy;
            }
        }

        for c in 0..self.channels {
            out[c] = 0.0;
        }

        for j in 0..4 {
            let py = (y_int + j as i32 - 1).clamp(0, self.height as i32 - 1) as u32;
            let weight_y = wy[j];

            for i in 0..4 {
                let px = (x_int + i as i32 - 1).clamp(0, self.width as i32 - 1) as u32;
                let weight = weight_y * wx[i];
                let p = self.get_pixel(px, py);

                for c in 0..self.channels {
                    out[c] += weight * p[c];
                }
            }
        }

        // Clamping para evitar overshoot fora do range típico [0.0, 1.0]
        for c in 0..self.channels {
            out[c] = out[c].clamp(0.0, 1.0);
        }
    }
}

#[inline]
fn cubic_kernel(t: f32) -> f32 {
    let at = t.abs();
    let a = -0.5f32;
    if at <= 1.0 {
        (a + 2.0) * at * at * at - (a + 3.0) * at * at + 1.0
    } else if at < 2.0 {
        a * at * at * at - 5.0 * a * at * at + 8.0 * a * at - 4.0 * a
    } else {
        0.0
    }
}

impl GrayImage {
    /// Converte o buffer monocromático em vetor de `LinearRgbColor`.
    pub fn to_linear_rgb_vec(&self) -> Vec<LinearRgbColor> {
        self.data
            .iter()
            .map(|&val| {
                let v = val.clamp(0.0, 1.0);
                LinearRgbColor::new(v, v, v)
            })
            .collect()
    }

    /// Cria um `GrayImage` a partir de uma fatia de `LinearRgbColor` usando luminância fotométrica linear.
    pub fn from_linear_rgb_slice(colors: &[LinearRgbColor], width: u32, height: u32) -> Self {
        assert_eq!(colors.len(), (width * height) as usize);
        let data = colors.iter().map(|c| c.luminance()).collect();
        Self {
            width,
            height,
            channels: 1,
            data,
        }
    }
}

impl Rgba8Image {
    /// Converte um buffer de bytes RGBA para `GrayImage` em luminância linear fotométrica.
    pub fn to_gray(&self) -> GrayImage {
        let count = (self.width * self.height) as usize;
        let mut gray_data = Vec::with_capacity(count);

        for chunk in self.data.chunks_exact(4) {
            let r_lin = srgb_to_linear_channel(chunk[0] as f32 / 255.0);
            let g_lin = srgb_to_linear_channel(chunk[1] as f32 / 255.0);
            let b_lin = srgb_to_linear_channel(chunk[2] as f32 / 255.0);
            let y = LUMA_REC709_R * r_lin + LUMA_REC709_G * g_lin + LUMA_REC709_B * b_lin;
            gray_data.push(y);
        }

        GrayImage {
            width: self.width,
            height: self.height,
            channels: 1,
            data: gray_data,
        }
    }

    /// Converte um buffer de bytes RGBA para `GrayImage` em luminância perceptual sRGB $[0.0, 1.0]$.
    ///
    /// Preserva a curva perceptual sRGB para operações radiométricas (CLAHE, contraste,
    /// unsharp mask, fusão de bordas), evitando dupla conversão gama antes da linearização final.
    pub fn to_perceptual_luma_gray(&self) -> GrayImage {
        let count = (self.width * self.height) as usize;
        let mut gray_data = Vec::with_capacity(count);

        for chunk in self.data.chunks_exact(4) {
            let r = chunk[0] as f32 / 255.0;
            let g = chunk[1] as f32 / 255.0;
            let b = chunk[2] as f32 / 255.0;
            let y = LUMA_REC709_R * r + LUMA_REC709_G * g + LUMA_REC709_B * b;
            gray_data.push(y.clamp(0.0, 1.0));
        }

        GrayImage {
            width: self.width,
            height: self.height,
            channels: 1,
            data: gray_data,
        }
    }

    /// Converte o buffer de bytes RGBA para um vetor de `LinearRgbColor`.
    pub fn to_linear_rgb_vec(&self) -> Vec<LinearRgbColor> {
        let count = (self.width * self.height) as usize;
        let mut result = Vec::with_capacity(count);

        for chunk in self.data.chunks_exact(4) {
            let r_lin = srgb_to_linear_channel(chunk[0] as f32 / 255.0);
            let g_lin = srgb_to_linear_channel(chunk[1] as f32 / 255.0);
            let b_lin = srgb_to_linear_channel(chunk[2] as f32 / 255.0);
            result.push(LinearRgbColor::new(r_lin, g_lin, b_lin));
        }

        result
    }

    /// Converte o buffer de bytes RGBA para um vetor de `LabColor`.
    pub fn to_lab_vec(&self) -> Vec<LabColor> {
        self.to_linear_rgb_vec()
            .iter()
            .map(|c| c.to_lab())
            .collect()
    }

    /// Cria um `Rgba8Image` a partir de uma fatia de `LinearRgbColor` com Alpha = 255.
    pub fn from_linear_rgb_slice(colors: &[LinearRgbColor], width: u32, height: u32) -> Self {
        assert_eq!(colors.len(), (width * height) as usize);
        let mut data = Vec::with_capacity(colors.len() * 4);

        for c in colors {
            let srgb = c.to_srgb();
            let [r, g, b] = srgb.to_u8_array();
            data.push(r);
            data.push(g);
            data.push(b);
            data.push(255);
        }

        Self {
            width,
            height,
            channels: 4,
            data,
        }
    }

    /// Cria um `Rgba8Image` a partir de uma fatia de `LabColor` com Alpha = 255.
    pub fn from_lab_slice(colors: &[LabColor], width: u32, height: u32) -> Self {
        assert_eq!(colors.len(), (width * height) as usize);
        let mut data = Vec::with_capacity(colors.len() * 4);

        for lab in colors {
            let srgb = lab.to_srgb();
            let [r, g, b] = srgb.to_u8_array();
            data.push(r);
            data.push(g);
            data.push(b);
            data.push(255);
        }

        Self {
            width,
            height,
            channels: 4,
            data,
        }
    }
}
