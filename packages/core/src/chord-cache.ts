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
 * LRU byte-bounded cache of rasterised chords in canonical orientation.
 * Guarantees bit-identical parity with direct (uncached) rasterisation.
 */
export class ChordCache {
  private readonly raster: ChordRasterizer;
  private readonly budgetBytes: number;
  private readonly widthClasses: number;
  private readonly entries = new Map<number, ChordSamples>();
  private currentBytes = 0;
  private hitCount = 0;
  private missCount = 0;
  private readonly passthroughSamples: { idx: Int32Array; cov: Float32Array; count: number };

  constructor(raster: ChordRasterizer, budgetBytes: number, widthClasses = 1) {
    this.raster = raster;
    this.budgetBytes = Math.max(0, budgetBytes);
    this.widthClasses = Math.max(1, widthClasses);
    this.passthroughSamples = {
      idx: raster.idx,
      cov: raster.cov,
      count: 0,
    };
  }

  get(key: number, widthClass: number, seg: Segment, scale: number, widthPx: number): ChordSamples {
    if (this.budgetBytes === 0) {
      this.missCount++;
      const count = this.raster.rasterize(seg.x0 * scale, seg.y0 * scale, seg.x1 * scale, seg.y1 * scale, widthPx);
      this.passthroughSamples.count = count;
      return this.passthroughSamples;
    }

    const compositeKey = this.widthClasses > 1 ? key * this.widthClasses + widthClass : key;
    const existing = this.entries.get(compositeKey);
    if (existing !== undefined) {
      this.hitCount++;
      // Move to end for LRU order
      this.entries.delete(compositeKey);
      this.entries.set(compositeKey, existing);
      return existing;
    }

    this.missCount++;
    const count = this.raster.rasterize(seg.x0 * scale, seg.y0 * scale, seg.x1 * scale, seg.y1 * scale, widthPx);

    const idxCopy = this.raster.idx.slice(0, count);
    const covCopy = this.raster.cov.slice(0, count);
    const entry: ChordSamples = { idx: idxCopy, cov: covCopy, count };
    const entryBytes = count * 8 + 64;

    if (entryBytes <= this.budgetBytes) {
      while (this.currentBytes + entryBytes > this.budgetBytes && this.entries.size > 0) {
        const oldestKey = this.entries.keys().next().value;
        if (oldestKey === undefined) break;
        const oldest = this.entries.get(oldestKey);
        if (oldest !== undefined) {
          this.currentBytes -= oldest.count * 8 + 64;
          this.entries.delete(oldestKey);
        }
      }
      this.entries.set(compositeKey, entry);
      this.currentBytes += entryBytes;
    }

    return entry;
  }

  get stats(): ChordCacheStats {
    return {
      hits: this.hitCount,
      misses: this.missCount,
      bytes: this.currentBytes,
      entries: this.entries.size,
    };
  }

  clear(): void {
    this.entries.clear();
    this.currentBytes = 0;
  }
}
