//! Cálculo de tangentes exatas para pinos cilíndricos com raio físico real e sentidos CW/CCW.

use crate::PegSide;
use super::loom::LoomGeometry;

/// Sentido de enrolamento da corda ao redor do pino cilíndrico.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WindingDirection {
    /// Sentido horário (CW, valor numérico `-1`).
    Clockwise,
    /// Sentido anti-horário (CCW, valor numérico `+1`).
    CounterClockwise,
}

impl WindingDirection {
    /// Retorna o multiplicador de sinal (`+1.0` para CCW, `-1.0` para CW).
    #[inline]
    pub fn sign_f64(self) -> f64 {
        match self {
            Self::CounterClockwise => 1.0,
            Self::Clockwise => -1.0,
        }
    }

    /// Retorna o valor inteiro (`+1` para CCW, `-1` para CW).
    #[inline]
    pub fn as_i8(self) -> i8 {
        match self {
            Self::CounterClockwise => 1,
            Self::Clockwise => -1,
        }
    }

    /// Inverte o sentido de enrolamento.
    #[inline]
    pub fn opposite(self) -> Self {
        match self {
            Self::Clockwise => Self::CounterClockwise,
            Self::CounterClockwise => Self::Clockwise,
        }
    }
}

impl From<PegSide> for WindingDirection {
    #[inline]
    fn from(side: PegSide) -> Self {
        match side {
            PegSide::Clockwise => Self::Clockwise,
            PegSide::CounterClockwise => Self::CounterClockwise,
        }
    }
}

impl From<WindingDirection> for PegSide {
    #[inline]
    fn from(dir: WindingDirection) -> Self {
        match dir {
            WindingDirection::Clockwise => PegSide::Clockwise,
            WindingDirection::CounterClockwise => PegSide::CounterClockwise,
        }
    }
}

/// Reta tangente contínua entre dois pinos cilíndricos reais.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TangentLine {
    /// Ponto de contato exato $(x_0, y_0)$ no pino de origem em milímetros (`mm`).
    pub start: (f64, f64),
    /// Ponto de contato exato $(x_1, y_1)$ no pino de destino em milímetros (`mm`).
    pub end: (f64, f64),
    /// Vetor de direção unitário $(\mathrm{d}x, \mathrm{d}y)$ da trajetória da corda.
    pub dir: (f64, f64),
    /// Vetor normal unitário $(- \mathrm{d}y, \mathrm{d}x)$ apontando para a esquerda da trajetória.
    pub normal: (f64, f64),
    /// Comprimento linear livre do segmento de fio esticado entre os pontos de tangência em milímetros (`mm`).
    pub length: f64,
    /// Sentido de enrolamento no pino de origem.
    pub from_direction: WindingDirection,
    /// Sentido de enrolamento no pino de destino.
    pub to_direction: WindingDirection,
}

impl TangentLine {
    /// Inverte a direção da trajetória do segmento preservando a mesma reta geométrica física.
    ///
    /// Pela regra de reciprocidade, inverter o sentido do trajeto inverte o sinal de ambos os lados:
    /// `tangent(B, -to_dir, A, -from_dir)` percorre o mesmo segmento que `tangent(A, from_dir, B, to_dir)`.
    pub fn reversed(self) -> Self {
        Self {
            start: self.end,
            end: self.start,
            dir: (-self.dir.0, -self.dir.1),
            normal: (-self.normal.0, -self.normal.1),
            length: self.length,
            from_direction: self.to_direction.opposite(),
            to_direction: self.from_direction.opposite(),
        }
    }
}

/// Conjunto das 4 tangentes físicas possíveis entre dois pinos cilíndricos de raio $r_p$.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PegTangents {
    /// Tangente externa com ambos em sentido horário (CW -> CW).
    pub outer_cw_cw: TangentLine,
    /// Tangente externa com ambos em sentido anti-horário (CCW -> CCW).
    pub outer_ccw_ccw: TangentLine,
    /// Tangente interna cruzada (CW -> CCW).
    pub inner_cw_ccw: TangentLine,
    /// Tangente interna cruzada (CCW -> CW).
    pub inner_ccw_cw: TangentLine,
}

/// Calcula o segmento de reta tangente exato entre dois pinos cilíndricos de raio $r_p \ge 0$.
///
/// Seja $\vec{C}_A$ e $\vec{C}_B$ os centros dos pinos, com distância $D = \|\vec{C}_B - \vec{C}_A\|$ e versor $\hat{u} = \frac{\vec{C}_B - \vec{C}_A}{D}$:
/// - Se $s_A == s_B$ (tangente externa): as retas são paralelas à linha dos centros, com $\vec{d} = \hat{u}$ e comprimento $L = D$.
/// - Se $s_A \ne s_B$ (tangente interna cruzada): a reta é rotacionada pelo ângulo de desvio $\Delta \phi = \arcsin\left(\frac{2 r_p}{D}\right)$,
///   com comprimento $L = \sqrt{D^2 - (2 r_p)^2}$.
pub fn compute_tangent(
    center_a: (f64, f64),
    from_direction: WindingDirection,
    center_b: (f64, f64),
    to_direction: WindingDirection,
    pin_radius_mm: f64,
) -> Option<TangentLine> {
    let vx = center_b.0 - center_a.0;
    let vy = center_b.1 - center_a.1;
    let dist = (vx * vx + vy * vy).sqrt();

    if dist < 1e-9 {
        return None; // Pinos coincidentes
    }

    let sa = from_direction.sign_f64();
    let sb = to_direction.sign_f64();

    let ux = vx / dist;
    let uy = vy / dist;

    let (dx, dy, length) = if pin_radius_mm > 0.0 && sa != sb {
        // Tangente interna cruzada
        let two_r = 2.0 * pin_radius_mm;
        if dist < two_r {
            // Pinos com sobreposição física: tangente interna não existe no espaço real
            return None;
        }

        let length_sq = dist * dist - two_r * two_r;
        let length = length_sq.max(0.0).sqrt();

        // Ângulo de desvio: sin(Delta phi) = (2 * sb * r_p) / dist
        let cos_phi = length / dist;
        let sin_phi = (two_r * sb) / dist;

        // Rotação 2D do vetor diretor pelo ângulo phi
        let dx = ux * cos_phi - uy * sin_phi;
        let dy = ux * sin_phi + uy * cos_phi;

        (dx, dy, length)
    } else {
        // Tangente externa paralela (ou pino ideal sem raio)
        (ux, uy, dist)
    };

    // Normal unitária perpendicular à direção de percurso (-dy, dx)
    let nx = -dy;
    let ny = dx;

    // Pontos de tangência na superfície do pino
    let start_x = center_a.0 + sa * pin_radius_mm * nx;
    let start_y = center_a.1 + sa * pin_radius_mm * ny;
    let end_x = center_b.0 + sb * pin_radius_mm * nx;
    let end_y = center_b.1 + sb * pin_radius_mm * ny;

    Some(TangentLine {
        start: (start_x, start_y),
        end: (end_x, end_y),
        dir: (dx, dy),
        normal: (nx, ny),
        length,
        from_direction,
        to_direction,
    })
}

/// Calcula todas as 4 retas tangentes possíveis entre dois pinos cilíndricos.
pub fn compute_all_tangents(
    center_a: (f64, f64),
    center_b: (f64, f64),
    pin_radius_mm: f64,
) -> Option<PegTangents> {
    Some(PegTangents {
        outer_cw_cw: compute_tangent(
            center_a,
            WindingDirection::Clockwise,
            center_b,
            WindingDirection::Clockwise,
            pin_radius_mm,
        )?,
        outer_ccw_ccw: compute_tangent(
            center_a,
            WindingDirection::CounterClockwise,
            center_b,
            WindingDirection::CounterClockwise,
            pin_radius_mm,
        )?,
        inner_cw_ccw: compute_tangent(
            center_a,
            WindingDirection::Clockwise,
            center_b,
            WindingDirection::CounterClockwise,
            pin_radius_mm,
        )?,
        inner_ccw_cw: compute_tangent(
            center_a,
            WindingDirection::CounterClockwise,
            center_b,
            WindingDirection::Clockwise,
            pin_radius_mm,
        )?,
    })
}

impl LoomGeometry {
    /// Calcula a reta tangente entre os pinos `from_pin` e `to_pin` com os sentidos de enrolamento dados.
    pub fn pin_tangent(
        &self,
        from_pin: usize,
        from_direction: WindingDirection,
        to_pin: usize,
        to_direction: WindingDirection,
    ) -> Option<TangentLine> {
        let center_a = self.pin_position(from_pin);
        let center_b = self.pin_position(to_pin);
        let pin_radius = self.spec.pin_radius_mm();
        compute_tangent(center_a, from_direction, center_b, to_direction, pin_radius)
    }

    /// Calcula todas as 4 retas tangentes entre os pinos `from_pin` e `to_pin`.
    pub fn all_pin_tangents(&self, from_pin: usize, to_pin: usize) -> Option<PegTangents> {
        let center_a = self.pin_position(from_pin);
        let center_b = self.pin_position(to_pin);
        let pin_radius = self.spec.pin_radius_mm();
        compute_all_tangents(center_a, center_b, pin_radius)
    }
}
