//! Métricas de erro perceptual e distâncias cromáticas.
//!
//! Fornece formulações precisas para avaliação de fidelidade de cor:
//! - `delta_e_76`: Distância euclidiana clássica em CIELAB.
//! - `delta_e_2000`: Formulação padrão-ouro internacional CIE CIEDE2000 (ISO/CIE 11664-6:2014).
//! - `redmean_distance`: Aproximação perceptualmente ponderada rápida em Linear RGB.
//! - `luminance_weighted_distance`: Distância euclidiana em Linear RGB ponderada pelos coeficientes Rec. 709.

use super::space::{LabColor, LinearRgbColor};
use std::f32::consts::PI;

const RAD_PER_DEG: f32 = PI / 180.0;
const DEG_PER_RAD: f32 = 180.0 / PI;

/// Calcula a distância de cor CIELAB clássica ΔE*76 (Euclidiana simples em L*a*b*).
#[inline]
pub fn delta_e_76(c1: LabColor, c2: LabColor) -> f32 {
    let dl = c1.l - c2.l;
    let da = c1.a - c2.a;
    let db = c1.b - c2.b;
    (dl * dl + da * da + db * db).sqrt()
}

/// Calcula a diferença de cor CIEDE2000 (ISO/CIE 11664-6:2014) entre dois pontos CIELAB.
///
/// Implementação estrita e canônica validada pelo conjunto de testes de Sharma et al. (2005).
pub fn delta_e_2000(c1: LabColor, c2: LabColor) -> f32 {
    delta_e_2000_parametric(c1, c2, 1.0, 1.0, 1.0)
}

/// Versão paramétrica de CIEDE2000 com fatores de escala `(k_l, k_c, k_h)`.
pub fn delta_e_2000_parametric(c1: LabColor, c2: LabColor, k_l: f32, k_c: f32, k_h: f32) -> f32 {
    let l_bar = (c1.l + c2.l) * 0.5;

    let c1_star = (c1.a * c1.a + c1.b * c1.b).sqrt();
    let c2_star = (c2.a * c2.a + c2.b * c2.b).sqrt();
    let c_bar = (c1_star + c2_star) * 0.5;

    let c_bar7 = c_bar.powi(7);
    let g = 0.5 * (1.0 - (c_bar7 / (c_bar7 + 6103515625.0)).sqrt()); // 25^7 = 6103515625

    let a1_prime = (1.0 + g) * c1.a;
    let a2_prime = (1.0 + g) * c2.a;

    let c1_prime = (a1_prime * a1_prime + c1.b * c1.b).sqrt();
    let c2_prime = (a2_prime * a2_prime + c2.b * c2.b).sqrt();
    let c_bar_prime = (c1_prime + c2_prime) * 0.5;

    let h1_prime = compute_hue_angle_deg(c1.b, a1_prime);
    let h2_prime = compute_hue_angle_deg(c2.b, a2_prime);

    let (delta_h_prime, h_bar_prime) = if c1_prime * c2_prime == 0.0 {
        (0.0, h1_prime + h2_prime)
    } else {
        let diff = h2_prime - h1_prime;
        let delta_h = if diff.abs() <= 180.0 {
            diff
        } else if diff > 180.0 {
            diff - 360.0
        } else {
            diff + 360.0
        };

        let sum = h1_prime + h2_prime;
        let h_bar = if diff.abs() <= 180.0 {
            sum * 0.5
        } else if sum < 360.0 {
            (sum + 360.0) * 0.5
        } else {
            (sum - 360.0) * 0.5
        };

        (delta_h, h_bar)
    };

    let delta_l_prime = c2.l - c1.l;
    let delta_c_prime = c2_prime - c1_prime;
    let delta_big_h_prime = 2.0 * (c1_prime * c2_prime).sqrt() * ((delta_h_prime * 0.5) * RAD_PER_DEG).sin();

    // Termo de rotação e fatores de ponderação T
    let t = 1.0
        - 0.17 * ((h_bar_prime - 30.0) * RAD_PER_DEG).cos()
        + 0.24 * ((2.0 * h_bar_prime) * RAD_PER_DEG).cos()
        + 0.32 * ((3.0 * h_bar_prime + 6.0) * RAD_PER_DEG).cos()
        - 0.20 * ((4.0 * h_bar_prime - 63.0) * RAD_PER_DEG).cos();

    let delta_theta = 30.0 * (-(((h_bar_prime - 275.0) / 25.0).powi(2))).exp();

    let c_bar_prime7 = c_bar_prime.powi(7);
    let r_c = 2.0 * (c_bar_prime7 / (c_bar_prime7 + 6103515625.0)).sqrt();

    let l_bar_minus_50_sq = (l_bar - 50.0).powi(2);
    let s_l = 1.0 + (0.015 * l_bar_minus_50_sq) / (20.0 + l_bar_minus_50_sq).sqrt();
    let s_c = 1.0 + 0.045 * c_bar_prime;
    let s_h = 1.0 + 0.015 * c_bar_prime * t;

    let r_t = -((2.0 * delta_theta) * RAD_PER_DEG).sin() * r_c;

    let term_l = delta_l_prime / (k_l * s_l);
    let term_c = delta_c_prime / (k_c * s_c);
    let term_h = delta_big_h_prime / (k_h * s_h);

    let d_e_sq = term_l * term_l + term_c * term_c + term_h * term_h + r_t * term_c * term_h;
    if d_e_sq <= 0.0 {
        0.0
    } else {
        d_e_sq.sqrt()
    }
}

#[inline]
fn compute_hue_angle_deg(b: f32, a: f32) -> f32 {
    let deg = b.atan2(a) * DEG_PER_RAD;
    if deg < 0.0 {
        deg + 360.0
    } else {
        deg
    }
}

/// Distância Euclidiana em Linear RGB com pesos Redmean contínuos.
///
/// Fornece aproximação perceptual rápida sem conversão completa para CIELAB.
#[inline]
pub fn redmean_distance(c1: LinearRgbColor, c2: LinearRgbColor) -> f32 {
    let r_mean = (c1.r + c2.r) * 0.5;
    let dr = c1.r - c2.r;
    let dg = c1.g - c2.g;
    let db = c1.b - c2.b;

    let w_r = 2.0 + r_mean;
    let w_g = 4.0;
    let w_b = 3.0 - r_mean;

    (w_r * dr * dr + w_g * dg * dg + w_b * db * db).sqrt()
}

/// Distância Euclidiana em Linear RGB ponderada pela sensibilidade de luminância Rec. 709.
#[inline]
pub fn luminance_weighted_distance(c1: LinearRgbColor, c2: LinearRgbColor) -> f32 {
    let dr = c1.r - c2.r;
    let dg = c1.g - c2.g;
    let db = c1.b - c2.b;

    (0.2126 * dr * dr + 0.7152 * dg * dg + 0.0722 * db * db).sqrt()
}

/// Distância Euclidiana pura em Linear RGB.
#[inline]
pub fn linear_rgb_distance(c1: LinearRgbColor, c2: LinearRgbColor) -> f32 {
    let dr = c1.r - c2.r;
    let dg = c1.g - c2.g;
    let db = c1.b - c2.b;

    (dr * dr + dg * dg + db * db).sqrt()
}

/// Modos de métrica de erro cromático do domínio.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ColorErrorMetric {
    /// Distância euclidiana pura em intensidade fotométrica linear.
    LinearRgb,
    /// Distância euclidiana ponderada por sensibilidade de cones oculares (Redmean).
    RedmeanWeighted,
    /// Distância euclidiana clássica em CIELAB 1976.
    CielabDeltaE76,
    /// Diferença de cor perceptualmente uniforme avançada CIEDE2000.
    CielabDeltaE2000,
}

impl ColorErrorMetric {
    /// Calcula a distância de cor a partir de dois pontos em Linear RGB.
    #[inline]
    pub fn distance_linear(&self, c1: LinearRgbColor, c2: LinearRgbColor) -> f32 {
        match self {
            Self::LinearRgb => linear_rgb_distance(c1, c2),
            Self::RedmeanWeighted => redmean_distance(c1, c2),
            Self::CielabDeltaE76 => delta_e_76(c1.to_lab(), c2.to_lab()),
            Self::CielabDeltaE2000 => delta_e_2000(c1.to_lab(), c2.to_lab()),
        }
    }

    /// Calcula a distância de cor a partir de dois pontos no espaço CIELAB.
    #[inline]
    pub fn distance_lab(&self, c1: LabColor, c2: LabColor) -> f32 {
        match self {
            Self::LinearRgb => linear_rgb_distance(c1.to_linear_rgb(), c2.to_linear_rgb()),
            Self::RedmeanWeighted => redmean_distance(c1.to_linear_rgb(), c2.to_linear_rgb()),
            Self::CielabDeltaE76 => delta_e_76(c1, c2),
            Self::CielabDeltaE2000 => delta_e_2000(c1, c2),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_delta_e_76_basics() {
        let black = LabColor::new(0.0, 0.0, 0.0);
        let white = LabColor::new(100.0, 0.0, 0.0);
        assert_eq!(delta_e_76(black, black), 0.0);
        assert_eq!(delta_e_76(black, white), 100.0);

        let c1 = LabColor::new(50.0, 10.0, 20.0);
        let c2 = LabColor::new(53.0, 14.0, 20.0); // dl=3, da=4, db=0 -> dist=5
        assert!((delta_e_76(c1, c2) - 5.0).abs() < 1e-4);
    }

    #[test]
    fn test_delta_e_2000_sharma_dataset() {
        // Pares de referência canônicos da publicação de Sharma et al. (2005)
        // Pair 1:
        let c1 = LabColor::new(50.0, 2.6772, -79.7751);
        let c2 = LabColor::new(50.0, 0.0, -82.7485);
        let de1 = delta_e_2000(c1, c2);
        assert!((de1 - 2.0425).abs() < 0.001, "Sharma Pair 1 failed: got {}", de1);

        // Pair 2:
        let c1 = LabColor::new(50.0, 3.1571, -77.2803);
        let c2 = LabColor::new(50.0, 0.0, -82.7485);
        let de2 = delta_e_2000(c1, c2);
        assert!((de2 - 2.8615).abs() < 0.001, "Sharma Pair 2 failed: got {}", de2);

        // Pair 25:
        let c1 = LabColor::new(60.2574, -34.0099, 36.2677);
        let c2 = LabColor::new(60.4626, -34.1751, 39.4387);
        let de25 = delta_e_2000(c1, c2);
        assert!((de25 - 1.2644).abs() < 0.001, "Sharma Pair 25 failed: got {}", de25);
    }

    #[test]
    fn test_redmean_and_luma_distance() {
        let c1 = LinearRgbColor::new(0.0, 0.0, 0.0);
        let c2 = LinearRgbColor::new(1.0, 0.0, 0.0);
        let rm_red = redmean_distance(c1, c2);
        // r_mean = 0.5 -> w_r = 2.5 -> sqrt(2.5) ~ 1.5811
        assert!((rm_red - 2.5f32.sqrt()).abs() < 1e-4);

        let c3 = LinearRgbColor::new(0.0, 1.0, 0.0);
        let rm_green = redmean_distance(c1, c3);
        // w_g = 4.0 -> sqrt(4.0) = 2.0
        assert!((rm_green - 2.0).abs() < 1e-4);

        let luma_dist = luminance_weighted_distance(c1, c2);
        assert!((luma_dist - 0.2126f32.sqrt()).abs() < 1e-4);
    }
}
