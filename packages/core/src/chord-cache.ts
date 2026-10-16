import type { Segment } from './geometry.js';
import type { ChordRasterizer } from './raster.js';

export interface ChordSamples {
  readonly idx: Int32Array;
  readonly cov: Float32Array;
  readonly count: number;
}

export interface ChordCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly bytes: number;
  readonly entries: number;
}

/**
 * Stub temporário de cache de cordas em JS (legado expurgado na Task 0.1).
 */
export class ChordCache {
  private readonly emptySamples: ChordSamples = {
    idx: new Int32Array(0),
    cov: new Float32Array(0),
    count: 0,
  };

  constructor(_raster: ChordRasterizer, _budgetBytes: number, _widthClasses = 1) {}

  get(_key: number, _widthClass: number, _seg: Segment, _scale: number, _widthPx: number): ChordSamples {
    return this.emptySamples;
  }

  get stats(): ChordCacheStats {
    return {
      hits: 0,
      misses: 0,
      bytes: 0,
      entries: 0,
    };
  }

  clear(): void {}
}
