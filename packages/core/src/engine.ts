import { hexToLinear, isAchromatic, linearToSrgb8, luminance } from './color.js';
import { computeThreadBudgets, resolveOptions } from './config.js';
import { buildChordMask, createLoom, tangentSegment, wrapAngle, type Loom, type Segment } from './geometry.js';
import { prepareTarget, type TargetImage } from './image.js';
import { calculateMetrics } from './metrics.js';
import { refineWeave } from './refine.js';
import {
  type CandidateEvaluator,
  type CandidateQuery,
  type CandidateResult,
  type EvaluatorFactory,
  type EvaluatorSetup,
  JsEvaluator,
} from './evaluator.js';
import type { ChordSamples } from './chord-cache.js';
import { StaleGainTable } from './pruning.js';
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

type Candidate = CandidateResult;

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
  readonly chordMask: Uint8Array;
  /** Simulated appearance of the artwork, linear light, `size * size * channels`. */
  readonly canvas: Float32Array;
  readonly steps: WeaveStep[] = [];
  readonly evaluator: CandidateEvaluator;
  stopReason: StopReason | null = null;

  private readonly threads: ThreadState[];
  private readonly threadColors: Float32Array;
  private readonly threadWidthPx: Float32Array;
  private readonly threadOpacity: Float32Array;
  private readonly chordUse: Uint16Array;
  private readonly pruningTable: StaleGainTable | null = null;
  private readonly startedAt: number;
  private readonly layerBudgets: number[];
  private readonly threadLineCounts: number[];
  private currentLayer = 0;
  private lastStopReason: StopReason = 'no-improvement';

  private readonly halftoneMixing: boolean;
  private readonly halftoneKernelRadius: number;
  private readonly halftoneKernel: Float32Array | null;
  private readonly halftoneResidual: Float32Array | null;
  private readonly halftoneScratch: Float32Array | null;

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

    const rasterCacheBytes = (options.rasterCacheMb ?? 128) * 1024 * 1024;
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
      lengthPenalty: options.lengthPenalty,
      rasterCacheBytes,
      highlightProtection: options.preprocess.highlightProtection ?? options.highlightProtection ?? 0,
      angularDiversity: options.preprocess.angularDiversity ?? options.angularDiversity ?? 0,
      centerDampRadiusMm: options.preprocess.centerDampRadiusMm ?? options.centerDampRadiusMm ?? 0,
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

    if (options.candidatePruning === 'lazy') {
      this.pruningTable = new StaleGainTable(options.threads.length, N);
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

    this.startedAt = now();
    this.layerBudgets = computeThreadBudgets(options);
    this.threadLineCounts = new Array(options.threads.length).fill(0);
    this.currentLayer = 0;

    this.halftoneMixing = Boolean(options.halftoneMixing);
    if (this.halftoneMixing) {
      const radiusMm = options.halftoneRadiusMm ?? 0.75;
      const sigmaPx = Math.max(0.2, radiusMm * this.pxPerMm);
      const kRad = Math.max(1, Math.min(8, Math.ceil(2.5 * sigmaPx)));
      this.halftoneKernelRadius = kRad;
      const kSize = kRad * 2 + 1;
      this.halftoneKernel = new Float32Array(kSize);
      let kSum = 0;
      for (let i = -kRad; i <= kRad; i++) {
        const v = Math.exp(-(i * i) / (2 * sigmaPx * sigmaPx));
        this.halftoneKernel[i + kRad] = v;
        kSum += v;
      }
      for (let i = 0; i < kSize; i++) this.halftoneKernel[i] /= kSum;
      if (this.evaluator.buffers.halftone && this.evaluator.buffers.halftone.length === this.size * this.size * C) {
        this.halftoneResidual = this.evaluator.buffers.halftone;
      } else {
        this.halftoneResidual = new Float32Array(this.size * this.size * C);
        this.evaluator.buffers.halftone = this.halftoneResidual;
      }
      this.halftoneScratch = new Float32Array(this.size * this.size * C);
      this.refreshHalftoneResidualFull();
    } else {
      this.halftoneKernelRadius = 0;
      this.halftoneKernel = null;
      this.halftoneResidual = null;
      this.halftoneScratch = null;
    }
  }

  /** Convenience factory: merge overrides onto the defaults, validate and build. */
  static create(
    image: RasterImage,
    overrides: DeepPartial<WeaveOptions> = {},
    importance?: RasterImage,
    extra?: EngineExtraOptions,
  ): WeaveEngine {
    return new WeaveEngine(image, resolveOptions(overrides), importance, extra);
  }

  /** Async factory for asynchronous evaluators (e.g. WebAssembly or parallel workers). */
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
      const rasterCacheBytes = (options.rasterCacheMb ?? 128) * 1024 * 1024;
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
        lengthPenalty: options.lengthPenalty,
        rasterCacheBytes,
        highlightProtection: options.preprocess.highlightProtection ?? options.highlightProtection ?? 0,
        angularDiversity: options.preprocess.angularDiversity ?? options.angularDiversity ?? 0,
        centerDampRadiusMm: options.preprocess.centerDampRadiusMm ?? options.centerDampRadiusMm ?? 0,
      };
      const resolvedEval = await Promise.resolve(extra.evaluator(setup));
      return new WeaveEngine(image, options, importance, { evaluator: resolvedEval });
    }
    return new WeaveEngine(image, options, importance, extra);
  }

  get done(): boolean {
    return this.stopReason !== null;
  }

  /** Current layer being woven in layered strategy (or layer of the most recent chord). */
  get currentLayerIndex(): number {
    if (this.steps.length > 0) {
      const last = this.steps[this.steps.length - 1];
      return last.layerIndex ?? last.thread;
    }
    return Math.min(this.currentLayer, this.options.threads.length - 1);
  }

  /** Current thread index being woven (or thread of the most recent chord). */
  get currentThreadIndex(): number {
    if (this.steps.length > 0) {
      return this.steps[this.steps.length - 1].thread;
    }
    return Math.min(this.currentLayer, this.options.threads.length - 1);
  }

  /** Lay the next best chord. Returns null (and sets `stopReason`) when finished. */
  step(): WeaveStep | null {
    if (this.stopReason) return null;
    if (this.steps.length >= this.options.maxLines) {
      this.stopReason = 'max-lines';
      return null;
    }

    const strategy = this.options.colorStrategy ?? 'layered';
    if (strategy === 'layered') {
      return this.stepLayered();
    } else if (strategy === 'interleaved-balanced') {
      return this.stepInterleavedBalanced();
    } else {
      return this.stepFree();
    }
  }

  private stepLayered(): WeaveStep | null {
    const numThreads = this.options.threads.length;
    const stopWhenNoImp = this.options.stopWhenNoImprovement;

    while (this.currentLayer < numThreads) {
      const t = this.currentLayer;
      const currentQuota = this.layerBudgets[t];

      if (this.threadLineCounts[t] >= currentQuota) {
        this.currentLayer++;
        continue;
      }

      const best = this.findBestForThread(t);

      if (!best) {
        this.lastStopReason = 'no-candidates';
        const unused = currentQuota - this.threadLineCounts[t];
        if (unused > 0 && this.currentLayer < numThreads - 1) {
          this.layerBudgets[numThreads - 1] += unused;
        }
        this.currentLayer++;
        continue;
      }

      if (best.gain <= 0 && stopWhenNoImp) {
        this.lastStopReason = 'no-improvement';
        const unused = currentQuota - this.threadLineCounts[t];
        if (unused > 0 && this.currentLayer < numThreads - 1) {
          this.layerBudgets[numThreads - 1] += unused;
        }
        this.currentLayer++;
        continue;
      }

      this.threadLineCounts[t]++;
      return this.apply(best, t);
    }

    if (this.steps.length >= this.options.maxLines) {
      this.stopReason = 'max-lines';
    } else {
      this.stopReason = this.lastStopReason;
    }
    return null;
  }

  private stepInterleavedBalanced(): WeaveStep | null {
    const numThreads = this.options.threads.length;
    const stopWhenNoImp = this.options.stopWhenNoImprovement;

    // Threads that haven't reached their budget
    const eligible: { thread: number; ratio: number }[] = [];
    for (let t = 0; t < numThreads; t++) {
      if (this.threadLineCounts[t] < this.layerBudgets[t]) {
        const quota = Math.max(1, this.layerBudgets[t]);
        eligible.push({ thread: t, ratio: this.threadLineCounts[t] / quota });
      }
    }

    if (eligible.length === 0) {
      this.stopReason = 'max-lines';
      return null;
    }

    // Sort by ratio ascending so threads furthest behind their quota take turns first
    eligible.sort((a, b) => a.ratio - b.ratio || a.thread - b.thread);

    // Try eligible threads in priority order to find one with positive gain
    let fallbackBest: Candidate | null = null;
    let fallbackThread = -1;

    for (const item of eligible) {
      const cand = this.findBestForThread(item.thread);
      if (cand && cand.gain > 0) {
        this.threadLineCounts[item.thread]++;
        return this.apply(cand, item.thread);
      }

      // If an intermediate thread (t < numThreads - 1) has no positive gain or no candidates,
      // roll over its remaining budget to the final thread (black) so lines are not lost.
      if ((!cand || (cand.gain <= 0 && stopWhenNoImp)) && item.thread < numThreads - 1) {
        const unused = this.layerBudgets[item.thread] - this.threadLineCounts[item.thread];
        if (unused > 0) {
          this.layerBudgets[numThreads - 1] += unused;
          this.layerBudgets[item.thread] = this.threadLineCounts[item.thread];
        }
        continue;
      }

      if (cand && !fallbackBest) {
        fallbackBest = cand;
        fallbackThread = item.thread;
      }
    }

    // If rollover gave budget to the final thread (numThreads - 1) and it hasn't woven yet,
    // let's try the final thread if it has positive gain
    const finalThread = numThreads - 1;
    if (this.threadLineCounts[finalThread] < this.layerBudgets[finalThread]) {
      const cand = this.findBestForThread(finalThread);
      if (cand && cand.gain > 0) {
        this.threadLineCounts[finalThread]++;
        return this.apply(cand, finalThread);
      }
      if (cand && !fallbackBest) {
        fallbackBest = cand;
        fallbackThread = finalThread;
      }
    }

    if (stopWhenNoImp) {
      this.stopReason = 'no-improvement';
      return null;
    }

    if (fallbackBest && fallbackThread >= 0) {
      this.threadLineCounts[fallbackThread]++;
      return this.apply(fallbackBest, fallbackThread);
    }

    this.stopReason = 'no-candidates';
    return null;
  }

  private stepFree(): WeaveStep | null {
    const best = this.findBestAllThreads();
    if (!best) {
      this.stopReason = 'no-candidates';
      return null;
    }
    if (best.gain <= 0 && this.options.stopWhenNoImprovement) {
      this.stopReason = 'no-improvement';
      return null;
    }
    this.threadLineCounts[best.thread]++;
    return this.apply(best, best.thread);
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
    if (this.options.refinePasses && this.options.refinePasses > 0 && this.stopReason !== 'aborted') {
      this.refine(this.options.refinePasses);
    }
    return this.result();
  }

  /** Perform global refinement passes, preserving thread continuity. Returns improvements count. */
  refine(passes = 1): number {
    return refineWeave(this, passes);
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
    const metrics = calculateMetrics(this.canvas, this.target, this.channels);
    const rmse = metrics.rmse;
    return {
      version: 1,
      options: this.options,
      steps: [...this.steps],
      threads,
      totalLengthMm: this.totalLengthMm,
      rmse,
      metrics,
      stopReason: this.stopReason ?? 'aborted',
      durationMs: now() - this.startedAt,
    };
  }

  /** Helper for refinement: returns linear channel values of thread t. */
  getThreadColorChannels(t: number): number[] {
    const C = this.channels;
    const out: number[] = [];
    for (let c = 0; c < C; c++) {
      out.push(this.threadColors[t * C + c]);
    }
    return out;
  }

  /** Helper for refinement: get count of times chord (from, to) was used. */
  getChordUse(from: number, to: number): number {
    const N = this.loom.pegs.length;
    return this.chordUse[from * N + to];
  }

  /** Helper for refinement: increment chord use count. */
  incrementChordUse(from: number, to: number): void {
    const N = this.loom.pegs.length;
    this.chordUse[from * N + to]++;
    this.chordUse[to * N + from]++;
  }

  /** Helper for refinement: decrement chord use count. */
  decrementChordUse(from: number, to: number): void {
    const N = this.loom.pegs.length;
    if (this.chordUse[from * N + to] > 0) this.chordUse[from * N + to]--;
    if (this.chordUse[to * N + from] > 0) this.chordUse[to * N + from]--;
  }

  /** Helper for refinement: rebuild canvas and thread physical stats from steps sequence. */
  rebuildCanvasFromSteps(): void {
    const C = this.channels;
    const toChannels = (hex: string): number[] => {
      const rgb = hexToLinear(hex);
      return C === 1 ? [luminance(rgb)] : rgb;
    };
    const bg = toChannels(this.options.background);
    for (let p = 0; p < this.size * this.size; p++) {
      for (let c = 0; c < C; c++) this.canvas[p * C + c] = bg[c];
    }

    this.threads.forEach((t, i) => {
      t.peg = this.options.threads[i].startPeg;
      t.side = null;
      t.dirX = 0;
      t.dirY = 0;
      t.hasDir = false;
      t.lengthMm = 0;
      t.lines = 0;
      t.pegs = [this.options.threads[i].startPeg];
    });

    const { pegs, pegRadiusMm } = this.loom;

    this.chordUse.fill(0);
    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i];
      const t = step.thread;
      const state = this.threads[t];
      const a = pegs[step.from];
      const b = pegs[step.to];
      const seg = tangentSegment(a, step.fromSide, b, step.toSide, pegRadiusMm);

      const samples = this.evaluator.samples(step.from, step.fromSide, step.to, step.toSide, t);
      const { idx, cov, count } = samples;
      const op = this.threadOpacity[t];
      for (let k = 0; k < count; k++) {
        const c = cov[k] * op;
        const q = idx[k] * C;
        for (let ch = 0; ch < C; ch++) {
          const K = this.threadColors[t * C + ch];
          this.canvas[q + ch] += c * (K - this.canvas[q + ch]);
        }
      }

      const wrapMm = state.hasDir
        ? this.loom.pegRadiusMm * wrapAngle(state.dirX, state.dirY, seg.dx, seg.dy, step.fromSide)
        : 0;
      step.segmentMm = seg.length;
      step.wrapMm = wrapMm;
      state.lengthMm += wrapMm + seg.length;
      state.peg = step.to;
      state.side = step.toSide;
      state.dirX = seg.dx;
      state.dirY = seg.dy;
      state.hasDir = true;
      state.lines++;
      state.pegs.push(step.to);
    }

    if (this.halftoneMixing) {
      this.refreshHalftoneResidualFull();
    }
  }

  /** Full 2D separable Gaussian filter refresh of the halftone effective residual G * (T - C). */
  private refreshHalftoneResidualFull(): void {
    if (!this.halftoneResidual || !this.halftoneKernel || !this.halftoneScratch) return;
    const size = this.size;
    const C = this.channels;
    const kRad = this.halftoneKernelRadius;
    const kernel = this.halftoneKernel;
    const scratch = this.halftoneScratch;
    const out = this.halftoneResidual;
    const target = this.target.data;
    const canvas = this.canvas;

    // Horizontal pass: compute residual (target - canvas) and blur along x
    for (let y = 0; y < size; y++) {
      const row = y * size;
      for (let x = 0; x < size; x++) {
        for (let c = 0; c < C; c++) {
          let sum = 0;
          for (let k = -kRad; k <= kRad; k++) {
            const sx = Math.min(Math.max(x + k, 0), size - 1);
            const p = (row + sx) * C + c;
            sum += (target[p] - canvas[p]) * kernel[k + kRad];
          }
          scratch[(row + x) * C + c] = sum;
        }
      }
    }

    // Vertical pass: blur scratch along y into out
    for (let y = 0; y < size; y++) {
      const row = y * size;
      for (let x = 0; x < size; x++) {
        for (let c = 0; c < C; c++) {
          let sum = 0;
          for (let k = -kRad; k <= kRad; k++) {
            const sy = Math.min(Math.max(y + k, 0), size - 1);
            sum += scratch[(sy * size + x) * C + c] * kernel[k + kRad];
          }
          out[(row + x) * C + c] = sum;
        }
      }
    }
  }

  /** Local 2D separable Gaussian filter update on the chord segment dilated bounding box. */
  private updateHalftoneResidualLocal(seg: Segment, threadIdx: number): void {
    if (!this.halftoneResidual || !this.halftoneKernel || !this.halftoneScratch) return;
    const size = this.size;
    const C = this.channels;
    const scale = this.pxPerMm;
    const kRad = this.halftoneKernelRadius;
    const kernel = this.halftoneKernel;
    const scratch = this.halftoneScratch;
    const out = this.halftoneResidual;
    const target = this.target.data;
    const canvas = this.canvas;

    const wPx = this.threadWidthPx[threadIdx];
    const x0 = seg.x0 * scale;
    const y0 = seg.y0 * scale;
    const x1 = seg.x1 * scale;
    const y1 = seg.y1 * scale;

    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - wPx - 1));
    const maxX = Math.min(size - 1, Math.ceil(Math.max(x0, x1) + wPx + 1));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - wPx - 1));
    const maxY = Math.min(size - 1, Math.ceil(Math.max(y0, y1) + wPx + 1));

    const outMinX = Math.max(0, minX - kRad);
    const outMaxX = Math.min(size - 1, maxX + kRad);
    const outMinY = Math.max(0, minY - kRad);
    const outMaxY = Math.min(size - 1, maxY + kRad);

    const inMinY = Math.max(0, outMinY - kRad);
    const inMaxY = Math.min(size - 1, outMaxY + kRad);

    // Horizontal blur pass on the dilated box
    for (let y = inMinY; y <= inMaxY; y++) {
      const row = y * size;
      for (let x = outMinX; x <= outMaxX; x++) {
        for (let c = 0; c < C; c++) {
          let sum = 0;
          for (let k = -kRad; k <= kRad; k++) {
            const sx = Math.min(Math.max(x + k, 0), size - 1);
            const p = (row + sx) * C + c;
            sum += (target[p] - canvas[p]) * kernel[k + kRad];
          }
          scratch[(row + x) * C + c] = sum;
        }
      }
    }

    // Vertical blur pass
    for (let y = outMinY; y <= outMaxY; y++) {
      const row = y * size;
      for (let x = outMinX; x <= outMaxX; x++) {
        for (let c = 0; c < C; c++) {
          let sum = 0;
          for (let k = -kRad; k <= kRad; k++) {
            const sy = Math.min(Math.max(y + k, 0), size - 1);
            sum += scratch[(sy * size + x) * C + c] * kernel[k + kRad];
          }
          out[(row + x) * C + c] = sum;
        }
      }
    }
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

  private findBestForThread(t: number): Candidate | null {
    const state = this.threads[t];
    const query: CandidateQuery = {
      thread: t,
      fromPeg: state.peg,
      fromSide: state.side,
      lastDirX: state.hasDir ? state.dirX : undefined,
      lastDirY: state.hasDir ? state.dirY : undefined,
    };
    if (this.pruningTable) {
      const forceFullScan = this.steps.length % 256 === 0;
      return this.pruningTable.findBestLazy(
        query,
        this.evaluator,
        this.loom.pegs,
        this.loom.sides,
        this.loom.pegRadiusMm,
        this.chordMask,
        this.options.maxChordRepeats,
        forceFullScan,
      );
    }
    return this.evaluator.bestForThread(query);
  }

  private findBestAllThreads(): Candidate | null {
    let best: Candidate | null = null;
    for (let t = 0; t < this.threads.length; t++) {
      const cand = this.findBestForThread(t);
      if (cand && (!best || cand.gain > best.gain)) {
        best = cand;
      }
    }
    return best;
  }

  private apply(cand: Candidate, layerIndex?: number): WeaveStep {
    const { thread: t, to, fromSide, toSide, seg } = cand;
    const state = this.threads[t];
    const N = this.loom.pegs.length;

    // Paint the chord onto the simulated canvas using canonical cached samples
    const samples = this.evaluator.samples(state.peg, fromSide, to, toSide, t);
    const { idx, cov, count } = samples;
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
      layerIndex: layerIndex ?? t,
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

    if (this.halftoneMixing) {
      if (this.steps.length % 50 === 0) {
        this.refreshHalftoneResidualFull();
      } else {
        this.updateHalftoneResidualLocal(seg, t);
      }
    }

    return step;
  }

  /** Chords samples in canonical orientation (cached). */
  chordSamples(from: number, fromSide: PegSide, to: number, toSide: PegSide, thread = 0): ChordSamples {
    return this.evaluator.samples(from, fromSide, to, toSide, thread);
  }

  /** Performance diagnostics for benchmark and UI. */
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
