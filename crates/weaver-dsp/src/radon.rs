//! Transformada de Radon, Sinograma $R(\rho, \theta)$ e Filtro em Rampa (Ram-Lak).
//!
//! Implementa a projeção tomográfica contínua da imagem ao longo de retas parametrizadas
//! por $(\rho, \theta)$ e o filtro passa-alta em rampa no domínio discreto/espacial para
//! pré-condicionamento de retroprojeção filtrada (FBP) e diagnóstico visual.

use crate::image::{GrayImage, Rgba8Image};
use std::f32::consts::PI;

/// Opções para o cálculo do Sinograma via Transformada de Radon.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RadonOptions {
    /// Quantidade de projeções angulares $\theta \in [0, \pi)$ (colunas do sinograma). Padrão: 180.
    pub num_angles: u32,
    /// Quantidade de bins de distância radial $\rho \in [-R, R]$ (linhas do sinograma). Padrão: 180.
    pub num_rhos: u32,
    /// Inverte a luminância para simular densidade de absorção óptica de fios (1.0 - luma). Padrão: true.
    pub invert_for_absorption: bool,
}

impl Default for RadonOptions {
    fn default() -> Self {
        Self {
            num_angles: 180,
            num_rhos: 180,
            invert_for_absorption: true,
        }
    }
}

/// Representação bidimensional contígua do Sinograma no espaço de Radon.
///
/// Dimensões: `num_angles` colunas (eixo $\theta \in [0, \pi)$) por `num_rhos` linhas (eixo $\rho \in [-R, R]$).
#[derive(Debug, Clone, PartialEq)]
pub struct Sinogram {
    pub num_angles: u32,
    pub num_rhos: u32,
    pub max_radius: f32,
    pub data: Vec<f32>,
}

impl Sinogram {
    /// Cria um novo sinograma com dados contíguos especificados.
    pub fn new(num_angles: u32, num_rhos: u32, max_radius: f32, data: Vec<f32>) -> Self {
        assert_eq!(
            data.len(),
            (num_angles * num_rhos) as usize,
            "Tamanho do vetor não corresponde a num_angles * num_rhos"
        );
        Self {
            num_angles,
            num_rhos,
            max_radius,
            data,
        }
    }

    /// Cria um sinograma preenchido com zeros.
    pub fn zeros(num_angles: u32, num_rhos: u32, max_radius: f32) -> Self {
        let total = (num_angles * num_rhos) as usize;
        Self {
            num_angles,
            num_rhos,
            max_radius,
            data: vec![0.0f32; total],
        }
    }

    /// Retorna o valor da integral de linha no bin radial $r$ e ângulo $a$.
    #[inline]
    pub fn get(&self, r: u32, a: u32) -> f32 {
        let idx = (r * self.num_angles + a) as usize;
        self.data[idx]
    }

    /// Sobrescreve o valor da integral de linha no bin radial $r$ e ângulo $a$.
    #[inline]
    pub fn set(&mut self, r: u32, a: u32, val: f32) {
        let idx = (r * self.num_angles + a) as usize;
        self.data[idx] = val;
    }

    /// Renderiza o Sinograma em formato RGBA (`Uint8`) normalizado com brilho ciano/azul para inspeção na UI.
    pub fn to_preview_rgba(&self) -> Rgba8Image {
        let total = self.data.len();
        let mut rgba = Vec::with_capacity(total * 4);

        let min_val = self.data.iter().copied().fold(f32::INFINITY, f32::min);
        let max_val = self.data.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        let span = (max_val - min_val).max(1e-5);

        for &val in &self.data {
            let norm = ((val - min_val) / span).clamp(0.0, 1.0);
            let intensity = (norm * 255.0).round();

            let r = (intensity * 0.30) as u8;
            let g = (intensity * 0.70) as u8;
            let b = intensity as u8;

            rgba.push(r);
            rgba.push(g);
            rgba.push(b);
            rgba.push(255);
        }

        Rgba8Image::new(self.num_angles, self.num_rhos, 4, rgba)
    }
}

/// Calcula a Transformada de Radon de uma imagem em escala de cinza.
///
/// Integra valores de pixel ao longo de feixes de retas $x \cos\theta + y \sin\theta = \rho$
/// para $\theta \in [0, \pi)$ e $\rho \in [-R, R]$ com interpolação contínua.
pub fn compute_radon_transform(img: &GrayImage, options: &RadonOptions) -> Sinogram {
    let w = img.width;
    let h = img.height;
    let num_angles = options.num_angles.max(2);
    let num_rhos = options.num_rhos.max(2);

    let cx = (w as f32 - 1.0) * 0.50;
    let cy = (h as f32 - 1.0) * 0.50;
    let max_radius = ((w * w + h * h) as f32).sqrt() * 0.50;

    let mut sinogram = Sinogram::zeros(num_angles, num_rhos, max_radius);
    if w == 0 || h == 0 {
        return sinogram;
    }

    let d_theta = PI / (num_angles as f32);
    let half_rhos = (num_rhos - 1) as f32 * 0.50;

    // Amostragem ao longo da reta com passo sub-pixel 0.5 px
    let dt = 0.50f32;
    let steps = ((2.0 * max_radius) / dt).ceil() as i32;

    for a in 0..num_angles {
        let theta = (a as f32) * d_theta;
        let cos_t = theta.cos();
        let sin_t = theta.sin();

        for r in 0..num_rhos {
            let rho = if half_rhos > 0.0 {
                ((r as f32 - half_rhos) / half_rhos) * max_radius
            } else {
                0.0
            };

            // Ponto central da reta para a distância radial rho
            let ox = cx + rho * cos_t;
            let oy = cy + rho * sin_t;

            // Vetor diretor unitário ao longo da reta (-sin_t, cos_t)
            let dx = -sin_t;
            let dy = cos_t;

            let mut sum = 0.0f32;
            let mut sample_count = 0u32;

            for step in -steps / 2..=steps / 2 {
                let t = (step as f32) * dt;
                let px = ox + t * dx;
                let py = oy + t * dy;

                if px >= 0.0 && px <= (w - 1) as f32 && py >= 0.0 && py <= (h - 1) as f32 {
                    let mut sample = [0.0f32; 1];
                    img.sample_bilinear(px, py, &mut sample);
                    let val = if options.invert_for_absorption {
                        (1.0 - sample[0]).max(0.0)
                    } else {
                        sample[0].max(0.0)
                    };
                    sum += val * dt;
                    sample_count += 1;
                }
            }

            if sample_count > 0 {
                sinogram.set(r, a, sum);
            }
        }
    }

    sinogram
}

/// Aplica o Filtro Passa-Alta em Rampa (*Ram-Lak Filter*) no domínio espacial/discreto.
///
/// O núcleo analítico discreto de Ram-Lak é dado por:
/// $$h[0] = \frac{1}{4 (\Delta \rho)^2}$$
/// $$h[n] = -\frac{1}{\pi^2 n^2 (\Delta \rho)^2} \quad \text{para } n \text{ ímpar}$$
/// $$h[n] = 0 \quad \text{para } n \text{ par}, n \ne 0$$
///
/// Este filtro atenua a singularidade geométrica $1/r$ no centro da retroprojeção e
/// pré-condiciona as projeções para o algoritmo de retroprojeção filtrada (FBP).
pub fn apply_ramp_filter(sinogram: &Sinogram, kernel_radius: Option<usize>) -> Sinogram {
    let num_angles = sinogram.num_angles;
    let num_rhos = sinogram.num_rhos;
    let max_radius = sinogram.max_radius;

    let k_radius = kernel_radius.unwrap_or(21).min(num_rhos as usize / 2);
    let mut h = vec![0.0f32; 2 * k_radius + 1];

    // Construção do núcleo discreto de Ram-Lak
    h[k_radius] = 0.25; // h[0]
    for n in 1..=k_radius {
        if n % 2 != 0 {
            let val = -1.0 / (PI * PI * (n as f32 * n as f32));
            h[k_radius + n] = val;
            h[k_radius - n] = val;
        } else {
            h[k_radius + n] = 0.0;
            h[k_radius - n] = 0.0;
        }
    }

    let mut filtered = Sinogram::zeros(num_angles, num_rhos, max_radius);

    // Convolve cada coluna de projeção 1D ao longo dos bins radiais rho
    for a in 0..num_angles {
        for r in 0..num_rhos {
            let mut sum = 0.0f32;
            for (k_idx, &kw) in h.iter().enumerate() {
                let offset = k_idx as i32 - k_radius as i32;
                let sample_r = r as i32 + offset;
                if sample_r >= 0 && sample_r < num_rhos as i32 {
                    sum += sinogram.get(sample_r as u32, a) * kw;
                }
            }
            filtered.set(r, a, sum);
        }
    }

    filtered
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sinogram_creation_and_access() {
        let mut sino = Sinogram::zeros(10, 20, 50.0);
        assert_eq!(sino.get(5, 3), 0.0);
        sino.set(5, 3, 42.5);
        assert_eq!(sino.get(5, 3), 42.5);
    }

    #[test]
    fn test_radon_transform_symmetric_circle() {
        let w = 24u32;
        let h = 24u32;
        let mut img = GrayImage::fill(w, h, 1, 1.0); // Fundo branco (absorção 0)

        // Círculo escuro no centro geométrico (absorção alta)
        let cx = (w as f32 - 1.0) * 0.50;
        let cy = (h as f32 - 1.0) * 0.50;
        let r = 4.0f32;
        for y in 0..h {
            for x in 0..w {
                let dx = x as f32 - cx;
                let dy = y as f32 - cy;
                if dx * dx + dy * dy <= r * r {
                    img.set_pixel(x, y, &[0.0]); // Preto (absorção 1.0)
                }
            }
        }

        let opts = RadonOptions {
            num_angles: 16,
            num_rhos: 20,
            invert_for_absorption: true,
        };

        let sino = compute_radon_transform(&img, &opts);

        // Como o círculo está centrado no meio, o pico do sinograma deve ocorrer em rho central (r ~ 9 ou 10)
        // e ser praticamente idêntico em todos os ângulos theta (simetria circular).
        let center_r = sino.num_rhos / 2;
        let val_angle_0 = sino.get(center_r, 0);
        let val_angle_4 = sino.get(center_r, 4);
        let val_angle_8 = sino.get(center_r, 8);

        assert!(val_angle_0 > 2.0, "Pico central deve ser detectado");
        assert!(
            (val_angle_0 - val_angle_4).abs() < 1.0,
            "Simetria circular violada: {:.3} vs {:.3}",
            val_angle_0,
            val_angle_4
        );
        assert!(
            (val_angle_0 - val_angle_8).abs() < 1.0,
            "Simetria circular violada: {:.3} vs {:.3}",
            val_angle_0,
            val_angle_8
        );
    }

    #[test]
    fn test_ram_lak_ramp_filter_kernel_and_frequency_response() {
        let num_angles = 8;
        let num_rhos = 32;
        let mut sino = Sinogram::zeros(num_angles, num_rhos, 20.0);

        // Degrau unitário constante em todas as posições
        for r in 0..num_rhos {
            for a in 0..num_angles {
                sino.set(r, a, 10.0);
            }
        }

        let filtered = apply_ramp_filter(&sino, Some(5));

        // Um sinal DC puro convoluído com o filtro de rampa (passa-alta de média zero) deve ter resposta próxima de zero
        let center_val = filtered.get(16, 0);
        assert!(
            center_val.abs() < 2.5,
            "Filtro em rampa deve atenuar componentes puramente DC: {:.4}",
            center_val
        );
    }

    #[test]
    fn test_sinogram_to_preview_rgba() {
        let mut sino = Sinogram::zeros(10, 10, 15.0);
        sino.set(5, 5, 100.0);

        let preview = sino.to_preview_rgba();
        assert_eq!(preview.width, 10);
        assert_eq!(preview.height, 10);
        assert_eq!(preview.channels, 4);

        // Ponto de pico em (5, 5) deve ter intensidade máxima
        let idx = (5 * 10 + 5) * 4;
        assert_eq!(preview.data[idx + 2], 255); // Canal azul
        assert_eq!(preview.data[idx + 3], 255); // Alpha
    }
}
