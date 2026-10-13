/**
 * Colour helpers. All optimisation happens in *linear light*: thread coverage
 * mixes light linearly, so working in gamma-encoded sRGB would bias mid-tones.
 */

/** sRGB transfer function (IEC 61966-2-1) — encoded [0,1] → linear [0,1]. */
export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Inverse sRGB transfer function — linear [0,1] → encoded [0,1]. */
export function linearToSrgb(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** Lookup table: 8-bit sRGB → linear float. */
export const SRGB8_TO_LINEAR: Float32Array = (() => {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = srgbToLinear(i / 255);
  return lut;
})();

/** Fast linear float → 8-bit sRGB using a 4096-entry table. */
const LINEAR_TO_SRGB8_LUT: Uint8Array = (() => {
  const lut = new Uint8Array(4096);
  for (let i = 0; i < 4096; i++) lut[i] = Math.round(linearToSrgb(i / 4095) * 255);
  return lut;
})();

export function linearToSrgb8(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 255;
  return LINEAR_TO_SRGB8_LUT[(v * 4095 + 0.5) | 0];
}

/** Rec. 709 / sRGB luminance coefficients (applied to linear RGB). */
export const LUMA_R = 0.2126;
export const LUMA_G = 0.7152;
export const LUMA_B = 0.0722;

export type RGB = [number, number, number];

/** Parse `#rrggbb` into 8-bit components. */
export function parseHex(hex: string): RGB {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) throw new Error(`Cor inválida: ${hex}`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

/** `#rrggbb` → linear RGB in [0,1]. */
export function hexToLinear(hex: string): RGB {
  const [r, g, b] = parseHex(hex);
  return [SRGB8_TO_LINEAR[r], SRGB8_TO_LINEAR[g], SRGB8_TO_LINEAR[b]];
}

/** Linear luminance of a linear RGB triple. */
export function luminance([r, g, b]: RGB): number {
  return LUMA_R * r + LUMA_G * g + LUMA_B * b;
}

/** True when the colour has no chroma (r = g = b). */
export function isAchromatic(hex: string): boolean {
  const [r, g, b] = parseHex(hex);
  return r === g && g === b;
}
