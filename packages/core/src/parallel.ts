import { tangentSegment, type Loom, type Peg } from './geometry.js';
import type { PegSide } from './types.js';
import {
  JsEvaluator,
  type CandidateEvaluator,
  type CandidateQuery,
  type CandidateResult,
  type EvaluatorBuffers,
  type EvaluatorSetup,
  type EvaluatorStats,
} from './evaluator.js';
import type { ChordSamples } from './chord-cache.js';

export const CMD_IDLE = 0;
export const CMD_EVALUATE = 1;
export const CMD_TERMINATE = 2;

export const CONTROL_EPOCH = 0;
export const CONTROL_COMMAND = 1;
export const CONTROL_QUERY_THREAD = 2;
export const CONTROL_QUERY_FROM_PEG = 3;
export const CONTROL_QUERY_FROM_SIDE = 4;
export const CONTROL_DONE_COUNT = 5;
export const CONTROL_WORKER_COUNT = 6;
export const CONTROL_HELPER_COUNT = 7;
export const CONTROL_READY_COUNT = 8;

export interface SharedBuffersDescriptor {
  canvasSab: SharedArrayBuffer;
  targetSab: SharedArrayBuffer;
  weightSab: SharedArrayBuffer;
  halftoneSab: SharedArrayBuffer | null;
  chordUseSab: SharedArrayBuffer;
}

export interface SharedControlDescriptor {
  controlSab: SharedArrayBuffer;
  resultsSab: SharedArrayBuffer;
}

export interface SharedControlState {
  control: Int32Array;
  resultsGain: Float64Array;
  resultsMeta: Int32Array;
  descriptor: SharedControlDescriptor;
}

export function createSharedBuffers(
  setup: EvaluatorSetup,
  hasHalftone = false,
): { buffers: EvaluatorBuffers; descriptor: SharedBuffersDescriptor } {
  const size = setup.size;
  const C = setup.channels;
  const N = setup.pegX.length;

  const canvasSab = new SharedArrayBuffer(size * size * C * 4);
  const targetSab = new SharedArrayBuffer(size * size * C * 4);
  const weightSab = new SharedArrayBuffer(size * size * 4);
  const halftoneSab = hasHalftone ? new SharedArrayBuffer(size * size * C * 4) : null;
  const chordUseSab = new SharedArrayBuffer(N * N * 2);

  const descriptor: SharedBuffersDescriptor = {
    canvasSab,
    targetSab,
    weightSab,
    halftoneSab,
    chordUseSab,
  };

  const buffers: EvaluatorBuffers = {
    canvas: new Float32Array(canvasSab),
    target: new Float32Array(targetSab),
    weight: new Float32Array(weightSab),
    halftone: halftoneSab ? new Float32Array(halftoneSab) : null,
    chordUse: new Uint16Array(chordUseSab),
  };

  return { buffers, descriptor };
}

export function viewSharedBuffers(descriptor: SharedBuffersDescriptor): EvaluatorBuffers {
  return {
    canvas: new Float32Array(descriptor.canvasSab),
    target: new Float32Array(descriptor.targetSab),
    weight: new Float32Array(descriptor.weightSab),
    halftone: descriptor.halftoneSab ? new Float32Array(descriptor.halftoneSab) : null,
    chordUse: new Uint16Array(descriptor.chordUseSab),
  };
}

export function createSharedControl(workerCount: number): SharedControlState {
  const controlSab = new SharedArrayBuffer(16 * 4);
  const resultsSab = new SharedArrayBuffer(workerCount * 8 + workerCount * 16);

  const control = new Int32Array(controlSab);
  const resultsGain = new Float64Array(resultsSab, 0, workerCount);
  const resultsMeta = new Int32Array(resultsSab, workerCount * 8, workerCount * 4);

  control[CONTROL_WORKER_COUNT] = workerCount;
  control[CONTROL_HELPER_COUNT] = Math.max(0, workerCount - 1);

  return {
    control,
    resultsGain,
    resultsMeta,
    descriptor: { controlSab, resultsSab },
  };
}

export function viewSharedControl(
  descriptor: SharedControlDescriptor,
  workerCount: number,
): { control: Int32Array; resultsGain: Float64Array; resultsMeta: Int32Array } {
  const control = new Int32Array(descriptor.controlSab);
  const resultsGain = new Float64Array(descriptor.resultsSab, 0, workerCount);
  const resultsMeta = new Int32Array(descriptor.resultsSab, workerCount * 8, workerCount * 4);
  return { control, resultsGain, resultsMeta };
}

export interface ParallelEvaluatorOptions {
  workerCount: number;
  setup: EvaluatorSetup;
  buffers: EvaluatorBuffers;
  sharedControl: SharedControlState;
  onDispose?: () => void;
}

export class ParallelEvaluator implements CandidateEvaluator {
  readonly name = 'parallel' as const;
  readonly buffers: EvaluatorBuffers;
  private readonly setup: EvaluatorSetup;
  private readonly loom: Loom;
  private readonly localEvaluator: JsEvaluator;
  private readonly workerCount: number;
  private readonly sharedControl: SharedControlState;
  private readonly onDispose?: () => void;
  private isDisposed = false;

  constructor(options: ParallelEvaluatorOptions) {
    this.setup = options.setup;
    this.buffers = options.buffers;
    this.workerCount = Math.max(1, options.workerCount);
    this.sharedControl = options.sharedControl;
    this.onDispose = options.onDispose;

    const N = this.setup.pegX.length;
    const pegs: Peg[] = new Array(N);
    for (let i = 0; i < N; i++) {
      pegs[i] = {
        index: i,
        angle: 0,
        x: this.setup.pegX[i],
        y: this.setup.pegY[i],
        nx: 0,
        ny: 0,
        edges: 0,
      };
    }
    this.loom = {
      pegs,
      pegRadiusMm: this.setup.pegRadiusMm,
      sides: this.setup.sides,
      extentMm: this.setup.extentMm,
      chordMask: this.setup.chordMask,
    } as unknown as Loom;

    const localCacheBytes = Math.floor(this.setup.rasterCacheBytes / this.workerCount);
    const localSetup: EvaluatorSetup = {
      ...this.setup,
      rasterCacheBytes: localCacheBytes,
    };
    this.localEvaluator = new JsEvaluator(localSetup, this.buffers);
  }

  waitUntilReady(): void {
    if (this.workerCount <= 1) return;
    const helperCount = this.workerCount - 1;
    const { control } = this.sharedControl;
    while (Atomics.load(control, CONTROL_READY_COUNT) < helperCount) {
      const current = Atomics.load(control, CONTROL_READY_COUNT);
      if (current < helperCount) {
        Atomics.wait(control, CONTROL_READY_COUNT, current);
      }
    }
  }

  bestForThread(q: CandidateQuery): CandidateResult | null {
    if (this.workerCount <= 1) {
      return this.localEvaluator.bestForThread(q);
    }

    const { control, resultsGain, resultsMeta } = this.sharedControl;
    const N = this.setup.pegX.length;
    const helperCount = this.workerCount - 1;

    // Set query parameters in control buffer
    Atomics.store(control, CONTROL_QUERY_THREAD, q.thread);
    Atomics.store(control, CONTROL_QUERY_FROM_PEG, q.fromPeg);
    Atomics.store(control, CONTROL_QUERY_FROM_SIDE, q.fromSide === null ? 0 : q.fromSide);
    Atomics.store(control, CONTROL_COMMAND, CMD_EVALUATE);
    Atomics.store(control, CONTROL_DONE_COUNT, 0);

    // Increment epoch to wake up all helper workers
    Atomics.add(control, CONTROL_EPOCH, 1);
    Atomics.notify(control, CONTROL_EPOCH, helperCount);

    // Worker 0 (main/coordinator thread) evaluates its own slice: [0, Math.floor(N / workerCount))
    const start0 = 0;
    const end0 = Math.floor(N / this.workerCount);
    const best0 = this.localEvaluator.bestForThreadSlice(q, start0, end0);

    // Wait for all helper workers (workers 1..W-1) to finish
    while (Atomics.load(control, CONTROL_DONE_COUNT) < helperCount) {
      const currentDone = Atomics.load(control, CONTROL_DONE_COUNT);
      if (currentDone < helperCount) {
        Atomics.wait(control, CONTROL_DONE_COUNT, currentDone);
      }
    }

    // Reduce best candidate across worker 0 and workers 1..W-1
    let best = best0;

    for (let w = 1; w < this.workerCount; w++) {
      const found = resultsMeta[w * 4 + 0];
      if (found === 1) {
        const gain = resultsGain[w];
        if (!best || gain > best.gain) {
          const to = resultsMeta[w * 4 + 1];
          const fromSide = resultsMeta[w * 4 + 2] as PegSide;
          const toSide = resultsMeta[w * 4 + 3] as PegSide;
          const seg = tangentSegment(
            this.loom.pegs[q.fromPeg],
            fromSide,
            this.loom.pegs[to],
            toSide,
            this.setup.pegRadiusMm,
          );
          best = {
            thread: q.thread,
            to,
            fromSide,
            toSide,
            gain,
            seg,
          };
        }
      }
    }

    return best;
  }

  scoreChord(q: CandidateQuery, to: number, toSide: PegSide): number {
    return this.localEvaluator.scoreChord(q, to, toSide);
  }

  samples(from: number, fromSide: PegSide, to: number, toSide: PegSide, thread: number): ChordSamples {
    return this.localEvaluator.samples(from, fromSide, to, toSide, thread);
  }

  get stats(): EvaluatorStats {
    return this.localEvaluator.stats;
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    if (this.workerCount > 1) {
      const { control } = this.sharedControl;
      const helperCount = this.workerCount - 1;
      Atomics.store(control, CONTROL_COMMAND, CMD_TERMINATE);
      Atomics.add(control, CONTROL_EPOCH, 1);
      Atomics.notify(control, CONTROL_EPOCH, helperCount);
    }

    this.localEvaluator.dispose();
    this.onDispose?.();
  }
}

/**
 * Worker helper loop intended to run inside any thread/worker context
 * (Node worker_threads or browser Web Worker).
 */
export function runHelperLoop(
  workerIndex: number,
  workerCount: number,
  controlDesc: SharedControlDescriptor,
  setup: EvaluatorSetup,
  buffersDesc: SharedBuffersDescriptor,
): void {
  const { control, resultsGain, resultsMeta } = viewSharedControl(controlDesc, workerCount);
  const buffers = viewSharedBuffers(buffersDesc);

  const N = setup.pegX.length;
  const startTo = Math.floor((workerIndex * N) / workerCount);
  const endTo = Math.floor(((workerIndex + 1) * N) / workerCount);

  const localCacheBytes = Math.floor(setup.rasterCacheBytes / workerCount);
  const localSetup: EvaluatorSetup = {
    ...setup,
    rasterCacheBytes: localCacheBytes,
  };
  const evaluator = new JsEvaluator(localSetup, buffers);

  // Signal that this worker is initialized and ready
  Atomics.add(control, CONTROL_READY_COUNT, 1);
  Atomics.notify(control, CONTROL_READY_COUNT, 1);

  let localEpoch = 0;

  while (true) {
    let currentEpoch = Atomics.load(control, CONTROL_EPOCH);
    while (currentEpoch === localEpoch) {
      Atomics.wait(control, CONTROL_EPOCH, localEpoch);
      currentEpoch = Atomics.load(control, CONTROL_EPOCH);
    }
    localEpoch = currentEpoch;

    const cmd = Atomics.load(control, CONTROL_COMMAND);
    if (cmd === CMD_TERMINATE) {
      evaluator.dispose();
      break;
    }

    if (cmd === CMD_EVALUATE) {
      const thread = Atomics.load(control, CONTROL_QUERY_THREAD);
      const fromPeg = Atomics.load(control, CONTROL_QUERY_FROM_PEG);
      const rawSide = Atomics.load(control, CONTROL_QUERY_FROM_SIDE);
      const fromSide = rawSide === 0 ? null : (rawSide as PegSide);

      const q: CandidateQuery = { thread, fromPeg, fromSide };
      const best = evaluator.bestForThreadSlice(q, startTo, endTo);

      if (best) {
        resultsGain[workerIndex] = best.gain;
        resultsMeta[workerIndex * 4 + 0] = 1;
        resultsMeta[workerIndex * 4 + 1] = best.to;
        resultsMeta[workerIndex * 4 + 2] = best.fromSide;
        resultsMeta[workerIndex * 4 + 3] = best.toSide;
      } else {
        resultsGain[workerIndex] = -Infinity;
        resultsMeta[workerIndex * 4 + 0] = 0;
      }

      const done = Atomics.add(control, CONTROL_DONE_COUNT, 1) + 1;
      const helperCount = Atomics.load(control, CONTROL_HELPER_COUNT);
      if (done === helperCount) {
        Atomics.notify(control, CONTROL_DONE_COUNT, 1);
      }
    }
  }
}
