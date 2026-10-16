import { hexToLinear, isAchromatic, linearToSrgb8, luminance } from './color.js';
import { resolveOptions } from './config.js';
import { buildChordMask, createLoom, type Loom } from './geometry.js';
import { prepareTarget, type TargetImage } from './image.js';
import { calculateMetrics } from './metrics.js';
import { type CandidateEvaluator, type EvaluatorFactory, type EvaluatorSetup, JsEvaluator } from './evaluator.js';
import type { ChordSamples } from './chord-cache.js';
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

export interface EngineExtraOptions {
  evaluator?: EvaluatorFactory | CandidateEvaluator;
}

export interface RunOptions {
  /** Called every `progressEvery` chords. */
  onProgress?: (engine: WeaveEngine) => void;
  progressEvery?: number;
  /** Return true to abort the run. */
  shouldAbort?: () => boolean;
}

/**
 * Stub tipado do WeaveEngine (loop guloso legado em JS expurgado na Task 0.1).
 * A UI e a Main Thread/Workers JS não executam mais cálculos pesados de String Art em JS;
 * o novo motor será implementado em Rust/Wasm + TypeScript/WebGL2.
 */
export class WeaveEngine {
  readonly options: WeaveOptions;
  readonly loom: Loom;
  readonly target: TargetImage;
  readonly size: number;
  readonly channels: 1 | 3;
  readonly pxPerMm: number;
  readonly chordMask: Uint8Array;
  readonly canvas: Float32Array;
  readonly steps: WeaveStep[] = [];
  readonly evaluator: CandidateEvaluator;
  stopReason: StopReason | null = null;

  private readonly threadColors: Float32Array;
  private readonly threadWidthPx: Float32Array;
  private readonly threadOpacity: Float32Array;
  private readonly chordUse: Uint16Array;
  private readonly startedAt: number;

  constructor(
    image: RasterImage | TargetImage,
    options: WeaveOptions,
    importance?: RasterImage,
    extra?: EngineExtraOptions,
  ) {
    this.options = options;
    this.loom = createLoom(options.loom);
    this.size = options.resolutionPx;
    this.pxPerMm = this.size / this.loom.extentMm;
    this.chordMask = buildChordMask(this.loom, options.minPegGap);

    const achromatic = isAchromatic(options.background) && options.threads.every((t) => isAchromatic(t.color));
    const channels: 1 | 3 = achromatic || options.preprocess.grayscale ? 1 : 3;
    if ('channels' in image) {
      if (image.size !== this.size) throw new Error('TargetImage.size difere de resolutionPx');
      this.target = image;
    } else {
      const preprocess = {
        ...options.preprocess,
        viewingDistanceM: options.preprocess.viewingDistanceM || options.viewingDistanceM,
      };
      this.target = prepareTarget(image, this.size, preprocess, channels, importance, this.loom);
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

    const N = this.loom.pegs.length;
    const pegX = new Float64Array(N);
    const pegY = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      pegX[i] = this.loom.pegs[i].x;
      pegY[i] = this.loom.pegs[i].y;
    }

    const setup: EvaluatorSetup = {
      size: this.size,
      channels: this.channels,
      scale: this.pxPerMm,
      extentMm: this.loom.extentMm,
      pegX,
      pegY,
      pegRadiusMm: this.loom.pegRadiusMm,
      sides: this.loom.sides,
      chordMask: this.chordMask,
      threadColors: this.threadColors,
      threadWidthPx: this.threadWidthPx,
      threadOpacity: this.threadOpacity,
      maxChordRepeats: options.maxChordRepeats,
      highlightProtection: options.preprocess.highlightProtection ?? options.highlightProtection ?? 0,
    };

    if (extra?.evaluator) {
      if (typeof extra.evaluator === 'function') {
        const created = extra.evaluator(setup);
        if (created instanceof Promise) {
          throw new Error('Async evaluator factory must be initialized using WeaveEngine.createAsync()');
        }
        this.evaluator = created;
      } else {
        this.evaluator = extra.evaluator;
      }
    } else {
      this.evaluator = new JsEvaluator(setup);
    }

    this.canvas = this.evaluator.buffers.canvas;
    this.chordUse = this.evaluator.buffers.chordUse;
    this.evaluator.buffers.target.set(this.target.data);
    this.evaluator.buffers.weight.set(this.target.weight);

    const bg = toChannels(options.background);
    for (let p = 0; p < this.size * this.size; p++) {
      for (let c = 0; c < C; c++) this.canvas[p * C + c] = bg[c];
    }

    this.startedAt = now();
  }

  static create(
    image: RasterImage,
    overrides: DeepPartial<WeaveOptions> = {},
    importance?: RasterImage,
    extra?: EngineExtraOptions,
  ): WeaveEngine {
    return new WeaveEngine(image, resolveOptions(overrides), importance, extra);
  }

  static async createAsync(
    image: RasterImage,
    overrides: DeepPartial<WeaveOptions> = {},
    importance?: RasterImage,
    extra?: EngineExtraOptions,
  ): Promise<WeaveEngine> {
    const options = resolveOptions(overrides);
    if (extra?.evaluator && typeof extra.evaluator === 'function') {
      const loom = createLoom(options.loom);
      const size = options.resolutionPx;
      const pxPerMm = size / loom.extentMm;
      const chordMask = buildChordMask(loom, options.minPegGap);
      const achromatic = isAchromatic(options.background) && options.threads.every((t) => isAchromatic(t.color));
      const channels: 1 | 3 = achromatic || options.preprocess.grayscale ? 1 : 3;
      const N = loom.pegs.length;
      const pegX = new Float64Array(N);
      const pegY = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        pegX[i] = loom.pegs[i].x;
        pegY[i] = loom.pegs[i].y;
      }
      const toChannels = (hex: string): number[] => {
        const rgb = hexToLinear(hex);
        return channels === 1 ? [luminance(rgb)] : rgb;
      };
      const threadColors = new Float32Array(options.threads.length * channels);
      const threadWidthPx = new Float32Array(options.threads.length);
      const threadOpacity = new Float32Array(options.threads.length);
      options.threads.forEach((t, i) => {
        threadColors.set(toChannels(t.color), i * channels);
        threadWidthPx[i] = t.widthMm * pxPerMm;
        threadOpacity[i] = t.opacity;
      });
      const setup: EvaluatorSetup = {
        size,
        channels,
        scale: pxPerMm,
        extentMm: loom.extentMm,
        pegX,
        pegY,
        pegRadiusMm: loom.pegRadiusMm,
        sides: loom.sides,
        chordMask,
        threadColors,
        threadWidthPx,
        threadOpacity,
        maxChordRepeats: options.maxChordRepeats,
        highlightProtection: options.preprocess.highlightProtection ?? options.highlightProtection ?? 0,
      };
      const resolvedEval = await Promise.resolve(extra.evaluator(setup));
      return new WeaveEngine(image, options, importance, { evaluator: resolvedEval });
    }
    return new WeaveEngine(image, options, importance, extra);
  }

  get done(): boolean {
    return this.stopReason !== null;
  }

  get currentLayerIndex(): number {
    return 0;
  }

  get currentThreadIndex(): number {
    return 0;
  }

  step(): WeaveStep | null {
    this.stopReason = 'no-candidates';
    return null;
  }

  runChunk(_count: number): boolean {
    this.step();
    return this.done;
  }

  run(opts: RunOptions = {}): WeaveResult {
    if (opts.shouldAbort?.()) {
      this.stopReason = 'aborted';
    } else {
      this.step();
      opts.onProgress?.(this);
    }
    return this.result();
  }

  refine(_passes = 1): number {
    return 0;
  }

  abort(): void {
    if (!this.stopReason) this.stopReason = 'aborted';
  }

  get totalLengthMm(): number {
    return 0;
  }

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
    const threads: ThreadSummary[] = this.options.threads.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      pegs: [t.startPeg],
      lengthMm: 0,
      lines: 0,
    }));
    const metrics = calculateMetrics(this.canvas, this.target, this.channels);
    return {
      version: 1,
      options: this.options,
      steps: [...this.steps],
      threads,
      totalLengthMm: 0,
      rmse: metrics.rmse,
      metrics,
      stopReason: this.stopReason ?? 'aborted',
      durationMs: now() - this.startedAt,
    };
  }

  getThreadColorChannels(t: number): number[] {
    const C = this.channels;
    const out: number[] = [];
    for (let c = 0; c < C; c++) {
      out.push(this.threadColors[t * C + c]);
    }
    return out;
  }

  getChordUse(from: number, to: number): number {
    const N = this.loom.pegs.length;
    return this.chordUse[from * N + to];
  }

  incrementChordUse(from: number, to: number): void {
    const N = this.loom.pegs.length;
    this.chordUse[from * N + to]++;
    this.chordUse[to * N + from]++;
  }

  decrementChordUse(from: number, to: number): void {
    const N = this.loom.pegs.length;
    if (this.chordUse[from * N + to] > 0) this.chordUse[from * N + to]--;
    if (this.chordUse[to * N + from] > 0) this.chordUse[to * N + from]--;
  }

  rebuildCanvasFromSteps(): void {}

  toRGBA(): Uint8ClampedArray {
    return toRGBA(this.canvas, this.channels, this.target.mask);
  }

  targetToRGBA(): Uint8ClampedArray {
    return toRGBA(this.target.data, this.channels, this.target.mask);
  }

  chordSamples(from: number, fromSide: PegSide, to: number, toSide: PegSide, thread = 0): ChordSamples {
    return this.evaluator.samples(from, fromSide, to, toSide, thread);
  }

  get perf(): {
    evaluator: 'js' | 'wasm' | 'parallel';
    cacheHits: number;
    cacheMisses: number;
    cacheBytes: number;
    candidatesScored: number;
    candidatesSkipped: number;
  } {
    const s = this.evaluator.stats;
    return {
      evaluator: this.evaluator.name,
      cacheHits: s.cacheHits,
      cacheMisses: s.cacheMisses,
      cacheBytes: s.cacheBytes,
      candidatesScored: s.candidatesScored,
      candidatesSkipped: s.candidatesSkipped,
    };
  }

  dispose(): void {
    this.evaluator.dispose();
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
