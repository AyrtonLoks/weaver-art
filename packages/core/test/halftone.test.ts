import { describe, expect, it } from 'vitest';
import { CMYK_THREADS, resolveOptions, validateOptions, WeaveEngine, type RasterImage } from '../src/index.js';

function makeColorImage(
  width: number,
  height: number,
  fn: (x: number, y: number) => [number, number, number],
): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fn(x, y);
      const o = (y * width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

describe('Halftone optical mixing model', () => {
  it('validates halftoneMixing and halftoneRadiusMm options', () => {
    // Valid options
    expect(() =>
      resolveOptions({
        halftoneMixing: true,
        halftoneRadiusMm: 1.0,
      }),
    ).not.toThrow();

    // Invalid halftoneRadiusMm <= 0
    expect(() =>
      validateOptions(
        resolveOptions({
          halftoneMixing: true,
          halftoneRadiusMm: 0,
        }),
      ),
    ).toThrow(/halftoneRadiusMm/);

    // Invalid halftoneRadiusMm > 20
    expect(() =>
      validateOptions(
        resolveOptions({
          halftoneMixing: true,
          halftoneRadiusMm: 25,
        }),
      ),
    ).toThrow(/halftoneRadiusMm/);
  });

  it('runs weaving with halftone mixing enabled and preserves physical invariants', () => {
    // Target with green center disc
    const img = makeColorImage(120, 120, (x, y) => {
      const d = Math.hypot(x - 60, y - 60);
      if (d < 35) return [30, 160, 40]; // Green disc
      return [255, 255, 255]; // White background
    });

    const options = resolveOptions({
      threads: CMYK_THREADS,
      resolutionPx: 128,
      maxLines: 40,
      minPegGap: 8,
      maxChordRepeats: 1,
      halftoneMixing: true,
      halftoneRadiusMm: 0.8,
      preprocess: { grayscale: false },
    });

    const engine = new WeaveEngine(img, options);
    const result = engine.run();

    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps.length).toBeLessThanOrEqual(40);
    expect(result.rmse).toBeLessThan(1.0);

    // Verify continuity: for each thread, consecutive steps must connect
    const threadSteps = new Map<number, typeof result.steps>();
    for (const step of result.steps) {
      if (!threadSteps.has(step.thread)) threadSteps.set(step.thread, []);
      threadSteps.get(step.thread)!.push(step);
    }

    for (const [, steps] of threadSteps) {
      for (let i = 1; i < steps.length; i++) {
        expect(steps[i].from).toBe(steps[i - 1].to);
        expect(steps[i].fromSide).toBe(steps[i - 1].toSide);
      }
    }
  });

  it('supports rebuildCanvasFromSteps with halftoneMixing active', () => {
    const img = makeColorImage(100, 100, (x, _y) => {
      return x < 50 ? [200, 50, 50] : [50, 50, 200];
    });

    const options = resolveOptions({
      threads: CMYK_THREADS,
      resolutionPx: 100,
      maxLines: 20,
      minPegGap: 8,
      halftoneMixing: true,
      halftoneRadiusMm: 0.75,
      preprocess: { grayscale: false },
    });

    const engine = new WeaveEngine(img, options);
    engine.run();

    const canvasBefore = new Float32Array(engine.canvas);
    engine.rebuildCanvasFromSteps();
    const canvasAfter = engine.canvas;

    for (let p = 0; p < canvasBefore.length; p++) {
      expect(canvasAfter[p]).toBeCloseTo(canvasBefore[p], 4);
    }
  });

  it('guarantees local bounding-box residual updates match full 2D Gaussian refresh with zero drift', () => {
    const img = makeColorImage(100, 100, (x, y) => {
      return [(x * 2.5) & 255, (y * 2.5) & 255, ((x + y) * 1.5) & 255];
    });

    const options = resolveOptions({
      threads: CMYK_THREADS,
      resolutionPx: 100,
      maxLines: 49, // Exactly 49 steps so periodic refresh (at step 50) has not run yet
      minPegGap: 8,
      halftoneMixing: true,
      halftoneRadiusMm: 0.75,
      preprocess: { grayscale: false },
    });

    const engine = new WeaveEngine(img, options);
    for (let i = 0; i < 49 && !engine.done; i++) {
      engine.step();
    }

    // Capture the local residual accumulated over all individual chord updates
    const localResidual = new Float32Array((engine as unknown as { halftoneResidual: Float32Array }).halftoneResidual);

    // Trigger full 2D Gaussian recalculation
    (engine as unknown as { refreshHalftoneResidualFull: () => void }).refreshHalftoneResidualFull();
    const fullResidual = (engine as unknown as { halftoneResidual: Float32Array }).halftoneResidual;

    // Both buffers must be mathematically identical (max diff < 1e-4)
    let maxDiff = 0;
    for (let p = 0; p < localResidual.length; p++) {
      const diff = Math.abs(localResidual[p] - fullResidual[p]);
      if (diff > maxDiff) maxDiff = diff;
    }
    expect(maxDiff).toBeLessThan(1e-4);
  });

  it('supports single-channel grayscale halftone mixing without regression', () => {
    const img = makeColorImage(80, 80, (x, y) => {
      const d = Math.hypot(x - 40, y - 40);
      const v = d < 25 ? 30 : 230;
      return [v, v, v];
    });

    const options = resolveOptions({
      resolutionPx: 80,
      maxLines: 25,
      minPegGap: 8,
      halftoneMixing: true,
      halftoneRadiusMm: 0.6,
      preprocess: { grayscale: true },
    });

    const engine = new WeaveEngine(img, options);
    const res = engine.run();
    expect(res.steps.length).toBeGreaterThan(0);
    expect(res.steps.length).toBeLessThanOrEqual(25);
    expect(res.rmse).toBeLessThan(1.0);
  });
});
