import { describe, expect, it } from 'vitest';
import { calibrateThreadColor, calibrateThreadPhysical } from '../src/calibration.js';
import type { RasterImage } from '../src/types.js';

describe('calibration', () => {
  it('calibrates thread color accurately rejecting highlights and shadows', () => {
    const width = 20;
    const height = 20;
    const data = new Uint8ClampedArray(width * height * 4);

    // Fill with a red tone: RGB around (200, 30, 40)
    for (let i = 0; i < width * height; i++) {
      data[i * 4] = 200;
      data[i * 4 + 1] = 30;
      data[i * 4 + 2] = 40;
      data[i * 4 + 3] = 255;
    }

    // Add specular highlights (pure white) in top 5%
    for (let i = 0; i < 10; i++) {
      data[i * 4] = 255;
      data[i * 4 + 1] = 255;
      data[i * 4 + 2] = 255;
    }

    // Add deep shadows in bottom 5%
    for (let i = 10; i < 20; i++) {
      data[i * 4] = 0;
      data[i * 4 + 1] = 0;
      data[i * 4 + 2] = 0;
    }

    const image: RasterImage = { width, height, data };
    const res = calibrateThreadColor(image);

    expect(res.sampleCount).toBeGreaterThan(0);
    // Should closely match #c81e28
    expect(res.hex).toBe('#c81e28');
    expect(res.linearRgb[0]).toBeGreaterThan(0.5);
    expect(res.linearRgb[1]).toBeLessThan(0.1);
  });

  it('calibrates thread physical width from patch transmittance', () => {
    // 100 cords of 50mm in a 50x50mm patch (area 2500 mm2)
    // with width 0.2mm and opacity 1.0:
    // exponent = - (1.0 * 0.2 * 100 * 50) / 2500 = - 1000 / 2500 = -0.4
    // T = exp(-0.4) ≈ 0.67032
    const T = Math.exp(-0.4);
    const result = calibrateThreadPhysical(T, 100, 2500, 50);
    expect(result.apparentWidthMm).toBeCloseTo(0.2, 4);
    expect(result.opacity).toBe(1.0);
  });

  it('rejects invalid physical calibration parameters', () => {
    expect(() => calibrateThreadPhysical(0, 100, 2500, 50)).toThrow();
    expect(() => calibrateThreadPhysical(1.5, 100, 2500, 50)).toThrow();
    expect(() => calibrateThreadPhysical(0.5, 0, 2500, 50)).toThrow();
  });
});
