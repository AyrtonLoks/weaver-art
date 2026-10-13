import { describe, expect, it } from 'vitest';
import { WeaveEngine, type DeepPartial, type WeaveOptions } from '../src/index.js';
import { refineWeave } from '../src/refine.js';
import { discImage, syntheticImage } from './fixtures.js';
import { pegDistance } from '../src/geometry.js';

const small: DeepPartial<WeaveOptions> = {
  resolutionPx: 120,
  maxLines: 40,
  loom: { pegCount: 80 },
  minPegGap: 6,
};

describe('refineWeave', () => {
  it('strictly preserves thread continuity and peg sides with physical cylindrical pegs', () => {
    const engine = WeaveEngine.create(discImage(), {
      ...small,
      loom: { pegCount: 80, pegDiameterMm: 3 },
    });
    engine.run();
    const countBefore = engine.steps.length;

    // Run refinement
    const swaps = refineWeave(engine, 1);
    expect(typeof swaps).toBe('number');
    expect(engine.steps.length).toBe(countBefore);

    // Verify continuity: for every consecutive step in the same thread:
    // from === previous to AND fromSide === previous toSide
    for (let i = 1; i < engine.steps.length; i++) {
      const prev = engine.steps[i - 1];
      const curr = engine.steps[i];
      if (prev.thread === curr.thread) {
        expect(curr.from).toBe(prev.to);
        expect(curr.fromSide).toBe(prev.toSide);
      }
    }
  });

  it('guarantees RMSE is non-increasing after refinement', () => {
    const offCenter = syntheticImage(120, 120, (x, y) => (Math.hypot(x - 40, y - 40) < 30 ? 20 : 255));
    const engine = WeaveEngine.create(offCenter, {
      ...small,
      maxLines: 60,
      loom: { pegCount: 60 },
    });
    const resBefore = engine.run();
    const rmseBefore = resBefore.rmse;

    const swaps = engine.refine(1);
    const resAfter = engine.result();

    if (swaps > 0) {
      expect(resAfter.rmse).toBeLessThanOrEqual(rmseBefore + 1e-6);
    }
    expect(resAfter.steps.length).toBe(resBefore.steps.length);
  });

  it('respects minPegGap and maxChordRepeats constraints across all refined chords', () => {
    const offCenter = syntheticImage(120, 120, (x, y) => (Math.hypot(x - 30, y - 30) < 25 ? 20 : 255));
    const maxChordRepeats = 2;
    const minPegGap = 6;
    const pegCount = 60;
    const engine = WeaveEngine.create(offCenter, {
      resolutionPx: 120,
      maxLines: 50,
      loom: { pegCount },
      minPegGap,
      maxChordRepeats,
    });
    engine.run();
    engine.refine(2);

    // Verify chord repeats and gaps across all steps
    const pairCounts = new Map<string, number>();
    for (let i = 0; i < engine.steps.length; i++) {
      const s = engine.steps[i];
      const gap = pegDistance(s.from, s.to, pegCount);
      expect(gap).toBeGreaterThanOrEqual(minPegGap);

      const key = s.from < s.to ? `${s.from}-${s.to}` : `${s.to}-${s.from}`;
      const count = (pairCounts.get(key) ?? 0) + 1;
      pairCounts.set(key, count);
      expect(count).toBeLessThanOrEqual(maxChordRepeats);
    }
  });

  it('runs through engine.refine(passes) without error and computes metrics', () => {
    const engine = WeaveEngine.create(discImage(), { ...small, maxLines: 20 });
    const result = engine.run();
    expect(result.metrics).toBeDefined();
    expect(result.metrics?.rmse).toBeCloseTo(result.rmse, 6);
    expect(result.metrics?.deltaELab).toBeGreaterThanOrEqual(0);
    expect(result.metrics?.ssim).toBeGreaterThan(0);

    const swaps = engine.refine(1);
    expect(typeof swaps).toBe('number');
  });
});
