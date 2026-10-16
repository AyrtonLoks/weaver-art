//! Matriz Esparsa CSR de Cordas do Tear (ADR-001 e RNF-03).
//!
//! Armazena todas as cordas rasterizadas do tear em três vetores contíguos em memória,
//! eliminando alocações dinâmicas em tempo de execução e assegurando localidade estrita
//! de cache L1/L2 para os motores de otimização (solvers greedy, beam search e NNLS).

use crate::geometry::LoomGeometry;
use crate::matrix::rasterizer::{
    circular_pin_distance, LineRasterizer, LoomGridMapping, RasterizerType,
};
use crate::Pixels;

/// Matriz esparsa contígua em formato CSR (Compressed Sparse Row) armazenando
/// todas as cordas rasterizadas do tear.
///
/// Cada corda $k$ entre um par de pinos indexado canonicamente corresponde a uma
/// linha da matriz, cujos elementos não-nulos são os pixels interceptados pela corda.
/// O formato CSR armazena os dados em exatamente três vetores planos contíguos:
/// - `chord_offsets: Vec<u32>`: Delimitadores de início e fim na fatia de pixels da corda $k$.
/// - `pixel_indices: Vec<u32>`: Coordenadas lineares contíguas pré-calculadas ($y \times W + x$).
/// - `pixel_weights: Vec<u8>`: Coberturas ou opacidades fracionárias sub-pixel normais ($w \in [1, 255]$).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SparseChordMatrixCSR {
    /// Ponteiros de deslocamento para início/fim de cada corda $k$ (`offset[k]..offset[k+1]`).
    pub chord_offsets: Vec<u32>,
    /// Índices lineares contíguos dos pixels atravessados (`y * width + x`).
    pub pixel_indices: Vec<u32>,
    /// Pesos fracionários normais de cobertura ou anti-aliasing em `u8` (onde 255 = 100%).
    pub pixel_weights: Vec<u8>,
    /// Largura da grade discreta de simulação em pixels (`Px`).
    pub width: u32,
    /// Altura da grade discreta de simulação em pixels (`Px`).
    pub height: u32,
    /// Quantidade de pinos perimétricos $N$ do tear.
    pub pin_count: usize,
    /// Distância mínima perimétrica circular entre pinos ($d_{\min}$).
    pub min_pin_distance: usize,
}

impl SparseChordMatrixCSR {
    /// Constrói diretamente a matriz CSR a partir de vetores planos já alocados.
    pub fn new(
        chord_offsets: Vec<u32>,
        pixel_indices: Vec<u32>,
        pixel_weights: Vec<u8>,
        width: u32,
        height: u32,
        pin_count: usize,
        min_pin_distance: usize,
    ) -> Self {
        debug_assert_eq!(pixel_indices.len(), pixel_weights.len());
        Self {
            chord_offsets,
            pixel_indices,
            pixel_weights,
            width,
            height,
            pin_count,
            min_pin_distance,
        }
    }

    /// Pré-computa e constrói a matriz CSR completa para a geometria do tear, resolução e método dados.
    pub fn build(
        loom: &LoomGeometry,
        resolution: Pixels,
        min_pin_distance: usize,
        method: RasterizerType,
    ) -> Self {
        let width = resolution.0;
        let height = resolution.0;
        let mapping = LoomGridMapping::from_loom(loom, width, height);
        Self::build_with_mapping(loom, mapping, min_pin_distance, method)
    }

    /// Constrói a matriz CSR utilizando um mapeamento de coordenadas explícito.
    pub fn build_with_mapping(
        loom: &LoomGeometry,
        mapping: LoomGridMapping,
        min_pin_distance: usize,
        method: RasterizerType,
    ) -> Self {
        let n = loom.pin_count();
        let total_chords = (n * (n.saturating_sub(1))) / 2;

        let mut chord_offsets = Vec::with_capacity(total_chords + 1);
        chord_offsets.push(0);

        // Estimativa inicial de capacidade baseada no tamanho da grade
        let est_pixels_per_chord = match method {
            RasterizerType::BresenhamBinary => (mapping.width as usize) * 2 / 3,
            RasterizerType::XiaolinWuAntialiased => (mapping.width as usize) * 4 / 3,
        };
        let est_total_entries = (total_chords * est_pixels_per_chord).min(32 * 1024 * 1024);

        let mut pixel_indices = Vec::with_capacity(est_total_entries);
        let mut pixel_weights = Vec::with_capacity(est_total_entries);

        // Buffers temporários reutilizáveis para zero-allocation durante o loop de rasterização
        let max_line_len = (mapping.width as usize + mapping.height as usize) * 2;
        let mut temp_pixels = Vec::with_capacity(max_line_len);
        let mut temp_weights = Vec::with_capacity(max_line_len);

        for a in 0..n {
            let (ax_mm, ay_mm) = loom.pin_position(a);
            let (ax_px, ay_px) = mapping.mm_to_pixel(ax_mm, ay_mm);

            for b in (a + 1)..n {
                let dist = circular_pin_distance(a, b, n);
                if dist >= min_pin_distance {
                    let (bx_mm, by_mm) = loom.pin_position(b);
                    let (bx_px, by_px) = mapping.mm_to_pixel(bx_mm, by_mm);

                    temp_pixels.clear();
                    temp_weights.clear();

                    method.rasterize_line(
                        ax_px,
                        ay_px,
                        bx_px,
                        by_px,
                        mapping.width,
                        mapping.height,
                        &mut temp_pixels,
                        &mut temp_weights,
                    );

                    pixel_indices.extend_from_slice(&temp_pixels);
                    pixel_weights.extend_from_slice(&temp_weights);
                }

                chord_offsets.push(pixel_indices.len() as u32);
            }
        }

        pixel_indices.shrink_to_fit();
        pixel_weights.shrink_to_fit();
        chord_offsets.shrink_to_fit();

        Self {
            chord_offsets,
            pixel_indices,
            pixel_weights,
            width: mapping.width,
            height: mapping.height,
            pin_count: n,
            min_pin_distance,
        }
    }

    /// Mapeia o par de pinos `(pin_a, pin_b)` para seu índice canônico único $k \in [0, \binom{N}{2})$.
    ///
    /// Garante reciprocidade estrita $k(a, b) = k(b, a)$ em $O(1)$ aritmético sem tabelas de busca.
    #[inline]
    pub fn canonical_chord_index(pin_a: usize, pin_b: usize, pin_count: usize) -> usize {
        assert!(
            pin_a != pin_b,
            "Cordas exigem pinos distintos (pin_a = {}, pin_b = {})",
            pin_a,
            pin_b
        );
        assert!(
            pin_a < pin_count && pin_b < pin_count,
            "Índice de pino fora dos limites (pin_a={}, pin_b={}, pin_count={})",
            pin_a,
            pin_b,
            pin_count
        );
        let (min_pin, max_pin) = if pin_a < pin_b {
            (pin_a, pin_b)
        } else {
            (pin_b, pin_a)
        };
        min_pin * pin_count - (min_pin * (min_pin + 1)) / 2 + (max_pin - min_pin - 1)
    }

    /// Versão segura que retorna `None` caso os índices sejam inválidos ou coincidentes.
    #[inline]
    pub fn try_canonical_chord_index(
        pin_a: usize,
        pin_b: usize,
        pin_count: usize,
    ) -> Option<usize> {
        if pin_a == pin_b || pin_a >= pin_count || pin_b >= pin_count {
            return None;
        }
        let (min_pin, max_pin) = if pin_a < pin_b {
            (pin_a, pin_b)
        } else {
            (pin_b, pin_a)
        };
        Some(min_pin * pin_count - (min_pin * (min_pin + 1)) / 2 + (max_pin - min_pin - 1))
    }

    /// Reverte o índice canônico de corda $k$ para o par de pinos original $(a, b)$ com $a < b$.
    #[inline]
    pub fn canonical_chord_pins(chord_idx: usize, pin_count: usize) -> (usize, usize) {
        let n_f = pin_count as f64;
        let k_f = chord_idx as f64;
        let discriminant = (2.0 * n_f - 1.0).powi(2) - 8.0 * k_f;
        let a_candidate = ((2.0 * n_f - 1.0 - discriminant.max(0.0).sqrt()) / 2.0).floor() as usize;
        let a = a_candidate.min(pin_count.saturating_sub(2));
        let row_start = a * pin_count - (a * (a + 1)) / 2;
        let b = a + 1 + (chord_idx - row_start);
        (a, b)
    }

    /// Quantidade total de pares canônicos possíveis na matriz $\binom{N}{2}$.
    #[inline]
    pub fn chord_count(&self) -> usize {
        self.chord_offsets.len().saturating_sub(1)
    }

    /// Quantidade de cordas ativas não-vazias (com distância $\ge d_{\min}$).
    pub fn non_empty_chord_count(&self) -> usize {
        let mut count = 0;
        for i in 0..self.chord_count() {
            if self.chord_offsets[i + 1] > self.chord_offsets[i] {
                count += 1;
            }
        }
        count
    }

    /// Quantidade total de elementos não-nulos (pixels atravessados) armazenados.
    #[inline]
    pub fn total_pixel_entries(&self) -> usize {
        self.pixel_indices.len()
    }

    /// Retorna o consumo total de memória heap estrita em bytes (ADR-001 e RNF-03).
    #[inline]
    pub fn memory_usage_bytes(&self) -> usize {
        self.chord_offsets.len() * std::mem::size_of::<u32>()
            + self.pixel_indices.len() * std::mem::size_of::<u32>()
            + self.pixel_weights.len() * std::mem::size_of::<u8>()
    }

    /// Retorna as fatias contíguas de índices lineares e pesos para a corda de índice $k$.
    ///
    /// Operação zero-allocation de custo $O(1)$, retornando referências diretas à memória cache.
    #[inline]
    pub fn chord_slice(&self, chord_idx: usize) -> (&[u32], &[u8]) {
        if chord_idx + 1 >= self.chord_offsets.len() {
            return (&[], &[]);
        }
        let start = self.chord_offsets[chord_idx] as usize;
        let end = self.chord_offsets[chord_idx + 1] as usize;
        if start >= end || end > self.pixel_indices.len() {
            return (&[], &[]);
        }
        (
            &self.pixel_indices[start..end],
            &self.pixel_weights[start..end],
        )
    }

    /// Retorna os pixels e pesos de cobertura para a corda entre `pin_a` e `pin_b`.
    ///
    /// Cumpre o princípio da reciprocidade física: `get_chord(a, b) == get_chord(b, a)`.
    #[inline]
    pub fn get_chord(&self, pin_a: usize, pin_b: usize) -> (&[u32], &[u8]) {
        if let Some(idx) = Self::try_canonical_chord_index(pin_a, pin_b, self.pin_count) {
            self.chord_slice(idx)
        } else {
            (&[], &[])
        }
    }

    /// Retorna apenas a fatia de índices lineares de pixels para a corda $k$.
    #[inline]
    pub fn chord_pixels(&self, chord_idx: usize) -> &[u32] {
        self.chord_slice(chord_idx).0
    }

    /// Retorna apenas a fatia de pesos de cobertura para a corda $k$.
    #[inline]
    pub fn chord_weights(&self, chord_idx: usize) -> &[u8] {
        self.chord_slice(chord_idx).1
    }

    /// Retorna o número de pixels interceptados pela corda $k$.
    #[inline]
    pub fn chord_len(&self, chord_idx: usize) -> usize {
        if chord_idx + 1 >= self.chord_offsets.len() {
            0
        } else {
            (self.chord_offsets[chord_idx + 1] - self.chord_offsets[chord_idx]) as usize
        }
    }

    /// Verifica se a corda entre `pin_a` e `pin_b` é válida e não-vazia.
    #[inline]
    pub fn is_chord_valid(&self, pin_a: usize, pin_b: usize) -> bool {
        let (pixels, _) = self.get_chord(pin_a, pin_b);
        !pixels.is_empty()
    }

    /// Iterador conveniente sobre todas as cordas ativas (não-vazias) da matriz.
    ///
    /// Emite tuplas `(chord_index, (pin_a, pin_b), &[pixel_indices], &[pixel_weights])`.
    pub fn iter_chords(
        &self,
    ) -> impl Iterator<Item = (usize, (usize, usize), &[u32], &[u8])> + '_ {
        (0..self.chord_count()).filter_map(move |k| {
            let (indices, weights) = self.chord_slice(k);
            if indices.is_empty() {
                None
            } else {
                let pins = Self::canonical_chord_pins(k, self.pin_count);
                Some((k, pins, indices, weights))
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_canonical_index_roundtrip() {
        let pin_count = 50;
        let mut expected_k = 0;
        for a in 0..pin_count {
            for b in (a + 1)..pin_count {
                let k = SparseChordMatrixCSR::canonical_chord_index(a, b, pin_count);
                assert_eq!(k, expected_k);

                // Reciprocidade
                let k_rev = SparseChordMatrixCSR::canonical_chord_index(b, a, pin_count);
                assert_eq!(k_rev, k);

                // Reversão canônica
                let (ra, rb) = SparseChordMatrixCSR::canonical_chord_pins(k, pin_count);
                assert_eq!((ra, rb), (a, b));

                expected_k += 1;
            }
        }
        let total_pairs = (pin_count * (pin_count - 1)) / 2;
        assert_eq!(expected_k, total_pairs);
    }

    #[test]
    fn test_sparse_chord_matrix_csr_basic_properties() {
        let n = 20;
        let res = Pixels(100);
        let spec = crate::geometry::LoomPhysicalSpec::circle(200.0, n, 2.0, 2.0, 5.0);
        let loom = LoomGeometry::new(spec);

        let matrix =
            SparseChordMatrixCSR::build(&loom, res, 2, RasterizerType::XiaolinWuAntialiased);

        let expected_total_chords = (n * (n - 1)) / 2;
        assert_eq!(matrix.chord_count(), expected_total_chords);
        assert_eq!(matrix.chord_offsets.len(), expected_total_chords + 1);

        // Cordas com distância < 2 (adjacentes) devem estar vazias
        for i in 0..n {
            let next = (i + 1) % n;
            let (pixels, weights) = matrix.get_chord(i, next);
            assert!(pixels.is_empty(), "Corda adjacente ({}, {}) deveria estar vazia", i, next);
            assert!(weights.is_empty());
        }

        // Cordas distantes (ex: opostas diametrais i e (i + 10) % 20) devem conter pixels
        for i in 0..10 {
            let opp = i + 10;
            let (pixels, weights) = matrix.get_chord(i, opp);
            assert!(!pixels.is_empty(), "Corda oposta ({}, {}) não deveria estar vazia", i, opp);
            assert_eq!(pixels.len(), weights.len());

            // Reciprocidade estrita
            let (pixels_rev, weights_rev) = matrix.get_chord(opp, i);
            assert_eq!(pixels, pixels_rev);
            assert_eq!(weights, weights_rev);

            // Todos os pixels devem residir dentro de 100x100
            for &p in pixels {
                assert!(p < 100 * 100);
            }
        }
    }

    #[test]
    fn test_memory_ceiling_rnf03() {
        // Validação estrita do RNF-03:
        // Tear com N = 250 pinos, resolução 600x600 e min_pin_distance = 10.
        // O consumo total de memória deve caber estritamente no teto de ~130 MB.
        let n = 250;
        let res = Pixels(600);
        let spec = crate::geometry::LoomPhysicalSpec::circle(600.0, n, 2.0, 2.0, 10.0);
        let loom = LoomGeometry::new(spec);

        let matrix =
            SparseChordMatrixCSR::build(&loom, res, 10, RasterizerType::XiaolinWuAntialiased);

        let total_chords = matrix.chord_count();
        assert_eq!(total_chords, (250 * 249) / 2); // 31.125 cordas

        let non_empty = matrix.non_empty_chord_count();
        // 250 pinos * 18 pinos pulados / 2 = 2250 cordas puladas -> 28875 cordas ativas
        assert_eq!(non_empty, 31125 - 2250);

        let mem_bytes = matrix.memory_usage_bytes();
        let mem_mb = mem_bytes as f64 / (1024.0 * 1024.0);

        println!(
            "RNF-03 Benchmark: N=250, Res=600x600 -> Memória CSR = {:.2} MB ({} entradas de pixel)",
            mem_mb,
            matrix.total_pixel_entries()
        );

        // O teto estipulado é ~130 MB. Verificamos limite estrito de 135 MB.
        const CEILING_BYTES: usize = 135 * 1024 * 1024;
        assert!(
            mem_bytes <= CEILING_BYTES,
            "Consumo de memória CSR de {:.2} MB excedeu o teto RNF-03 de 130 MB",
            mem_mb
        );
        assert!(mem_mb > 50.0, "Consumo suspeitamente baixo de memória CSR");
    }
}
