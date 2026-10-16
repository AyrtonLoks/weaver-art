import { linearToSrgb8 } from './color.js';
import { BLACK_THREAD, VRELLIS_LOOM } from './config.js';
import { loomPegCount } from './geometry.js';
import type { CustomPaletteResult, LoomConfig, PaletteOptions, RasterImage } from './types.js';

// D65 reference white point
const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;

const EPSILON = 216 / 24389;
const KAPPA = 24389 / 27;

/** Convert CIELAB (L*, a*, b*) to CIE XYZ (D65). */
export function labToXyz(l: number, a: number, b: number): [number, number, number] {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;

  const fx3 = fx * fx * fx;
  const fz3 = fz * fz * fz;
  const fy3 = fy * fy * fy;

  const xr = fx3 > EPSILON ? fx3 : (116 * fx - 16) / KAPPA;
  const yr = l > KAPPA * EPSILON ? fy3 : l / KAPPA;
  const zr = fz3 > EPSILON ? fz3 : (116 * fz - 16) / KAPPA;

  return [xr * XN, yr * YN, zr * ZN];
}

/** Convert CIE XYZ (D65) to linear sRGB [0, 1]. */
export function xyzToLinearRgb(x: number, y: number, z: number): [number, number, number] {
  const r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const g = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const b = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return [Math.max(0, Math.min(1, r)), Math.max(0, Math.min(1, g)), Math.max(0, Math.min(1, b))];
}

/** Convert CIELAB (L*, a*, b*) directly to linear sRGB [0, 1]. */
export function labToLinearRgb(l: number, a: number, b: number): [number, number, number] {
  const [x, y, z] = labToXyz(l, a, b);
  return xyzToLinearRgb(x, y, z);
}

/** Convert linear sRGB [0, 1] to #rrggbb hex string. */
export function linearRgbToHex(r: number, g: number, b: number): string {
  const r8 = linearToSrgb8(r);
  const g8 = linearToSrgb8(g);
  const b8 = linearToSrgb8(b);
  const h = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${h(r8)}${h(g8)}${h(b8)}`;
}

/** Convert CIELAB (L*, a*, b*) to #rrggbb hex string. */
export function labToHex(l: number, a: number, b: number): string {
  const [r, g, bLin] = labToLinearRgb(l, a, b);
  return linearRgbToHex(r, g, bLin);
}

/** Generate a friendly Portuguese color name and stable ID from CIELAB values. */
export function describeColor(lab: [number, number, number]): { name: string; id: string } {
  const [l, a, b] = lab;
  const chroma = Math.hypot(a, b);
  if (l < 18) return { name: 'Preto', id: 'black' };
  if (chroma < 12) return { name: 'Cinza', id: 'gray' };
  return { name: 'Cor', id: 'color' };
}

/**
 * Stub temporário de extração automática de paleta JS (legado expurgado na Task 0.1).
 */
export function extractPalette(_image: RasterImage, _k = 4, options: PaletteOptions = {}): CustomPaletteResult {
  const widthMm = options.threadWidthMm ?? 0.2;
  const opacity = options.opacity ?? 1.0;
  return {
    threads: [{ ...BLACK_THREAD, widthMm, opacity, startPeg: 0 }],
    threadLineBudgets: [1],
    colorsHex: [BLACK_THREAD.color],
  };
}

export function generateCustomThreads(
  image: RasterImage,
  k = 4,
  loom: LoomConfig = VRELLIS_LOOM,
  options: PaletteOptions = {},
): CustomPaletteResult {
  return extractPalette(image, k, { ...options, loom, loomPegCount: loomPegCount(loom) });
}
