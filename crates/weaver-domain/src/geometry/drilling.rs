//! Validação mecânica de furação, parede mínima livre e tabela de coordenadas CAM.

use super::loom::LoomGeometry;

/// Limiar padrão de parede livre mínima para aviso de espessura delgada (`mm`).
pub const DEFAULT_MIN_WALL_THRESHOLD_MM: f64 = 1.5;

/// Status mecânico de integridade da furação do tear.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DrillingStatus {
    /// Furação segura: parede livre entre furos adjacentes superior ao limiar de segurança.
    Safe,
    /// Parede delgada: risco mecânico de trinca ou arrancamento de material durante a usinagem/furação.
    WarningThinWall,
    /// Colisão física: os furos adjacentes se interceptam ou sobrepõem ($w_{\text{livre}} \le 0$).
    ErrorCollision,
}

/// Registro mecânico de um furo de pino para furação CNC / CAM.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DrillHole {
    /// Índice sequencial do pino (0..N-1).
    pub pin_index: usize,
    /// Ângulo polar em graus no plano $[0^\circ, 360^\circ)$.
    pub angle_deg: f64,
    /// Coordenada X em milímetros (`mm`).
    pub x_mm: f64,
    /// Coordenada Y em milímetros (`mm`).
    pub y_mm: f64,
}

/// Diagnóstico mecânico completo de furação do tear.
#[derive(Debug, Clone, PartialEq)]
pub struct DrillingDiagnostic {
    /// Status mecânico global da furação.
    pub status: DrillingStatus,
    /// Menor distância euclidiana entre centros de furos adjacentes ($d_{\text{adj}}$) em milímetros (`mm`).
    pub min_adjacent_distance_mm: f64,
    /// Espessura de parede livre restante entre furos adjacentes ($w_{\text{livre}} = d_{\text{adj}} - d_{\text{broca}}$) em milímetros (`mm`).
    pub free_wall_mm: f64,
    /// Passo linear nominal médio entre furos ao longo do perímetro em milímetros (`mm`).
    pub linear_pitch_mm: f64,
    /// Tabela ordenada com todos os furos para exportação CAM (G-code / CSV).
    pub holes: Vec<DrillHole>,
}

impl DrillingDiagnostic {
    /// Avalia a integridade mecânica de furação para uma dada geometria de tear com limiar customizado.
    pub fn evaluate(loom: &LoomGeometry, warning_wall_threshold_mm: f64) -> Self {
        let n = loom.pin_count();
        if n < 2 {
            return Self {
                status: DrillingStatus::Safe,
                min_adjacent_distance_mm: 0.0,
                free_wall_mm: 0.0,
                linear_pitch_mm: 0.0,
                holes: Vec::new(),
            };
        }

        let mut holes = Vec::with_capacity(n);
        let mut min_adj_dist = f64::INFINITY;
        let mut sum_dist = 0.0;

        for i in 0..n {
            let p_curr = loom.pin_position(i);
            let p_next = loom.pin_position((i + 1) % n);

            let dx = p_next.0 - p_curr.0;
            let dy = p_next.1 - p_curr.1;
            let dist = (dx * dx + dy * dy).sqrt();

            if dist < min_adj_dist {
                min_adj_dist = dist;
            }
            sum_dist += dist;

            let angle_rad = p_curr.1.atan2(p_curr.0);
            let angle_deg = (angle_rad.to_degrees() + 360.0) % 360.0;

            holes.push(DrillHole {
                pin_index: i,
                angle_deg,
                x_mm: p_curr.0,
                y_mm: p_curr.1,
            });
        }

        let linear_pitch_mm = sum_dist / n as f64;
        let drill_diameter = loom.spec.drill_diameter_mm;
        let free_wall_mm = min_adj_dist - drill_diameter;

        let status = if free_wall_mm <= 0.0 {
            DrillingStatus::ErrorCollision
        } else if free_wall_mm < warning_wall_threshold_mm {
            DrillingStatus::WarningThinWall
        } else {
            DrillingStatus::Safe
        };

        Self {
            status,
            min_adjacent_distance_mm: min_adj_dist,
            free_wall_mm,
            linear_pitch_mm,
            holes,
        }
    }

    /// Retorna `true` se a furação for mecânica e estruturalmente segura.
    #[inline]
    pub fn is_safe(&self) -> bool {
        self.status == DrillingStatus::Safe
    }

    /// Retorna `true` se houver colisão de brocas.
    #[inline]
    pub fn is_collision(&self) -> bool {
        self.status == DrillingStatus::ErrorCollision
    }

    /// Exporta a tabela de furos para o formato padrão CSV para uso em CNC ou inspeção.
    pub fn to_csv(&self) -> String {
        let mut out = String::from("pin_index,angle_deg,x_mm,y_mm\n");
        for h in &self.holes {
            out.push_str(&format!(
                "{},{:.4},{:.4},{:.4}\n",
                h.pin_index, h.angle_deg, h.x_mm, h.y_mm
            ));
        }
        out
    }
}

impl LoomGeometry {
    /// Executa o diagnóstico mecânico de furação com o limiar padrão de parede livre (1.5 mm).
    pub fn drilling_diagnostic(&self) -> DrillingDiagnostic {
        DrillingDiagnostic::evaluate(self, DEFAULT_MIN_WALL_THRESHOLD_MM)
    }

    /// Executa o diagnóstico mecânico de furação com um limiar customizado de parede livre.
    pub fn drilling_diagnostic_with_threshold(&self, warning_threshold_mm: f64) -> DrillingDiagnostic {
        DrillingDiagnostic::evaluate(self, warning_threshold_mm)
    }
}
