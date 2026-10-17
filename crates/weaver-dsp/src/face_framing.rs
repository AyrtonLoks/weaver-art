//! Enquadramento pelo rosto (`face_framing.rs`).
//!
//! String art só fica reconhecível quando o **rosto** ocupa quase todo o aro: olhos, boca e
//! óculos precisam ter dezenas de milímetros para que o fio consiga desenhá-los. Este módulo
//! localiza o rosto com o detector clássico de **Viola-Jones** (cascata Haar frontal do OpenCV,
//! convertida para tabelas estáticas em [`crate::haar_frontalface`]) — puro Rust, roda em Wasm,
//! funciona em tons de cinza e por isso é robusto à cor da iluminação — e calcula o zoom/pan
//! que faz o rosto ocupar a fração pedida do diâmetro do tear.

use crate::haar_frontalface::{FEATURES, RECTS, STAGES, WEAK, WINDOW};
use crate::image::Rgba8Image;

/// Região do rosto detectada, em pixels da imagem de origem.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FaceRegion {
    /// `[x0, y0, x1, y1]` da caixa do detector (aprox. sobrancelhas → boca, bochecha → bochecha).
    pub bbox: [f32; 4],
    /// Centro da caixa.
    pub center: (f32, f32),
    /// Confiança heurística em `[0, 1]` (número de detecções agrupadas).
    pub confidence: f32,
}

/// Lado máximo da cópia reduzida usada na detecção (rostos de retrato continuam ≫ 24 px).
const WORK_MAX_SIDE: u32 = 360;
/// Fator entre escalas consecutivas da janela.
const SCALE_FACTOR: f32 = 1.12;
/// Detecções vizinhas mínimas para aceitar um rosto (equivalente ao `minNeighbors` do OpenCV).
const MIN_NEIGHBORS: usize = 3;

/// Imagem integral (soma e soma dos quadrados) com uma linha/coluna extra de zeros.
struct Integral {
    w: usize,
    sum: Vec<f64>,
    sq: Vec<f64>,
}

impl Integral {
    fn new(gray: &[f32], w: usize, h: usize) -> Self {
        let iw = w + 1;
        let mut sum = vec![0.0f64; iw * (h + 1)];
        let mut sq = vec![0.0f64; iw * (h + 1)];
        for y in 0..h {
            let mut rs = 0.0f64;
            let mut rq = 0.0f64;
            for x in 0..w {
                let v = gray[y * w + x] as f64;
                rs += v;
                rq += v * v;
                sum[(y + 1) * iw + x + 1] = sum[y * iw + x + 1] + rs;
                sq[(y + 1) * iw + x + 1] = sq[y * iw + x + 1] + rq;
            }
        }
        Self { w: iw, sum, sq }
    }

    #[inline]
    fn rect(&self, t: &[f64], x: usize, y: usize, w: usize, h: usize) -> f64 {
        let (a, b) = (y * self.w + x, y * self.w + x + w);
        let (c, d) = ((y + h) * self.w + x, (y + h) * self.w + x + w);
        t[d] - t[b] - t[c] + t[a]
    }
}

/// Feature escalada: até 3 retângulos `(x, y, w, h, peso)` relativos à janela.
#[derive(Clone, Copy)]
struct ScaledFeature {
    n: usize,
    r: [(usize, usize, usize, usize, f64); 3],
}

/// Pré-escala todas as features para uma janela de lado `24 · s` (mesma regra do OpenCV:
/// o peso do primeiro retângulo é recalculado para manter a feature de média zero).
fn scale_features(s: f32, inv_area: f64) -> Vec<ScaledFeature> {
    let win = (WINDOW as f32 * s).round() as usize;
    FEATURES
        .iter()
        .map(|&(first, count)| {
            let mut f = ScaledFeature {
                n: count as usize,
                r: [(0, 0, 0, 0, 0.0); 3],
            };
            let mut area0 = 1.0f64;
            let mut sum0 = 0.0f64;
            for k in 0..count as usize {
                let (x, y, w, h, wt) = RECTS[first as usize + k];
                let sx = ((x as f32 * s).round() as usize).min(win - 1);
                let sy = ((y as f32 * s).round() as usize).min(win - 1);
                let sw = ((w as f32 * s).round() as usize).clamp(1, win - sx);
                let sh = ((h as f32 * s).round() as usize).clamp(1, win - sy);
                let weight = wt as f64 * inv_area;
                if k == 0 {
                    area0 = (sw * sh) as f64;
                } else {
                    sum0 += weight * (sw * sh) as f64;
                }
                f.r[k] = (sx, sy, sw, sh, weight);
            }
            f.r[0].4 = -sum0 / area0;
            f
        })
        .collect()
}

/// Avalia a cascata na janela com canto em `(x, y)`.
fn passes_cascade(
    ii: &Integral,
    feats: &[ScaledFeature],
    x: usize,
    y: usize,
    border: usize,
    inner: usize,
    inv_area: f64,
) -> bool {
    let s = ii.rect(&ii.sum, x + border, y + border, inner, inner);
    let q = ii.rect(&ii.sq, x + border, y + border, inner, inner);
    let mean = s * inv_area;
    let var = q * inv_area - mean * mean;
    let norm = if var > 0.0 { var.sqrt() } else { 1.0 };
    for &(first, count, stage_thr) in STAGES.iter() {
        let mut stage_sum = 0.0f64;
        for wk in &WEAK[first as usize..(first + count) as usize] {
            let f = &feats[wk.0 as usize];
            let mut v = 0.0f64;
            for k in 0..f.n {
                let (rx, ry, rw, rh, wt) = f.r[k];
                v += ii.rect(&ii.sum, x + rx, y + ry, rw, rh) * wt;
            }
            stage_sum += if v < wk.1 as f64 * norm {
                wk.2 as f64
            } else {
                wk.3 as f64
            };
        }
        if stage_sum < stage_thr as f64 {
            return false;
        }
    }
    true
}

/// Agrupa detecções semelhantes (centro e tamanho próximos) e devolve `(caixa média, vizinhos)`.
fn group_rects(rects: &[[f32; 3]]) -> Vec<([f32; 3], usize)> {
    let mut groups: Vec<(Vec<[f32; 3]>, [f32; 3])> = Vec::new();
    for r in rects {
        let (cx, cy, s) = (r[0] + r[2] * 0.5, r[1] + r[2] * 0.5, r[2]);
        let found = groups.iter_mut().find(|(_, g)| {
            let (gx, gy, gs) = (g[0] + g[2] * 0.5, g[1] + g[2] * 0.5, g[2]);
            let tol = 0.25 * s.min(gs);
            (cx - gx).abs() <= tol && (cy - gy).abs() <= tol && (s / gs).max(gs / s) <= 1.35
        });
        match found {
            Some((members, g)) => {
                members.push(*r);
                let n = members.len() as f32;
                *g = [
                    members.iter().map(|m| m[0]).sum::<f32>() / n,
                    members.iter().map(|m| m[1]).sum::<f32>() / n,
                    members.iter().map(|m| m[2]).sum::<f32>() / n,
                ];
            }
            None => groups.push((vec![*r], *r)),
        }
    }
    groups.into_iter().map(|(m, g)| (g, m.len())).collect()
}

/// Fração da menor caixa coberta pela interseção das duas (detecta sobreposição e aninhamento).
fn overlap_ratio(a: &[f32; 3], b: &[f32; 3]) -> f32 {
    let ix = (a[0] + a[2]).min(b[0] + b[2]) - a[0].max(b[0]);
    let iy = (a[1] + a[2]).min(b[1] + b[2]) - a[1].max(b[1]);
    if ix <= 0.0 || iy <= 0.0 {
        return 0.0;
    }
    ix * iy / (a[2] * a[2]).min(b[2] * b[2])
}

/// Converte para tons de cinza reduzidos (média de blocos), lado máximo `WORK_MAX_SIDE`.
fn gray_downsample(image: &Rgba8Image) -> (Vec<f32>, usize, usize, f32) {
    let max_side = image.width.max(image.height).max(1);
    let scale = (max_side as f32 / WORK_MAX_SIDE as f32).max(1.0);
    let w = ((image.width as f32 / scale).round() as usize).max(1);
    let h = ((image.height as f32 / scale).round() as usize).max(1);
    let mut out = vec![0.0f32; w * h];
    for y in 0..h {
        let sy0 = (y as f32 * scale) as u32;
        let sy1 = (((y + 1) as f32 * scale) as u32).clamp(sy0 + 1, image.height);
        for x in 0..w {
            let sx0 = (x as f32 * scale) as u32;
            let sx1 = (((x + 1) as f32 * scale) as u32).clamp(sx0 + 1, image.width);
            let mut acc = 0.0f32;
            let mut n = 0.0f32;
            for sy in sy0..sy1 {
                for sx in sx0..sx1 {
                    let p = image.get_pixel(sx, sy);
                    acc += 0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32;
                    n += 1.0;
                }
            }
            out[y * w + x] = acc / n.max(1.0);
        }
    }
    (out, w, h, scale)
}

/// Detecta todos os rostos frontais. Retorna caixas em pixels da imagem de origem,
/// ordenadas da mais confiável/maior para a menor.
pub fn detect_faces(image: &Rgba8Image) -> Vec<FaceRegion> {
    if image.width < WINDOW || image.height < WINDOW {
        return Vec::new();
    }
    let (gray, w, h, img_scale) = gray_downsample(image);
    let ii = Integral::new(&gray, w, h);
    let mut hits: Vec<[f32; 3]> = Vec::new();

    let mut s = 1.0f32;
    while (WINDOW as f32 * s).round() as usize <= w.min(h) {
        let win = (WINDOW as f32 * s).round() as usize;
        let border = (s.round() as usize).max(1);
        let inner = ((WINDOW as f32 - 2.0) * s).round() as usize;
        let inv_area = 1.0 / (inner * inner).max(1) as f64;
        let feats = scale_features(s, inv_area);
        let step = ((s * 1.5).round() as usize).max(1);
        let mut y = 0;
        while y + win <= h {
            let mut x = 0;
            while x + win <= w {
                if passes_cascade(&ii, &feats, x, y, border, inner, inv_area) {
                    hits.push([x as f32, y as f32, win as f32]);
                }
                x += step;
            }
            y += step;
        }
        s *= SCALE_FACTOR;
    }

    let mut groups: Vec<([f32; 3], usize)> = group_rects(&hits)
        .into_iter()
        .filter(|(_, n)| *n >= MIN_NEIGHBORS)
        .collect();
    // Supressão de caixas sobrepostas/aninhadas: mantém a de mais detecções vizinhas
    groups.sort_by_key(|g| std::cmp::Reverse(g.1));
    let mut kept: Vec<([f32; 3], usize)> = Vec::new();
    for g in groups {
        if !kept.iter().any(|k| overlap_ratio(&k.0, &g.0) > 0.3) {
            kept.push(g);
        }
    }
    let mut faces: Vec<(f32, FaceRegion)> = kept
        .into_iter()
        .map(|(g, n)| {
            let (x, y, side) = (g[0] * img_scale, g[1] * img_scale, g[2] * img_scale);
            let region = FaceRegion {
                bbox: [x, y, x + side, y + side],
                center: (x + side * 0.5, y + side * 0.5),
                confidence: (n as f32 / 12.0).min(1.0),
            };
            // Prioriza o rosto maior (mais próximo da câmera); detecções vizinhas pesam pouco
            (side * (n.min(12) as f32).powf(0.25), region)
        })
        .collect();
    faces.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    faces.into_iter().map(|(_, f)| f).collect()
}

/// Rosto principal (o maior/mais confiável), se houver.
pub fn detect_face_region(image: &Rgba8Image) -> Option<FaceRegion> {
    detect_faces(image).into_iter().next()
}

/// Extensão do rosto usada no enquadramento, em múltiplos do lado da caixa do detector
/// (a caixa Haar vai das sobrancelhas a abaixo da boca, de bochecha a bochecha).
/// Calibrado visualmente: a caixa ocupando ~95 % do aro deu o retrato mais reconhecível.
const FACE_HEIGHT_PER_BOX: f32 = 1.0;
/// Deslocamento vertical do centro do enquadramento em relação ao centro da caixa (queixo abaixo).
const FACE_CENTER_SHIFT_PER_BOX: f32 = 0.05;

/// Zoom e pan (convenções de `apply_affine_transform`) para o rosto (testa → queixo) ocupar
/// `fill_ratio` do diâmetro do tear, centralizado.
pub fn face_framing_from_region(
    region: &FaceRegion,
    image_width: u32,
    image_height: u32,
    fill_ratio: f32,
) -> (f32, f32, f32) {
    let r_in = image_width.min(image_height) as f32 * 0.5;
    let side = (region.bbox[2] - region.bbox[0]).max(1.0);
    let face_h = side * FACE_HEIGHT_PER_BOX;
    let zoom = (fill_ratio.clamp(0.4, 1.3) * 2.0 * r_in / face_h).clamp(0.3, 10.0);
    let cx = region.center.0;
    let cy = region.center.1 + side * FACE_CENTER_SHIFT_PER_BOX;
    let c_in_x = (image_width as f32 - 1.0) * 0.5;
    let c_in_y = (image_height as f32 - 1.0) * 0.5;
    let pan_x = ((c_in_x - cx) / r_in).clamp(-3.0, 3.0);
    let pan_y = ((c_in_y - cy) / r_in).clamp(-3.0, 3.0);
    (zoom, pan_x, pan_y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cascade_tables_are_consistent() {
        for &(first, count, _) in STAGES.iter() {
            assert!((first + count) as usize <= WEAK.len());
        }
        for w in WEAK.iter() {
            assert!((w.0 as usize) < FEATURES.len());
        }
        for &(first, count) in FEATURES.iter() {
            assert!((2..=3).contains(&count));
            for k in 0..count as usize {
                let (x, y, w, h, _) = RECTS[first as usize + k];
                assert!(x as u32 + w as u32 <= WINDOW && y as u32 + h as u32 <= WINDOW);
            }
        }
    }

    #[test]
    fn uniform_and_noise_images_have_no_faces() {
        let flat = Rgba8Image::fill(240, 240, 4, 128u8);
        assert!(detect_faces(&flat).is_empty());
        let mut noise = Rgba8Image::fill(240, 240, 4, 255u8);
        let mut seed = 12345u32;
        for y in 0..240 {
            for x in 0..240 {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
                let v = (seed >> 16) as u8;
                noise.set_pixel(x, y, &[v, v, v, 255]);
            }
        }
        assert!(detect_faces(&noise).len() <= 1);
    }

    #[test]
    fn framing_fills_requested_ratio() {
        let region = FaceRegion {
            bbox: [150.0, 100.0, 250.0, 200.0],
            center: (200.0, 150.0),
            confidence: 1.0,
        };
        let (zoom, pan_x, pan_y) = face_framing_from_region(&region, 400, 600, 0.9);
        let face_h = 100.0 * FACE_HEIGHT_PER_BOX;
        let out_fraction = face_h * zoom / 400.0;
        assert!((out_fraction - 0.9).abs() < 1e-3, "fração={out_fraction}");
        assert!(pan_x.abs() < 0.01, "rosto centrado em x");
        assert!(pan_y > 0.0, "rosto acima do centro da foto: pan_y positivo");
    }
}
