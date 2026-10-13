import { linearToSrgb8, LUMA_B, LUMA_G, LUMA_R, SRGB8_TO_LINEAR, type RGB } from './color.js';
import type { RasterImage } from './types.js';

export interface ColorCalibrationResult {
  hex: string;
  linearRgb: RGB;
  sampleCount: number;
}

export interface PhysicalCalibrationResult {
  apparentWidthMm: number;
  opacity: number;
}

export interface CalibrationRoi {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Calibrate thread color from a photograph of a skein or thread sample.
 * Rejects specular highlights and deep shadow pixels using luminance percentiles,
 * computing the robust trimmed mean in linear light.
 */
export function calibrateThreadColor(image: RasterImage, roi?: CalibrationRoi): ColorCalibrationResult {
  const { width: imgW, height: imgH, data } = image;
  const rx = roi ? Math.max(0, Math.floor(roi.x)) : 0;
  const ry = roi ? Math.max(0, Math.floor(roi.y)) : 0;
  const rw = roi ? Math.min(Math.floor(roi.width), imgW - rx) : imgW;
  const rh = roi ? Math.min(Math.floor(roi.height), imgH - ry) : imgH;

  if (rw <= 0 || rh <= 0) {
    throw new Error('Região de calibração (ROI) vazia ou fora dos limites da imagem');
  }

  interface Sample {
    r: number;
    g: number;
    b: number;
    luma: number;
  }

  const samples: Sample[] = [];

  for (let y = ry; y < ry + rh; y++) {
    const row = y * imgW;
    for (let x = rx; x < rx + rw; x++) {
      const o = (row + x) * 4;
      const alpha = data[o + 3] / 255;
      if (alpha < 0.5) continue; // Skip transparent background

      const r = SRGB8_TO_LINEAR[data[o]];
      const g = SRGB8_TO_LINEAR[data[o + 1]];
      const b = SRGB8_TO_LINEAR[data[o + 2]];
      const luma = LUMA_R * r + LUMA_G * g + LUMA_B * b;

      samples.push({ r, g, b, luma });
    }
  }

  if (samples.length === 0) {
    throw new Error('Nenhum pixel válido encontrado na região de calibração');
  }

  // Sort by luminance to reject outliers (shadows < 10% and specular highlights > 90%)
  samples.sort((s1, s2) => s1.luma - s2.luma);

  const startIdx = Math.floor(samples.length * 0.1);
  const endIdx = Math.ceil(samples.length * 0.9);
  const kept = samples.slice(startIdx, Math.max(startIdx + 1, endIdx));

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (const s of kept) {
    sumR += s.r;
    sumG += s.g;
    sumB += s.b;
  }

  const count = kept.length;
  const meanR = sumR / count;
  const meanG = sumG / count;
  const meanB = sumB / count;

  const hexR = linearToSrgb8(meanR).toString(16).padStart(2, '0');
  const hexG = linearToSrgb8(meanG).toString(16).padStart(2, '0');
  const hexB = linearToSrgb8(meanB).toString(16).padStart(2, '0');
  const hex = `#${hexR}${hexG}${hexB}`;

  return {
    hex,
    linearRgb: [meanR, meanG, meanB],
    sampleCount: count,
  };
}

/**
 * Estimate physical apparent width and opacity from measured transmittance of a test patch.
 *
 * Under the multiplicative area-coverage model:
 * T = exp(-alpha * w * N * L / A) => alpha * w = - (A / (N * L)) * ln(T)
 */
export function calibrateThreadPhysical(
  measuredTransmittance: number,
  chordCount: number,
  patchAreaMm2: number,
  chordLengthMm: number,
): PhysicalCalibrationResult {
  if (measuredTransmittance <= 0 || measuredTransmittance >= 1) {
    throw new Error('Transmitância medida deve estar em (0, 1)');
  }
  if (chordCount <= 0) throw new Error('Número de cordas deve ser > 0');
  if (patchAreaMm2 <= 0) throw new Error('Área do patch em mm² deve ser > 0');
  if (chordLengthMm <= 0) throw new Error('Comprimento médio da corda em mm deve ser > 0');

  // Total line path length in mm
  const totalLengthMm = chordCount * chordLengthMm;
  // Effective density = alpha * widthMm
  const effectiveWidthMm = -(patchAreaMm2 / totalLengthMm) * Math.log(measuredTransmittance);

  return {
    apparentWidthMm: effectiveWidthMm,
    opacity: 1.0,
  };
}
