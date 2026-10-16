//! Codec de Retomada Stateless e Compressor Binário de Sequências de Tecelagem (`resume_codec.rs`).
//!
//! Fornece duas ferramentas fundamentais de sincronização e compartilhamento serverless:
//! 1. `ProgressToken`: Token ultra-compacto no formato `WA1-<project_hash>-<spool_idx>-<step_idx>`
//!    para sincronização do progresso manual entre dispositivos via URL hash (`#progress=...`).
//! 2. `compress_steps` / `decompress_steps`: Compressor binário compacto utilizando Delta Encoding
//!    dos índices perimétricos de pinos e Run-Length Encoding (RLE) das cores dos carretéis, codificado
//!    em Base64URL sem dependências externas, ideal para QR Code e compartilhamento P2P.

use std::fmt;
use weaver_domain::{LoomGeometry, WindingDirection};

use crate::bom_calculator::WeavingStep;

/// Erros possíveis na decodificação de tokens ou descompressão de sequências binárias.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResumeCodecError {
    /// Formato inválido da string do token.
    InvalidFormat(String),
    /// Caracteres inválidos na decodificação Base64URL.
    InvalidBase64,
    /// Cabeçalho binário incompatível (magic bytes divergentes de 'WA').
    InvalidMagic,
    /// Versão do codec não suportada.
    UnsupportedVersion(u8),
    /// Fluxo de bytes truncado prematuramente.
    TruncatedData,
    /// Dados binários corrompidos ou inconsistentes.
    CorruptedData(String),
}

impl fmt::Display for ResumeCodecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidFormat(msg) => write!(f, "Formato de token de retomada inválido: {}", msg),
            Self::InvalidBase64 => write!(f, "Decodificação Base64URL falhou: caracteres inválidos"),
            Self::InvalidMagic => write!(f, "Cabeçalho binário inválido: magic bytes incompatíveis"),
            Self::UnsupportedVersion(v) => write!(f, "Versão de codec não suportada: {}", v),
            Self::TruncatedData => write!(f, "Dados truncados inesperadamente durante a descompressão"),
            Self::CorruptedData(msg) => write!(f, "Dados binários corrompidos: {}", msg),
        }
    }
}

impl std::error::Error for ResumeCodecError {}

/// Token de sincronização de progresso leve para retomada via URL hash (`#progress=...`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgressToken {
    /// Hash determinístico identificador da geometria do tear e da obra.
    pub project_hash: String,
    /// Índice do carretel/cor atualmente ativo.
    pub spool_idx: u8,
    /// Índice do passo atual na sequência (0-indexed).
    pub step_idx: usize,
}

impl ProgressToken {
    /// Cria uma nova instância do token de progresso.
    pub fn new(project_hash: impl Into<String>, spool_idx: u8, step_idx: usize) -> Self {
        Self {
            project_hash: project_hash.into(),
            spool_idx,
            step_idx,
        }
    }

    /// Codifica o token no formato canônico `WA1-<project_hash>-<spool_idx>-<step_idx>`.
    pub fn encode(&self) -> String {
        format!("WA1-{}-{}-{}", self.project_hash, self.spool_idx, self.step_idx)
    }

    /// Decodifica o token a partir de uma string ou fragmento de URL hash (`#progress=...` ou direto).
    pub fn decode(input: &str) -> Result<Self, ResumeCodecError> {
        let raw = input.trim();
        let token_str = if let Some(stripped) = raw.strip_prefix("#progress=") {
            stripped
        } else if let Some(stripped) = raw.strip_prefix("progress=") {
            stripped
        } else {
            raw
        };

        let parts: Vec<&str> = token_str.split('-').collect();
        if parts.len() != 4 {
            return Err(ResumeCodecError::InvalidFormat(format!(
                "Esperado 4 segmentos separados por hífen ('WA1-<hash>-<spool>-<step>'), obtido {}",
                parts.len()
            )));
        }

        if parts[0] != "WA1" {
            return Err(ResumeCodecError::InvalidFormat(format!(
                "Prefixo de versão deve ser 'WA1', obtido '{}'",
                parts[0]
            )));
        }

        let project_hash = parts[1].to_string();
        if project_hash.is_empty() {
            return Err(ResumeCodecError::InvalidFormat(
                "Hash do projeto não pode ser vazio".to_string(),
            ));
        }

        let spool_idx: u8 = parts[2].parse().map_err(|_| {
            ResumeCodecError::InvalidFormat(format!(
                "Índice de carretel '{}' não é um u8 válido",
                parts[2]
            ))
        })?;

        let step_idx: usize = parts[3].parse().map_err(|_| {
            ResumeCodecError::InvalidFormat(format!(
                "Índice de passo '{}' não é um número inteiro válido",
                parts[3]
            ))
        })?;

        Ok(Self {
            project_hash,
            spool_idx,
            step_idx,
        })
    }
}

/// Calcula um hash determinístico FNV-1a de 64 bits para o projeto (geometria e passos).
pub fn compute_project_hash(loom: &LoomGeometry, steps: &[WeavingStep]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;

    // Hash da especificação mecânica do tear
    let pin_count = loom.pins().len() as u64;
    for b in pin_count.to_le_bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(PRIME);
    }
    let diam_bits = loom.spec.diameter_mm.to_bits();
    for b in diam_bits.to_le_bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(PRIME);
    }
    let pin_diam_bits = loom.spec.pin_diameter_mm.to_bits();
    for b in pin_diam_bits.to_le_bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(PRIME);
    }

    // Hash da sequência de passos
    for s in steps {
        for b in (s.from_pin as u64).to_le_bytes() {
            hash ^= b as u64;
            hash = hash.wrapping_mul(PRIME);
        }
        for b in (s.to_pin as u64).to_le_bytes() {
            hash ^= b as u64;
            hash = hash.wrapping_mul(PRIME);
        }
        hash ^= s.spool_id as u64;
        hash = hash.wrapping_mul(PRIME);
        hash ^= s.departure_winding.as_i8() as u8 as u64;
        hash = hash.wrapping_mul(PRIME);
        hash ^= s.arrival_winding.as_i8() as u8 as u64;
        hash = hash.wrapping_mul(PRIME);
    }

    format!("{:016x}", hash)
}

// -----------------------------------------------------------------------------
// Base64URL (RFC 4648 sem padding) Puro em Rust
// -----------------------------------------------------------------------------

const BASE64URL_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Codifica bytes em string Base64URL sem padding.
pub fn base64url_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() * 4 + 2) / 3);
    let mut i = 0;
    while i < data.len() {
        let b0 = data[i] as usize;
        let b1 = if i + 1 < data.len() {
            data[i + 1] as usize
        } else {
            0
        };
        let b2 = if i + 2 < data.len() {
            data[i + 2] as usize
        } else {
            0
        };

        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(BASE64URL_ALPHABET[(triple >> 18) & 0x3F] as char);
        out.push(BASE64URL_ALPHABET[(triple >> 12) & 0x3F] as char);

        if i + 1 < data.len() {
            out.push(BASE64URL_ALPHABET[(triple >> 6) & 0x3F] as char);
        }
        if i + 2 < data.len() {
            out.push(BASE64URL_ALPHABET[triple & 0x3F] as char);
        }

        i += 3;
    }
    out
}

/// Decodifica uma string Base64URL (com ou sem padding) para vetor de bytes.
pub fn base64url_decode(input: &str) -> Result<Vec<u8>, ResumeCodecError> {
    fn decode_char(c: u8) -> Result<u8, ResumeCodecError> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'-' => Ok(62),
            b'_' => Ok(63),
            b'=' => Ok(0),
            _ => Err(ResumeCodecError::InvalidBase64),
        }
    }

    let bytes = input.trim_end_matches('=').as_bytes();
    if bytes.is_empty() {
        return Ok(Vec::new());
    }

    let mut out = Vec::with_capacity((bytes.len() * 3) / 4);
    let mut i = 0;
    while i < bytes.len() {
        let rem = bytes.len() - i;
        if rem == 1 {
            return Err(ResumeCodecError::InvalidBase64);
        }

        let c0 = decode_char(bytes[i])? as u32;
        let c1 = decode_char(bytes[i + 1])? as u32;

        if rem == 2 {
            let triple = (c0 << 18) | (c1 << 12);
            out.push(((triple >> 16) & 0xFF) as u8);
            break;
        } else if rem == 3 {
            let c2 = decode_char(bytes[i + 2])? as u32;
            let triple = (c0 << 18) | (c1 << 12) | (c2 << 6);
            out.push(((triple >> 16) & 0xFF) as u8);
            out.push(((triple >> 8) & 0xFF) as u8);
            break;
        } else {
            let c2 = decode_char(bytes[i + 2])? as u32;
            let c3 = decode_char(bytes[i + 3])? as u32;
            let triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
            out.push(((triple >> 16) & 0xFF) as u8);
            out.push(((triple >> 8) & 0xFF) as u8);
            out.push((triple & 0xFF) as u8);
            i += 4;
        }
    }
    Ok(out)
}

// -----------------------------------------------------------------------------
// Codificador / Decodificador de Varint U32
// -----------------------------------------------------------------------------

fn write_varint_u32(val: u32, buf: &mut Vec<u8>) {
    let mut v = val;
    while v >= 0x80 {
        buf.push(((v & 0x7F) as u8) | 0x80);
        v >>= 7;
    }
    buf.push(v as u8);
}

fn read_varint_u32(buf: &[u8], offset: &mut usize) -> Result<u32, ResumeCodecError> {
    let mut res: u32 = 0;
    let mut shift = 0;
    loop {
        if *offset >= buf.len() {
            return Err(ResumeCodecError::TruncatedData);
        }
        let b = buf[*offset];
        *offset += 1;
        res |= ((b & 0x7F) as u32) << shift;
        if (b & 0x80) == 0 {
            break;
        }
        shift += 7;
        if shift > 35 {
            return Err(ResumeCodecError::CorruptedData(
                "Varint overflow excedeu 32 bits".to_string(),
            ));
        }
    }
    Ok(res)
}

// -----------------------------------------------------------------------------
// Compressor e Descompressor Binário de Sequências de Passos
// -----------------------------------------------------------------------------

/// Comprime uma sequência completa de passos de tecelagem em uma string Base64URL compacta.
///
/// Formato binário:
/// - Magic: `b"WA"` (`0x57, 0x41`)
/// - Versão: `1u8`
/// - Número total de pinos: `u16` (big-endian)
/// - Contagem de passos: Varint
/// - Blocos de Cores Run-Length:
///   - Quantidade de blocos: Varint
///   - Para cada bloco: `spool_id: u8` + `run_length: Varint`
/// - Trajetória de Pinos (Delta Encoding):
///   - Para cada passo:
///     - `flags: u8`: Bit 0 = departure CCW, Bit 1 = arrival CCW, Bit 2 = is_continuation, Bit 3 = has_score
///     - Se `!is_continuation`: `from_pin: Varint`
///     - `delta: Varint` onde `to_pin = (from_pin + delta) % peg_count`
///     - Se `has_score`: `score_normalized: Varint`
pub fn compress_steps(steps: &[WeavingStep], peg_count: u16) -> String {
    let mut buf = Vec::with_capacity(steps.len() * 3 + 32);

    // 1. Cabeçalho
    buf.push(b'W');
    buf.push(b'A');
    buf.push(1); // Versão 1
    buf.extend_from_slice(&peg_count.to_be_bytes());
    write_varint_u32(steps.len() as u32, &mut buf);

    if steps.is_empty() {
        return base64url_encode(&buf);
    }

    // 2. Run-Length Encoding (RLE) das cores dos carretéis
    let mut runs: Vec<(u8, u32)> = Vec::new();
    let mut current_spool = steps[0].spool_id;
    let mut current_count = 0u32;

    for s in steps {
        if s.spool_id == current_spool {
            current_count += 1;
        } else {
            runs.push((current_spool, current_count));
            current_spool = s.spool_id;
            current_count = 1;
        }
    }
    runs.push((current_spool, current_count));

    write_varint_u32(runs.len() as u32, &mut buf);
    for (spool_id, count) in runs {
        buf.push(spool_id);
        write_varint_u32(count, &mut buf);
    }

    // 3. Trajetória de Pinos com Delta Encoding e Sentidos CW/CCW
    for (i, s) in steps.iter().enumerate() {
        let is_cont = i > 0 && steps[i - 1].to_pin == s.from_pin;
        let has_score = s.score_normalized > 0;

        let dep_bit = if s.departure_winding == WindingDirection::CounterClockwise {
            1
        } else {
            0
        };
        let arr_bit = if s.arrival_winding == WindingDirection::CounterClockwise {
            2
        } else {
            0
        };
        let cont_bit = if is_cont { 4 } else { 0 };
        let score_bit = if has_score { 8 } else { 0 };

        let flags = dep_bit | arr_bit | cont_bit | score_bit;
        buf.push(flags);

        if !is_cont {
            write_varint_u32(s.from_pin as u32, &mut buf);
        }

        // Delta perimétrico modular no sentido horário/avançado
        let delta = if peg_count > 0 {
            (s.to_pin as i32 - s.from_pin as i32).rem_euclid(peg_count as i32) as u32
        } else {
            0
        };
        write_varint_u32(delta, &mut buf);

        if has_score {
            write_varint_u32(s.score_normalized as u32, &mut buf);
        }
    }

    base64url_encode(&buf)
}

/// Descomprime uma string Base64URL recuperando o total de pinos do tear e a sequência original de passos.
pub fn decompress_steps(encoded: &str) -> Result<(u16, Vec<WeavingStep>), ResumeCodecError> {
    let buf = base64url_decode(encoded)?;
    if buf.len() < 5 {
        return Err(ResumeCodecError::TruncatedData);
    }

    // 1. Cabeçalho
    if buf[0] != b'W' || buf[1] != b'A' {
        return Err(ResumeCodecError::InvalidMagic);
    }
    let version = buf[2];
    if version != 1 {
        return Err(ResumeCodecError::UnsupportedVersion(version));
    }

    let peg_count = u16::from_be_bytes([buf[3], buf[4]]);
    let mut offset = 5;

    let total_steps = read_varint_u32(&buf, &mut offset)? as usize;
    if total_steps == 0 {
        return Ok((peg_count, Vec::new()));
    }

    // 2. Decodifica Run-Length das cores
    let num_runs = read_varint_u32(&buf, &mut offset)? as usize;
    let mut spool_ids = Vec::with_capacity(total_steps);

    for _ in 0..num_runs {
        if offset >= buf.len() {
            return Err(ResumeCodecError::TruncatedData);
        }
        let spool_id = buf[offset];
        offset += 1;
        let count = read_varint_u32(&buf, &mut offset)? as usize;
        for _ in 0..count {
            spool_ids.push(spool_id);
        }
    }

    if spool_ids.len() != total_steps {
        return Err(ResumeCodecError::CorruptedData(format!(
            "Soma dos comprimentos das meadas ({}) difere do total de passos ({})",
            spool_ids.len(),
            total_steps
        )));
    }

    // 3. Decodifica Trajetória de Pinos
    let mut steps = Vec::with_capacity(total_steps);
    let mut prev_to_pin = 0u16;

    for i in 0..total_steps {
        if offset >= buf.len() {
            return Err(ResumeCodecError::TruncatedData);
        }
        let flags = buf[offset];
        offset += 1;

        let dep = if (flags & 1) != 0 {
            WindingDirection::CounterClockwise
        } else {
            WindingDirection::Clockwise
        };
        let arr = if (flags & 2) != 0 {
            WindingDirection::CounterClockwise
        } else {
            WindingDirection::Clockwise
        };
        let is_cont = (flags & 4) != 0;
        let has_score = (flags & 8) != 0;

        let from_pin = if is_cont && i > 0 {
            prev_to_pin
        } else {
            read_varint_u32(&buf, &mut offset)? as u16
        };

        let delta = read_varint_u32(&buf, &mut offset)?;
        let to_pin = if peg_count > 0 {
            ((from_pin as u32 + delta) % peg_count as u32) as u16
        } else {
            0
        };

        let score = if has_score {
            read_varint_u32(&buf, &mut offset)? as u16
        } else {
            0
        };

        let spool_id = spool_ids[i];
        prev_to_pin = to_pin;

        steps.push(WeavingStep::with_details(
            i,
            from_pin,
            to_pin,
            spool_id,
            dep,
            arr,
            score,
            spool_id,
        ));
    }

    Ok((peg_count, steps))
}

#[cfg(test)]
mod tests {
    use super::*;
    use weaver_domain::LoomPhysicalSpec;

    #[test]
    fn test_progress_token_encode_decode() {
        let token = ProgressToken::new("7b9f1a2c3d4e5f60", 2, 450);
        let encoded = token.encode();
        assert_eq!(encoded, "WA1-7b9f1a2c3d4e5f60-2-450");

        // Decodificação direta
        let decoded = ProgressToken::decode(&encoded).unwrap();
        assert_eq!(decoded, token);

        // Decodificação a partir de hash URL "#progress=..."
        let url_hash = "#progress=WA1-7b9f1a2c3d4e5f60-2-450";
        let decoded_url = ProgressToken::decode(url_hash).unwrap();
        assert_eq!(decoded_url, token);

        // Erros de sintaxe
        assert!(ProgressToken::decode("invalid-token").is_err());
        assert!(ProgressToken::decode("WA2-abc-1-2").is_err());
        assert!(ProgressToken::decode("WA1--1-2").is_err());
        assert!(ProgressToken::decode("WA1-abc-not_a_num-2").is_err());
    }

    #[test]
    fn test_base64url_round_trip() {
        let test_cases: Vec<&[u8]> = vec![
            b"",
            b"f",
            b"fo",
            b"foo",
            b"foob",
            b"fooba",
            b"foobar",
            b"Weaver Art Petros Vrellis String Art Generator",
            &[0x00, 0xFF, 0xFE, 0xFD, 0x12, 0x34, 0x56, 0x78],
        ];

        for original in test_cases {
            let encoded = base64url_encode(original);
            // Garante que é URL-safe (sem '+' nem '/' nem '=')
            assert!(!encoded.contains('+'));
            assert!(!encoded.contains('/'));
            assert!(!encoded.contains('='));

            let decoded = base64url_decode(&encoded).expect("Decodificação bem-sucedida");
            assert_eq!(decoded, original);
        }
    }

    #[test]
    fn test_compress_decompress_round_trip_exact() {
        let peg_count = 200u16;

        // Sequência com 15 passos contínuos e descontinuados, cores variadas, CW e CCW, com scores
        let original_steps = vec![
            WeavingStep::with_details(0, 0, 100, 0, WindingDirection::Clockwise, WindingDirection::Clockwise, 1500, 0),
            WeavingStep::with_details(1, 100, 25, 0, WindingDirection::Clockwise, WindingDirection::CounterClockwise, 2000, 0),
            WeavingStep::with_details(2, 25, 175, 0, WindingDirection::CounterClockwise, WindingDirection::CounterClockwise, 0, 0),
            // Salto não contínuo (nova amarração ou troca de carretel)
            WeavingStep::with_details(3, 10, 120, 1, WindingDirection::Clockwise, WindingDirection::Clockwise, 500, 1),
            WeavingStep::with_details(4, 120, 30, 1, WindingDirection::Clockwise, WindingDirection::CounterClockwise, 32000, 1),
            WeavingStep::with_details(5, 30, 190, 2, WindingDirection::CounterClockwise, WindingDirection::Clockwise, 4000, 2),
        ];

        let compressed = compress_steps(&original_steps, peg_count);
        assert!(!compressed.is_empty());

        let (decoded_pegs, decoded_steps) = decompress_steps(&compressed).expect("Descompressão sem erro");
        assert_eq!(decoded_pegs, peg_count);
        assert_eq!(decoded_steps.len(), original_steps.len());

        for (orig, dec) in original_steps.iter().zip(decoded_steps.iter()) {
            assert_eq!(dec.step_index, orig.step_index);
            assert_eq!(dec.from_pin, orig.from_pin);
            assert_eq!(dec.to_pin, orig.to_pin);
            assert_eq!(dec.spool_id, orig.spool_id);
            assert_eq!(dec.departure_winding, orig.departure_winding);
            assert_eq!(dec.arrival_winding, orig.arrival_winding);
            assert_eq!(dec.score_normalized, orig.score_normalized);
        }
    }

    #[test]
    fn test_compute_project_hash_determinism() {
        let spec = LoomPhysicalSpec::circle(711.2, 200, 2.0, 2.0, 15.0);
        let loom = LoomGeometry::new(spec);

        let steps = vec![
            WeavingStep::new(0, 0, 100, 0, WindingDirection::Clockwise, WindingDirection::Clockwise),
            WeavingStep::new(1, 100, 50, 0, WindingDirection::Clockwise, WindingDirection::Clockwise),
        ];

        let hash1 = compute_project_hash(&loom, &steps);
        let hash2 = compute_project_hash(&loom, &steps);

        assert_eq!(hash1, hash2);
        assert_eq!(hash1.len(), 16);
    }
}
