import { describe, expect, it } from 'vitest';
import {
  BLACK_THREAD,
  DEFAULT_OPTIONS,
  estimateWeave,
  formatDuration,
  toInstructions,
  type WeaveResult,
} from '../src/index.js';

describe('Weaving estimation and spool calculation', () => {
  const mockResult: WeaveResult = {
    version: 1,
    options: {
      ...DEFAULT_OPTIONS,
      threads: [
        { ...BLACK_THREAD, id: 't1', name: 'Preto' },
        { ...BLACK_THREAD, id: 't2', name: 'Branco', color: '#ffffff' },
      ],
    },
    steps: [
      // Thread 0: 3 chords
      { index: 0, thread: 0, from: 0, to: 50, fromSide: 1, toSide: 1, gain: 0.1, segmentMm: 500, wrapMm: 3 },
      { index: 1, thread: 0, from: 50, to: 120, fromSide: 1, toSide: 1, gain: 0.1, segmentMm: 600, wrapMm: 3 },
      { index: 2, thread: 0, from: 120, to: 30, fromSide: 1, toSide: 1, gain: 0.1, segmentMm: 700, wrapMm: 3 },
      // Thread 1: 2 chords
      { index: 3, thread: 1, from: 0, to: 100, fromSide: 1, toSide: 1, gain: 0.1, segmentMm: 700, wrapMm: 3 },
      { index: 4, thread: 1, from: 100, to: 40, fromSide: 1, toSide: 1, gain: 0.1, segmentMm: 600, wrapMm: 3 },
      // Thread 0 again: 1 chord (switch, not new tie-on)
      { index: 5, thread: 0, from: 30, to: 150, fromSide: 1, toSide: 1, gain: 0.1, segmentMm: 600, wrapMm: 3 },
    ],
    threads: [
      { id: 't1', name: 'Preto', color: '#000000', pegs: [0], lengthMm: 2412, lines: 4 },
      { id: 't2', name: 'Branco', color: '#ffffff', pegs: [0], lengthMm: 1306, lines: 2 },
    ],
    totalLengthMm: 3718,
    rmse: 0.05,
    stopReason: 'max-lines',
    durationMs: 150,
  };

  it('computes correct chords, tie-ons, switches, and weaving time', () => {
    const est = estimateWeave(mockResult, {
      secondsPerChord: 6,
      secondsPerTieOn: 120,
      secondsPerSwitch: 10,
    });

    expect(est.chords).toBe(6);
    expect(est.weavingSeconds).toBe(6 * 6); // 36 s
    expect(est.tieOns).toBe(2); // Thread 0 tied at step 0, Thread 1 tied at step 3
    expect(est.switches).toBe(1); // Thread 0 switched back at step 5
    expect(est.overheadSeconds).toBe(2 * 120 + 1 * 10); // 250 s
    expect(est.totalSeconds).toBe(36 + 250); // 286 s
  });

  it('calculates thread required with safety margin and tails, plus spools', () => {
    const est = estimateWeave(mockResult, {
      safetyMarginPct: 10,
      tailMmPerThread: 300,
      spoolLengthM: 1000, // 1,000,000 mm
    });

    // Thread 0: 4 steps, length = 503 + 603 + 703 + 603 = 2412 mm
    // required = 2412 * 1.1 + 300 = 2653.2 + 300 = 2953.2 mm
    const t0 = est.threads[0];
    expect(t0.lengthMm).toBe(2412);
    expect(t0.requiredMm).toBeCloseTo(2953.2, 1);
    expect(t0.spools).toBe(1); // 2.95 m fits in 1000 m spool
    expect(t0.spoolUsagePct).toBeCloseTo((2953.2 / 1000000) * 100, 2);
  });

  it('supports fromStep to compute remaining weaving time', () => {
    // Starting from step 3 (only last 3 steps remaining)
    const est = estimateWeave(mockResult, { secondsPerChord: 6 }, 3);
    expect(est.chords).toBe(3);
    expect(est.weavingSeconds).toBe(18);
  });

  it('formats durations cleanly into hours, minutes, and seconds', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(360)).toBe('6 min');
    expect(formatDuration(3600)).toBe('1 h');
    expect(formatDuration(3665)).toBe('1 h 1 min');
    expect(formatDuration(24420)).toBe('6 h 47 min');
  });

  it('includes ESTIMATIVA DE FABRICAÇÃO block in toInstructions when estimate: true', () => {
    const textWithEst = toInstructions(mockResult, { estimate: true });
    expect(textWithEst).toContain('ESTIMATIVA DE FABRICAÇÃO:');
    expect(textWithEst).toContain('Tempo manual total:');
    expect(textWithEst).toContain('Consumo total com margem');
    expect(textWithEst).toContain('carretel(eis)');

    const textWithoutEst = toInstructions(mockResult, { estimate: false });
    expect(textWithoutEst).not.toContain('ESTIMATIVA DE FABRICAÇÃO:');
  });
});
