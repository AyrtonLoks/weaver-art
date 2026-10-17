//! Modelagem polimórfica de tear físico e parametrização por comprimento de arco.

use std::f64::consts::PI;

/// Formato geométrico do contorno perimétrico do tear.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LoomShape {
    Circular,
    Elliptical,
    Rectangular,
    RegularPolygon,
}

/// Especificação mecânica e física completa do tear.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LoomPhysicalSpec {
    /// Formato geométrico do tear.
    pub shape: LoomShape,
    /// Diâmetro primitivo nominal em milímetros (`mm`) para contornos circulares ou poligonais regulares.
    pub diameter_mm: f64,
    /// Largura primitiva nominal em milímetros (`mm`) para contornos elípticos ou retangulares.
    pub width_mm: f64,
    /// Altura primitiva nominal em milímetros (`mm`) para contornos elípticos ou retangulares.
    pub height_mm: f64,
    /// Número total de pinos perimétricos $N$.
    pub peg_count: usize,
    /// Diâmetro externo do pino cilíndrico físico em milímetros (`mm`).
    pub pin_diameter_mm: f64,
    /// Diâmetro da broca de furação em milímetros (`mm`).
    pub drill_diameter_mm: f64,
    /// Margem mecânica de borda até o perímetro externo da moldura em milímetros (`mm`).
    pub margin_mm: f64,
    /// Número de lados para polígonos regulares (mínimo 3).
    pub polygon_sides: usize,
}

impl LoomPhysicalSpec {
    /// Cria uma especificação para tear circular clássico (ex: padrão Petros Vrellis).
    pub fn circle(
        diameter_mm: f64,
        peg_count: usize,
        pin_diameter_mm: f64,
        drill_diameter_mm: f64,
        margin_mm: f64,
    ) -> Self {
        Self {
            shape: LoomShape::Circular,
            diameter_mm,
            width_mm: diameter_mm,
            height_mm: diameter_mm,
            peg_count,
            pin_diameter_mm,
            drill_diameter_mm,
            margin_mm,
            polygon_sides: 0,
        }
    }

    /// Cria uma especificação para tear elíptico com largura e altura especificadas.
    pub fn ellipse(
        width_mm: f64,
        height_mm: f64,
        peg_count: usize,
        pin_diameter_mm: f64,
        drill_diameter_mm: f64,
        margin_mm: f64,
    ) -> Self {
        Self {
            shape: LoomShape::Elliptical,
            diameter_mm: width_mm.max(height_mm),
            width_mm,
            height_mm,
            peg_count,
            pin_diameter_mm,
            drill_diameter_mm,
            margin_mm,
            polygon_sides: 0,
        }
    }

    /// Cria uma especificação para tear retangular com largura e altura especificadas.
    pub fn rectangle(
        width_mm: f64,
        height_mm: f64,
        peg_count: usize,
        pin_diameter_mm: f64,
        drill_diameter_mm: f64,
        margin_mm: f64,
    ) -> Self {
        Self {
            shape: LoomShape::Rectangular,
            diameter_mm: (width_mm * width_mm + height_mm * height_mm).sqrt(),
            width_mm,
            height_mm,
            peg_count,
            pin_diameter_mm,
            drill_diameter_mm,
            margin_mm,
            polygon_sides: 4,
        }
    }

    /// Cria uma especificação para tear em formato de polígono regular inscrito de $K$ lados.
    pub fn regular_polygon(
        polygon_sides: usize,
        diameter_mm: f64,
        peg_count: usize,
        pin_diameter_mm: f64,
        drill_diameter_mm: f64,
        margin_mm: f64,
    ) -> Self {
        let sides = polygon_sides.max(3);
        Self {
            shape: LoomShape::RegularPolygon,
            diameter_mm,
            width_mm: diameter_mm,
            height_mm: diameter_mm,
            peg_count,
            pin_diameter_mm,
            drill_diameter_mm,
            margin_mm,
            polygon_sides: sides,
        }
    }

    /// Raio do pino em milímetros ($r_p = d_p / 2$).
    #[inline]
    pub fn pin_radius_mm(&self) -> f64 {
        self.pin_diameter_mm / 2.0
    }

    /// Raio da broca de furação em milímetros ($r_{\text{drill}} = d_{\text{drill}} / 2$).
    #[inline]
    pub fn drill_radius_mm(&self) -> f64 {
        self.drill_diameter_mm / 2.0
    }
}

impl Default for LoomPhysicalSpec {
    fn default() -> Self {
        Self::circle(711.2, 200, 2.0, 2.0, 15.0)
    }
}

/// Contrato matemático para curvas perimétricas fechadas parametrizadas por comprimento de arco $s \in [0, P)$.
pub trait LoomContour: std::fmt::Debug + Send + Sync {
    /// Perímetro total $P$ do contorno em milímetros (`mm`).
    fn perimeter(&self) -> f64;

    /// Coordenadas $(X, Y)$ na curva para o comprimento de arco $s \in [0, P)$.
    fn point_at_arc_length(&self, s: f64) -> (f64, f64);

    /// Vetor normal unitário voltado para fora $(N_x, N_y)$ no comprimento de arco $s \in [0, P)$.
    fn normal_at_arc_length(&self, s: f64) -> (f64, f64);
}

/// Contorno circular centrado na origem $(0, 0)$.
#[derive(Debug, Clone, Copy)]
pub struct CircularContour {
    radius: f64,
    perimeter: f64,
}

impl CircularContour {
    pub fn new(diameter_mm: f64) -> Self {
        let radius = diameter_mm / 2.0;
        let perimeter = 2.0 * PI * radius;
        Self { radius, perimeter }
    }

    /// Verifica se o ponto $(x, y)$ em milímetros está dentro do círculo.
    #[inline]
    pub fn is_inside(&self, x: f64, y: f64) -> bool {
        x * x + y * y <= self.radius * self.radius
    }
}

impl LoomContour for CircularContour {
    #[inline]
    fn perimeter(&self) -> f64 {
        self.perimeter
    }

    #[inline]
    fn point_at_arc_length(&self, s: f64) -> (f64, f64) {
        let theta = (s.rem_euclid(self.perimeter)) / self.radius;
        (self.radius * theta.cos(), self.radius * theta.sin())
    }

    #[inline]
    fn normal_at_arc_length(&self, s: f64) -> (f64, f64) {
        let theta = (s.rem_euclid(self.perimeter)) / self.radius;
        (theta.cos(), theta.sin())
    }
}

/// Contorno elíptico parametrizado por comprimento de arco via quadratura numérica e refinamento de Newton-Raphson.
#[derive(Debug, Clone)]
pub struct EllipticalContour {
    a: f64,
    b: f64,
    perimeter: f64,
    samples: Vec<(f64, f64)>, // (t_i, cumulative_arc_length_i)
}

impl EllipticalContour {
    pub fn new(width_mm: f64, height_mm: f64) -> Self {
        let a = width_mm / 2.0;
        let b = height_mm / 2.0;

        // Pré-calcula a tabela de comprimento de arco com 2048 subdivisões usando a regra de Simpson
        const N_SAMPLES: usize = 2048;
        let dt = (2.0 * PI) / N_SAMPLES as f64;
        let mut samples = Vec::with_capacity(N_SAMPLES + 1);
        samples.push((0.0, 0.0));

        let speed = |t: f64| (a * a * t.sin().powi(2) + b * b * t.cos().powi(2)).sqrt();

        let mut cumulative = 0.0;
        for i in 1..=N_SAMPLES {
            let t_prev = (i - 1) as f64 * dt;
            let t_curr = i as f64 * dt;
            let t_mid = 0.5 * (t_prev + t_curr);
            let ds = (dt / 6.0) * (speed(t_prev) + 4.0 * speed(t_mid) + speed(t_curr));
            cumulative += ds;
            samples.push((t_curr, cumulative));
        }

        let perimeter = cumulative;
        Self {
            a,
            b,
            perimeter,
            samples,
        }
    }

    /// Verifica se o ponto $(x, y)$ em milímetros está dentro da elipse.
    #[inline]
    pub fn is_inside(&self, x: f64, y: f64) -> bool {
        if self.a <= 1e-9 || self.b <= 1e-9 {
            return false;
        }
        (x / self.a).powi(2) + (y / self.b).powi(2) <= 1.0
    }

    /// Encontra o parâmetro $t \in [0, 2\pi)$ correspondente ao comprimento de arco $s \in [0, P)$.
    fn parameter_for_arc_length(&self, s: f64) -> f64 {
        let s_norm = s.rem_euclid(self.perimeter);
        if s_norm <= 1e-12 {
            return 0.0;
        }
        if (s_norm - self.perimeter).abs() <= 1e-12 {
            return 2.0 * PI;
        }

        // Busca binária na tabela de amostras
        let idx = match self.samples.binary_search_by(|&(_, arc)| {
            arc.partial_cmp(&s_norm).unwrap_or(std::cmp::Ordering::Equal)
        }) {
            Ok(i) => return self.samples[i].0,
            Err(i) => i.saturating_sub(1),
        };

        let next_idx = (idx + 1).min(self.samples.len() - 1);
        let (t0, s0) = self.samples[idx];
        let (t1, s1) = self.samples[next_idx];

        // Interpolação linear como aproximação inicial
        let frac = if (s1 - s0).abs() > 1e-12 {
            (s_norm - s0) / (s1 - s0)
        } else {
            0.0
        };
        let mut t = t0 + frac * (t1 - t0);

        let speed = |angle: f64| (self.a * self.a * angle.sin().powi(2) + self.b * self.b * angle.cos().powi(2)).sqrt();

        // Refinamento de Newton-Raphson de convergência quadrática
        for _ in 0..4 {
            let dt_step = t - t0;
            let t_mid = t0 + 0.5 * dt_step;
            let s_est = s0 + (dt_step / 6.0) * (speed(t0) + 4.0 * speed(t_mid) + speed(t));
            let error = s_est - s_norm;
            if error.abs() < 1e-11 {
                break;
            }
            let deriv = speed(t);
            if deriv > 1e-12 {
                t -= error / deriv;
            }
        }

        t.clamp(0.0, 2.0 * PI)
    }
}

impl LoomContour for EllipticalContour {
    #[inline]
    fn perimeter(&self) -> f64 {
        self.perimeter
    }

    fn point_at_arc_length(&self, s: f64) -> (f64, f64) {
        let t = self.parameter_for_arc_length(s);
        (self.a * t.cos(), self.b * t.sin())
    }

    fn normal_at_arc_length(&self, s: f64) -> (f64, f64) {
        let t = self.parameter_for_arc_length(s);
        let nx_raw = self.b * t.cos();
        let ny_raw = self.a * t.sin();
        let len = (nx_raw * nx_raw + ny_raw * ny_raw).sqrt();
        if len > 1e-12 {
            (nx_raw / len, ny_raw / len)
        } else {
            (1.0, 0.0)
        }
    }
}

/// Contorno poligonal fechado orientado no sentido anti-horário (retângulos, polígonos regulares).
#[derive(Debug, Clone)]
pub struct PolygonContour {
    vertices: Vec<(f64, f64)>,
    edge_lengths: Vec<f64>,
    cumulative_lengths: Vec<f64>,
    edge_normals: Vec<(f64, f64)>,
    vertex_normals: Vec<(f64, f64)>,
    perimeter: f64,
}

impl PolygonContour {
    /// Constrói um polígono a partir de uma lista ordenada de vértices no sentido anti-horário (CCW).
    pub fn new(vertices: Vec<(f64, f64)>) -> Self {
        let count = vertices.len();
        assert!(count >= 3, "Polígono deve conter ao menos 3 vértices");

        let mut edge_lengths = Vec::with_capacity(count);
        let mut cumulative_lengths = Vec::with_capacity(count + 1);
        let mut edge_normals = Vec::with_capacity(count);

        cumulative_lengths.push(0.0);
        let mut total = 0.0;

        for i in 0..count {
            let next_i = (i + 1) % count;
            let dx = vertices[next_i].0 - vertices[i].0;
            let dy = vertices[next_i].1 - vertices[i].1;
            let len = (dx * dx + dy * dy).sqrt();
            assert!(len > 1e-12, "Vértices adjacentes coincidentes");

            edge_lengths.push(len);
            total += len;
            cumulative_lengths.push(total);

            // Vetor tangente unitário: T = (dx/len, dy/len)
            // Em rotação CCW no plano XY, a normal externa é (T_y, -T_x)
            let tx = dx / len;
            let ty = dy / len;
            edge_normals.push((ty, -tx));
        }

        // Vetores normais unitários nos vértices (bissetriz das normais das arestas adjacentes)
        let mut vertex_normals = Vec::with_capacity(count);
        for i in 0..count {
            let prev_edge = if i == 0 { count - 1 } else { i - 1 };
            let curr_edge = i;
            let nx = edge_normals[prev_edge].0 + edge_normals[curr_edge].0;
            let ny = edge_normals[prev_edge].1 + edge_normals[curr_edge].1;
            let len = (nx * nx + ny * ny).sqrt();
            if len > 1e-12 {
                vertex_normals.push((nx / len, ny / len));
            } else {
                vertex_normals.push(edge_normals[curr_edge]);
            }
        }

        Self {
            vertices,
            edge_lengths,
            cumulative_lengths,
            edge_normals,
            vertex_normals,
            perimeter: total,
        }
    }

    /// Cria um contorno retangular centralizado na origem $(0, 0)$ com vértices em sentido anti-horário.
    pub fn rectangle(width_mm: f64, height_mm: f64) -> Self {
        let hx = width_mm / 2.0;
        let hy = height_mm / 2.0;
        let vertices = vec![
            (hx, -hy), // Canto inferior direito
            (hx, hy),  // Canto superior direito
            (-hx, hy), // Canto superior esquerdo
            (-hx, -hy), // Canto inferior esquerdo
        ];
        Self::new(vertices)
    }

    /// Cria um contorno de polígono regular inscrito de $K$ lados com diâmetro primitivo $D$.
    pub fn regular_polygon(sides: usize, diameter_mm: f64) -> Self {
        let k = sides.max(3);
        let radius = diameter_mm / 2.0;
        let mut vertices = Vec::with_capacity(k);
        for i in 0..k {
            let theta = (2.0 * PI * i as f64) / k as f64;
            vertices.push((radius * theta.cos(), radius * theta.sin()));
        }
        Self::new(vertices)
    }

    fn locate_edge(&self, s: f64) -> (usize, f64) {
        let s_norm = s.rem_euclid(self.perimeter);
        let count = self.edge_lengths.len();
        for i in 0..count {
            if s_norm < self.cumulative_lengths[i + 1] || i == count - 1 {
                let local_s = s_norm - self.cumulative_lengths[i];
                return (i, local_s);
            }
        }
        (count - 1, self.edge_lengths[count - 1])
    }

    /// Verifica se o ponto $(x, y)$ em milímetros está dentro do polígono fechado via ray-casting.
    pub fn is_inside(&self, x: f64, y: f64) -> bool {
        let mut inside = false;
        let n = self.vertices.len();
        let mut j = n - 1;
        for i in 0..n {
            let (xi, yi) = self.vertices[i];
            let (xj, yj) = self.vertices[j];
            if ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
                inside = !inside;
            }
            j = i;
        }
        inside
    }
}

impl LoomContour for PolygonContour {
    #[inline]
    fn perimeter(&self) -> f64 {
        self.perimeter
    }

    fn point_at_arc_length(&self, s: f64) -> (f64, f64) {
        let (edge_idx, local_s) = self.locate_edge(s);
        let len = self.edge_lengths[edge_idx];
        let frac = (local_s / len).clamp(0.0, 1.0);
        let next_idx = (edge_idx + 1) % self.vertices.len();
        let p0 = self.vertices[edge_idx];
        let p1 = self.vertices[next_idx];
        (
            (1.0 - frac) * p0.0 + frac * p1.0,
            (1.0 - frac) * p0.1 + frac * p1.1,
        )
    }

    fn normal_at_arc_length(&self, s: f64) -> (f64, f64) {
        let (edge_idx, local_s) = self.locate_edge(s);
        let len = self.edge_lengths[edge_idx];
        const EPS: f64 = 1e-6;
        if local_s < EPS {
            return self.vertex_normals[edge_idx];
        }
        if (len - local_s) < EPS {
            let next_v = (edge_idx + 1) % self.vertices.len();
            return self.vertex_normals[next_v];
        }
        self.edge_normals[edge_idx]
    }
}

/// Implementação unificada dos contornos geométricos suportados.
#[derive(Debug, Clone)]
enum ContourKind {
    Circular(CircularContour),
    Elliptical(EllipticalContour),
    Polygon(PolygonContour),
}

impl LoomContour for ContourKind {
    fn perimeter(&self) -> f64 {
        match self {
            Self::Circular(c) => c.perimeter(),
            Self::Elliptical(c) => c.perimeter(),
            Self::Polygon(c) => c.perimeter(),
        }
    }

    fn point_at_arc_length(&self, s: f64) -> (f64, f64) {
        match self {
            Self::Circular(c) => c.point_at_arc_length(s),
            Self::Elliptical(c) => c.point_at_arc_length(s),
            Self::Polygon(c) => c.point_at_arc_length(s),
        }
    }

    fn normal_at_arc_length(&self, s: f64) -> (f64, f64) {
        match self {
            Self::Circular(c) => c.normal_at_arc_length(s),
            Self::Elliptical(c) => c.normal_at_arc_length(s),
            Self::Polygon(c) => c.normal_at_arc_length(s),
        }
    }
}

impl ContourKind {
    #[inline]
    fn is_inside(&self, x: f64, y: f64) -> bool {
        match self {
            Self::Circular(c) => c.is_inside(x, y),
            Self::Elliptical(e) => e.is_inside(x, y),
            Self::Polygon(p) => p.is_inside(x, y),
        }
    }
}

/// Dados pré-calculados para cada pino perimétrico do tear.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LoomPin {
    pub index: usize,
    pub arc_length_mm: f64,
    pub position: (f64, f64),
    pub normal: (f64, f64),
    pub angle_deg: f64,
}

/// Motor geométrico puro do tear com parametrização por comprimento de arco e posicionamento de pinos.
#[derive(Debug, Clone)]
pub struct LoomGeometry {
    pub spec: LoomPhysicalSpec,
    contour: ContourKind,
    pins: Vec<LoomPin>,
}

impl LoomGeometry {
    /// Inicializa a geometria computacional do tear a partir de sua especificação física.
    pub fn new(spec: LoomPhysicalSpec) -> Self {
        let contour = match spec.shape {
            LoomShape::Circular => ContourKind::Circular(CircularContour::new(spec.diameter_mm)),
            LoomShape::Elliptical => {
                ContourKind::Elliptical(EllipticalContour::new(spec.width_mm, spec.height_mm))
            }
            LoomShape::Rectangular => {
                ContourKind::Polygon(PolygonContour::rectangle(spec.width_mm, spec.height_mm))
            }
            LoomShape::RegularPolygon => ContourKind::Polygon(PolygonContour::regular_polygon(
                spec.polygon_sides,
                spec.diameter_mm,
            )),
        };

        let perimeter = contour.perimeter();
        let peg_count = spec.peg_count.max(1);
        let mut pins = Vec::with_capacity(peg_count);

        for i in 0..peg_count {
            let arc_length_mm = (i as f64 * perimeter) / peg_count as f64;
            let position = contour.point_at_arc_length(arc_length_mm);
            let normal = contour.normal_at_arc_length(arc_length_mm);
            let angle_rad = position.1.atan2(position.0);
            let angle_deg = (angle_rad.to_degrees() + 360.0) % 360.0;

            pins.push(LoomPin {
                index: i,
                arc_length_mm,
                position,
                normal,
                angle_deg,
            });
        }

        Self {
            spec,
            contour,
            pins,
        }
    }

    /// Perímetro total $P$ do tear em milímetros (`mm`).
    #[inline]
    pub fn perimeter(&self) -> f64 {
        self.contour.perimeter()
    }

    /// Quantidade de pinos perimétricos $N$.
    #[inline]
    pub fn pin_count(&self) -> usize {
        self.spec.peg_count
    }

    /// Retorna as coordenadas $(x, y)$ em milímetros do pino `i`.
    #[inline]
    pub fn pin_position(&self, i: usize) -> (f64, f64) {
        let idx = i % self.pins.len();
        self.pins[idx].position
    }

    /// Retorna o vetor normal unitário $(n_x, n_y)$ apontando para fora no pino `i`.
    #[inline]
    pub fn normal_vector(&self, i: usize) -> (f64, f64) {
        let idx = i % self.pins.len();
        self.pins[idx].normal
    }

    /// Retorna o comprimento de arco $s_i \in [0, P)$ correspondente ao pino `i`.
    #[inline]
    pub fn pin_arc_length(&self, i: usize) -> f64 {
        let idx = i % self.pins.len();
        self.pins[idx].arc_length_mm
    }

    /// Retorna a estrutura completa do pino `i`.
    #[inline]
    pub fn pin(&self, i: usize) -> LoomPin {
        let idx = i % self.pins.len();
        self.pins[idx]
    }

    /// Retorna todos os pinos pré-calculados.
    #[inline]
    pub fn pins(&self) -> &[LoomPin] {
        &self.pins
    }

    /// Avalia a coordenada $(X, Y)$ contínua no contorno para qualquer comprimento de arco $s \in [0, P)$.
    #[inline]
    pub fn point_at_arc_length(&self, s: f64) -> (f64, f64) {
        self.contour.point_at_arc_length(s)
    }

    /// Avalia a normal unitária externa contínua no contorno para qualquer comprimento de arco $s \in [0, P)$.
    #[inline]
    pub fn normal_at_arc_length(&self, s: f64) -> (f64, f64) {
        self.contour.normal_at_arc_length(s)
    }

    /// Verifica se as coordenadas $(x, y)$ em milímetros estão dentro do perímetro útil do tear.
    #[inline]
    pub fn is_inside(&self, x_mm: f64, y_mm: f64) -> bool {
        self.contour.is_inside(x_mm, y_mm)
    }
}
