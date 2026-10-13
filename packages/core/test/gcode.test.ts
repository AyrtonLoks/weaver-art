import { describe, expect, it } from 'vitest';
import { BLACK_THREAD, DEFAULT_OPTIONS, gcodePathLengthMm, toGcode, type WeaveResult } from '../src/index.js';

describe('G-code export for CNC / robotic weaving', () => {
  const mockResult: WeaveResult = {
    version: 1,
    options: {
      ...DEFAULT_OPTIONS,
      threads: [
        { ...BLACK_THREAD, id: 'black', name: 'Preto' },
        { ...BLACK_THREAD, id: 'blue', name: 'Azul', color: '#0000ff' },
      ],
    },
    steps: [
      { index: 0, thread: 0, from: 0, to: 50, fromSide: 1, toSide: 1, gain: 0.1, segmentMm: 500, wrapMm: 3 },
      { index: 1, thread: 0, from: 50, to: 120, fromSide: 1, toSide: -1, gain: 0.1, segmentMm: 600, wrapMm: 3 },
      { index: 2, thread: 1, from: 10, to: 80, fromSide: 1, toSide: 1, gain: 0.1, segmentMm: 550, wrapMm: 3 },
    ],
    threads: [
      { id: 'black', name: 'Preto', color: '#000000', pegs: [0], lengthMm: 1106, lines: 2 },
      { id: 'blue', name: 'Azul', color: '#0000ff', pegs: [10], lengthMm: 553, lines: 1 },
    ],
    totalLengthMm: 1659,
    rmse: 0.04,
    stopReason: 'max-lines',
    durationMs: 100,
  };

  it('generates valid G-code with headers, G1 lines, G2/G3 arcs, M0 pauses, and M2 termination', () => {
    const gcode = toGcode(mockResult, {
      clearanceMm: 1.5,
      feedMmPerMin: 3000,
      pauseOnThreadChange: true,
      origin: 'bottom-left',
    });

    expect(gcode).toContain('G21');
    expect(gcode).toContain('G90');
    expect(gcode).toContain('G17');
    expect(gcode).toContain('G94');
    expect(gcode).toContain('M2');

    // M0 pauses for 2 threads
    const m0Matches = gcode.match(/\bM0\b/g);
    expect(m0Matches).not.toBeNull();
    expect(m0Matches!.length).toBe(2);

    // G1 chords
    const g1Matches = gcode.match(/\bG1\b/g);
    expect(g1Matches).not.toBeNull();
    expect(g1Matches!.length).toBe(3);

    // Verify all emitted coordinates are finite numbers
    const lines = gcode.split('\n');
    for (const line of lines) {
      if (line.startsWith(';') || line.trim() === '') continue;
      const xMatch = line.match(/X(-?\d+\.?\d*)/);
      if (xMatch) {
        expect(Number.isFinite(parseFloat(xMatch[1]))).toBe(true);
      }
      const yMatch = line.match(/Y(-?\d+\.?\d*)/);
      if (yMatch) {
        expect(Number.isFinite(parseFloat(yMatch[1]))).toBe(true);
      }
    }
  });

  it('calculates total travel distance including rapid moves and arcs', () => {
    const pathLen = gcodePathLengthMm(mockResult, { clearanceMm: 1.5 });
    expect(pathLen).toBeGreaterThan(mockResult.totalLengthMm);
  });

  it('emits G3 for counter-clockwise wrap (side=1) and preserves exact arc radius |start-center| ≈ |end-center| ≈ toolRadius', () => {
    const clearanceMm = 1.5;
    const gcode = toGcode(mockResult, {
      clearanceMm,
      origin: 'bottom-left',
    });

    // In mockResult, step 1 wraps peg 50 with fromSide = 1 (CCW)
    // In bottom-left origin, physical CCW on the table must emit G3
    expect(gcode).toMatch(/\bG3\b/);

    const lines = gcode.split('\n');
    let currentX = 0;
    let currentY = 0;
    const toolRadius = mockResult.options.loom.pegDiameterMm / 2 + clearanceMm;

    for (const line of lines) {
      if (line.startsWith(';') || line.trim() === '') continue;
      const xMatch = line.match(/\bX(-?\d+\.?\d*)/);
      const yMatch = line.match(/\bY(-?\d+\.?\d*)/);
      const endX = xMatch ? parseFloat(xMatch[1]) : currentX;
      const endY = yMatch ? parseFloat(yMatch[1]) : currentY;

      if (line.startsWith('G2 ') || line.startsWith('G3 ')) {
        const iMatch = line.match(/\bI(-?\d+\.?\d*)/);
        const jMatch = line.match(/\bJ(-?\d+\.?\d*)/);
        expect(iMatch).not.toBeNull();
        expect(jMatch).not.toBeNull();
        const I = parseFloat(iMatch![1]);
        const J = parseFloat(jMatch![1]);

        // Start to center distance
        const rStart = Math.hypot(I, J);
        expect(rStart).toBeCloseTo(toolRadius, 2);

        // Center is (currentX + I, currentY + J)
        const centerX = currentX + I;
        const centerY = currentY + J;
        const rEnd = Math.hypot(endX - centerX, endY - centerY);
        expect(rEnd).toBeCloseTo(toolRadius, 2);
      }

      currentX = endX;
      currentY = endY;
    }
  });

  it('splits arcs > 180 degrees into two halves and keeps arcs <= 180 as a single command', () => {
    // 1) Turn > 180 degrees: peg 0 -> peg 50 -> peg 120 (turn = 252.6 deg > 180 deg)
    const splitGcode = toGcode(mockResult, { clearanceMm: 2.0, origin: 'bottom-left' });
    const splitArcs = splitGcode.match(/^(G2|G3) /gm);
    expect(splitArcs).not.toBeNull();
    // The turn around peg 50 splits into 2 arc segments
    expect(splitArcs!.length).toBe(2);

    // 2) Turn <= 180 degrees: peg 0 -> peg 50 -> peg 1 (turn = 179.1 deg <= 180 deg)
    const singleTurnResult: WeaveResult = {
      ...mockResult,
      steps: [
        { index: 0, thread: 0, from: 0, to: 50, fromSide: 1, toSide: 1, gain: 0.1, segmentMm: 500, wrapMm: 3 },
        { index: 1, thread: 0, from: 50, to: 1, fromSide: 1, toSide: 1, gain: 0.1, segmentMm: 500, wrapMm: 3 },
      ],
    };
    const singleGcode = toGcode(singleTurnResult, { clearanceMm: 2.0, origin: 'bottom-left' });
    const singleArcs = singleGcode.match(/^(G2|G3) /gm);
    expect(singleArcs).not.toBeNull();
    expect(singleArcs!.length).toBe(1);
  });

  it('does not emit zero-radius arcs for ideal point pegs (pegDiameter = 0, clearance = 0)', () => {
    const idealResult: WeaveResult = {
      ...mockResult,
      options: {
        ...mockResult.options,
        loom: { ...mockResult.options.loom, pegDiameterMm: 0 },
      },
    };

    const gcode = toGcode(idealResult, { clearanceMm: 0, origin: 'bottom-left' });
    expect(gcode).not.toMatch(/\bG2\b/);
    expect(gcode).not.toMatch(/\bG3\b/);
  });
});
