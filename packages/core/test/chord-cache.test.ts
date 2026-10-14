import { describe, expect, it } from 'vitest';
import { ChordCache, ChordRasterizer, type Segment } from '../src/index.js';

describe('ChordCache', () => {
  const size = 128;
  const raster = new ChordRasterizer(size, 4);

  const sampleSeg: Segment = {
    x0: 10,
    y0: 15,
    x1: 100,
    y1: 85,
    dx: 0.78,
    dy: 0.62,
    length: 114,
  };

  it('produces bit-identical idx and cov compared to direct rasterization', () => {
    const directRaster = new ChordRasterizer(size, 4);
    const directCount = directRaster.rasterize(sampleSeg.x0, sampleSeg.y0, sampleSeg.x1, sampleSeg.y1, 2.0);

    const cache = new ChordCache(raster, 1024 * 1024);
    const cached = cache.get(42, 0, sampleSeg, 1.0, 2.0);

    expect(cached.count).toBe(directCount);
    for (let i = 0; i < directCount; i++) {
      expect(cached.idx[i]).toBe(directRaster.idx[i]);
      expect(cached.cov[i]).toBe(directRaster.cov[i]);
    }

    // Cache hit should return identical cached entry
    const hit = cache.get(42, 0, sampleSeg, 1.0, 2.0);
    expect(hit).toBe(cached);
    expect(cache.stats.hits).toBe(1);
    expect(cache.stats.misses).toBe(1);
  });

  it('evicts oldest entries when exceeding budgetBytes (LRU)', () => {
    // Budget enough for ~2 small chords (each is ~50-100 samples = ~500-900 bytes)
    const budgetBytes = 1500;
    const cache = new ChordCache(raster, budgetBytes);

    const seg1: Segment = { x0: 5, y0: 5, x1: 50, y1: 10, dx: 1, dy: 0, length: 45 };
    const seg2: Segment = { x0: 5, y0: 20, x1: 50, y1: 25, dx: 1, dy: 0, length: 45 };
    const seg3: Segment = { x0: 5, y0: 40, x1: 50, y1: 45, dx: 1, dy: 0, length: 45 };

    cache.get(1, 0, seg1, 1.0, 1.0);
    cache.get(2, 0, seg2, 1.0, 1.0);
    expect(cache.stats.entries).toBeGreaterThanOrEqual(1);
    expect(cache.stats.bytes).toBeLessThanOrEqual(budgetBytes);

    // Access seg3, which should trigger eviction of oldest
    cache.get(3, 0, seg3, 1.0, 1.0);
    expect(cache.stats.bytes).toBeLessThanOrEqual(budgetBytes);
  });

  it('acts as zero-allocation passthrough when budgetBytes === 0', () => {
    const cache = new ChordCache(raster, 0);
    const res1 = cache.get(10, 0, sampleSeg, 1.0, 1.5);
    expect(cache.stats.entries).toBe(0);
    expect(cache.stats.bytes).toBe(0);
    expect(cache.stats.misses).toBe(1);
    expect(cache.stats.hits).toBe(0);
    expect(res1.count).toBeGreaterThan(0);
  });
});
