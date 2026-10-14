import { canonicalSegment, chordKey, tangentSegment, type Loom, type Peg, type Segment } from './geometry.js';
import type { PegSide } from './types.js';
import { ChordCache, type ChordSamples } from './chord-cache.js';
import { ChordRasterizer } from './raster.js';

export interface EvaluatorSetup {
  size: number;
  channels: 1 | 3;
  scale: number;
  extentMm: number;
  pegX: Float64Array;
  pegY: Float64Array;
  pegRadiusMm: number;
  sides: readonly PegSide[];
  chordMask: Uint8Array;
  threadColors: Float32Array;
  threadWidthPx: Float32Array | Float64Array | number[];
  threadOpacity: Float32Array | Float64Array | number[];
  maxChordRepeats: number;
  lengthPenalty?: number;
  rasterCacheBytes: number;
}

export interface EvaluatorBuffers {
  canvas: Float32Array;
  target: Float32Array;
  weight: Float32Array;
  halftone: Float32Array | null;
  chordUse: Uint16Array;
}

export interface CandidateQuery {
  thread: number;
  fromPeg: number;
  fromSide: PegSide | null;
}

export interface CandidateResult {
  thread: number;
  to: number;
  fromSide: PegSide;
  toSide: PegSide;
  gain: number;
  seg: Segment;
}

export interface EvaluatorStats {
  candidatesScored: number;
  candidatesSkipped: number;
  cacheHits: number;
  cacheMisses: number;
  cacheBytes: number;
}

export interface CandidateEvaluator {
  readonly name: 'js' | 'wasm' | 'parallel';
  readonly buffers: EvaluatorBuffers;
  bestForThread(q: CandidateQuery): CandidateResult | null;
  bestForThreadSlice?(q: CandidateQuery, startTo: number, endTo: number): CandidateResult | null;
  scoreChord(q: CandidateQuery, to: number, toSide: PegSide): number;
  samples(from: number, fromSide: PegSide, to: number, toSide: PegSide, thread: number): ChordSamples;
  readonly stats: EvaluatorStats;
  dispose(): void;
}

export type EvaluatorFactory = (setup: EvaluatorSetup) => CandidateEvaluator | Promise<CandidateEvaluator>;

export class JsEvaluator implements CandidateEvaluator {
  readonly name = 'js' as const;
  readonly buffers: EvaluatorBuffers;
  private readonly setup: EvaluatorSetup;
  private readonly loom: Loom;
  private readonly cache: ChordCache;
  private readonly threadWidthClasses: number[];
  private scoredCount = 0;
  private skippedCount = 0;

  constructor(setup: EvaluatorSetup, buffers?: EvaluatorBuffers) {
    this.setup = setup;
    const N = setup.pegX.length;
    const pegs: Peg[] = new Array(N);
    for (let i = 0; i < N; i++) {
      pegs[i] = {
        index: i,
        angle: 0,
        x: setup.pegX[i],
        y: setup.pegY[i],
        nx: 0,
        ny: 0,
        edges: 0,
      };
    }
    this.loom = {
      pegs,
      pegRadiusMm: setup.pegRadiusMm,
      sides: setup.sides,
      extentMm: setup.extentMm,
      chordMask: setup.chordMask,
    } as unknown as Loom;

    const size = setup.size;
    const channels = setup.channels;
    if (buffers) {
      this.buffers = buffers;
    } else {
      this.buffers = {
        canvas: new Float32Array(size * size * channels),
        target: new Float32Array(size * size * channels),
        weight: new Float32Array(size * size),
        halftone: null,
        chordUse: new Uint16Array(N * N),
      };
    }

    // Map thread widths to discrete classes
    const uniqueWidths: number[] = [];
    this.threadWidthClasses = new Array(setup.threadWidthPx.length);
    for (let i = 0; i < setup.threadWidthPx.length; i++) {
      const w = setup.threadWidthPx[i];
      let cls = uniqueWidths.indexOf(w);
      if (cls === -1) {
        cls = uniqueWidths.length;
        uniqueWidths.push(w);
      }
      this.threadWidthClasses[i] = cls;
    }

    let maxWidth = 1;
    for (let i = 0; i < setup.threadWidthPx.length; i++) {
      if (setup.threadWidthPx[i] > maxWidth) maxWidth = setup.threadWidthPx[i];
    }
    const raster = new ChordRasterizer(size, maxWidth);
    this.cache = new ChordCache(raster, setup.rasterCacheBytes, Math.max(1, uniqueWidths.length));
  }

  bestForThread(q: CandidateQuery): CandidateResult | null {
    return this.bestForThreadSlice(q, 0, this.setup.pegX.length);
  }

  bestForThreadSlice(q: CandidateQuery, startTo: number, endTo: number): CandidateResult | null {
    const { thread, fromPeg, fromSide } = q;
    const N = this.setup.pegX.length;
    const sides = this.setup.sides;
    const fromSides: readonly PegSide[] = fromSide === null ? sides : [fromSide];
    const pegs = this.loom.pegs;
    const pegRadiusMm = this.setup.pegRadiusMm;

    let best: CandidateResult | null = null;
    const a = pegs[fromPeg];

    for (let to = startTo; to < endTo; to++) {
      if (this.setup.chordMask[fromPeg * N + to] === 0) {
        this.skippedCount++;
        continue;
      }
      if (this.buffers.chordUse[fromPeg * N + to] >= this.setup.maxChordRepeats) {
        this.skippedCount++;
        continue;
      }
      const b = pegs[to];
      for (const fSide of fromSides) {
        const queryWithSide: CandidateQuery = { thread, fromPeg, fromSide: fSide };
        for (const tSide of sides) {
          const gain = this.scoreChord(queryWithSide, to, tSide);
          if (!best || gain > best.gain) {
            const seg = tangentSegment(a, fSide, b, tSide, pegRadiusMm);
            best = { thread, to, fromSide: fSide, toSide: tSide, gain, seg };
          }
        }
      }
    }
    return best;
  }

  scoreChord(q: CandidateQuery, to: number, toSide: PegSide): number {
    this.scoredCount++;
    const { thread, fromPeg } = q;
    const fromSide = q.fromSide ?? this.setup.sides[0];
    const canonical = canonicalSegment(this.loom, fromPeg, fromSide, to, toSide);
    const key = chordKey(fromPeg, fromSide, to, toSide, this.setup.pegX.length);
    const widthClass = this.threadWidthClasses[thread];
    const widthPx = this.setup.threadWidthPx[thread];
    const samples = this.cache.get(key, widthClass, canonical, this.setup.scale, widthPx);

    const { idx, cov, count } = samples;
    const { canvas, target, weight, halftone } = this.buffers;
    const op = this.setup.threadOpacity[thread];
    let gain = 0;

    if (this.setup.channels === 1) {
      const K = this.setup.threadColors[thread];
      for (let i = 0; i < count; i++) {
        const p = idx[i];
        const w = weight[p];
        if (w === 0) continue;
        const R = canvas[p];
        const d = cov[i] * op * (K - R);
        const err = halftone ? halftone[p] : target[p] - R;
        gain += w * d * (2 * err - d);
      }
    } else {
      const o = thread * 3;
      const K0 = this.setup.threadColors[o];
      const K1 = this.setup.threadColors[o + 1];
      const K2 = this.setup.threadColors[o + 2];
      for (let i = 0; i < count; i++) {
        const p = idx[i];
        const w = weight[p];
        if (w === 0) continue;
        const c = cov[i] * op;
        const q = p * 3;
        const R0 = canvas[q];
        const R1 = canvas[q + 1];
        const R2 = canvas[q + 2];
        const d0 = c * (K0 - R0);
        const d1 = c * (K1 - R1);
        const d2 = c * (K2 - R2);
        const err0 = halftone ? halftone[q] : target[q] - R0;
        const err1 = halftone ? halftone[q + 1] : target[q + 1] - R1;
        const err2 = halftone ? halftone[q + 2] : target[q + 2] - R2;
        gain += w * (d0 * (2 * err0 - d0) + d1 * (2 * err1 - d1) + d2 * (2 * err2 - d2));
      }
    }

    if (this.setup.lengthPenalty && this.setup.lengthPenalty > 0 && gain > 0) {
      const normLen = canonical.length / this.setup.extentMm;
      gain *= Math.max(0, 1 - this.setup.lengthPenalty * normLen);
    }

    return gain;
  }

  samples(from: number, fromSide: PegSide, to: number, toSide: PegSide, thread: number): ChordSamples {
    const canonical = canonicalSegment(this.loom, from, fromSide, to, toSide);
    const key = chordKey(from, fromSide, to, toSide, this.setup.pegX.length);
    const widthClass = this.threadWidthClasses[thread];
    const widthPx = this.setup.threadWidthPx[thread];
    return this.cache.get(key, widthClass, canonical, this.setup.scale, widthPx);
  }

  get stats(): EvaluatorStats {
    const cs = this.cache.stats;
    return {
      candidatesScored: this.scoredCount,
      candidatesSkipped: this.skippedCount,
      cacheHits: cs.hits,
      cacheMisses: cs.misses,
      cacheBytes: cs.bytes,
    };
  }

  recordSkipped(count: number): void {
    this.skippedCount += count;
  }

  dispose(): void {
    this.cache.clear();
  }
}

export function createJsEvaluator(setup: EvaluatorSetup): CandidateEvaluator {
  return new JsEvaluator(setup);
}
