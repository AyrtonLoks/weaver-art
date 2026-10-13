import { hexToLinear, isAchromatic, linearToSrgb8, luminance } from './color.js';
import { resolveOptions } from './config.js';
import { createLoom, pegDistance, tangentSegment, wrapAngle, type Loom, type Segment } from './geometry.js';
import { prepareTarget, type TargetImage } from './image.js';
import { ChordRasterizer } from './raster.js';
import type {
  DeepPartial,
  PegSide,
  RasterImage,
  StopReason,
  ThreadSummary,
  WeaveOptions,
  WeaveResult,
  WeaveStep,
} from './types.js';

interface ThreadState {
  peg: number;
  /** Side currently wrapped around `peg`; null before the first chord (tie-on side is free). */
  side: PegSide | null;
  /** Direction of the last segment (for wrap-arc length). */
  dirX: number;
  dirY: number;
  hasDir: boolean;
  lengthMm: number;
  lines: number;
  pegs: number[];
}

interface Candidate {
  thread: number;
  to: number;
  fromSide: PegSide;
  toSide: PegSide;
  gain: number;
  seg: Segment;
}

export interface RunOptions {
  /** Called every `progressEvery` chords. */
  onProgress?: (engine: WeaveEngine) => void;
  progressEvery?: number;
  /** Return true to abort the run. */
  shouldAbort?: () => boolean;
}

/**
 * Greedy error-minimising weaver.
 *
 * Model (per pixel p, linear light, per channel):
 *   canvas_p ← canvas_p + c_p · (K − canvas_p)
 * where c_p ∈ [0,1] is the area coverage of the thread over the pixel (times its opacity)
 * and K is the thread colour. For a black thread on white this is the multiplicative
 * transmittance model T = Π(1 − c_i): tone darkens with thread *density and intersections*,
 * exactly as described by Vrellis.
 *
 * At each step every admissible next chord of every thread is evaluated and the one that
 * maximises the reduction of the weighted squared error Σ w_p (target_p − canvas_p)² is laid.
 */
export class WeaveEngine {
  readonly options: WeaveOptions;
  readonly loom: Loom;
  readonly target: TargetImage;
  readonly size: number;
  readonly channels: 1 | 3;
  readonly pxPerMm: number;
  /** Simulated appearance of the artwork, linear light, `size * size * channels`. */
  readonly canvas: Float32Array;
  readonly steps: WeaveStep[] = [];
  stopReason: StopReason | null = null;

  private readonly threads: ThreadState[];
  private readonly threadColors: Float32Array;
  private readonly threadWidthPx: Float32Array;
  private readonly threadOpacity: Float32Array;
  private readonly chordUse: Uint16Array;
  private readonly raster: ChordRasterizer;
  private readonly startedAt: number;

  constructor(image: RasterImage | TargetImage, options: WeaveOptions, importance?: RasterImage) {
    this.options = options;
    this.loom = createLoom(options.loom);
    this.size = options.resolutionPx;
    this.pxPerMm = this.size / options.loom.diameterMm;

    const achromatic = isAchromatic(options.background) && options.threads.every((t) => isAchromatic(t.color));
    const channels: 1 | 3 = achromatic || options.preprocess.grayscale ? 1 : 3;
    if ('channels' in image) {
      if (image.size !== this.size) throw new Error('TargetImage.size difere de resolutionPx');
      this.target = image;
    } else {
      this.target = prepareTarget(image, this.size, options.preprocess, channels, importance);
    }
    this.channels = this.target.channels;
    const C = this.channels;

    const toChannels = (hex: string): number[] => {
      const rgb = hexToLinear(hex);
      return C === 1 ? [luminance(rgb)] : rgb;
    };

    this.threadColors = new Float32Array(options.threads.length * C);
    this.threadWidthPx = new Float32Array(options.threads.length);
    this.threadOpacity = new Float32Array(options.threads.length);
    options.threads.forEach((t, i) => {
      this.threadColors.set(toChannels(t.color), i * C);
      this.threadWidthPx[i] = t.widthMm * this.pxPerMm;
      this.threadOpacity[i] = t.opacity;
    });

    const bg = toChannels(options.background);
    this.canvas = new Float32Array(this.size * this.size * C);
    for (let p = 0; p < this.size * this.size; p++) {
      for (let c = 0; c < C; c++) this.canvas[p * C + c] = bg[c];
    }

    this.threads = options.threads.map((t) => ({
      peg: t.startPeg,
      side: null,
      dirX: 0,
      dirY: 0,
      hasDir: false,
      lengthMm: 0,
      lines: 0,
      pegs: [t.startPeg],
    }));

    const N = options.loom.pegCount;
    this.chordUse = new Uint16Array(N * N);
    this.raster = new ChordRasterizer(this.size, Math.max(...this.threadWidthPx, 1));
    this.startedAt = now();
  }

  /** Convenience factory: merge overrides onto the defaults, validate and build. */
  static create(image: RasterImage, overrides: DeepPartial<WeaveOptions> = {}, importance?: RasterImage): WeaveEngine {
    return new WeaveEngine(image, resolveOptions(overrides), importance);
  }

  get done(): boolean {
    return this.stopReason !== null;
  }

  /** Lay the next best chord. Returns null (and sets `stopReason`) when finished. */
  step(): WeaveStep | null {
    if (this.stopReason) return null;
    if (this.steps.length >= this.options.maxLines) {
      this.stopReason = 'max-lines';
      return null;
    }
    const best = this.findBest();
    if (!best) {
      this.stopReason = 'no-candidates';
      return null;
    }
    if (best.gain <= 0 && this.options.stopWhenNoImprovement) {
      this.stopReason = 'no-improvement';
      return null;
    }
    return this.apply(best);
  }

  /** Lay up to `count` chords. Returns true when the run is finished. */
  runChunk(count: number): boolean {
    for (let i = 0; i < count && !this.stopReason; i++) this.step();
    return this.done;
  }

  /** Run to completion (synchronously) and return the result. */
  run(opts: RunOptions = {}): WeaveResult {
    const every = Math.max(1, opts.progressEvery ?? 50);
    while (!this.stopReason) {
      if (opts.shouldAbort?.()) {
        this.stopReason = 'aborted';
        break;
      }
      this.runChunk(every);
      opts.onProgress?.(this);
    }
    return this.result();
  }

  /** Abort a running weave (keeps the chords laid so far). */
  abort(): void {
    if (!this.stopReason) this.stopReason = 'aborted';
  }

  /** Total thread length laid so far, in mm. */
  get totalLengthMm(): number {
    return this.threads.reduce((sum, t) => sum + t.lengthMm, 0);
  }

  /** Weighted RMSE between simulation and target (linear light, inside the loom). */
  rmse(): number {
    const { data, weight } = this.target;
    const C = this.channels;
    let err = 0;
    let wsum = 0;
    for (let p = 0; p < weight.length; p++) {
      const w = weight[p];
      if (w === 0) continue;
      for (let c = 0; c < C; c++) {
        const e = data[p * C + c] - this.canvas[p * C + c];
        err += w * e * e;
      }
      wsum += w * C;
    }
    return wsum > 0 ? Math.sqrt(err / wsum) : 0;
  }

  result(): WeaveResult {
    const threads: ThreadSummary[] = this.options.threads.map((t, i) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      pegs: [...this.threads[i].pegs],
      lengthMm: this.threads[i].lengthMm,
      lines: this.threads[i].lines,
    }));
    return {
      version: 1,
      options: this.options,
      steps: [...this.steps],
      threads,
      totalLengthMm: this.totalLengthMm,
      rmse: this.rmse(),
      stopReason: this.stopReason ?? 'aborted',
      durationMs: now() - this.startedAt,
    };
  }

  /** Simulation as 8-bit sRGB RGBA (alpha = loom mask). */
  toRGBA(): Uint8ClampedArray {
    return toRGBA(this.canvas, this.channels, this.target.mask);
  }

  /** Target (after preprocessing) as 8-bit sRGB RGBA. */
  targetToRGBA(): Uint8ClampedArray {
    return toRGBA(this.target.data, this.channels, this.target.mask);
  }

  // ---------------------------------------------------------------------------

  private findBest(): Candidate | null {
    const { pegs, sides, pegRadiusMm } = this.loom;
    const N = pegs.length;
    const { minPegGap, maxChordRepeats } = this.options;
    const scale = this.pxPerMm;
    let best: Candidate | null = null;

    for (let t = 0; t < this.threads.length; t++) {
      const state = this.threads[t];
      const a = pegs[state.peg];
      const fromSides: readonly PegSide[] = state.side === null ? sides : [state.side];
      const widthPx = this.threadWidthPx[t];

      for (let to = 0; to < N; to++) {
        if (pegDistance(state.peg, to, N) < minPegGap) continue;
        if (this.chordUse[state.peg * N + to] >= maxChordRepeats) continue;
        const b = pegs[to];
        for (const fromSide of fromSides) {
          for (const toSide of sides) {
            const seg = tangentSegment(a, fromSide, b, toSide, pegRadiusMm);
            const count = this.raster.rasterize(
              seg.x0 * scale,
              seg.y0 * scale,
              seg.x1 * scale,
              seg.y1 * scale,
              widthPx,
            );
            const gain = this.score(t, count);
            if (!best || gain > best.gain) {
              best = { thread: t, to, fromSide, toSide, gain, seg };
            }
          }
        }
      }
    }
    return best;
  }

  /** Error reduction if thread `t` covered the samples currently in the rasterizer. */
  private score(t: number, count: number): number {
    const { idx, cov } = this.raster;
    const { data: target, weight } = this.target;
    const canvas = this.canvas;
    const op = this.threadOpacity[t];
    let gain = 0;
    if (this.channels === 1) {
      const K = this.threadColors[t];
      for (let i = 0; i < count; i++) {
        const p = idx[i];
        const w = weight[p];
        if (w === 0) continue;
        const R = canvas[p];
        const d = cov[i] * op * (K - R);
        gain += w * d * (2 * (target[p] - R) - d);
      }
    } else {
      const o = t * 3;
      const K0 = this.threadColors[o];
      const K1 = this.threadColors[o + 1];
      const K2 = this.threadColors[o + 2];
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
        gain +=
          w *
          (d0 * (2 * (target[q] - R0) - d0) +
            d1 * (2 * (target[q + 1] - R1) - d1) +
            d2 * (2 * (target[q + 2] - R2) - d2));
      }
    }
    return gain;
  }

  private apply(cand: Candidate): WeaveStep {
    const { thread: t, to, fromSide, toSide, seg } = cand;
    const state = this.threads[t];
    const N = this.loom.pegs.length;
    const scale = this.pxPerMm;

    // Paint the chord onto the simulated canvas.
    const count = this.raster.rasterize(
      seg.x0 * scale,
      seg.y0 * scale,
      seg.x1 * scale,
      seg.y1 * scale,
      this.threadWidthPx[t],
    );
    const { idx, cov } = this.raster;
    const op = this.threadOpacity[t];
    const C = this.channels;
    for (let i = 0; i < count; i++) {
      const c = cov[i] * op;
      const q = idx[i] * C;
      for (let ch = 0; ch < C; ch++) {
        const K = this.threadColors[t * C + ch];
        this.canvas[q + ch] += c * (K - this.canvas[q + ch]);
      }
    }

    // Physical bookkeeping: wrap arc around the departure peg + straight segment.
    const wrapMm = state.hasDir
      ? this.loom.pegRadiusMm * wrapAngle(state.dirX, state.dirY, seg.dx, seg.dy, fromSide)
      : 0;
    state.lengthMm += wrapMm + seg.length;

    const step: WeaveStep = {
      index: this.steps.length,
      thread: t,
      from: state.peg,
      to,
      fromSide,
      toSide,
      gain: cand.gain,
      segmentMm: seg.length,
      wrapMm,
    };
    this.steps.push(step);

    this.chordUse[state.peg * N + to]++;
    this.chordUse[to * N + state.peg]++;
    state.peg = to;
    state.side = toSide;
    state.dirX = seg.dx;
    state.dirY = seg.dy;
    state.hasDir = true;
    state.lines++;
    state.pegs.push(to);
    return step;
  }
}

/** Convert a linear buffer (1 or 3 channels) to sRGB RGBA8. */
export function toRGBA(buf: Float32Array, channels: 1 | 3, mask?: Float32Array): Uint8ClampedArray {
  const n = buf.length / channels;
  const out = new Uint8ClampedArray(n * 4);
  for (let p = 0; p < n; p++) {
    const o = p * 4;
    if (channels === 1) {
      const v = linearToSrgb8(buf[p]);
      out[o] = v;
      out[o + 1] = v;
      out[o + 2] = v;
    } else {
      out[o] = linearToSrgb8(buf[p * 3]);
      out[o + 1] = linearToSrgb8(buf[p * 3 + 1]);
      out[o + 2] = linearToSrgb8(buf[p * 3 + 2]);
    }
    out[o + 3] = mask ? Math.round(mask[p] * 255) : 255;
  }
  return out;
}

function now(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf ? perf.now() : Date.now();
}
