//! Gamut Mapping por projeção convexa no espaço CIELAB.
//!
//! Na arte com fios (*string art*), a sobreposição física e mistura óptica de carretéis
//! $\{s_1, \dots, s_M\}$ sobre a base $s_0$ define um espaço restrito de cores atingíveis
//! (fecho convexo / *Convex Hull* dos carretéis + fundo no espaço de cor).
//!
//! Imagens alvo com cores fora do *gamut* provocam saturação matemática, sobre-escurecimento
//! ("buraco negro") e artefatos de clipping. Este módulo projeta ortogonalmente pixels
//! fora do *gamut* para a fronteira viável, preservando prioritariamente a luminância $L^*$.

use super::metrics::delta_e_76;
use super::space::{LabColor, LinearRgbColor, SrgbColor};

/// Peso padrão atribuído à preservação de luminância L* na projeção ortogonal.
pub const DEFAULT_LUMINANCE_WEIGHT: f32 = 25.0;

/// Estrutura que encapsula o fecho convexo (*Convex Hull*) da paleta de carretéis e fundo.
#[derive(Debug, Clone)]
pub struct GamutHull {
    /// Fundo em Linear RGB
    background_linear: LinearRgbColor,
    /// Carretéis em Linear RGB
    spools_linear: Vec<LinearRgbColor>,
    /// Vértices do fecho convexo em CIELAB: `[background, spool_1, ..., spool_M]`
    vertices_lab: Vec<LabColor>,
    /// Menor luminância L* atingível na paleta
    min_l: f32,
    /// Maior luminância L* atingível na paleta
    max_l: f32,
}

impl GamutHull {
    /// Constrói um `GamutHull` a partir da cor de fundo e da lista de carretéis em `LinearRgbColor`.
    pub fn new(background: LinearRgbColor, spools: &[LinearRgbColor]) -> Self {
        let mut vertices_lab = Vec::with_capacity(spools.len() + 1);
        vertices_lab.push(background.to_lab());
        for s in spools {
            vertices_lab.push(s.to_lab());
        }

        let mut min_l = f32::INFINITY;
        let mut max_l = f32::NEG_INFINITY;
        for v in &vertices_lab {
            if v.l < min_l {
                min_l = v.l;
            }
            if v.l > max_l {
                max_l = v.l;
            }
        }

        Self {
            background_linear: background,
            spools_linear: spools.to_vec(),
            vertices_lab,
            min_l,
            max_l,
        }
    }

    /// Constrói um `GamutHull` a partir de cores sRGB.
    pub fn from_srgb(background: SrgbColor, spools: &[SrgbColor]) -> Self {
        let bg_linear = background.to_linear();
        let spools_linear: Vec<LinearRgbColor> = spools.iter().map(|s| s.to_linear()).collect();
        Self::new(bg_linear, &spools_linear)
    }

    /// Cor do fundo em Linear RGB.
    #[inline]
    pub fn background(&self) -> LinearRgbColor {
        self.background_linear
    }

    /// Lista de carretéis em Linear RGB.
    #[inline]
    pub fn spools(&self) -> &[LinearRgbColor] {
        &self.spools_linear
    }

    /// Vértices da paleta em CIELAB.
    #[inline]
    pub fn vertices_lab(&self) -> &[LabColor] {
        &self.vertices_lab
    }

    /// Luminância L* mínima alcançável pela paleta.
    #[inline]
    pub fn min_luminance(&self) -> f32 {
        self.min_l
    }

    /// Luminância L* máxima alcançável pela paleta.
    #[inline]
    pub fn max_luminance(&self) -> f32 {
        self.max_l
    }

    /// Quantidade total de vértices (1 fundo + M carretéis).
    #[inline]
    pub fn vertex_count(&self) -> usize {
        self.vertices_lab.len()
    }

    /// Verifica se uma cor CIELAB está contida no fecho convexo com uma tolerância de ΔE*76.
    pub fn contains(&self, color: LabColor, tolerance: f32) -> bool {
        let proj = self.project_orthogonal(color, 1.0);
        delta_e_76(color, proj) <= tolerance
    }

    /// Projeção padrão com preservação prioritária de luminância L*.
    #[inline]
    pub fn project(&self, color: LabColor) -> LabColor {
        self.project_preserve_luminance(color)
    }

    /// Projeta a cor ortogonalmente no fecho convexo preservando prioritariamente a luminância L*.
    ///
    /// Se a luminância de entrada estiver fora da faixa física `[min_l, max_l]`, ela é atenuada
    /// para o extremo viável antes de projetar as coordenadas cromáticas.
    pub fn project_preserve_luminance(&self, color: LabColor) -> LabColor {
        let clamped_l = color.l.clamp(self.min_l, self.max_l);
        let target = LabColor::new(clamped_l, color.a, color.b);
        self.project_orthogonal(target, DEFAULT_LUMINANCE_WEIGHT)
    }

    /// Projeção ortogonal no fecho convexo com peso de luminância parametrizado.
    ///
    /// Utiliza o algoritmo GJK (Gilbert-Johnson-Keerthi) em coordenadas ponderadas em R^3,
    /// garantindo convergência exata, estabilidade numérica e zero alocações na heap.
    pub fn project_orthogonal(&self, target: LabColor, luminance_weight: f32) -> LabColor {
        let k = self.vertices_lab.len();
        if k == 0 {
            return target;
        }
        if k == 1 {
            return self.vertices_lab[0];
        }

        // Fator de escala da luminância: s = sqrt(w_L)
        let s = luminance_weight.max(1e-4).sqrt();

        // Transforma target e vértices para o espaço R^3 métrico euclidiano: [s*L, a, b]
        let p = Vec3([s * target.l, target.a, target.b]);

        // Simplex GJK: armazena até 4 vértices (em R^3 um simplex tem no máximo 4 vértices)
        let mut simplex_indices = [0usize; 4];
        let mut simplex_points = [Vec3::ZERO; 4];
        let mut simplex_weights = [0.0f32; 4];

        // Inicializa com o primeiro vértice
        simplex_indices[0] = 0;
        simplex_points[0] = self.vertex_in_space(0, s);
        simplex_weights[0] = 1.0;
        let mut simplex_count = 1;

        let mut closest_point = simplex_points[0];

        const MAX_GJK_ITER: usize = 20;
        const GJK_TOL_SQ: f32 = 1e-6;

        for _ in 0..MAX_GJK_ITER {
            let diff = p - closest_point;
            let dist_sq = diff.norm_sq();
            if dist_sq <= GJK_TOL_SQ {
                // O ponto alvo está no simplex (distância zero)
                return target;
            }

            // Direção de busca em direção ao ponto P
            let dir = diff;

            // Busca do vértice de suporte que maximiza v_i . dir
            let mut best_idx = 0;
            let mut best_dot = f32::NEG_INFINITY;
            for i in 0..k {
                let v = self.vertex_in_space(i, s);
                let dot = v.dot(dir);
                if dot > best_dot {
                    best_dot = dot;
                    best_idx = i;
                }
            }

            // Critério de parada de suporte: se o hiperplano de separação não avança
            let support_pt = self.vertex_in_space(best_idx, s);
            if (support_pt - closest_point).dot(dir) <= 1e-4 {
                break;
            }

            // Verifica se o vértice de suporte já está no simplex
            let mut already_in = false;
            for i in 0..simplex_count {
                if simplex_indices[i] == best_idx {
                    already_in = true;
                    break;
                }
            }
            if already_in {
                break;
            }

            // Adiciona o novo vértice ao simplex
            simplex_indices[simplex_count] = best_idx;
            simplex_points[simplex_count] = support_pt;
            simplex_count += 1;

            // Resolve o sub-problema de ponto mais próximo no simplex (1, 2, 3 ou 4 vértices)
            let (new_closest, new_count) = solve_simplex_closest_point(
                &mut simplex_indices,
                &mut simplex_points,
                &mut simplex_weights,
                simplex_count,
                p,
            );

            closest_point = new_closest;
            simplex_count = new_count;
        }

        // Reconstrói a cor projetada no espaço CIELAB original via combinação convexa
        let mut proj_l = 0.0f32;
        let mut proj_a = 0.0f32;
        let mut proj_b = 0.0f32;
        for i in 0..simplex_count {
            let w = simplex_weights[i];
            let v = self.vertices_lab[simplex_indices[i]];
            proj_l += w * v.l;
            proj_a += w * v.a;
            proj_b += w * v.b;
        }

        LabColor::new(proj_l, proj_a, proj_b)
    }

    #[inline]
    fn vertex_in_space(&self, idx: usize, s: f32) -> Vec3 {
        let v = self.vertices_lab[idx];
        Vec3([s * v.l, v.a, v.b])
    }

    /// Mapeia uma cor Linear RGB para o gamut atingível.
    #[inline]
    pub fn map_color(&self, color: LinearRgbColor) -> LinearRgbColor {
        let lab = color.to_lab();
        let proj = self.project_preserve_luminance(lab);
        proj.to_linear_rgb().clamp()
    }

    /// Mapeia uma cor sRGB para o gamut atingível.
    #[inline]
    pub fn map_srgb_color(&self, color: SrgbColor) -> SrgbColor {
        let lin = color.to_linear();
        let mapped_lin = self.map_color(lin);
        mapped_lin.to_srgb()
    }

    /// Mapeia um buffer de imagem Linear RGB em lote para dentro do gamut viável.
    pub fn map_image(&self, input: &[LinearRgbColor], output: &mut [LinearRgbColor]) {
        assert_eq!(
            input.len(),
            output.len(),
            "Input and output image slices must have identical length"
        );
        for (src, dst) in input.iter().zip(output.iter_mut()) {
            *dst = self.map_color(*src);
        }
    }

    /// Mapeia um buffer de imagem sRGB em lote para dentro do gamut viável.
    pub fn map_srgb_image(&self, input: &[SrgbColor], output: &mut [SrgbColor]) {
        assert_eq!(
            input.len(),
            output.len(),
            "Input and output image slices must have identical length"
        );
        for (src, dst) in input.iter().zip(output.iter_mut()) {
            *dst = self.map_srgb_color(*src);
        }
    }
}

/// Vetor tridimensional simples em R^3 com operações elementares sem dependências.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Vec3(pub [f32; 3]);

impl Vec3 {
    pub const ZERO: Self = Self([0.0, 0.0, 0.0]);

    #[inline]
    pub fn dot(self, other: Self) -> f32 {
        self.0[0] * other.0[0] + self.0[1] * other.0[1] + self.0[2] * other.0[2]
    }

    #[inline]
    pub fn cross(self, other: Self) -> Self {
        Self([
            self.0[1] * other.0[2] - self.0[2] * other.0[1],
            self.0[2] * other.0[0] - self.0[0] * other.0[2],
            self.0[0] * other.0[1] - self.0[1] * other.0[0],
        ])
    }

    #[inline]
    pub fn norm_sq(self) -> f32 {
        self.dot(self)
    }
}

impl std::ops::Add for Vec3 {
    type Output = Self;
    #[inline]
    fn add(self, rhs: Self) -> Self {
        Self([self.0[0] + rhs.0[0], self.0[1] + rhs.0[1], self.0[2] + rhs.0[2]])
    }
}

impl std::ops::Sub for Vec3 {
    type Output = Self;
    #[inline]
    fn sub(self, rhs: Self) -> Self {
        Self([self.0[0] - rhs.0[0], self.0[1] - rhs.0[1], self.0[2] - rhs.0[2]])
    }
}

impl std::ops::Mul<f32> for Vec3 {
    type Output = Self;
    #[inline]
    fn mul(self, rhs: f32) -> Self {
        Self([self.0[0] * rhs, self.0[1] * rhs, self.0[2] * rhs])
    }
}

/// Calcula o ponto mais próximo no simplex de 1, 2, 3 ou 4 vértices para o ponto P
/// e atualiza o simplex mantendo apenas os vértices ativos de suporte com seus pesos baricêntricos.
fn solve_simplex_closest_point(
    indices: &mut [usize; 4],
    points: &mut [Vec3; 4],
    weights: &mut [f32; 4],
    count: usize,
    p: Vec3,
) -> (Vec3, usize) {
    match count {
        1 => {
            weights[0] = 1.0;
            (points[0], 1)
        }
        2 => {
            let a = points[0];
            let b = points[1];
            let ab = b - a;
            let ap = p - a;
            let ab_sq = ab.norm_sq();
            if ab_sq <= 1e-8 {
                weights[0] = 1.0;
                return (a, 1);
            }
            let t = (ap.dot(ab) / ab_sq).clamp(0.0, 1.0);
            if t <= 1e-6 {
                weights[0] = 1.0;
                (a, 1)
            } else if t >= 1.0 - 1e-6 {
                indices[0] = indices[1];
                points[0] = points[1];
                weights[0] = 1.0;
                (b, 1)
            } else {
                weights[0] = 1.0 - t;
                weights[1] = t;
                (a + ab * t, 2)
            }
        }
        3 => {
            let a = points[0];
            let b = points[1];
            let c = points[2];
            let (pt, b_weights, active_count, active_idx) = closest_point_triangle(a, b, c, p);

            // Reorganiza o simplex
            let old_indices = *indices;
            let old_points = *points;
            for i in 0..active_count {
                let src_idx = active_idx[i];
                indices[i] = old_indices[src_idx];
                points[i] = old_points[src_idx];
                weights[i] = b_weights[i];
            }
            (pt, active_count)
        }
        4 => {
            // Tetraedro: testamos as 4 faces triangulares
            let a = points[0];

            // 4 faces com vértices (f0, f1, f2) e vértice oposto f_opp
            let faces: [([usize; 3], usize); 4] = [
                ([0, 1, 2], 3), // Face ABC, oposto D
                ([0, 2, 3], 1), // Face ACD, oposto B
                ([0, 3, 1], 2), // Face ADB, oposto C
                ([1, 3, 2], 0), // Face BDC, oposto A
            ];

            let mut best_dist_sq = f32::INFINITY;
            let mut best_pt = a;
            let mut best_face_active_count = 1;
            let mut best_active_indices = [0usize; 3];
            let mut best_b_weights = [0.0f32; 3];
            let mut is_outside_any = false;

            for (face_v, opp_idx) in faces {
                let fa = points[face_v[0]];
                let fb = points[face_v[1]];
                let fc = points[face_v[2]];
                let fo = points[opp_idx];

                let mut n = (fb - fa).cross(fc - fa);
                if (fo - fa).dot(n) > 0.0 {
                    n = Vec3::ZERO - n; // Aponta para fora do tetraedro
                }

                if (p - fa).dot(n) > -1e-5 {
                    is_outside_any = true;
                    let (pt, b_w, act_count, act_idx) = closest_point_triangle(fa, fb, fc, p);
                    let dist_sq = (p - pt).norm_sq();
                    if dist_sq < best_dist_sq {
                        best_dist_sq = dist_sq;
                        best_pt = pt;
                        best_face_active_count = act_count;
                        for i in 0..act_count {
                            best_active_indices[i] = face_v[act_idx[i]];
                            best_b_weights[i] = b_w[i];
                        }
                    }
                }
            }

            if !is_outside_any {
                // P está dentro do tetraedro!
                weights[0] = 0.25;
                weights[1] = 0.25;
                weights[2] = 0.25;
                weights[3] = 0.25;
                (p, 4)
            } else {
                let old_indices = *indices;
                let old_points = *points;
                for i in 0..best_face_active_count {
                    let src = best_active_indices[i];
                    indices[i] = old_indices[src];
                    points[i] = old_points[src];
                    weights[i] = best_b_weights[i];
                }
                (best_pt, best_face_active_count)
            }
        }
        _ => (points[0], 1),
    }
}

/// Ponto mais próximo em um triângulo 3D (Christer Ericson, "Real-Time Collision Detection").
fn closest_point_triangle(
    a: Vec3,
    b: Vec3,
    c: Vec3,
    p: Vec3,
) -> (Vec3, [f32; 3], usize, [usize; 3]) {
    let ab = b - a;
    let ac = c - a;
    let ap = p - a;

    let d1 = ab.dot(ap);
    let d2 = ac.dot(ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return (a, [1.0, 0.0, 0.0], 1, [0, 0, 0]);
    }

    let bp = p - b;
    let d3 = ab.dot(bp);
    let d4 = ac.dot(bp);
    if d3 >= 0.0 && d4 <= d3 {
        return (b, [1.0, 0.0, 0.0], 1, [1, 0, 0]);
    }

    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        return (a + ab * v, [1.0 - v, v, 0.0], 2, [0, 1, 0]);
    }

    let cp = p - c;
    let d5 = ab.dot(cp);
    let d6 = ac.dot(cp);
    if d6 >= 0.0 && d5 <= d6 {
        return (c, [1.0, 0.0, 0.0], 1, [2, 0, 0]);
    }

    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        return (a + ac * w, [1.0 - w, w, 0.0], 2, [0, 2, 0]);
    }

    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return (b + (c - b) * w, [1.0 - w, w, 0.0], 2, [1, 2, 0]);
    }

    let denom = 1.0 / (va + vb + vc);
    let v = vb * denom;
    let w = vc * denom;
    let u = 1.0 - v - w;
    (a * u + b * v + c * w, [u, v, w], 3, [0, 1, 2])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::space::SrgbColor;

    #[test]
    fn test_monochrome_gamut_mapping() {
        // Paleta monocromática clássica Vrellis: Fundo Branco + Carretel Preto
        let white = LinearRgbColor::WHITE;
        let black = LinearRgbColor::BLACK;
        let hull = GamutHull::new(white, &[black]);

        assert_eq!(hull.vertex_count(), 2);
        assert!((hull.min_luminance() - 0.0).abs() < 1e-3);
        assert!((hull.max_luminance() - 100.0).abs() < 1e-3);

        // Um cinza médio neutro deve estar 100% contido no gamut
        let gray_lab = LabColor::new(50.0, 0.0, 0.0);
        assert!(hull.contains(gray_lab, 0.01));

        // Cor vermelha pura (fora do gamut monocromático por possuir croma a*>0, b*>0)
        let red_lab = SrgbColor::RED.to_linear().to_lab();
        assert!(!hull.contains(red_lab, 1.0));

        // Mapeamento deve preservar a luminância perceptiva do vermelho (L* ~ 53.24) e zerar o croma
        let mapped = hull.project_preserve_luminance(red_lab);
        assert!(
            (mapped.l - red_lab.l).abs() < 0.1,
            "Luminance must be preserved! Got {}, expected {}",
            mapped.l,
            red_lab.l
        );
        assert!(
            mapped.a.abs() < 1e-4,
            "Chroma 'a' must be collapsed to zero in mono! Got {}",
            mapped.a
        );
        assert!(
            mapped.b.abs() < 1e-4,
            "Chroma 'b' must be collapsed to zero in mono! Got {}",
            mapped.b
        );
    }

    #[test]
    fn test_cmyk_gamut_mapping() {
        // Paleta CMYK sobre fundo branco
        let white = SrgbColor::WHITE;
        let cyan = SrgbColor::CYAN;
        let magenta = SrgbColor::MAGENTA;
        let yellow = SrgbColor::YELLOW;
        let black = SrgbColor::BLACK;

        let hull = GamutHull::from_srgb(white, &[cyan, magenta, yellow, black]);
        assert_eq!(hull.vertex_count(), 5);

        // O próprio ciano está no gamut
        let cyan_lab = cyan.to_linear().to_lab();
        assert!(hull.contains(cyan_lab, 0.1));

        let mapped_cyan = hull.project(cyan_lab);
        assert!((mapped_cyan.l - cyan_lab.l).abs() < 0.1);
        assert!((mapped_cyan.a - cyan_lab.a).abs() < 0.1);
        assert!((mapped_cyan.b - cyan_lab.b).abs() < 0.1);

        // Uma cor hiper-saturada externa (fora do espaço de mistura sRGB/CMYK)
        // deve ser puxada para o fecho convexo
        let out_of_gamut = LabColor::new(60.0, 120.0, -90.0);
        let mapped = hull.project(out_of_gamut);
        assert!(hull.contains(mapped, 0.5));
        assert!(
            (mapped.l - 60.0).abs() < 2.0,
            "Lightness should be prioritized, got {}",
            mapped.l
        );
    }

    #[test]
    fn test_image_mapping() {
        let white = LinearRgbColor::WHITE;
        let black = LinearRgbColor::BLACK;
        let hull = GamutHull::new(white, &[black]);

        let input = vec![
            LinearRgbColor::new(1.0, 0.0, 0.0), // Vermelho puro
            LinearRgbColor::new(0.0, 1.0, 0.0), // Verde puro
            LinearRgbColor::new(0.0, 0.0, 1.0), // Azul puro
        ];
        let mut output = vec![LinearRgbColor::BLACK; 3];

        hull.map_image(&input, &mut output);

        // Todas as cores mapeadas para a paleta preto e branco devem ser cinzas neutros (r == g == b)
        for c in &output {
            assert!(
                (c.r - c.g).abs() < 1e-4 && (c.g - c.b).abs() < 1e-4,
                "Output color must be achromatic: {:?}",
                c
            );
        }
    }

    #[test]
    fn test_restricted_duotone_palette() {
        // Paleta restrita: Tela Branca + Carretel Azul Escuro
        let white = SrgbColor::WHITE;
        let dark_blue = SrgbColor::new(0.0, 0.1, 0.5);
        let hull = GamutHull::from_srgb(white, &[dark_blue]);

        assert_eq!(hull.vertex_count(), 2);

        // Amarelo puro é completamente incompatível com essa paleta restrita (não há pigmento amarelo)
        let yellow_lab = SrgbColor::YELLOW.to_linear().to_lab();
        assert!(!hull.contains(yellow_lab, 1.0));

        let mapped_yellow = hull.project_preserve_luminance(yellow_lab);
        // O amarelo projetado deve estar no segmento viável e manter luminância próxima ao máximo possível da paleta
        assert!(hull.contains(mapped_yellow, 0.01));
        assert!(mapped_yellow.l <= hull.max_luminance());
        assert!(mapped_yellow.l >= hull.min_luminance());
    }

    #[test]
    fn test_inverted_black_canvas_monochrome() {
        // String art invertida (estilo negativo): Fundo Preto + Fio Branco
        let black = LinearRgbColor::BLACK;
        let white = LinearRgbColor::WHITE;
        let hull = GamutHull::new(black, &[white]);

        assert!((hull.min_luminance() - 0.0).abs() < 1e-3);
        assert!((hull.max_luminance() - 100.0).abs() < 1e-3);

        // Um verde puro projetado no negativo deve preservar sua luminância perceptual (L* ~ 87.73)
        let green_lab = SrgbColor::GREEN.to_linear().to_lab();
        let mapped = hull.project_preserve_luminance(green_lab);

        assert!((mapped.l - green_lab.l).abs() < 0.1);
        assert!(mapped.a.abs() < 1e-4);
        assert!(mapped.b.abs() < 1e-4);
    }
}
