import type { PegSide } from './types.js';
import type {
  CandidateEvaluator,
  CandidateQuery,
  CandidateResult,
  EvaluatorBuffers,
  EvaluatorSetup,
  EvaluatorStats,
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
export const CONTROL_QUERY_HAS_LAST_DIR = 9;

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

const EMPTY_SAMPLES: ChordSamples = {
  idx: new Int32Array(0),
  cov: new Float32Array(0),
  count: 0,
};

/**
 * Stub temporário de avaliação paralela JS (legado expurgado na Task 0.1).
 */
export class ParallelEvaluator implements CandidateEvaluator {
  readonly name = 'parallel' as const;
  readonly buffers: EvaluatorBuffers;
  private readonly onDispose?: () => void;

  constructor(options: ParallelEvaluatorOptions) {
    this.buffers = options.buffers;
    this.onDispose = options.onDispose;
  }

  waitUntilReady(): void {}

  bestForThread(_q: CandidateQuery): CandidateResult | null {
    return null;
  }

  scoreChord(_q: CandidateQuery, _to: number, _toSide: PegSide): number {
    return 0;
  }

  samples(_from: number, _fromSide: PegSide, _to: number, _toSide: PegSide, _thread: number): ChordSamples {
    return EMPTY_SAMPLES;
  }

  get stats(): EvaluatorStats {
    return {
      candidatesScored: 0,
      candidatesSkipped: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheBytes: 0,
    };
  }

  dispose(): void {
    this.onDispose?.();
  }
}

export function runHelperLoop(
  _workerIndex: number,
  _workerCount: number,
  _controlDesc: SharedControlDescriptor,
  _setup: EvaluatorSetup,
  _buffersDesc: SharedBuffersDescriptor,
): void {}
