import { describe, expect, it } from 'vitest';
import {
  BLACK_THREAD,
  decodeProgressCode,
  DEFAULT_OPTIONS,
  encodeProgressCode,
  mergeProgress,
  weaveFingerprint,
  withProgress,
  type WeaveProgress,
  type WeaveResult,
} from '../src/index.js';

describe('Knitting progress, fingerprints, and cross-device resume', () => {
  const mockResult: WeaveResult = {
    version: 1,
    options: {
      ...DEFAULT_OPTIONS,
      threads: [BLACK_THREAD],
    },
    steps: [
      { index: 0, thread: 0, from: 0, to: 50, fromSide: 1, toSide: 1, gain: 0.1, segmentMm: 500, wrapMm: 3 },
      { index: 1, thread: 0, from: 50, to: 120, fromSide: 1, toSide: 1, gain: 0.1, segmentMm: 600, wrapMm: 3 },
      { index: 2, thread: 0, from: 120, to: 30, fromSide: 1, toSide: 1, gain: 0.1, segmentMm: 700, wrapMm: 3 },
    ],
    threads: [{ id: 'black', name: 'Preto', color: '#000000', pegs: [0], lengthMm: 1809, lines: 3 }],
    totalLengthMm: 1809,
    rmse: 0.05,
    stopReason: 'max-lines',
    durationMs: 50,
  };

  it('generates a stable deterministic fingerprint string', () => {
    const fp1 = weaveFingerprint(mockResult);
    const fp2 = weaveFingerprint(mockResult);
    expect(fp1).toBe(fp2);
    expect(typeof fp1).toBe('string');
    expect(fp1.length).toBeGreaterThan(0);
  });

  it('encodes and decodes progress codes (WA1-...) with checksum verification', () => {
    const code = encodeProgressCode(mockResult, 42);
    expect(code.startsWith('WA1-')).toBe(true);

    const decoded = decodeProgressCode(code);
    expect(decoded).not.toBeNull();
    expect(decoded!.fingerprint).toBe(weaveFingerprint(mockResult));
    expect(decoded!.index).toBe(42);
  });

  it('rejects tampered or corrupt progress codes', () => {
    const code = encodeProgressCode(mockResult, 100);
    // Tamper with index
    const tampered = code.replace('-2s-', '-99-');
    expect(decodeProgressCode(tampered)).toBeNull();

    // Invalid format
    expect(decodeProgressCode('NOT-A-VALID-CODE')).toBeNull();
  });

  it('attaches progress metadata with withProgress', () => {
    const date = new Date('2026-10-13T12:00:00Z');
    const updated = withProgress(mockResult, 50, date);
    expect(updated.progress).toEqual({
      index: 50,
      updatedAt: '2026-10-13T12:00:00.000Z',
    });
  });

  it('mergeProgress selects the most recently updated progress', () => {
    const older: WeaveProgress = { index: 10, updatedAt: '2026-10-13T10:00:00Z' };
    const newer: WeaveProgress = { index: 25, updatedAt: '2026-10-13T14:00:00Z' };

    expect(mergeProgress(older, newer)).toEqual(newer);
    expect(mergeProgress(newer, older)).toEqual(newer);
    expect(mergeProgress(older, undefined)).toEqual(older);
    expect(mergeProgress(undefined, newer)).toEqual(newer);
  });
});
