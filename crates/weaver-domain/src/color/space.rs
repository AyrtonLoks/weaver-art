//! Definições de espaços de cor e transformações fotométricas e perceptuais.
//!
//! - `SrgbColor`: Espaço de cor sRGB padrão (IEC 61966-2-1), codificado não-linearmente em [0.0, 1.0].
//! - `LinearRgbColor`: Espaço RGB Linear em intensidade fotométrica [0.0, 1.0].
//! - `XyzColor`: Espaço tristímulo CIEXYZ 1931 com iluminante de referência D65.
//! - `LabColor`: Espaço perceptual uniforme CIELAB 1976 (L* em [0, 100], a* e b* tipicamente em [-128, 128]).

use std::fmt;

/// Coeficientes de luminância linear Rec. 709 / sRGB.
pub const LUMA_REC709_R: f32 = 0.2126;
pub const LUMA_REC709_G: f32 = 0.7152;
pub const LUMA_REC709_B: f32 = 0.0722;

/// Coordenadas do iluminante padrão D65 (observador 2° padrão CIE 1931).
pub const D65_XN: f32 = 0.95047;
pub const D65_YN: f32 = 1.00000;
pub const D65_ZN: f32 = 1.08883;

/// Erro de parsing de string hexadecimal de cor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColorParseError(pub String);

impl fmt::Display for ColorParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Invalid color representation: {}", self.0)
    }
}

impl std::error::Error for ColorParseError {}

/// Função de transferência direta sRGB (IEC 61966-2-1): sRGB codificado [0, 1] -> Linear [0, 1].
#[inline]
pub fn srgb_to_linear_channel(v: f32) -> f32 {
    let v_clamped = v.clamp(0.0, 1.0);
    if v_clamped <= 0.04045 {
        v_clamped / 12.92
    } else {
        ((v_clamped + 0.055) / 1.055).powf(2.4)
    }
}

/// Função de transferência inversa sRGB (IEC 61966-2-1): Linear [0, 1] -> sRGB codificado [0, 1].
#[inline]
pub fn linear_to_srgb_channel(v: f32) -> f32 {
    if v <= 0.0 {
        0.0
    } else if v >= 1.0 {
        1.0
    } else if v <= 0.0031308 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

/// Conversão simplificada usando expoente gamma fixo.
#[inline]
pub fn gamma_to_linear_channel(v: f32, gamma: f32) -> f32 {
    v.clamp(0.0, 1.0).powf(gamma)
}

/// Conversão inversa simplificada usando expoente gamma fixo.
#[inline]
pub fn linear_to_gamma_channel(v: f32, gamma: f32) -> f32 {
    v.clamp(0.0, 1.0).powf(1.0 / gamma)
}

/// Cor no espaço sRGB padrão (não-linear), componentes em [0.0, 1.0].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SrgbColor {
    pub r: f32,
    pub g: f32,
    pub b: f32,
}

impl SrgbColor {
    pub const BLACK: Self = Self { r: 0.0, g: 0.0, b: 0.0 };
    pub const WHITE: Self = Self { r: 1.0, g: 1.0, b: 1.0 };
    pub const RED: Self = Self { r: 1.0, g: 0.0, b: 0.0 };
    pub const GREEN: Self = Self { r: 0.0, g: 1.0, b: 0.0 };
    pub const BLUE: Self = Self { r: 0.0, g: 0.0, b: 1.0 };
    pub const CYAN: Self = Self { r: 0.0, g: 1.0, b: 1.0 };
    pub const MAGENTA: Self = Self { r: 1.0, g: 0.0, b: 1.0 };
    pub const YELLOW: Self = Self { r: 1.0, g: 1.0, b: 0.0 };

    #[inline]
    pub const fn new(r: f32, g: f32, b: f32) -> Self {
        Self { r, g, b }
    }

    #[inline]
    pub fn new_clamped(r: f32, g: f32, b: f32) -> Self {
        Self {
            r: r.clamp(0.0, 1.0),
            g: g.clamp(0.0, 1.0),
            b: b.clamp(0.0, 1.0),
        }
    }

    #[inline]
    pub fn from_u8(r: u8, g: u8, b: u8) -> Self {
        Self {
            r: r as f32 / 255.0,
            g: g as f32 / 255.0,
            b: b as f32 / 255.0,
        }
    }

    #[inline]
    pub fn to_u8_array(&self) -> [u8; 3] {
        [
            (self.r.clamp(0.0, 1.0) * 255.0 + 0.5) as u8,
            (self.g.clamp(0.0, 1.0) * 255.0 + 0.5) as u8,
            (self.b.clamp(0.0, 1.0) * 255.0 + 0.5) as u8,
        ]
    }

    pub fn from_hex(hex: &str) -> Result<Self, ColorParseError> {
        let clean = hex.trim().trim_start_matches('#');
        if clean.len() != 6 {
            return Err(ColorParseError(format!(
                "Hex color must have 6 hex digits, got '{}'",
                hex
            )));
        }
        let r = u8::from_str_radix(&clean[0..2], 16)
            .map_err(|_| ColorParseError(hex.to_string()))?;
        let g = u8::from_str_radix(&clean[2..4], 16)
            .map_err(|_| ColorParseError(hex.to_string()))?;
        let b = u8::from_str_radix(&clean[4..6], 16)
            .map_err(|_| ColorParseError(hex.to_string()))?;
        Ok(Self::from_u8(r, g, b))
    }

    pub fn to_hex(&self) -> String {
        let [r, g, b] = self.to_u8_array();
        format!("#{:02x}{:02x}{:02x}", r, g, b)
    }

    #[inline]
    pub fn clamp(&self) -> Self {
        Self {
            r: self.r.clamp(0.0, 1.0),
            g: self.g.clamp(0.0, 1.0),
            b: self.b.clamp(0.0, 1.0),
        }
    }

    #[inline]
    pub fn to_linear(&self) -> LinearRgbColor {
        LinearRgbColor {
            r: srgb_to_linear_channel(self.r),
            g: srgb_to_linear_channel(self.g),
            b: srgb_to_linear_channel(self.b),
        }
    }
}

impl From<LinearRgbColor> for SrgbColor {
    #[inline]
    fn from(c: LinearRgbColor) -> Self {
        c.to_srgb()
    }
}

impl From<[f32; 3]> for SrgbColor {
    #[inline]
    fn from(arr: [f32; 3]) -> Self {
        Self::new(arr[0], arr[1], arr[2])
    }
}

impl From<SrgbColor> for [f32; 3] {
    #[inline]
    fn from(c: SrgbColor) -> Self {
        [c.r, c.g, c.b]
    }
}

/// Cor no espaço RGB Linear (fotométrico), componentes em [0.0, 1.0].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LinearRgbColor {
    pub r: f32,
    pub g: f32,
    pub b: f32,
}

impl LinearRgbColor {
    pub const BLACK: Self = Self { r: 0.0, g: 0.0, b: 0.0 };
    pub const WHITE: Self = Self { r: 1.0, g: 1.0, b: 1.0 };
    pub const RED: Self = Self { r: 1.0, g: 0.0, b: 0.0 };
    pub const GREEN: Self = Self { r: 0.0, g: 1.0, b: 0.0 };
    pub const BLUE: Self = Self { r: 0.0, g: 0.0, b: 1.0 };
    pub const CYAN: Self = Self { r: 0.0, g: 1.0, b: 1.0 };
    pub const MAGENTA: Self = Self { r: 1.0, g: 0.0, b: 1.0 };
    pub const YELLOW: Self = Self { r: 1.0, g: 1.0, b: 0.0 };

    #[inline]
    pub const fn new(r: f32, g: f32, b: f32) -> Self {
        Self { r, g, b }
    }

    #[inline]
    pub fn new_clamped(r: f32, g: f32, b: f32) -> Self {
        Self {
            r: r.clamp(0.0, 1.0),
            g: g.clamp(0.0, 1.0),
            b: b.clamp(0.0, 1.0),
        }
    }

    #[inline]
    pub fn clamp(&self) -> Self {
        Self {
            r: self.r.clamp(0.0, 1.0),
            g: self.g.clamp(0.0, 1.0),
            b: self.b.clamp(0.0, 1.0),
        }
    }

    /// Luminância fotométrica linear (Rec. 709).
    #[inline]
    pub fn luminance(&self) -> f32 {
        LUMA_REC709_R * self.r + LUMA_REC709_G * self.g + LUMA_REC709_B * self.b
    }

    /// Interpolação linear no espaço fotométrico: `(1 - t) * self + t * other`.
    #[inline]
    pub fn lerp(&self, other: &Self, t: f32) -> Self {
        Self {
            r: self.r + (other.r - self.r) * t,
            g: self.g + (other.g - self.g) * t,
            b: self.b + (other.b - self.b) * t,
        }
    }

    /// Modelo físico de transmitância em luz linear: T_new = T_canvas * (1 - alpha * (1 - c_thread)).
    ///
    /// Preserva a invariante física: escurecimento cumulativo e multiplicativo com densidade de cordas.
    #[inline]
    pub fn subtractive_mix(&self, thread_color: &Self, alpha: f32) -> Self {
        Self {
            r: (self.r * (1.0 - alpha * (1.0 - thread_color.r))).clamp(0.0, 1.0),
            g: (self.g * (1.0 - alpha * (1.0 - thread_color.g))).clamp(0.0, 1.0),
            b: (self.b * (1.0 - alpha * (1.0 - thread_color.b))).clamp(0.0, 1.0),
        }
    }

    #[inline]
    pub fn to_srgb(&self) -> SrgbColor {
        SrgbColor {
            r: linear_to_srgb_channel(self.r),
            g: linear_to_srgb_channel(self.g),
            b: linear_to_srgb_channel(self.b),
        }
    }

    #[inline]
    pub fn to_xyz(&self) -> XyzColor {
        // Matriz sRGB -> CIEXYZ (D65)
        let x = 0.4124564 * self.r + 0.3575761 * self.g + 0.1804375 * self.b;
        let y = 0.2126729 * self.r + 0.7151522 * self.g + 0.0721750 * self.b;
        let z = 0.0193339 * self.r + 0.1191920 * self.g + 0.9503041 * self.b;
        XyzColor { x, y, z }
    }

    #[inline]
    pub fn to_lab(&self) -> LabColor {
        self.to_xyz().to_lab()
    }
}

impl From<SrgbColor> for LinearRgbColor {
    #[inline]
    fn from(c: SrgbColor) -> Self {
        c.to_linear()
    }
}

impl From<[f32; 3]> for LinearRgbColor {
    #[inline]
    fn from(arr: [f32; 3]) -> Self {
        Self::new(arr[0], arr[1], arr[2])
    }
}

impl From<LinearRgbColor> for [f32; 3] {
    #[inline]
    fn from(c: LinearRgbColor) -> Self {
        [c.r, c.g, c.b]
    }
}

/// Tristímulo CIEXYZ 1931 com ponto branco D65.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct XyzColor {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl XyzColor {
    #[inline]
    pub const fn new(x: f32, g: f32, z: f32) -> Self {
        Self { x, y: g, z }
    }

    #[inline]
    pub fn to_linear_rgb(&self) -> LinearRgbColor {
        // Matriz inversa CIEXYZ (D65) -> sRGB Linear
        let r =  3.2404542 * self.x - 1.5371385 * self.y - 0.4985314 * self.z;
        let g = -0.9692660 * self.x + 1.8760108 * self.y + 0.0415560 * self.z;
        let b =  0.0556434 * self.x - 0.2040259 * self.y + 1.0572252 * self.z;
        LinearRgbColor { r, g, b }
    }

    #[inline]
    pub fn to_lab(&self) -> LabColor {
        let fx = f_cielab(self.x / D65_XN);
        let fy = f_cielab(self.y / D65_YN);
        let fz = f_cielab(self.z / D65_ZN);

        let l = 116.0 * fy - 16.0;
        let a = 500.0 * (fx - fy);
        let b = 200.0 * (fy - fz);
        LabColor { l, a, b }
    }
}

impl From<LinearRgbColor> for XyzColor {
    #[inline]
    fn from(c: LinearRgbColor) -> Self {
        c.to_xyz()
    }
}

impl From<XyzColor> for LinearRgbColor {
    #[inline]
    fn from(c: XyzColor) -> Self {
        c.to_linear_rgb()
    }
}

// Constantes da função não linear CIELAB
const DELTA: f32 = 6.0 / 29.0;
const DELTA_CUBED: f32 = DELTA * DELTA * DELTA;
const FACTOR_LINEAR: f32 = 841.0 / 108.0; // 1.0 / (3.0 * DELTA^2)
const OFFSET_LINEAR: f32 = 4.0 / 29.0;   // 16.0 / 116.0

#[inline]
fn f_cielab(t: f32) -> f32 {
    if t > DELTA_CUBED {
        t.cbrt()
    } else {
        FACTOR_LINEAR * t + OFFSET_LINEAR
    }
}

#[inline]
fn f_cielab_inv(t: f32) -> f32 {
    if t > DELTA {
        t * t * t
    } else {
        3.0 * DELTA * DELTA * (t - OFFSET_LINEAR)
    }
}

/// Espaço de cor perceptual uniforme CIELAB 1976.
///
/// - `l`: Luminosidade percebida L* em [0.0, 100.0].
/// - `a`: Eixo verde-vermelho a* tipicamente em [-128.0, 128.0].
/// - `b`: Eixo azul-amarelo b* tipicamente em [-128.0, 128.0].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LabColor {
    pub l: f32,
    pub a: f32,
    pub b: f32,
}

impl LabColor {
    pub const BLACK: Self = Self { l: 0.0, a: 0.0, b: 0.0 };
    pub const WHITE: Self = Self { l: 100.0, a: 0.0, b: 0.0 };

    #[inline]
    pub const fn new(l: f32, a: f32, b: f32) -> Self {
        Self { l, a, b }
    }

    #[inline]
    pub fn chroma(&self) -> f32 {
        (self.a * self.a + self.b * self.b).sqrt()
    }

    #[inline]
    pub fn hue_angle_deg(&self) -> f32 {
        let deg = self.b.atan2(self.a).to_degrees();
        if deg < 0.0 {
            deg + 360.0
        } else {
            deg
        }
    }

    #[inline]
    pub fn to_xyz(&self) -> XyzColor {
        let fy = (self.l + 16.0) / 116.0;
        let fx = fy + self.a / 500.0;
        let fz = fy - self.b / 200.0;

        let x = D65_XN * f_cielab_inv(fx);
        let y = D65_YN * f_cielab_inv(fy);
        let z = D65_ZN * f_cielab_inv(fz);
        XyzColor { x, y, z }
    }

    #[inline]
    pub fn to_linear_rgb(&self) -> LinearRgbColor {
        self.to_xyz().to_linear_rgb()
    }

    #[inline]
    pub fn to_srgb(&self) -> SrgbColor {
        self.to_linear_rgb().to_srgb()
    }
}

impl From<XyzColor> for LabColor {
    #[inline]
    fn from(c: XyzColor) -> Self {
        c.to_lab()
    }
}

impl From<LabColor> for XyzColor {
    #[inline]
    fn from(c: LabColor) -> Self {
        c.to_xyz()
    }
}

impl From<LinearRgbColor> for LabColor {
    #[inline]
    fn from(c: LinearRgbColor) -> Self {
        c.to_lab()
    }
}

impl From<LabColor> for LinearRgbColor {
    #[inline]
    fn from(c: LabColor) -> Self {
        c.to_linear_rgb()
    }
}

impl From<SrgbColor> for LabColor {
    #[inline]
    fn from(c: SrgbColor) -> Self {
        c.to_linear().to_lab()
    }
}

impl From<LabColor> for SrgbColor {
    #[inline]
    fn from(c: LabColor) -> Self {
        c.to_linear_rgb().to_srgb()
    }
}

impl From<[f32; 3]> for LabColor {
    #[inline]
    fn from(arr: [f32; 3]) -> Self {
        Self::new(arr[0], arr[1], arr[2])
    }
}

impl From<LabColor> for [f32; 3] {
    #[inline]
    fn from(c: LabColor) -> Self {
        [c.l, c.a, c.b]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_srgb_gamma_roundtrip() {
        for i in 0..=255 {
            let v = i as f32 / 255.0;
            let linear = srgb_to_linear_channel(v);
            let srgb = linear_to_srgb_channel(linear);
            assert!(
                (v - srgb).abs() < 1e-4,
                "sRGB roundtrip failed for v={}: got {}",
                v,
                srgb
            );
        }
    }

    #[test]
    fn test_black_white_conversions() {
        // Preto Puro
        let black_srgb = SrgbColor::BLACK;
        let black_lin = black_srgb.to_linear();
        assert_eq!(black_lin, LinearRgbColor::BLACK);
        let black_lab = black_lin.to_lab();
        assert!((black_lab.l - 0.0).abs() < 1e-4);
        assert!((black_lab.a - 0.0).abs() < 1e-4);
        assert!((black_lab.b - 0.0).abs() < 1e-4);

        let round_black = black_lab.to_srgb();
        assert_eq!(round_black.to_u8_array(), [0, 0, 0]);

        // Branco Puro
        let white_srgb = SrgbColor::WHITE;
        let white_lin = white_srgb.to_linear();
        assert_eq!(white_lin, LinearRgbColor::WHITE);
        let white_lab = white_lin.to_lab();
        assert!((white_lab.l - 100.0).abs() < 1e-3);
        assert!((white_lab.a - 0.0).abs() < 1e-3);
        assert!((white_lab.b - 0.0).abs() < 1e-3);

        let round_white = white_lab.to_srgb();
        assert_eq!(round_white.to_u8_array(), [255, 255, 255]);
    }

    #[test]
    fn test_primary_colors_lab_values() {
        // Valores de referência padrão sRGB D65 para cores primárias e secundárias
        let red_lab = SrgbColor::RED.to_linear().to_lab();
        assert!((red_lab.l - 53.24).abs() < 0.2);
        assert!((red_lab.a - 80.09).abs() < 0.2);
        assert!((red_lab.b - 67.20).abs() < 0.2);

        let green_lab = SrgbColor::GREEN.to_linear().to_lab();
        assert!((green_lab.l - 87.73).abs() < 0.2);
        assert!((green_lab.a - -86.18).abs() < 0.2);
        assert!((green_lab.b - 83.18).abs() < 0.2);

        let blue_lab = SrgbColor::BLUE.to_linear().to_lab();
        assert!((blue_lab.l - 32.30).abs() < 0.2);
        assert!((blue_lab.a - 79.20).abs() < 0.2);
        assert!((blue_lab.b - -107.86).abs() < 0.2);

        let cyan_lab = SrgbColor::CYAN.to_linear().to_lab();
        assert!((cyan_lab.l - 91.11).abs() < 0.2);
        assert!((cyan_lab.a - -48.09).abs() < 0.2);
        assert!((cyan_lab.b - -14.14).abs() < 0.2);

        let magenta_lab = SrgbColor::MAGENTA.to_linear().to_lab();
        assert!((magenta_lab.l - 60.32).abs() < 0.2);
        assert!((magenta_lab.a - 98.23).abs() < 0.2);
        assert!((magenta_lab.b - -60.82).abs() < 0.2);

        let yellow_lab = SrgbColor::YELLOW.to_linear().to_lab();
        assert!((yellow_lab.l - 97.14).abs() < 0.2);
        assert!((yellow_lab.a - -21.55).abs() < 0.2);
        assert!((yellow_lab.b - 94.48).abs() < 0.2);
    }

    #[test]
    fn test_hex_parsing() {
        let hex = "#ff8000";
        let c = SrgbColor::from_hex(hex).unwrap();
        assert_eq!(c.to_u8_array(), [255, 128, 0]);
        assert_eq!(c.to_hex(), "#ff8000");

        assert!(SrgbColor::from_hex("invalid").is_err());
        assert!(SrgbColor::from_hex("#12345").is_err());
    }
}
