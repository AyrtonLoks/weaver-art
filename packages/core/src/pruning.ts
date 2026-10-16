import type { Peg } from './geometry.js';
import type { PegSide } from './types.js';
import type { CandidateEvaluator, CandidateQuery, CandidateResult } from './evaluator.js';

/**
 * Stub temporário da tabela de poda preguiçosa JS (legado expurgado na Task 0.1).
 */
export class StaleGainTable {
  constructor(_threadCount: number, _pegCount: number) {}

  get(_thread: number, _chordKey: number): number {
    return 0;
  }

  set(_thread: number, _chordKey: number, _gain: number): void {}

  reset(): void {}

  findBestLazy(
    _q: CandidateQuery,
    _evaluator: CandidateEvaluator,
    _pegs: readonly Peg[],
    _sides: readonly PegSide[],
    _pegRadiusMm: number,
    _chordMask: Uint8Array,
    _maxChordRepeats: number,
    _forceFullScan: boolean,
  ): CandidateResult | null {
    return null;
  }
}
