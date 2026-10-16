//! As 5 Estratégias de Minimização de Trocas de Carretel (`spool_scheduler.rs`).
//!
//! Na tecelagem física real de String Art, cada troca de carretel exige corte manual da linha,
//! amarração do novo fio, ajuste de tensão e troca de carretel (consumindo de 1 a 3 minutos por troca).
//! Estratégias gulosas ingênuas que trocam de carretel a cada poucas linhas geram milhares de trocas,
//! tornando a confecção física inviável.
//!
//! Este módulo implementa as 5 estratégias fundamentais:
//! 1. `FreeGreedy`: $\lambda_{\text{troca}} = 0$ (avaliação livre sem penalidades).
//! 2. `HysteresisPenalty`: Aplica penalidade $-\lambda_{\text{troca}}$ ao ganho marginal quando $k \neq k_{\text{atual}}$.
//! 3. `MinRunLength`: Trava a avaliação no carretel ativo até cumprir uma cota mínima contígua $L_{\min}$ de fios.
//! 4. `CoarseToFineEpochs`: Divide os $K_{\max}$ passos em 3 épocas estruturadas (Base, Refino e Acabamento Topo K/W).
//! 5. `SeparatedChannels`: Executa cada cor em um único bloco sequencial ($M-1$ trocas totais), com compensação de oclusão.

use crate::optical_models::SpoolColor;

/// As 5 estratégias de troca de carretel suportadas.
#[derive(Debug, Clone, PartialEq)]
pub enum SpoolSwitchStrategy {
    /// Avaliação livre gulosa sem penalidade de troca ($\lambda = 0$).
    FreeGreedy,

    /// Penalidade de histerese dinâmica subtraída do ganho marginal se $k \neq k_{\text{atual}}$.
    HysteresisPenalty {
        penalty_lambda: f32,
    },

    /// Bloqueia a troca enquanto o carretel atual não atingir o tamanho mínimo de lote $L_{\min}$.
    MinRunLength {
        min_run_length: usize,
    },

    /// Épocas estruturadas Coarse-to-Fine:
    /// - Época 1 (Base Volume): Blocos longos de carretéis base cromáticos.
    /// - Época 2 (Refino Cromático): Blocos médios de carretéis base.
    /// - Época 3 (Acabamento Nitidez no Topo): Últimos ~15% forçam Preto (K) e opcionalmente Branco (W),
    ///   com elevação dinâmica do peso de bordas no mapa $W(x,y)$.
    CoarseToFineEpochs {
        base_ratio: f32,
        refine_ratio: f32,
        detail_top_ratio: f32,
        black_spool_id: u8,
        white_spool_id: Option<u8>,
        edge_importance_boost: f32,
    },

    /// Camadas sequenciais estritas em lote único por cor ($M - 1$ trocas totais no projeto).
    /// Aplica fator de compensação de oclusão para que camadas inferiores tenham densidade reforçada.
    SeparatedChannels {
        /// Cotas fracionárias de passos para cada carretel (soma deve ser 1.0).
        quotas: Vec<f32>,
        /// Fator de compensação de oclusão para camadas inferiores $\ge 1.0$.
        occlusion_compensation: f32,
    },
}

impl Default for SpoolSwitchStrategy {
    fn default() -> Self {
        Self::FreeGreedy
    }
}

/// Estado do escalonador de carretéis ao longo da execução da tecelagem.
#[derive(Debug, Clone, PartialEq)]
pub struct SpoolScheduler {
    pub strategy: SpoolSwitchStrategy,
    pub max_steps: usize,
    pub current_step: usize,
    pub active_spool_id: u8,
    pub consecutive_steps: usize,
    pub total_switches: usize,
}

impl SpoolScheduler {
    /// Cria um novo escalonador de carretéis.
    pub fn new(strategy: SpoolSwitchStrategy, max_steps: usize, initial_spool_id: u8) -> Self {
        Self {
            strategy,
            max_steps: max_steps.max(1),
            current_step: 0,
            active_spool_id: initial_spool_id,
            consecutive_steps: 0,
            total_switches: 0,
        }
    }

    /// Retorna a lista de IDs de carretéis permitidos para avaliação no passo atual.
    pub fn allowed_spools(&self, spools: &[SpoolColor]) -> Vec<u8> {
        if spools.is_empty() {
            return Vec::new();
        }

        let all_ids: Vec<u8> = spools.iter().map(|s| s.id).collect();

        match &self.strategy {
            SpoolSwitchStrategy::FreeGreedy => all_ids,

            SpoolSwitchStrategy::HysteresisPenalty { .. } => all_ids,

            SpoolSwitchStrategy::MinRunLength { min_run_length } => {
                if self.consecutive_steps < *min_run_length && self.current_step > 0 {
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
                let target_spool_id = Self::compute_epoch_spool(
                    self.current_step,
                    self.max_steps,
                    *base_ratio,
                    *refine_ratio,
                    *black_spool_id,
                    *white_spool_id,
                    spools,
                );
                vec![target_spool_id]
            }

            SpoolSwitchStrategy::SeparatedChannels { quotas, .. } => {
                let mut accumulated = 0.0f32;
                let total = self.max_steps as f32;
                let cur = self.current_step as f32;

                for (idx, &quota) in quotas.iter().enumerate() {
                    let next_accum = accumulated + quota * total;
                    if cur < next_accum || idx == quotas.len() - 1 {
                        let spool_id = spools.get(idx).map(|s| s.id).unwrap_or(0);
                        return vec![spool_id];
                    }
                    accumulated = next_accum;
                }
                vec![self.active_spool_id]
            }
        }
    }

    /// Calcula deterministicamente o carretel programado para a época atual.
    fn compute_epoch_spool(
        step: usize,
        max_steps: usize,
        base_ratio: f32,
        refine_ratio: f32,
        black_spool_id: u8,
        white_spool_id: Option<u8>,
        spools: &[SpoolColor],
    ) -> u8 {
        let chromatic: Vec<u8> = spools
            .iter()
            .map(|s| s.id)
            .filter(|&id| id != black_spool_id && Some(id) != white_spool_id)
            .collect();

        let progress = (step as f32) / (max_steps as f32);
        let epoch1_limit = base_ratio;
        let epoch2_limit = base_ratio + refine_ratio;

        if progress >= epoch2_limit {
            // Época 3 (Acabamento Nitidez no Topo):
            let epoch3_progress = (progress - epoch2_limit) / (1.0 - epoch2_limit).max(1e-4);
            if epoch3_progress < 0.85 || white_spool_id.is_none() {
                black_spool_id
            } else {
                white_spool_id.unwrap()
            }
        } else if chromatic.is_empty() {
            black_spool_id
        } else if progress < epoch1_limit {
            // Época 1 (Base Volume): Blocos longos por cor cromática
            let num_c = chromatic.len();
            let step_in_epoch1 = step as f32;
            let epoch1_total = (max_steps as f32) * epoch1_limit;
            let block_idx = ((step_in_epoch1 / epoch1_total.max(1.0)) * (num_c as f32)).floor() as usize;
            let idx = block_idx.min(num_c - 1);
            chromatic[idx]
        } else {
            // Época 2 (Refino Cromático): Blocos médios
            let num_c = chromatic.len();
            let step_in_epoch2 = (step as f32) - (max_steps as f32) * epoch1_limit;
            let epoch2_total = (max_steps as f32) * refine_ratio;
            let block_idx = ((step_in_epoch2 / epoch2_total.max(1.0)) * (num_c as f32)).floor() as usize;
            let idx = block_idx.min(num_c - 1);
            chromatic[idx]
        }
    }

    /// Retorna a penalidade algébrica de troca a ser subtraída do ganho marginal para o carretel candidato.
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

    /// Verifica se a estratégia atual requer elevação do mapa de bordas $W(p) \leftarrow W(p) + \Delta\beta \cdot E(p)$.
    ///
    /// Ativo na Época 3 de `CoarseToFineEpochs`.
    pub fn active_edge_boost(&self) -> f32 {
        match &self.strategy {
            SpoolSwitchStrategy::CoarseToFineEpochs {
                base_ratio,
                refine_ratio,
                edge_importance_boost,
                ..
            } => {
                let progress = (self.current_step as f32) / (self.max_steps as f32);
                if progress >= (*base_ratio + *refine_ratio) {
                    *edge_importance_boost
                } else {
                    0.0
                }
            }
            _ => 0.0,
        }
    }

    /// Fator de compensação de oclusão para o carretel ativo na estratégia `SeparatedChannels`.
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
                    1.0 + (*occlusion_compensation - 1.0) * (depth_from_top / ((total_spools - 1) as f32))
                }
            }
            _ => 1.0,
        }
    }

    /// Registra a aplicação de um passo de corda com o carretel escolhido.
    pub fn advance_step(&mut self, chosen_spool_id: u8, _spools: &[SpoolColor]) {
        if chosen_spool_id != self.active_spool_id {
            self.total_switches += 1;
            self.active_spool_id = chosen_spool_id;
            self.consecutive_steps = 1;
        } else {
            self.consecutive_steps += 1;
        }

        self.current_step += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use weaver_domain::LinearRgbColor;

    #[test]
    fn test_free_greedy_allows_all() {
        let spools = vec![
            SpoolColor::new(0, LinearRgbColor::new(1.0, 1.0, 0.0), 0.2), // Yellow
            SpoolColor::new(1, LinearRgbColor::new(1.0, 0.0, 1.0), 0.2), // Magenta
            SpoolColor::new(2, LinearRgbColor::new(0.0, 1.0, 1.0), 0.2), // Cyan
            SpoolColor::new(3, LinearRgbColor::BLACK, 0.3),              // Black
        ];

        let scheduler = SpoolScheduler::new(SpoolSwitchStrategy::FreeGreedy, 1000, 0);
        let allowed = scheduler.allowed_spools(&spools);
        assert_eq!(allowed.len(), 4);
        assert_eq!(scheduler.switch_penalty(1), 0.0);
    }

    #[test]
    fn test_hysteresis_penalty() {
        let scheduler = SpoolScheduler::new(
            SpoolSwitchStrategy::HysteresisPenalty {
                penalty_lambda: 0.25,
            },
            1000,
            0,
        );
        assert_eq!(scheduler.switch_penalty(0), 0.0);
    }

    #[test]
    fn test_min_run_length_locks_active() {
        let spools = vec![
            SpoolColor::new(0, LinearRgbColor::new(1.0, 1.0, 0.0), 0.2),
            SpoolColor::new(1, LinearRgbColor::BLACK, 0.3),
        ];

        let mut scheduler = SpoolScheduler::new(
            SpoolSwitchStrategy::MinRunLength { min_run_length: 50 },
            1000,
            0,
        );

        scheduler.advance_step(0, &spools);
        let allowed = scheduler.allowed_spools(&spools);
        assert_eq!(allowed, vec![0]);

        for _ in 1..50 {
            scheduler.advance_step(0, &spools);
        }
        let allowed_after = scheduler.allowed_spools(&spools);
        assert_eq!(allowed_after.len(), 2);
    }

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
            assert!(!allowed.is_empty(), "Deve sempre haver ao menos um carretel disponível");
            let chosen = allowed[0];
            scheduler.advance_step(chosen, &spools);
        }

        assert_eq!(scheduler.current_step, 6000);
        assert!(
            scheduler.total_switches < 15,
            "CoarseToFineEpochs gerou {} trocas, esperado < 15 trocas!",
            scheduler.total_switches
        );
        // Na reta final, carretel ativo deve ser o Preto (K = 3)
        assert_eq!(scheduler.active_spool_id, 3);
        // Na reta final o boost de bordas deve estar ativo
        assert!(scheduler.active_edge_boost() > 0.0);
    }

    #[test]
    fn test_separated_channels_exact_switches() {
        let spools = vec![
            SpoolColor::new(0, LinearRgbColor::new(1.0, 1.0, 0.0), 0.2), // Y
            SpoolColor::new(1, LinearRgbColor::new(1.0, 0.0, 1.0), 0.2), // M
            SpoolColor::new(2, LinearRgbColor::new(0.0, 1.0, 1.0), 0.2), // C
            SpoolColor::new(3, LinearRgbColor::BLACK, 0.3),              // K
        ];

        let mut scheduler = SpoolScheduler::new(
            SpoolSwitchStrategy::SeparatedChannels {
                quotas: vec![0.30, 0.15, 0.20, 0.35],
                occlusion_compensation: 1.5,
            },
            1000,
            0,
        );

        for _ in 0..1000 {
            let allowed = scheduler.allowed_spools(&spools);
            let chosen = allowed[0];
            scheduler.advance_step(chosen, &spools);
        }

        // Com 4 cores em camadas sequenciais puras, temos exatamente M - 1 = 3 trocas!
        assert_eq!(scheduler.total_switches, 3);
        assert_eq!(scheduler.active_spool_id, 3); // Termina no Preto (K)
    }
}
