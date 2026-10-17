//! Métricas de qualidade da tecelagem (`telemetry_metrics.rs`).
//!
//! Reescrito para medir o que o olho vê, contra a **foto enquadrada** (referência sem realces):
//!
//! - Tanto a tela simulada quanto a referência são desfocadas por uma gaussiana
//!   ($\sigma \approx$ `resolução / 250` px, ≈ 2,4 mm num tear de 600 mm), simulando a obra vista
//!   à distância — fios individuais não são estrutura da imagem.
//! - **SSIM** padrão (janela gaussiana $\sigma = 1{,}5$) sobre a luma sRGB.
//! - **RMSE** sobre a luma sRGB.
//! - **ΔE\*76** médio em CIELAB.
//!
//! Tudo é calculado apenas dentro do disco inscrito do tear. O cálculo completo custa
//! $O(W \cdot H)$ e por isso é feito a cada `interval` passos e ao final da execução.

use weaver_domain::{delta_e_76, linear_to_srgb_channel, LinearRgbColor};

use crate::state_matrix::CanvasStateSoA;

/// Instantâneo das métricas de telemetria da tecelagem.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TelemetrySnapshot {
    pub ssim: f32,
    pub rmse: f32,
    pub delta_e: f32,
}

impl Default for TelemetrySnapshot {
    fn default() -> Self {
        Self {
            ssim: 0.0,
            rmse: 1.0,
            delta_e: 100.0,
        }
    }
}

fn gaussian_kernel(sigma: f32) -> Vec<f32> {
    let r = (sigma * 3.0).ceil().max(1.0) as i32;
    let mut k: Vec<f32> = (-r..=r)
        .map(|i| (-((i * i) as f32) / (2.0 * sigma * sigma)).exp())
        .collect();
    let s: f32 = k.iter().sum();
    k.iter_mut().for_each(|v| *v /= s);
    k
}

/// Desfoque gaussiano separável com borda replicada.
pub fn gaussian_blur(src: &[f32], w: usize, h: usize, sigma: f32) -> Vec<f32> {
    if sigma <= 0.0 || w == 0 || h == 0 {
        return src.to_vec();
    }
    let k = gaussian_kernel(sigma);
    let r = (k.len() / 2) as i32;
    let mut tmp = vec![0.0f32; w * h];
    let mut out = vec![0.0f32; w * h];
    for y in 0..h {
        let row = y * w;
        for x in 0..w {
            let mut acc = 0.0;
            for (j, &kv) in k.iter().enumerate() {
                let sx = (x as i32 + j as i32 - r).clamp(0, w as i32 - 1) as usize;
                acc += src[row + sx] * kv;
            }
            tmp[row + x] = acc;
        }
    }
    for y in 0..h {
        for x in 0..w {
            let mut acc = 0.0;
            for (j, &kv) in k.iter().enumerate() {
                let sy = (y as i32 + j as i32 - r).clamp(0, h as i32 - 1) as usize;
                acc += tmp[sy * w + x] * kv;
            }
            out[y * w + x] = acc;
        }
    }
    out
}

/// SSIM padrão (Wang et al. 2004, janela gaussiana σ = 1,5) médio dentro da máscara.
pub fn ssim_masked(a: &[f32], b: &[f32], w: usize, h: usize, mask: &[bool]) -> f32 {
    let c1 = 0.01f32 * 0.01;
    let c2 = 0.03f32 * 0.03;
    let mu_a = gaussian_blur(a, w, h, 1.5);
    let mu_b = gaussian_blur(b, w, h, 1.5);
    let aa: Vec<f32> = a.iter().map(|v| v * v).collect();
    let bb: Vec<f32> = b.iter().map(|v| v * v).collect();
    let ab: Vec<f32> = a.iter().zip(b).map(|(x, y)| x * y).collect();
    let saa = gaussian_blur(&aa, w, h, 1.5);
    let sbb = gaussian_blur(&bb, w, h, 1.5);
    let sab = gaussian_blur(&ab, w, h, 1.5);
    let mut sum = 0.0f64;
    let mut n = 0usize;
    for i in 0..w * h {
        if !mask[i] {
            continue;
        }
        let va = (saa[i] - mu_a[i] * mu_a[i]).max(0.0);
        let vb = (sbb[i] - mu_b[i] * mu_b[i]).max(0.0);
        let cov = sab[i] - mu_a[i] * mu_b[i];
        let s = ((2.0 * mu_a[i] * mu_b[i] + c1) * (2.0 * cov + c2))
            / ((mu_a[i] * mu_a[i] + mu_b[i] * mu_b[i] + c1) * (va + vb + c2));
        sum += s as f64;
        n += 1;
    }
    if n == 0 {
        1.0
    } else {
        (sum / n as f64) as f32
    }
}

/// Máscara do disco inscrito (raio 0,47 · lado) na grade de simulação.
pub fn inscribed_disc_mask(w: usize, h: usize) -> Vec<bool> {
    let cx = (w as f32 - 1.0) * 0.5;
    let cy = (h as f32 - 1.0) * 0.5;
    let r = w.min(h) as f32 * 0.47;
    (0..w * h)
        .map(|i| {
            let x = (i % w) as f32 - cx;
            let y = (i / w) as f32 - cy;
            x * x + y * y <= r * r
        })
        .collect()
}

/// Avaliador de métricas contra a referência (foto enquadrada).
#[derive(Debug, Clone)]
pub struct MetricsTracker {
    pub width: usize,
    pub height: usize,
    /// Recalcula as métricas a cada `interval` passos.
    pub interval: usize,
    sigma_view: f32,
    mask: Vec<bool>,
    ref_r: Vec<f32>,
    ref_g: Vec<f32>,
    ref_b: Vec<f32>,
    ref_luma_srgb_blur: Vec<f32>,
    steps_since_update: usize,
    last: TelemetrySnapshot,
}

impl MetricsTracker {
    /// Cria o rastreador usando o alvo da tela como referência (substituível por `set_reference`).
    pub fn new(state: &CanvasStateSoA) -> Self {
        let width = state.width_px as usize;
        let height = state.height_px as usize;
        let n = width * height;
        let reference: Vec<LinearRgbColor> = (0..n).map(|p| state.target_color(p)).collect();
        let mut t = Self {
            width,
            height,
            interval: 250,
            sigma_view: (width.min(height) as f32 / 250.0).max(0.8),
            mask: inscribed_disc_mask(width, height),
            ref_r: Vec::new(),
            ref_g: Vec::new(),
            ref_b: Vec::new(),
            ref_luma_srgb_blur: Vec::new(),
            steps_since_update: 0,
            last: TelemetrySnapshot::default(),
        };
        t.set_reference(&reference);
        t.last = t.compute(state);
        t
    }

    /// Define a imagem de referência (foto enquadrada, em luz linear).
    pub fn set_reference(&mut self, reference: &[LinearRgbColor]) {
        assert_eq!(reference.len(), self.width * self.height);
        let (w, h, s) = (self.width, self.height, self.sigma_view);
        let r: Vec<f32> = reference.iter().map(|c| c.r).collect();
        let g: Vec<f32> = reference.iter().map(|c| c.g).collect();
        let b: Vec<f32> = reference.iter().map(|c| c.b).collect();
        self.ref_r = gaussian_blur(&r, w, h, s);
        self.ref_g = gaussian_blur(&g, w, h, s);
        self.ref_b = gaussian_blur(&b, w, h, s);
        self.ref_luma_srgb_blur = (0..w * h)
            .map(|i| {
                linear_to_srgb_channel(
                    0.2126 * self.ref_r[i] + 0.7152 * self.ref_g[i] + 0.0722 * self.ref_b[i],
                )
            })
            .collect();
    }

    /// Calcula todas as métricas para o estado atual da tela.
    pub fn compute(&self, state: &CanvasStateSoA) -> TelemetrySnapshot {
        self.compute_masked(state, &self.mask)
    }

    /// Calcula as métricas apenas nos pixels de mask (ex.: região do rosto).
    pub fn compute_masked(&self, state: &CanvasStateSoA, mask: &[bool]) -> TelemetrySnapshot {
        let (w, h, s) = (self.width, self.height, self.sigma_view);
        let n = w * h;
        let cr = gaussian_blur(&state.current_c0[..n], w, h, s);
        let cg = gaussian_blur(&state.current_c1[..n], w, h, s);
        let cb = gaussian_blur(&state.current_c2[..n], w, h, s);
        let luma: Vec<f32> = (0..n)
            .map(|i| linear_to_srgb_channel(0.2126 * cr[i] + 0.7152 * cg[i] + 0.0722 * cb[i]))
            .collect();

        let mut se = 0.0f64;
        let mut de = 0.0f64;
        let mut count = 0usize;
        for i in 0..n {
            if !mask[i] {
                continue;
            }
            let d = (luma[i] - self.ref_luma_srgb_blur[i]) as f64;
            se += d * d;
            let c = LinearRgbColor::new(cr[i], cg[i], cb[i]).to_lab();
            let t = LinearRgbColor::new(self.ref_r[i], self.ref_g[i], self.ref_b[i]).to_lab();
            de += delta_e_76(c, t) as f64;
            count += 1;
        }
        let count = count.max(1) as f64;
        TelemetrySnapshot {
            ssim: ssim_masked(&luma, &self.ref_luma_srgb_blur, w, h, mask),
            rmse: (se / count).sqrt() as f32,
            delta_e: (de / count) as f32,
        }
    }

    /// Notifica um passo de tecelagem; recalcula a cada `interval` passos.
    pub fn on_step(&mut self, state: &CanvasStateSoA) {
        self.steps_since_update += 1;
        if self.steps_since_update >= self.interval {
            self.refresh(state);
        }
    }

    /// Força o recálculo imediato das métricas.
    pub fn refresh(&mut self, state: &CanvasStateSoA) {
        self.steps_since_update = 0;
        self.last = self.compute(state);
    }

    /// Último instantâneo calculado.
    #[inline]
    pub fn current_snapshot(&self) -> TelemetrySnapshot {
        self.last
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient_target(n: u32) -> Vec<LinearRgbColor> {
        (0..n * n)
            .map(|i| {
                let x = (i % n) as f32;
                let y = (i / n) as f32;
                let v = 0.05 + 0.9 * (0.5 + 0.5 * (x * 0.45).sin() * (y * 0.35).cos());
                LinearRgbColor::new(v, v, v)
            })
            .collect()
    }

    #[test]
    fn identical_images_score_perfect() {
        let n = 64u32;
        let target = gradient_target(n);
        let mut state =
            CanvasStateSoA::from_target_and_background(n, n, &target, LinearRgbColor::WHITE, None);
        for p in 0..(n * n) as usize {
            state.set_current_color(p, target[p]);
        }
        let tracker = MetricsTracker::new(&state);
        let s = tracker.compute(&state);
        assert!((s.ssim - 1.0).abs() < 1e-4, "ssim={}", s.ssim);
        assert!(s.rmse < 1e-4);
        assert!(s.delta_e < 1e-2);
    }

    #[test]
    fn blank_canvas_scores_poorly_against_structured_target() {
        let n = 64u32;
        let target = gradient_target(n);
        let state =
            CanvasStateSoA::from_target_and_background(n, n, &target, LinearRgbColor::WHITE, None);
        let tracker = MetricsTracker::new(&state);
        let s = tracker.current_snapshot();
        assert!(s.ssim < 0.3, "ssim={}", s.ssim);
        assert!(s.rmse > 0.1);
    }

    #[test]
    fn interval_controls_refresh() {
        let n = 32u32;
        let target = gradient_target(n);
        let mut state =
            CanvasStateSoA::from_target_and_background(n, n, &target, LinearRgbColor::WHITE, None);
        let mut tracker = MetricsTracker::new(&state);
        tracker.interval = 3;
        let before = tracker.current_snapshot();
        for p in 0..(n * n) as usize {
            state.set_current_color(p, target[p]);
        }
        tracker.on_step(&state);
        tracker.on_step(&state);
        assert_eq!(tracker.current_snapshot(), before);
        tracker.on_step(&state);
        assert!(tracker.current_snapshot().ssim > before.ssim);
    }
}
