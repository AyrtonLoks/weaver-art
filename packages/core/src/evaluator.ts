import type { Segment } from './geometry.js';
import type { PegSide } from './types.js';
import type { ChordSamples } from './chord-cache.js';

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
  highlightProtection?: number;
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
  lastDirX?: number;
  lastDirY?: number;
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

const EMPTY_SAMPLES: ChordSamples = {
  idx: new Int32Array(0),
  cov: new Float32Array(0),
  count: 0,
};

/**
 * Stub temporário do avaliador JS (legado expurgado na Task 0.1).
 * Nenhum cálculo matemático pesado de String Art é executado em JS.
 */
export class JsEvaluator implements CandidateEvaluator {
  readonly name = 'js' as const;
  readonly buffers: EvaluatorBuffers;

  constructor(setup: EvaluatorSetup, buffers?: EvaluatorBuffers) {
    const N = setup.pegX.length;
    const size = setup.size;
    const channels = setup.channels;
    this.buffers = buffers ?? {
      canvas: new Float32Array(size * size * channels),
      target: new Float32Array(size * size * channels),
      weight: new Float32Array(size * size),
      halftone: null,
      chordUse: new Uint16Array(N * N),
    };
  }

  bestForThread(_q: CandidateQuery): CandidateResult | null {
    return null;
  }

  bestForThreadSlice(_q: CandidateQuery, _startTo: number, _endTo: number): CandidateResult | null {
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

  recordSkipped(_count: number): void {}

  dispose(): void {}
}

export function createJsEvaluator(setup: EvaluatorSetup): CandidateEvaluator {
  return new JsEvaluator(setup);
}
