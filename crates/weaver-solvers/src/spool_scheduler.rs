//! As 5 Estratégias de Minimização de Trocas de Carretel (`spool_scheduler.rs`).

use crate::optical_models::SpoolColor;

#[derive(Debug, Clone, PartialEq)]
pub enum SpoolSwitchStrategy {
    FreeGreedy,
    HysteresisPenalty {
        penalty_lambda: f32,
    },
    MinRunLength {
        min_run_length: usize,
    },
    CoarseToFineEpochs {
        base_ratio: f32,
        refine_ratio: f32,
        detail_top_ratio: f32,
        black_spool_id: u8,
        white_spool_id: Option<u8>,
        edge_importance_boost: f32,
    },
    SeparatedChannels {
        quotas: Vec<f32>,
        occlusion_compensation: f32,
    },
}

impl Default for SpoolSwitchStrategy {
    fn default() -> Self {
        Self::FreeGreedy
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpoolScheduler {
    pub strategy: SpoolSwitchStrategy,
    pub max_steps: usize,
    pub current_step: usize,
    /// Passo virtual usado para saltar blocos quando um carretel satura prematuramente.
    pub schedule_cursor: usize,
    pub active_spool_id: u8,
    pub consecutive_steps: usize,
    pub total_switches: usize,
    saturated_spools: Vec<u8>,
}

impl SpoolScheduler {
    pub fn new(strategy: SpoolSwitchStrategy, max_steps: usize, initial_spool_id: u8) -> Self {
        Self {
            strategy,
            max_steps: max_steps.max(1),
            current_step: 0,
            schedule_cursor: 0,
            active_spool_id: initial_spool_id,
            consecutive_steps: 0,
            total_switches: 0,
            saturated_spools: Vec::new(),
        }
    }

    pub fn allowed_spools(&self, spools: &[SpoolColor]) -> Vec<u8> {
        if spools.is_empty() {
            return Vec::new();
        }

        let all_ids: Vec<u8> = spools
            .iter()
            .map(|s| s.id)
            .filter(|id| !self.saturated_spools.contains(id))
            .collect();

        if all_ids.is_empty() {
            return Vec::new();
        }

        match &self.strategy {
            SpoolSwitchStrategy::FreeGreedy | SpoolSwitchStrategy::HysteresisPenalty { .. } => {
                all_ids
            }

            SpoolSwitchStrategy::MinRunLength { min_run_length } => {
                if self.consecutive_steps < *min_run_length
                    && self.current_step > 0
                    && !self.saturated_spools.contains(&self.active_spool_id)
                {
                    vec![self.active_spool_id]
                } else {
                    all_ids
                }
            }

            SpoolSwitchStrategy::CoarseToFineEpochs {
                base_ratio,
                refine_ratio,
                black_spool_id,
                white_spool_id,
                ..
            } => {
                let cursor = self.schedule_cursor.max(self.current_step);
                let target_spool_id = Self::compute_epoch_spool(
                    cursor,
                    self.max_steps,
                    *base_ratio,
                    *refine_ratio,
                    *black_spool_id,
                    *white_spool_id,
                    spools,
                );
                if self.saturated_spools.contains(&target_spool_id) {
                    // Avança para o próximo carretel na ordem das camadas (Y -> M -> C -> K)
                    vec![all_ids[0]]
                } else {
                    vec![target_spool_id]
                }
            }

            SpoolSwitchStrategy::SeparatedChannels { quotas, .. } => {
                let mut accumulated = 0.0f32;
                let total = self.max_steps as f32;
                let cur = self.schedule_cursor.max(self.current_step) as f32;

                for (idx, &quota) in quotas.iter().enumerate() {
                    let next_accum = accumulated + quota * total;
                    if cur < next_accum || idx == quotas.len() - 1 {
                        let spool_id = spools.get(idx).map(|s| s.id).unwrap_or(0);
                        if !self.saturated_spools.contains(&spool_id) {
                            return vec![spool_id];
                        }
                    }
                    accumulated = next_accum;
                }
                vec![all_ids[0]]
            }
        }
    }

    /// Quando o carretel atual não possui mais cordas com ganho positivo,
    /// avança o cursor de agendamento para o próximo bloco/cor e transfere (rollover)
    /// o saldo restante para a camada final Preta (K).
    pub fn skip_saturated_spool(&mut self, spools: &[SpoolColor]) -> bool {
        let current_allowed = self.allowed_spools(spools);
        if current_allowed.is_empty() {
            return false;
        }
        for id in &current_allowed {
            if !self.saturated_spools.contains(id) {
                self.saturated_spools.push(*id);
            }
        }

        // Avança o cursor até encontrar a janela do próximo carretel na sequência
        let step_inc = (self.max_steps / 50).max(1);
        let mut cursor = self.schedule_cursor.max(self.current_step);
        while cursor < self.max_steps {
            cursor = (cursor + step_inc).min(self.max_steps);
            self.schedule_cursor = cursor;
            let next_allowed = self.allowed_spools(spools);
            if !next_allowed.is_empty() && next_allowed != current_allowed {
                break;
            }
        }

        !self.allowed_spools(spools).is_empty()
    }

    /// Calcula deterministicamente o carretel programado para a época atual,
    /// respeitando a Invariante de Camadas Sequenciais (AGENTS.md Seção 2):
    /// Cores luminosas primeiro (Amarelo -> Magenta -> Ciano) e Preto (K) por último
    /// (com saldo dinâmico de rollover e época final de alta nitidez nas bordas faciais).
    fn compute_epoch_spool(
        step: usize,
        max_steps: usize,
        _base_ratio: f32,
        _refine_ratio: f32,
        black_spool_id: u8,
        white_spool_id: Option<u8>,
        spools: &[SpoolColor],
    ) -> u8 {
        let chromatic: Vec<u8> = spools
            .iter()
            .map(|s| s.id)
            .filter(|&id| id != black_spool_id && Some(id) != white_spool_id)
            .collect();

        if chromatic.is_empty() {
            return black_spool_id;
        }

        let progress = ((step as f32) / (max_steps as f32).max(1.0)).clamp(0.0, 1.0);

        // Cronograma Físico de Camadas Sequenciais (Padrão Petros Vrellis / CMYK):
        // 1. [0.00 .. 0.58]: Camadas Cromáticas Luminosas (Amarelo 18% -> Magenta 20% -> Ciano 20%)
        // 2. [0.58 .. 0.78]: Camada Preta Estrutural (20% K para sombras e volume anatômico)
        // 3. [0.78 .. 1.00]: Camada Preta de Nitidez Facial (22% K com boost de bordas para olhos, óculos e boca)
        let cmy_total_ratio = 0.58f32;
        if progress < cmy_total_ratio {
            let n = chromatic.len();
            if n == 3 {
                if progress < 0.18 {
                    chromatic[0] // Amarelo (Y)
                } else if progress < 0.38 {
                    chromatic[1] // Magenta (M)
                } else {
                    chromatic[2] // Ciano (C)
                }
            } else {
                let c_prog = progress / cmy_total_ratio;
                let idx = ((c_prog * (n as f32)).floor() as usize).min(n - 1);
                chromatic[idx]
            }
        } else {
            if let Some(w_id) = white_spool_id {
                if progress >= 0.94 {
                    return w_id;
                }
            }
            black_spool_id
        }
    }

    #[inline]
    pub fn switch_penalty(&self, candidate_spool_id: u8) -> f32 {
        if candidate_spool_id == self.active_spool_id || self.current_step == 0 {
            0.0
        } else {
            match &self.strategy {
                SpoolSwitchStrategy::HysteresisPenalty { penalty_lambda } => *penalty_lambda,
                _ => 0.0,
            }
        }
    }

    pub fn active_edge_boost(&self) -> f32 {
        match &self.strategy {
            SpoolSwitchStrategy::CoarseToFineEpochs {
                base_ratio,
                refine_ratio,
                edge_importance_boost,
                ..
            } => {
                let progress = (self.schedule_cursor.max(self.current_step) as f32)
                    / (self.max_steps as f32).max(1.0);
                let detail_start = (*base_ratio + *refine_ratio).clamp(0.58, 0.85);
                if progress >= detail_start {
                    *edge_importance_boost
                } else if progress >= 0.58 {
                    *edge_importance_boost * 0.45
                } else {
                    0.0
                }
            }
            _ => 0.0,
        }
    }

    pub fn occlusion_compensation_factor(&self, spool_idx: usize, total_spools: usize) -> f32 {
        match &self.strategy {
            SpoolSwitchStrategy::SeparatedChannels {
                occlusion_compensation,
                ..
            } => {
                if total_spools <= 1 {
                    1.0
                } else {
                    let depth_from_top = (total_spools - 1 - spool_idx) as f32;
                    1.0 + (*occlusion_compensation - 1.0)
                        * (depth_from_top / ((total_spools - 1) as f32))
                }
            }
            _ => 1.0,
        }
    }

    pub fn advance_step(&mut self, chosen_spool_id: u8, _spools: &[SpoolColor]) {
        if self.current_step == 0 {
            self.active_spool_id = chosen_spool_id;
            self.consecutive_steps = 1;
        } else if chosen_spool_id != self.active_spool_id {
            self.total_switches += 1;
            self.active_spool_id = chosen_spool_id;
            self.consecutive_steps = 1;
        } else {
            self.consecutive_steps += 1;
        }

        self.current_step += 1;
        self.schedule_cursor = (self.schedule_cursor + 1).max(self.current_step);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use weaver_domain::LinearRgbColor;

    #[test]
    fn test_coarse_to_fine_epochs_under_15_switches_in_6000_steps() {
        let spools = vec![
            SpoolColor::new(0, LinearRgbColor::new(1.0, 1.0, 0.0), 0.2), // Y
            SpoolColor::new(1, LinearRgbColor::new(1.0, 0.0, 1.0), 0.2), // M
            SpoolColor::new(2, LinearRgbColor::new(0.0, 1.0, 1.0), 0.2), // C
            SpoolColor::new(3, LinearRgbColor::BLACK, 0.3),              // K
        ];

        let mut scheduler = SpoolScheduler::new(
            SpoolSwitchStrategy::CoarseToFineEpochs {
                base_ratio: 0.65,
                refine_ratio: 0.20,
                detail_top_ratio: 0.15,
                black_spool_id: 3,
                white_spool_id: None,
                edge_importance_boost: 2.5,
            },
            6000,
            0,
        );

        for _ in 0..6000 {
            let allowed = scheduler.allowed_spools(&spools);
            assert!(!allowed.is_empty());
            let chosen = allowed[0];
            scheduler.advance_step(chosen, &spools);
        }

        assert_eq!(scheduler.current_step, 6000);
        assert!(scheduler.total_switches < 15);
        assert_eq!(scheduler.active_spool_id, 3);
    }
}
