import { linearToSrgb, LUMA_B, LUMA_G, LUMA_R } from './color.js';
import type { TargetImage } from './image.js';
import type { WeaveMetrics } from './types.js';

// D65 reference white point (2° standard observer)
const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;

const EPSILON = 216 / 24389; // (6/29)^3 ≈ 0.008856
const KAPPA = 24389 / 27; // (29/3)^3 ≈ 903.3

function labF(t: number): number {
  return t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
}

/** Linear sRGB [0, 1] to CIE XYZ (D65). */
export function linearRgbToXyz(r: number, g: number, b: number): [number, number, number] {
  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  return [x, y, z];
}

/** CIE XYZ to CIELAB (L*, a*, b*). */
export function xyzToLab(x: number, y: number, z: number): [number, number, number] {
  const fx = labF(x / XN);
  const fy = labF(y / YN);
  const fz = labF(z / ZN);
  const l = 116 * fy - 16;
  const a = 500 * (fx - fy);
  const b = 200 * (fy - fz);
  return [l, a, b];
}

/** Linear sRGB [0, 1] to CIELAB (L*, a*, b*). */
export function linearRgbToLab(r: number, g: number, b: number): [number, number, number] {
  const [x, y, z] = linearRgbToXyz(r, g, b);
  return xyzToLab(x, y, z);
}

/** Euclidean CIE76 color difference between two CIELAB colors. */
export function deltaE76(lab1: [number, number, number], lab2: [number, number, number]): number {
  const dl = lab1[0] - lab2[0];
  const da = lab1[1] - lab2[1];
  const db = lab1[2] - lab2[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

/**
 * Average CIELAB ΔE (CIE76) between simulation canvas and target image,
 * evaluated inside the loom mask.
 */
export function calculateDeltaE(sim: Float32Array, target: Float32Array, channels: 1 | 3, mask: Float32Array): number {
  const n = mask.length;
  let totalDeltaE = 0;
  let maskWeight = 0;

  if (channels === 1) {
    for (let p = 0; p < n; p++) {
      const m = mask[p];
      if (m <= 0) continue;
      const vSim = Math.max(0, Math.min(1, sim[p]));
      const vTgt = Math.max(0, Math.min(1, target[p]));
      const [lSim] = xyzToLab(vSim * XN, vSim * YN, vSim * ZN);
      const [lTgt] = xyzToLab(vTgt * XN, vTgt * YN, vTgt * ZN);
      totalDeltaE += m * Math.abs(lSim - lTgt);
      maskWeight += m;
    }
  } else {
    for (let p = 0; p < n; p++) {
      const m = mask[p];
      if (m <= 0) continue;
      const o = p * 3;
      const labSim = linearRgbToLab(
        Math.max(0, Math.min(1, sim[o])),
        Math.max(0, Math.min(1, sim[o + 1])),
        Math.max(0, Math.min(1, sim[o + 2])),
      );
      const labTgt = linearRgbToLab(
        Math.max(0, Math.min(1, target[o])),
        Math.max(0, Math.min(1, target[o + 1])),
        Math.max(0, Math.min(1, target[o + 2])),
      );
      totalDeltaE += m * deltaE76(labSim, labTgt);
      maskWeight += m;
    }
  }

  return maskWeight > 0 ? totalDeltaE / maskWeight : 0;
}

// Standard SSIM parameters (Wang et al., 2004)
const SSIM_RADIUS = 5;
const SSIM_SIGMA = 1.5;
const SSIM_KERNEL_SIZE = SSIM_RADIUS * 2 + 1; // 11
const SSIM_KERNEL = new Float32Array(SSIM_KERNEL_SIZE);
(() => {
  let sum = 0;
  for (let i = -SSIM_RADIUS; i <= SSIM_RADIUS; i++) {
    const v = Math.exp(-(i * i) / (2 * SSIM_SIGMA * SSIM_SIGMA));
    SSIM_KERNEL[i + SSIM_RADIUS] = v;
    sum += v;
  }
  for (let i = 0; i < SSIM_KERNEL_SIZE; i++) {
    SSIM_KERNEL[i] /= sum;
  }
})();

function separableGaussian2D(input: Float32Array, size: number, out: Float32Array, scratch?: Float32Array): void {
  const temp = scratch ?? new Float32Array(size * size);

  // Horizontal pass
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let k = -SSIM_RADIUS; k <= SSIM_RADIUS; k++) {
        const sx = Math.min(Math.max(x + k, 0), size - 1);
        sum += input[row + sx] * SSIM_KERNEL[k + SSIM_RADIUS];
      }
      temp[row + x] = sum;
    }
  }

  // Vertical pass
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let k = -SSIM_RADIUS; k <= SSIM_RADIUS; k++) {
        const sy = Math.min(Math.max(y + k, 0), size - 1);
        sum += temp[sy * size + x] * SSIM_KERNEL[k + SSIM_RADIUS];
      }
      out[row + x] = sum;
    }
  }
}

/**
 * Structural Similarity Index (SSIM) computed on perceptual luminance inside the loom mask.
 * Returns a value in [-1, 1], where 1 represents identical visual structure.
 */
export function calculateSSIM(
  sim: Float32Array,
  target: Float32Array,
  channels: 1 | 3,
  mask: Float32Array,
  size: number,
): number {
  const n = size * size;
  const x = new Float32Array(n);
  const y = new Float32Array(n);

  for (let p = 0; p < n; p++) {
    if (channels === 1) {
      x[p] = linearToSrgb(sim[p]);
      y[p] = linearToSrgb(target[p]);
    } else {
      const o = p * 3;
      const lumX = LUMA_R * sim[o] + LUMA_G * sim[o + 1] + LUMA_B * sim[o + 2];
      const lumY = LUMA_R * target[o] + LUMA_G * target[o + 1] + LUMA_B * target[o + 2];
      x[p] = linearToSrgb(lumX);
      y[p] = linearToSrgb(lumY);
    }
  }

  const scratch = new Float32Array(n);
  const muX = new Float32Array(n);
  const muY = new Float32Array(n);
  separableGaussian2D(x, size, muX, scratch);
  separableGaussian2D(y, size, muY, scratch);

  const x2 = new Float32Array(n);
  const y2 = new Float32Array(n);
  const xy = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    x2[p] = x[p] * x[p];
    y2[p] = y[p] * y[p];
    xy[p] = x[p] * y[p];
  }

  const muX2 = new Float32Array(n);
  const muY2 = new Float32Array(n);
  const muXY = new Float32Array(n);
  separableGaussian2D(x2, size, muX2, scratch);
  separableGaussian2D(y2, size, muY2, scratch);
  separableGaussian2D(xy, size, muXY, scratch);

  const C1 = 0.0001; // (0.01)^2
  const C2 = 0.0009; // (0.03)^2

  let ssimSum = 0;
  let weightSum = 0;

  for (let p = 0; p < n; p++) {
    const m = mask[p];
    if (m <= 0) continue;

    const mx = muX[p];
    const my = muY[p];
    const mx2 = mx * mx;
    const my2 = my * my;
    const mxy = mx * my;

    const varX = Math.max(0, muX2[p] - mx2);
    const varY = Math.max(0, muY2[p] - my2);
    const covXY = muXY[p] - mxy;

    const num = (2 * mxy + C1) * (2 * covXY + C2);
    const den = (mx2 + my2 + C1) * (varX + varY + C2);
    const ssimLocal = num / den;

    ssimSum += m * ssimLocal;
    weightSum += m;
  }

  return weightSum > 0 ? ssimSum / weightSum : 1.0;
}

/** Compute full perceptual and physical metrics for a weaving result. */
export function calculateMetrics(sim: Float32Array, target: TargetImage, channels: 1 | 3): WeaveMetrics {
  const { data, mask, weight, size } = target;
  let err = 0;
  let wsum = 0;
  for (let p = 0; p < weight.length; p++) {
    const w = weight[p];
    if (w === 0) continue;
    for (let c = 0; c < channels; c++) {
      const e = data[p * channels + c] - sim[p * channels + c];
      err += w * e * e;
    }
    wsum += w * channels;
  }
  const rmse = wsum > 0 ? Math.sqrt(err / wsum) : 0;
  const deltaELab = calculateDeltaE(sim, data, channels, mask);
  const ssim = calculateSSIM(sim, data, channels, mask, size);

  return { rmse, deltaELab, ssim };
}
