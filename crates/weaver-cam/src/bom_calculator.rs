//! Calculadora de BOM (Bill of Materials) e Estimativa de Tempo de Execução Humana (`bom_calculator.rs`).
//!
//! Na manufatura física real de String Art:
//! - Cada corda possui um comprimento linear esticado exato entre os pontos de tangência dos pinos
//!   mais o comprimento do arco de contorno ao redor do pino cilíndrico ($\approx \pi \cdot r_p$).
//! - O consumo de fio é agrupado por carretel/cor com aplicação de margem de segurança configurável (+10%),
//!   sobras para amarração de pontas e cálculo do número inteiro de cones comerciais necessários.
//! - A estimativa de tempo manual modela a cadência média do tecelão (ex: 4.5 s/passo) somada ao tempo
//!   gasto em nós, amarrações iniciais e trocas de carretel (ex: 90 s por amarração/troca).

use std::collections::HashSet;
use std::f64::consts::PI;
use weaver_domain::{compute_tangent, LoomGeometry, WindingDirection};

/// Um passo individual de corda na tecelagem da obra.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WeavingStep {
    /// Índice sequencial do passo (0-indexed).
    pub step_index: usize,
    /// Pino de origem (0-indexed).
    pub from_pin: u16,
    /// Pino de destino (0-indexed).
    pub to_pin: u16,
    /// Identificador do carretel/cor utilizado.
    pub spool_id: u8,
    /// Sentido de enrolamento na saída do pino de origem.
    pub departure_winding: WindingDirection,
    /// Sentido de enrolamento na chegada ao pino de destino.
    pub arrival_winding: WindingDirection,
    /// Pontuação / ganho normalizado em ponto fixo (`score * 65535`).
    pub score_normalized: u16,
    /// Identificador da época ou camada de empilhamento físico.
    pub epoch_id: u8,
}

impl WeavingStep {
    /// Cria um novo passo de tecelagem com valores padrão para pontuação e época.
    pub fn new(
        step_index: usize,
        from_pin: u16,
        to_pin: u16,
        spool_id: u8,
        departure_winding: WindingDirection,
        arrival_winding: WindingDirection,
    ) -> Self {
        Self {
            step_index,
            from_pin,
            to_pin,
            spool_id,
            departure_winding,
            arrival_winding,
            score_normalized: 0,
            epoch_id: spool_id,
        }
    }

    /// Cria um passo de tecelagem completo com todos os metadados.
    pub fn with_details(
        step_index: usize,
        from_pin: u16,
        to_pin: u16,
        spool_id: u8,
        departure_winding: WindingDirection,
        arrival_winding: WindingDirection,
        score_normalized: u16,
        epoch_id: u8,
    ) -> Self {
        Self {
            step_index,
            from_pin,
            to_pin,
            spool_id,
            departure_winding,
            arrival_winding,
            score_normalized,
            epoch_id,
        }
    }

    /// Codifica os sentidos de saída e chegada em um único byte de 8 bits (ADR-003).
    /// - Bit 0: Saída (0 = CW, 1 = CCW)
    /// - Bit 1: Chegada (0 = CW, 1 = CCW)
    #[inline]
    pub fn pack_windings(&self) -> u8 {
        let dep = match self.departure_winding {
            WindingDirection::Clockwise => 0,
            WindingDirection::CounterClockwise => 1,
        };
        let arr = match self.arrival_winding {
            WindingDirection::Clockwise => 0,
            WindingDirection::CounterClockwise => 2,
        };
        dep | arr
    }

    /// Decodifica os sentidos de saída e chegada a partir de um byte empacotado.
    #[inline]
    pub fn unpack_windings(byte: u8) -> (WindingDirection, WindingDirection) {
        let dep = if (byte & 1) != 0 {
            WindingDirection::CounterClockwise
        } else {
            WindingDirection::Clockwise
        };
        let arr = if (byte & 2) != 0 {
            WindingDirection::CounterClockwise
        } else {
            WindingDirection::Clockwise
        };
        (dep, arr)
    }
}

/// Metadados descritivos de um carretel de fio.
#[derive(Debug, Clone, PartialEq)]
pub struct SpoolInfo {
    /// Identificador numérico do carretel.
    pub id: u8,
    /// Nome amigável (ex: "Amarelo Dourado", "Preto Intenso").
    pub name: String,
    /// Código de cor em hexadecimal (ex: "#ffd700", "#000000").
    pub color_hex: String,
    /// Comprimento customizado do cone em metros (se diferente do padrão).
    pub custom_spool_length_meters: Option<f64>,
    /// Espessura física do fio em milímetros (ex: 0.20 mm).
    pub thread_thickness_mm: Option<f64>,
    /// Opacidade fotométrica do fio em [0.0, 1.0].
    pub opacity: Option<f32>,
}

impl SpoolInfo {
    /// Cria uma nova especificação de carretel.
    pub fn new(id: u8, name: impl Into<String>, color_hex: impl Into<String>) -> Self {
        Self {
            id,
            name: name.into(),
            color_hex: color_hex.into(),
            custom_spool_length_meters: None,
            thread_thickness_mm: None,
            opacity: None,
        }
    }
}

/// Parâmetros de configuração para a calculadora de BOM e tempo.
#[derive(Debug, Clone, PartialEq)]
pub struct BomConfig {
    /// Margem de segurança de fio aplicada sobre o comprimento bruto (ex: 0.10 para +10%). Padrão: 0.10.
    pub safety_margin_ratio: f64,
    /// Comprimento nominal comercial do cone de carretel em metros. Padrão: 1000.0 m.
    pub standard_spool_length_meters: f64,
    /// Cadência média manual por passo/pino em segundos. Padrão: 4.5 s.
    pub seconds_per_step: f64,
    /// Tempo médio em segundos para troca de carretel, corte e amarração de nós. Padrão: 90.0 s.
    pub knot_and_switch_time_seconds: f64,
    /// Folga adicional por carretel em milímetros para sobras de nós. Padrão: 300.0 mm (0.3 m).
    pub tail_allowance_per_spool_mm: f64,
}

impl Default for BomConfig {
    fn default() -> Self {
        Self {
            safety_margin_ratio: 0.10,
            standard_spool_length_meters: 1000.0,
            seconds_per_step: 4.5,
            knot_and_switch_time_seconds: 90.0,
            tail_allowance_per_spool_mm: 300.0,
        }
    }
}

/// Item consolidado da lista de materiais (BOM) para um carretel individual.
#[derive(Debug, Clone, PartialEq)]
pub struct SpoolBomItem {
    pub spool_id: u8,
    pub spool_name: String,
    pub color_hex: String,
    /// Quantidade de cordas/linhas tecidas com esta cor.
    pub line_count: usize,
    /// Comprimento linear físico bruto somado em metros.
    pub raw_length_meters: f64,
    /// Comprimento com margem de segurança e sobras de amarração em metros.
    pub length_with_margin_meters: f64,
    /// Número inteiro de cones comerciais necessários (arredondado para cima).
    pub spools_needed: usize,
    /// Porcentagem de utilização da capacidade total adquirida (em %).
    pub spool_usage_percent: f64,
}

/// Detalhamento da estimativa de tempo de execução manual.
#[derive(Debug, Clone, PartialEq)]
pub struct TimeEstimate {
    /// Tempo ativo tecendo as cordas nos pinos em segundos.
    pub weaving_time_seconds: f64,
    /// Tempo despendido em amarrações, cortes e trocas de carretel em segundos.
    pub knot_and_switch_time_seconds: f64,
    /// Tempo total estimado de fabricação humana em segundos.
    pub total_time_seconds: f64,
    /// Tempo total formatado para humanos (ex: "4 h 32 min" ou "45 min" ou "30 s").
    pub formatted_total_time: String,
    /// Tempo tecendo formatado.
    pub formatted_weaving_time: String,
    /// Tempo em nós/trocas formatado.
    pub formatted_switch_time: String,
    /// Total de trocas de carretel ao longo da obra.
    pub total_switches: usize,
    /// Total de amarrações iniciais de novos carretéis.
    pub tie_ons: usize,
}

/// Resultado completo da análise de BOM e logística da obra.
#[derive(Debug, Clone, PartialEq)]
pub struct BomEstimate {
    pub total_chords: usize,
    pub total_raw_length_meters: f64,
    pub total_length_with_margin_meters: f64,
    pub spools: Vec<SpoolBomItem>,
    pub time_estimate: TimeEstimate,
}

/// Formata uma duração em segundos em uma string amigável para humanos (ex: "6 h 47 min", "15 min", "45 s").
pub fn format_duration(seconds: f64) -> String {
    let s = seconds.round().max(0.0) as u64;
    if s < 60 {
        return format!("{} s", s);
    }
    let h = s / 3600;
    let m = (s % 3600) / 60;
    if h == 0 {
        format!("{} min", m)
    } else if m == 0 {
        format!("{} h", h)
    } else {
        format!("{} h {} min", h, m)
    }
}

/// Calcula o comprimento físico real em milímetros (`mm`) de um único passo de tecelagem.
///
/// O cálculo soma:
/// 1. O segmento linear livre entre os pontos de tangência nos dois pinos cilíndricos.
/// 2. O arco de contorno de acomodação do fio no pino ($\approx \pi \cdot r_p$).
pub fn calculate_single_step_length_mm(loom: &LoomGeometry, step: &WeavingStep) -> f64 {
    let pin_radius = loom.spec.pin_diameter_mm / 2.0;
    let p_a = loom.pin_position(step.from_pin as usize);
    let p_b = loom.pin_position(step.to_pin as usize);

    let tangent_len = if let Some(tangent) = compute_tangent(
        p_a,
        step.departure_winding,
        p_b,
        step.arrival_winding,
        pin_radius,
    ) {
        tangent.length
    } else {
        // Pinos coincidentes ou distância menor que 2*rp: distância euclidiana simples
        let dx = p_b.0 - p_a.0;
        let dy = p_b.1 - p_a.1;
        (dx * dx + dy * dy).sqrt()
    };

    let wrap_arc = if pin_radius > 0.0 {
        PI * pin_radius
    } else {
        0.0
    };

    tangent_len + wrap_arc
}

/// Calcula o BOM (consumo de fio e carretéis) e a estimativa de tempo manual para a sequência de passos.
pub fn calculate_bom(
    loom: &LoomGeometry,
    steps: &[WeavingStep],
    config: &BomConfig,
    spool_infos: &[SpoolInfo],
) -> BomEstimate {
    let total_chords = steps.len();

    // Rastreia trocas e nós
    let mut tie_ons = 0usize;
    let mut total_switches = 0usize;
    let mut prev_spool: Option<u8> = None;
    let mut seen_spools = HashSet::new();

    // Acumuladores de comprimento bruto por spool_id
    // Usamos um mapa simples baseado em vetor para manter ordem determinística
    let mut spool_lines: std::collections::BTreeMap<u8, usize> = std::collections::BTreeMap::new();
    let mut spool_raw_mm: std::collections::BTreeMap<u8, f64> = std::collections::BTreeMap::new();

    for step in steps {
        if Some(step.spool_id) != prev_spool {
            if seen_spools.insert(step.spool_id) {
                tie_ons += 1;
            } else {
                total_switches += 1;
            }
            prev_spool = Some(step.spool_id);
        }

        *spool_lines.entry(step.spool_id).or_insert(0) += 1;

        let step_len_mm = calculate_single_step_length_mm(loom, step);
        *spool_raw_mm.entry(step.spool_id).or_insert(0.0) += step_len_mm;
    }

    // Identifica todos os spools a relatar: inclui todos os fornecidos em spool_infos + os que apareceram nos passos
    let mut all_spool_ids = Vec::new();
    for s in spool_infos {
        if !all_spool_ids.contains(&s.id) {
            all_spool_ids.push(s.id);
        }
    }
    for &id in spool_lines.keys() {
        if !all_spool_ids.contains(&id) {
            all_spool_ids.push(id);
        }
    }
    all_spool_ids.sort_unstable();

    let mut spool_items = Vec::new();
    let mut total_raw_meters = 0.0;
    let mut total_with_margin_meters = 0.0;

    for &spool_id in &all_spool_ids {
        let line_count = spool_lines.get(&spool_id).copied().unwrap_or(0);
        let raw_mm = spool_raw_mm.get(&spool_id).copied().unwrap_or(0.0);
        let raw_m = raw_mm / 1000.0;
        total_raw_meters += raw_m;

        let info = spool_infos.iter().find(|s| s.id == spool_id);
        let name = info
            .map(|s| s.name.clone())
            .unwrap_or_else(|| format!("Carretel #{}", spool_id));
        let color_hex = info
            .map(|s| s.color_hex.clone())
            .unwrap_or_else(|| "#000000".to_string());
        let spool_capacity = info
            .and_then(|s| s.custom_spool_length_meters)
            .unwrap_or(config.standard_spool_length_meters);

        let length_with_margin_m = if line_count > 0 {
            let tail_m = config.tail_allowance_per_spool_mm / 1000.0;
            raw_m * (1.0 + config.safety_margin_ratio) + tail_m
        } else {
            0.0
        };
        total_with_margin_meters += length_with_margin_m;

        let spools_needed = if length_with_margin_m > 0.0 {
            (length_with_margin_m / spool_capacity).ceil().max(1.0) as usize
        } else {
            0
        };

        let spool_usage_percent = if spools_needed > 0 {
            (length_with_margin_m / (spools_needed as f64 * spool_capacity)) * 100.0
        } else {
            0.0
        };

        spool_items.push(SpoolBomItem {
            spool_id,
            spool_name: name,
            color_hex,
            line_count,
            raw_length_meters: raw_m,
            length_with_margin_meters: length_with_margin_m,
            spools_needed,
            spool_usage_percent,
        });
    }

    // Cálculo do tempo
    let weaving_seconds = total_chords as f64 * config.seconds_per_step;
    // Cada amarração inicial (tie-on) e cada troca posterior (switch) consome knot_and_switch_time_seconds
    let total_knot_events = tie_ons + total_switches;
    let switch_seconds = total_knot_events as f64 * config.knot_and_switch_time_seconds;
    let total_seconds = weaving_seconds + switch_seconds;

    let time_estimate = TimeEstimate {
        weaving_time_seconds: weaving_seconds,
        knot_and_switch_time_seconds: switch_seconds,
        total_time_seconds: total_seconds,
        formatted_total_time: format_duration(total_seconds),
        formatted_weaving_time: format_duration(weaving_seconds),
        formatted_switch_time: format_duration(switch_seconds),
        total_switches,
        tie_ons,
    };

    BomEstimate {
        total_chords,
        total_raw_length_meters: total_raw_meters,
        total_length_with_margin_meters: total_with_margin_meters,
        spools: spool_items,
        time_estimate,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use weaver_domain::LoomPhysicalSpec;

    #[test]
    fn test_format_duration() {
        assert_eq!(format_duration(0.0), "0 s");
        assert_eq!(format_duration(45.2), "45 s");
        assert_eq!(format_duration(59.0), "59 s");
        assert_eq!(format_duration(59.9), "1 min");
        assert_eq!(format_duration(120.0), "2 min");
        assert_eq!(format_duration(3600.0), "1 h");
        assert_eq!(format_duration(3665.0), "1 h 1 min");
        assert_eq!(format_duration(16320.0), "4 h 32 min");
    }

    #[test]
    fn test_single_step_trigonometric_length_circle() {
        let spec = LoomPhysicalSpec::circle(711.2, 200, 2.0, 2.0, 15.0);
        let loom = LoomGeometry::new(spec);

        // Passo cruzando o diâmetro exato (pino 0 para pino 100)
        let step_cw = WeavingStep::new(
            0,
            0,
            100,
            0,
            WindingDirection::Clockwise,
            WindingDirection::Clockwise,
        );

        let len_cw = calculate_single_step_length_mm(&loom, &step_cw);
        // Distância entre centros = 711.2 mm. Tangente externa CW->CW = 711.2 mm.
        // Raio do pino = 1.0 mm. Arco de contorno = pi * 1.0 = ~3.14159 mm.
        // Comprimento total esperado = 711.2 + pi = ~714.34159 mm.
        let expected_len = 711.2 + PI * 1.0;
        assert!(
            (len_cw - expected_len).abs() < 1e-4,
            "Comprimento {} difere do esperado {}",
            len_cw,
            expected_len
        );

        // Passo cruzando tangente interna CW -> CCW
        let step_cross = WeavingStep::new(
            1,
            0,
            100,
            0,
            WindingDirection::Clockwise,
            WindingDirection::CounterClockwise,
        );
        let len_cross = calculate_single_step_length_mm(&loom, &step_cross);
        // Tangente interna = sqrt(711.2^2 - 4.0) = ~711.197187
        let expected_inner = (711.2f64 * 711.2f64 - 4.0f64).sqrt() + PI * 1.0;
        assert!((len_cross - expected_inner).abs() < 1e-4);
    }

    #[test]
    fn test_calculate_bom_and_time_estimate() {
        let spec = LoomPhysicalSpec::circle(711.2, 200, 2.0, 2.0, 15.0);
        let loom = LoomGeometry::new(spec);

        let spools = vec![
            SpoolInfo::new(0, "Amarelo", "#ffd700"),
            SpoolInfo::new(1, "Preto", "#000000"),
        ];

        // 10 passos no carretel 0 (Amarelo) + 10 passos no carretel 1 (Preto)
        let mut steps = Vec::new();
        for i in 0..10 {
            steps.push(WeavingStep::new(
                i,
                (i * 10) as u16,
                ((i * 10) + 100) as u16,
                0,
                WindingDirection::Clockwise,
                WindingDirection::Clockwise,
            ));
        }
        for i in 10..20 {
            steps.push(WeavingStep::new(
                i,
                (i * 10) as u16,
                ((i * 10) + 100) as u16,
                1,
                WindingDirection::CounterClockwise,
                WindingDirection::Clockwise,
            ));
        }

        let config = BomConfig {
            safety_margin_ratio: 0.10,
            standard_spool_length_meters: 100.0, // Cone pequeno de 100m para teste
            seconds_per_step: 4.5,
            knot_and_switch_time_seconds: 90.0,
            tail_allowance_per_spool_mm: 300.0,
        };

        let bom = calculate_bom(&loom, &steps, &config, &spools);

        assert_eq!(bom.total_chords, 20);
        assert_eq!(bom.spools.len(), 2);

        // Amarelo
        let yellow = &bom.spools[0];
        assert_eq!(yellow.spool_id, 0);
        assert_eq!(yellow.line_count, 10);
        // Cada corda ~ 0.71434 m -> 10 cordas ~ 7.1434 m
        assert!((yellow.raw_length_meters - 7.1434).abs() < 0.05);
        // Com margem (+10% + 0.3m sobra): 7.1434 * 1.1 + 0.3 = 8.1577 m
        assert!((yellow.length_with_margin_meters - 8.158).abs() < 0.05);
        assert_eq!(yellow.spools_needed, 1);
        assert!((yellow.spool_usage_percent - 8.16).abs() < 0.1);

        // Preto
        let black = &bom.spools[1];
        assert_eq!(black.spool_id, 1);
        assert_eq!(black.line_count, 10);
        assert_eq!(black.spools_needed, 1);

        // Tempo
        // 20 passos * 4.5 s = 90 s
        assert_eq!(bom.time_estimate.weaving_time_seconds, 90.0);
        // 2 amarrações iniciais (tie-ons) + 0 trocas adicionais (1 transição no total = 2 tie-ons: Amarelo e depois Preto)
        assert_eq!(bom.time_estimate.tie_ons, 2);
        assert_eq!(bom.time_estimate.total_switches, 0);
        // 2 eventos * 90 s = 180 s
        assert_eq!(bom.time_estimate.knot_and_switch_time_seconds, 180.0);
        // Total = 90 + 180 = 270 s = 4.5 min -> "4 min" ou "5 min"
        assert_eq!(bom.time_estimate.total_time_seconds, 270.0);
    }
}
