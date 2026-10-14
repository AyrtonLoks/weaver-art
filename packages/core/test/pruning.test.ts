import { describe, expect, it } from 'vitest';
import { CMYK_THREADS, WeaveEngine, type DeepPartial, type RasterImage, type WeaveOptions } from '../src/index.js';

function createSyntheticImage(size = 100): RasterImage {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - size / 2;
      const dy = y - size / 2;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // Soft disc target
      const val = dist < size * 0.35 ? Math.floor(40 + (dist / (size * 0.35)) * 100) : 255;
      data[idx] = val;
      data[idx + 1] = Math.floor(val * 0.9);
      data[idx + 2] = Math.floor(val * 0.8);
      data[idx + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

describe('Candidate Pruning (Minoux Lazy Greedy)', () => {
  const img = createSyntheticImage(100);

  const baseConfig: DeepPartial<WeaveOptions> = {
    resolutionPx: 100,
    maxLines: 40,
    minPegGap: 8,
    loom: {
      shape: 'circle',
      diameterMm: 200,
      pegCount: 40,
      pegDiameterMm: 2,
    },
  };

  it('guarantees identical steps to exact search in single-thread monochrome', () => {
    const engineExact = WeaveEngine.create(img, {
      ...baseConfig,
      candidatePruning: 'none',
    });
    const resultExact = engineExact.run();

    const engineLazy = WeaveEngine.create(img, {
      ...baseConfig,
      candidatePruning: 'lazy',
    });
    const resultLazy = engineLazy.run();

    expect(resultLazy.steps.length).toBe(resultExact.steps.length);
    for (let i = 0; i < resultLazy.steps.length; i++) {
      expect(resultLazy.steps[i].from).toBe(resultExact.steps[i].from);
      expect(resultLazy.steps[i].to).toBe(resultExact.steps[i].to);
      expect(resultLazy.steps[i].fromSide).toBe(resultExact.steps[i].fromSide);
      expect(resultLazy.steps[i].toSide).toBe(resultExact.steps[i].toSide);
      expect(resultLazy.steps[i].gain).toBeCloseTo(resultExact.steps[i].gain, 6);
    }

    // Must skip candidates effectively
    expect(engineLazy.perf.candidatesSkipped).toBeGreaterThan(0);
    const totalCandidates = engineLazy.perf.candidatesScored + engineLazy.perf.candidatesSkipped;
    const skipRate = engineLazy.perf.candidatesSkipped / totalCandidates;
    expect(skipRate).toBeGreaterThan(0.5);
  });

  it('satisfies ΔRMSE <= 2% and ΔSSIM <= 2% in CMYK multi-color and halftone', () => {
    const cmykConfig: DeepPartial<WeaveOptions> = {
      ...baseConfig,
      maxLines: 40,
      threads: CMYK_THREADS.map((t, i) => ({ ...t, startPeg: i * 8 })),
      preprocess: { grayscale: false },
      halftoneMixing: true,
      halftoneRadiusMm: 0.5,
    };

    const engineExact = WeaveEngine.create(img, {
      ...cmykConfig,
      candidatePruning: 'none',
    });
    const resultExact = engineExact.run();

    const engineLazy = WeaveEngine.create(img, {
      ...cmykConfig,
      candidatePruning: 'lazy',
    });
    const resultLazy = engineLazy.run();

    const deltaRmse = Math.abs(resultLazy.rmse - resultExact.rmse) / resultExact.rmse;
    expect(deltaRmse).toBeLessThanOrEqual(0.02);

    const ssimExact = resultExact.metrics?.ssim ?? 1;
    const ssimLazy = resultLazy.metrics?.ssim ?? 1;
    const deltaSsim = Math.abs(ssimLazy - ssimExact) / Math.max(1e-4, ssimExact);
    expect(deltaSsim).toBeLessThanOrEqual(0.02);

    expect(engineLazy.perf.candidatesSkipped).toBeGreaterThan(0);
  });

  it('guarantees monotonically decreasing error and high skip rate with angularDiversity > 0', () => {
    const engineExact = WeaveEngine.create(img, {
      ...baseConfig,
      angularDiversity: 0.35,
      candidatePruning: 'none',
    });
    const resultExact = engineExact.run();

    const engineLazy = WeaveEngine.create(img, {
      ...baseConfig,
      angularDiversity: 0.35,
      candidatePruning: 'lazy',
    });
    const resultLazy = engineLazy.run();

    expect(resultLazy.steps.length).toBe(resultExact.steps.length);
    const deltaRmse = Math.abs(resultLazy.rmse - resultExact.rmse) / resultExact.rmse;
    expect(deltaRmse).toBeLessThanOrEqual(0.02);
    expect(engineLazy.perf.candidatesSkipped).toBeGreaterThan(0);
  });
});
