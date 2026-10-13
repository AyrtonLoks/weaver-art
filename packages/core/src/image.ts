import { applyClahe } from './clahe.js';
import { LUMA_B, LUMA_G, LUMA_R, SRGB8_TO_LINEAR, linearToSrgb, srgbToLinear } from './color.js';
import type { Loom } from './geometry.js';
import type { PreprocessOptions, RasterImage } from './types.js';

/** The optimisation target: a square image in linear light plus per-pixel weights. */
export interface TargetImage {
  size: number;
  channels: 1 | 3;
  /** Linear-light values, `size * size * channels`. */
  data: Float32Array;
  /** Loom mask: 1 inside the loom frame, 0 outside, anti-aliased at the rim. */
  mask: Float32Array;
  /** Error weight per pixel (`mask` × optional importance map). */
  weight: Float32Array;
}

/** Default crop: the largest centred square. */
export function centeredSquareCrop(width: number, height: number): { x: number; y: number; size: number } {
  const size = Math.min(width, height);
  return { x: (width - size) / 2, y: (height - size) / 2, size };
}

/**
 * Compute the square simulation crop in image pixels for a given loom.
 * The loom frame itself is framed as the largest centered rectangle with its aspect ratio,
 * then mapped back to the square enclosing the simulation frame.
 */
export function loomFrameCrop(imgW: number, imgH: number, loom: Loom): { x: number; y: number; size: number } {
  if (loom.config.shape === 'circle') {
    return centeredSquareCrop(imgW, imgH);
  }

  const loomW = loom.widthMm;
  const loomH = loom.heightMm;
  const aspect = loomW / loomH;
  const imgAspect = imgW / imgH;

  let cropLoomW: number;
  let cropLoomX: number;
  let cropLoomY: number;

  if (imgAspect > aspect) {
    cropLoomW = imgH * aspect;
    cropLoomX = (imgW - cropLoomW) / 2;
    cropLoomY = 0;
  } else {
    const cropLoomH = imgW / aspect;
    cropLoomW = imgW;
    cropLoomX = 0;
    cropLoomY = (imgH - cropLoomH) / 2;
  }

  const scale = cropLoomW / loomW;
  const cropSize = loom.extentMm * scale;
  const ox = (loom.extentMm - loomW) / 2;
  const oy = (loom.extentMm - loomH) / 2;
  const cropX = cropLoomX - ox * scale;
  const cropY = cropLoomY - oy * scale;

  return { x: cropX, y: cropY, size: cropSize };
}

/**
 * Resample a square region of `img` into a `size × size` linear-light buffer.
 * Each output pixel averages k×k bilinear samples (area filter), so downscaling
 * large photographs does not alias. Transparent pixels are composited over white.
 */
export function resampleLinear(
  img: RasterImage,
  size: number,
  crop: { x: number; y: number; size: number },
): Float32Array {
  const { width, height, data } = img;
  const out = new Float32Array(size * size * 3);
  const scale = crop.size / size;
  const k = Math.max(1, Math.min(6, Math.ceil(scale)));
  const inv = 1 / (k * k);
  const px = new Float32Array(3);

  const sample = (sx: number, sy: number): void => {
    const fx = Math.min(Math.max(sx - 0.5, 0), width - 1);
    const fy = Math.min(Math.max(sy - 0.5, 0), height - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, width - 1);
    const y1 = Math.min(y0 + 1, height - 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const w00 = (1 - tx) * (1 - ty);
    const w10 = tx * (1 - ty);
    const w01 = (1 - tx) * ty;
    const w11 = tx * ty;
    const o00 = (y0 * width + x0) * 4;
    const o10 = (y0 * width + x1) * 4;
    const o01 = (y1 * width + x0) * 4;
    const o11 = (y1 * width + x1) * 4;
    for (let c = 0; c < 3; c++) {
      const v = w00 * mix(data, o00, c) + w10 * mix(data, o10, c) + w01 * mix(data, o01, c) + w11 * mix(data, o11, c);
      px[c] = v;
    }
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < k; j++) {
        for (let i = 0; i < k; i++) {
          const sx = crop.x + (x + (i + 0.5) / k) * scale;
          const sy = crop.y + (y + (j + 0.5) / k) * scale;
          sample(sx, sy);
          r += px[0];
          g += px[1];
          b += px[2];
        }
      }
      const o = (y * size + x) * 3;
      out[o] = r * inv;
      out[o + 1] = g * inv;
      out[o + 2] = b * inv;
    }
  }
  return out;
}

/** Linear value of channel `c` at byte offset `o`, composited over white using alpha. */
function mix(data: Uint8ClampedArray | Uint8Array, o: number, c: number): number {
  const a = data[o + 3] / 255;
  return a * SRGB8_TO_LINEAR[data[o + c]] + (1 - a);
}

/** Apply perceptual tone adjustments to a linear value. */
function tone(v: number, p: PreprocessOptions): number {
  let s = linearToSrgb(v);
  s = (s - 0.5) * p.contrast + 0.5 + p.brightness;
  s = Math.min(1, Math.max(0, s));
  if (p.gamma !== 1) s = Math.pow(s, p.gamma);
  if (p.shadowLift && p.shadowLift > 0) {
    const lift = Math.min(0.5, Math.max(0, p.shadowLift));
    s = s + lift * Math.pow(1 - s, 2);
    s = Math.min(1, Math.max(0, s));
  }
  if (p.invert) s = 1 - s;
  return srgbToLinear(s);
}

/** Anti-aliased circular mask inscribed in a `size × size` grid. */
export function circleMask(size: number): Float32Array {
  const mask = new Float32Array(size * size);
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - r, y + 0.5 - r);
      mask[y * size + x] = Math.min(1, Math.max(0, r - d + 0.5));
    }
  }
  return mask;
}

/**
 * Anti-aliased mask for any loom geometry inscribed in a `size × size` simulation grid.
 * For circles, returns the analytical circular mask.
 * For convex polygon frames, returns anti-aliased coverage via signed edge distances:
 * m = clamp(min_e d_e + 0.5, 0, 1).
 */
export function loomMask(loom: Loom, size: number): Float32Array {
  if (loom.config.shape === 'circle' || !loom.outline) {
    return circleMask(size);
  }

  const mask = new Float32Array(size * size);
  const scale = size / loom.extentMm;
  const poly = loom.outline.map((pt) => ({ x: pt.x * scale, y: pt.y * scale }));
  const numEdges = poly.length;

  // Precompute line coefficients a * px + b * py + c for each directed edge
  // In screen coords (Y down, clockwise poly), inward normal has:
  // dx = B.x - A.x, dy = B.y - A.y
  // distance = (dx * (py - A.y) - dy * (px - A.x)) / L = (-dy/L)*px + (dx/L)*py + (dy*A.x - dx*A.y)/L
  const a = new Float64Array(numEdges);
  const b = new Float64Array(numEdges);
  const c = new Float64Array(numEdges);

  for (let i = 0; i < numEdges; i++) {
    const p0 = poly[i];
    const p1 = poly[(i + 1) % numEdges];
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy) || 1;
    a[i] = -dy / len;
    b[i] = dx / len;
    c[i] = (dy * p0.x - dx * p0.y) / len;
  }

  for (let y = 0; y < size; y++) {
    const py = y + 0.5;
    const rowOffset = y * size;
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      let minD = Infinity;
      for (let e = 0; e < numEdges; e++) {
        const d = a[e] * px + b[e] * py + c[e];
        if (d < minD) minD = d;
      }
      mask[rowOffset + x] = Math.min(1, Math.max(0, minD + 0.5));
    }
  }

  return mask;
}

/** 3x3 Sobel edge gradient magnitude in [0, 1]. */
export function computeSobelEdgeMagnitude(luma: Float32Array, size: number): Float32Array {
  const edges = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(size - 1, y + 1);
    const row0 = y0 * size;
    const row1 = y * size;
    const row2 = y1 * size;
    for (let x = 0; x < size; x++) {
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(size - 1, x + 1);

      // Sobel horizontal gradient
      const gx =
        -luma[row0 + x0] +
        luma[row0 + x1] -
        2 * luma[row1 + x0] +
        2 * luma[row1 + x1] -
        luma[row2 + x0] +
        luma[row2 + x1];

      // Sobel vertical gradient
      const gy =
        -luma[row0 + x0] -
        2 * luma[row0 + x] -
        luma[row0 + x1] +
        luma[row2 + x0] +
        2 * luma[row2 + x] +
        luma[row2 + x1];

      // Normalized magnitude (Sobel kernel scale factor 4)
      edges[row1 + x] = Math.min(1, Math.hypot(gx, gy) / 4);
    }
  }
  return edges;
}

/**
 * Fast separable Gaussian blur in O(N * radius) for simulating retinal visual acuity.
 */
export function gaussianBlur(
  data: Float32Array,
  width: number,
  height: number,
  channels: 1 | 3,
  sigmaPx: number,
): Float32Array {
  if (sigmaPx < 0.2) return new Float32Array(data);
  const radius = Math.min(Math.ceil(3 * sigmaPx), Math.floor(Math.min(width, height) / 2));
  if (radius < 1) return new Float32Array(data);

  const kSize = radius * 2 + 1;
  const kernel = new Float32Array(kSize);
  let kSum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigmaPx * sigmaPx));
    kernel[i + radius] = v;
    kSum += v;
  }
  for (let i = 0; i < kSize; i++) kernel[i] /= kSum;

  const totalPixels = width * height;
  const temp = new Float32Array(totalPixels * channels);
  const out = new Float32Array(totalPixels * channels);

  // Horizontal pass
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const sx = Math.min(Math.max(x + k, 0), width - 1);
          sum += data[(row + sx) * channels + c] * kernel[k + radius];
        }
        temp[(row + x) * channels + c] = sum;
      }
    }
  }

  // Vertical pass
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const sy = Math.min(Math.max(y + k, 0), height - 1);
          sum += temp[(sy * width + x) * channels + c] * kernel[k + radius];
        }
        out[(row + x) * channels + c] = sum;
      }
    }
  }

  return out;
}

/**
 * Turn a photograph into the optimisation target.
 *
 * @param img        Source RGBA image.
 * @param size       Simulation grid size in pixels.
 * @param opts       Tone / crop options.
 * @param channels   1 = luminance only, 3 = linear RGB.
 * @param importance Optional importance map (white = important, black = ignored), same framing as `img`.
 * @param frame      Loom physical geometry or legacy diameter in mm (default: 711.2).
 */
export function prepareTarget(
  img: RasterImage,
  size: number,
  opts: PreprocessOptions,
  channels: 1 | 3,
  importance?: RasterImage,
  frame: number | Loom = 711.2,
): TargetImage {
  const isLoom = typeof frame !== 'number';
  const loomDiameterMm = isLoom ? frame.extentMm : frame;
  const crop =
    opts.crop ?? (isLoom ? loomFrameCrop(img.width, img.height, frame) : centeredSquareCrop(img.width, img.height));
  const rgb = resampleLinear(img, size, crop);
  const n = size * size;
  const data = new Float32Array(n * channels);
  for (let p = 0; p < n; p++) {
    const r = rgb[p * 3];
    const g = rgb[p * 3 + 1];
    const b = rgb[p * 3 + 2];
    if (channels === 1) {
      data[p] = tone(LUMA_R * r + LUMA_G * g + LUMA_B * b, opts);
    } else {
      data[p * 3] = tone(r, opts);
      data[p * 3 + 1] = tone(g, opts);
      data[p * 3 + 2] = tone(b, opts);
    }
  }

  // Local contrast equalization (CLAHE) applied in perceptual space
  if (opts.clahe) {
    if (channels === 1) {
      const sChannel = new Float32Array(n);
      for (let p = 0; p < n; p++) {
        sChannel[p] = linearToSrgb(data[p]);
      }
      const equalized = applyClahe(sChannel, size, size, {
        clipLimit: opts.claheClipLimit,
        gridSize: opts.claheGridSize,
      });
      for (let p = 0; p < n; p++) {
        data[p] = srgbToLinear(equalized[p]);
      }
    } else {
      // For color images, apply CLAHE to perceptual luminance and scale channels proportionally
      // to preserve hue and saturation without chromatic distortion.
      const sLuma = new Float32Array(n);
      for (let p = 0; p < n; p++) {
        const o = p * 3;
        const linLuma = LUMA_R * data[o] + LUMA_G * data[o + 1] + LUMA_B * data[o + 2];
        sLuma[p] = linearToSrgb(linLuma);
      }
      const equalized = applyClahe(sLuma, size, size, {
        clipLimit: opts.claheClipLimit,
        gridSize: opts.claheGridSize,
      });
      for (let p = 0; p < n; p++) {
        const o = p * 3;
        const oldLumaSrgb = sLuma[p];
        const newLumaSrgb = equalized[p];
        const oldLumaLin = srgbToLinear(oldLumaSrgb);
        const newLumaLin = srgbToLinear(newLumaSrgb);
        if (oldLumaLin > 1e-4) {
          const ratio = newLumaLin / oldLumaLin;
          data[o] = Math.min(1, Math.max(0, data[o] * ratio));
          data[o + 1] = Math.min(1, Math.max(0, data[o + 1] * ratio));
          data[o + 2] = Math.min(1, Math.max(0, data[o + 2] * ratio));
        } else {
          data[o] = newLumaLin;
          data[o + 1] = newLumaLin;
          data[o + 2] = newLumaLin;
        }
      }
    }
  }

  // Retinal blur model for observation distance (Birsak et al., 2018)
  const blurMm =
    opts.perceptualBlurMm && opts.perceptualBlurMm > 0
      ? opts.perceptualBlurMm
      : opts.viewingDistanceM && opts.viewingDistanceM > 0
        ? opts.viewingDistanceM * 0.291
        : 0;

  if (blurMm > 0) {
    const sigmaPx = blurMm * (size / loomDiameterMm);
    const blurred = gaussianBlur(data, size, size, channels, sigmaPx);
    data.set(blurred);
  }

  const mask = isLoom ? loomMask(frame, size) : circleMask(size);
  const weight = new Float32Array(mask);
  if (importance) {
    const impCrop =
      opts.crop ??
      (isLoom
        ? loomFrameCrop(importance.width, importance.height, frame)
        : centeredSquareCrop(importance.width, importance.height));
    const imp = resampleLinear(importance, size, impCrop);
    for (let p = 0; p < n; p++) {
      const lum = LUMA_R * imp[p * 3] + LUMA_G * imp[p * 3 + 1] + LUMA_B * imp[p * 3 + 2];
      weight[p] *= linearToSrgb(lum);
    }
  }

  if (opts.edgeEmphasis && opts.edgeEmphasis > 0) {
    const luma = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      luma[p] =
        channels === 1
          ? linearToSrgb(data[p])
          : linearToSrgb(LUMA_R * data[p * 3] + LUMA_G * data[p * 3 + 1] + LUMA_B * data[p * 3 + 2]);
    }
    const edges = computeSobelEdgeMagnitude(luma, size);
    const factor = opts.edgeEmphasis * 3;
    for (let p = 0; p < n; p++) {
      weight[p] *= 1 + factor * edges[p];
    }
  }

  return { size, channels, data, mask, weight };
}
