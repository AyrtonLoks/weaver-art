import type {
  CandidateEvaluator,
  CandidateQuery,
  CandidateResult,
  ChordSamples,
  EvaluatorBuffers,
  EvaluatorSetup,
  EvaluatorStats,
  PegSide,
} from '@weaver-art/core';
import { KERNEL_WASM_BASE64 } from './generated/kernel.js';

interface WasmExports {
  memory: WebAssembly.Memory;
  wasm_init(
    size: number,
    channels: number,
    peg_count: number,
    thread_count: number,
    sides_count: number,
    max_chord_repeats: number,
    has_halftone: number,
    peg_radius_mm: number,
    scale: number,
    extent_mm: number,
    length_penalty: number,
  ): number;
  best_for_thread(thread: number, from_peg: number, from_side_val: number): number;
  score_chord(thread: number, from_peg: number, from_side: number, to: number, to_side: number): number;
  samples_canonical(from_peg: number, from_side: number, to: number, to_side: number, width_px: number): number;
  set_halftone_active(active: number): void;
  get_canvas_ptr(): number;
  get_target_ptr(): number;
  get_weight_ptr(): number;
  get_halftone_ptr(): number;
  get_chord_use_ptr(): number;
  get_chord_mask_ptr(): number;
  get_pegs_x_ptr(): number;
  get_pegs_y_ptr(): number;
  get_thread_colors_ptr(): number;
  get_thread_width_px_ptr(): number;
  get_thread_opacity_ptr(): number;
  get_sides_ptr(): number;
  get_result_ptr(): number;
  get_samples_idx_ptr(): number;
  get_samples_cov_ptr(): number;
}

export class WasmEvaluator implements CandidateEvaluator {
  readonly name = 'wasm' as const;
  readonly buffers: EvaluatorBuffers;
  private readonly exports: WasmExports;
  private readonly setup: EvaluatorSetup;
  private readonly resultView: Float64Array;
  private readonly samplesIdxView: Int32Array;
  private readonly samplesCovView: Float32Array;
  private scoredCount = 0;
  private skippedCount = 0;

  constructor(instance: WebAssembly.Instance, setup: EvaluatorSetup) {
    this.setup = setup;
    const exp = instance.exports as unknown as WasmExports;
    this.exports = exp;

    const N = setup.pegX.length;
    const T = setup.threadOpacity.length;
    const C = setup.channels;
    const S = setup.size;

    const initRes = exp.wasm_init(
      S,
      C,
      N,
      T,
      setup.sides.length,
      setup.maxChordRepeats,
      1, // Always allocate halftone buffer slot
      setup.pegRadiusMm,
      setup.scale,
      setup.extentMm,
      0,
    );

    if (initRes !== 0) {
      throw new Error(`Failed to initialize WASM memory (code: ${initRes})`);
    }

    const mem = exp.memory.buffer;
    const canvas = new Float32Array(mem, exp.get_canvas_ptr(), S * S * C);
    const target = new Float32Array(mem, exp.get_target_ptr(), S * S * C);
    const weight = new Float32Array(mem, exp.get_weight_ptr(), S * S);
    const chordUse = new Uint16Array(mem, exp.get_chord_use_ptr(), N * N);

    this.buffers = {
      canvas,
      target,
      weight,
      halftone: null,
      chordUse,
    };

    // Populate static geometry & thread arrays into WASM memory
    new Float64Array(mem, exp.get_pegs_x_ptr(), N).set(setup.pegX);
    new Float64Array(mem, exp.get_pegs_y_ptr(), N).set(setup.pegY);
    new Uint8Array(mem, exp.get_chord_mask_ptr(), N * N).set(setup.chordMask);
    new Float32Array(mem, exp.get_thread_colors_ptr(), T * C).set(setup.threadColors);
    new Float64Array(mem, exp.get_thread_width_px_ptr(), T).set(setup.threadWidthPx);
    new Float64Array(mem, exp.get_thread_opacity_ptr(), T).set(setup.threadOpacity);

    const sidesArr = new Int32Array(mem, exp.get_sides_ptr(), setup.sides.length);
    for (let i = 0; i < setup.sides.length; i++) {
      sidesArr[i] = setup.sides[i];
    }

    this.resultView = new Float64Array(mem, exp.get_result_ptr(), 16);
    const maxSamples = S * 16 + 64;
    this.samplesIdxView = new Int32Array(mem, exp.get_samples_idx_ptr(), maxSamples);
    this.samplesCovView = new Float32Array(mem, exp.get_samples_cov_ptr(), maxSamples);
  }

  bestForThread(q: CandidateQuery): CandidateResult | null {
    if (this.buffers.halftone) {
      this.exports.set_halftone_active(1);
    } else {
      this.exports.set_halftone_active(0);
    }

    const rawSide = q.fromSide === null ? 0 : q.fromSide;
    const found = this.exports.best_for_thread(q.thread, q.fromPeg, rawSide);
    if (found === 0) {
      return null;
    }

    const res = this.resultView;
    const to = Math.round(res[1]);
    const fromSide = Math.round(res[2]) as PegSide;
    const toSide = Math.round(res[3]) as PegSide;
    const gain = res[4];
    const seg = {
      x0: res[5],
      y0: res[6],
      x1: res[7],
      y1: res[8],
      dx: res[9],
      dy: res[10],
      length: res[11],
    };

    this.scoredCount += this.setup.pegX.length;
    return {
      thread: q.thread,
      to,
      fromSide,
      toSide,
      gain,
      seg,
    };
  }

  scoreChord(q: CandidateQuery, to: number, toSide: PegSide): number {
    this.scoredCount++;
    if (this.buffers.halftone) {
      this.exports.set_halftone_active(1);
    } else {
      this.exports.set_halftone_active(0);
    }
    const fromSide = q.fromSide ?? this.setup.sides[0];
    return this.exports.score_chord(q.thread, q.fromPeg, fromSide, to, toSide);
  }

  samples(from: number, fromSide: PegSide, to: number, toSide: PegSide, thread: number): ChordSamples {
    const widthPx = this.setup.threadWidthPx[thread];
    const count = this.exports.samples_canonical(from, fromSide, to, toSide, widthPx);
    return {
      idx: this.samplesIdxView.subarray(0, count),
      cov: this.samplesCovView.subarray(0, count),
      count,
    };
  }

  get stats(): EvaluatorStats {
    return {
      candidatesScored: this.scoredCount,
      candidatesSkipped: this.skippedCount,
      cacheHits: 0,
      cacheMisses: 0,
      cacheBytes: 0,
    };
  }

  recordSkipped(count: number): void {
    this.skippedCount += count;
  }

  dispose(): void {
    // WASM memory is garbage-collected with the instance
  }
}

export async function instantiateWasmKernel(setup: EvaluatorSetup): Promise<WasmEvaluator> {
  let wasmBytes: Uint8Array;
  const maybeBuffer = (globalThis as unknown as { Buffer?: { from: (s: string, e: string) => Uint8Array } }).Buffer;
  if (maybeBuffer && typeof maybeBuffer.from === 'function') {
    wasmBytes = maybeBuffer.from(KERNEL_WASM_BASE64, 'base64');
  } else {
    const binaryString = (globalThis as unknown as { atob: (s: string) => string }).atob(KERNEL_WASM_BASE64);
    wasmBytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      wasmBytes[i] = binaryString.charCodeAt(i);
    }
  }

  const module = await WebAssembly.compile(wasmBytes as unknown as BufferSource);
  const instance = await WebAssembly.instantiate(module, {});
  return new WasmEvaluator(instance, setup);
}
