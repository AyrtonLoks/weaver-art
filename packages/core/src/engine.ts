import { hexToLinear, isAchromatic, linearToSrgb8, luminance } from './color.js';
import { computeThreadBudgets, resolveOptions } from './config.js';
import { createLoom, pegDistance, tangentSegment, wrapAngle, type Loom, type Segment } from './geometry.js';
import { prepareTarget, type TargetImage } from './image.js';
import { calculateMetrics } from './metrics.js';
import { ChordRasterizer } from './raster.js';
import { refineWeave } from './refine.js';
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
  private readonly layerBudgets: number[];
  private readonly threadLineCounts: number[];
  private currentLayer = 0;
  private lastStopReason: StopReason = 'no-improvement';

  private readonly halftoneMixing: boolean;
  private readonly halftoneKernelRadius: number;
  private readonly halftoneKernel: Float32Array | null;
  private readonly halftoneResidual: Float32Array | null;
  private readonly halftoneScratch: Float32Array | null;

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
      const preprocess = {
        ...options.preprocess,
        viewingDistanceM: options.preprocess.viewingDistanceM || options.viewingDistanceM,
      };
      this.target = prepareTarget(image, this.size, preprocess, channels, importance, options.loom.diameterMm);
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
      this.halftoneResidual = new Float32Array(this.size * this.size * C);
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
  static create(image: RasterImage, overrides: DeepPartial<WeaveOptions> = {}, importance?: RasterImage): WeaveEngine {
    return new WeaveEngine(image, resolveOptions(overrides), importance);
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

    const scale = this.pxPerMm;
    const { pegs, pegRadiusMm } = this.loom;

    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i];
      const t = step.thread;
      const state = this.threads[t];
      const a = pegs[step.from];
      const b = pegs[step.to];
      const seg = tangentSegment(a, step.fromSide, b, step.toSide, pegRadiusMm);

      const count = this.raster.rasterize(
        seg.x0 * scale,
        seg.y0 * scale,
        seg.x1 * scale,
        seg.y1 * scale,
        this.threadWidthPx[t],
      );
      const { idx, cov } = this.raster;
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
    const { pegs, sides, pegRadiusMm } = this.loom;
    const N = pegs.length;
    const { minPegGap, maxChordRepeats } = this.options;
    const scale = this.pxPerMm;
    let best: Candidate | null = null;

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
          const count = this.raster.rasterize(seg.x0 * scale, seg.y0 * scale, seg.x1 * scale, seg.y1 * scale, widthPx);
          let gain = this.score(t, count);
          if (this.options.lengthPenalty && this.options.lengthPenalty > 0 && gain > 0) {
            const normLen = seg.length / this.options.loom.diameterMm;
            gain *= Math.max(0, 1 - this.options.lengthPenalty * normLen);
          }
          if (!best || gain > best.gain) {
            best = { thread: t, to, fromSide, toSide, gain, seg };
          }
        }
      }
    }
    return best;
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

  /** Error reduction if thread `t` covered the samples currently in the rasterizer. */
  private score(t: number, count: number): number {
    const { idx, cov } = this.raster;
    const { data: target, weight } = this.target;
    const canvas = this.canvas;
    const op = this.threadOpacity[t];
    const halftone = this.halftoneResidual;
    let gain = 0;
    if (this.channels === 1) {
      const K = this.threadColors[t];
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
        const err0 = halftone ? halftone[q] : target[q] - R0;
        const err1 = halftone ? halftone[q + 1] : target[q + 1] - R1;
        const err2 = halftone ? halftone[q + 2] : target[q + 2] - R2;
        gain += w * (d0 * (2 * err0 - d0) + d1 * (2 * err1 - d1) + d2 * (2 * err2 - d2));
      }
    }
    return gain;
  }

  private apply(cand: Candidate, layerIndex?: number): WeaveStep {
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
