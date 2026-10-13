import { describe, expect, it } from 'vitest';
import {
  calculateDeltaE,
  calculateMetrics,
  calculateSSIM,
  deltaE76,
  linearRgbToLab,
  linearRgbToXyz,
  xyzToLab,
} from '../src/metrics.js';
import { circleMask, type TargetImage } from '../src/image.js';

describe('metrics', () => {
  it('converts D65 white from linear sRGB to XYZ and Lab accurately', () => {
    // Pure white [1, 1, 1] in linear sRGB corresponds to D65 reference white
    const [x, y, z] = linearRgbToXyz(1, 1, 1);
    expect(x).toBeCloseTo(0.95047, 3);
    expect(y).toBeCloseTo(1.0, 3);
    expect(z).toBeCloseTo(1.08883, 3);

    const [l, a, b] = xyzToLab(x, y, z);
    expect(l).toBeCloseTo(100, 2);
    expect(a).toBeCloseTo(0, 2);
    expect(b).toBeCloseTo(0, 2);
  });

  it('computes deltaE76 between identical colors as 0 and distinct colors reasonably', () => {
    const white = linearRgbToLab(1, 1, 1);
    const black = linearRgbToLab(0, 0, 0);
    expect(deltaE76(white, white)).toBe(0);
    // Delta E between pure black and white in CIELAB is ~100 (L*=0 vs L*=100)
    expect(deltaE76(white, black)).toBeCloseTo(100, 0);
  });

  it('computes calculateDeltaE as 0 for identical buffers', () => {
    const size = 32;
    const mask = circleMask(size);
    const buf = new Float32Array(size * size);
    buf.fill(0.5);
    const de = calculateDeltaE(buf, buf, 1, mask);
    expect(de).toBe(0);
  });

  it('computes SSIM as 1.0 for identical images', () => {
    const size = 32;
    const mask = circleMask(size);
    const buf = new Float32Array(size * size);
    for (let i = 0; i < buf.length; i++) buf[i] = (i % 32) / 32;
    const ssim = calculateSSIM(buf, buf, 1, mask, size);
    expect(ssim).toBeCloseTo(1.0, 4);
  });

  it('calculates full metrics on a target image', () => {
    const size = 32;
    const mask = circleMask(size);
    const targetData = new Float32Array(size * size);
    const simData = new Float32Array(size * size);
    targetData.fill(0.2);
    simData.fill(0.3);

    const target: TargetImage = {
      size,
      channels: 1,
      data: targetData,
      mask,
      weight: mask,
    };

    const metrics = calculateMetrics(simData, target, 1);
    expect(metrics.rmse).toBeGreaterThan(0);
    expect(metrics.deltaELab).toBeGreaterThan(0);
    expect(metrics.ssim).toBeGreaterThan(0.9);
    expect(metrics.ssim).toBeLessThanOrEqual(1.0);
  });

  it('calculates full metrics on a 3-channel color target image', () => {
    const size = 32;
    const mask = circleMask(size);
    const targetData = new Float32Array(size * size * 3);
    const simData = new Float32Array(size * size * 3);
    for (let i = 0; i < size * size; i++) {
      targetData[i * 3] = 0.8;
      targetData[i * 3 + 1] = 0.2;
      targetData[i * 3 + 2] = 0.2;
      simData[i * 3] = 0.7;
      simData[i * 3 + 1] = 0.25;
      simData[i * 3 + 2] = 0.15;
    }

    const target: TargetImage = {
      size,
      channels: 3,
      data: targetData,
      mask,
      weight: mask,
    };

    const metrics = calculateMetrics(simData, target, 3);
    expect(metrics.rmse).toBeGreaterThan(0);
    expect(metrics.deltaELab).toBeGreaterThan(0);
    expect(metrics.ssim).toBeGreaterThan(0.9);
    expect(metrics.ssim).toBeLessThanOrEqual(1.0);

    const deSame = calculateDeltaE(targetData, targetData, 3, mask);
    expect(deSame).toBe(0);

    const ssimSame = calculateSSIM(targetData, targetData, 3, mask, size);
    expect(ssimSame).toBeCloseTo(1.0, 4);
  });
});
