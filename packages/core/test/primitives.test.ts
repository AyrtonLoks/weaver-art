import { describe, expect, it } from 'vitest';
import {
  canonicalSegment,
  chordKey,
  ChordRasterizer,
  createLoom,
  hexToLinear,
  linearToSrgb,
  pegDistance,
  srgbToLinear,
  tangentSegment,
  VRELLIS_LOOM,
  wrapAngle,
  type PegSide,
} from '../src/index.js';

describe('color', () => {
  it('round-trips sRGB ↔ linear', () => {
    for (const v of [0, 0.01, 0.04045, 0.2, 0.5, 0.8, 1]) {
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 6);
    }
  });

  it('parses hex colours into linear light', () => {
    expect(hexToLinear('#ffffff')).toEqual([1, 1, 1]);
    expect(hexToLinear('#000000')).toEqual([0, 0, 0]);
    expect(hexToLinear('#808080')[0]).toBeCloseTo(0.2158, 3);
  });
});

describe('geometry', () => {
  const loom = createLoom(VRELLIS_LOOM);

  it('places 200 pegs on a 28″ circle, peg #0 at the top', () => {
    expect(loom.pegs).toHaveLength(200);
    expect(loom.radiusMm).toBeCloseTo(355.6, 6);
    expect(loom.pegs[0].x).toBeCloseTo(355.6, 6);
    expect(loom.pegs[0].y).toBeCloseTo(0, 6);
    for (const p of loom.pegs) {
      expect(Math.hypot(p.x - loom.radiusMm, p.y - loom.radiusMm)).toBeCloseTo(loom.radiusMm, 6);
    }
  });

  it('computes circular peg distance', () => {
    expect(pegDistance(0, 199, 200)).toBe(1);
    expect(pegDistance(10, 110, 200)).toBe(100);
    expect(pegDistance(150, 20, 200)).toBe(70);
  });

  it('tangent segments touch both pegs for every side combination', () => {
    const r = 1.5;
    const a = loom.pegs[3];
    const b = loom.pegs[97];
    const sides: PegSide[] = [1, -1];
    for (const sa of sides) {
      for (const sb of sides) {
        const s = tangentSegment(a, sa, b, sb, r);
        // Distance from each peg centre to the infinite line must equal r.
        const distA = Math.abs((a.x - s.x0) * -s.dy + (a.y - s.y0) * s.dx);
        const distB = Math.abs((b.x - s.x0) * -s.dy + (b.y - s.y0) * s.dx);
        expect(distA).toBeCloseTo(r, 9);
        expect(distB).toBeCloseTo(r, 9);
        expect(Math.hypot(s.x1 - s.x0, s.y1 - s.y0)).toBeCloseTo(s.length, 9);
        // Tangent points lie on the peg circles.
        expect(Math.hypot(s.x0 - a.x, s.y0 - a.y)).toBeCloseTo(r, 9);
        expect(Math.hypot(s.x1 - b.x, s.y1 - b.y)).toBeCloseTo(r, 9);
      }
    }
  });

  it('degenerates to centre-to-centre chords with ideal pegs', () => {
    const a = loom.pegs[0];
    const b = loom.pegs[100];
    const s = tangentSegment(a, 1, b, 1, 0);
    expect(s.length).toBeCloseTo(VRELLIS_LOOM.diameterMm, 6);
    expect(s.x0).toBeCloseTo(a.x, 9);
    expect(s.y1).toBeCloseTo(b.y, 9);
  });

  it('wrap angle turns towards the peg', () => {
    // Moving right, then moving down (screen coords): a clockwise quarter turn.
    expect(wrapAngle(1, 0, 0, 1, -1)).toBeCloseTo(Math.PI / 2, 9);
    // Same directions wrapped the other way: three quarters of a turn.
    expect(wrapAngle(1, 0, 0, 1, 1)).toBeCloseTo((3 * Math.PI) / 2, 9);
  });

  it('canonicalSegment gives identical coordinates and length in both travel directions across Circle, Rectangle, and Custom looms', () => {
    const circleLoom = loom;
    const rectLoom = createLoom({
      shape: 'rectangle',
      widthMm: 400,
      heightMm: 300,
      pegsX: 10,
      pegsY: 8,
      pegDiameterMm: 2,
    });
    const customLoom = createLoom({
      shape: 'custom',
      pegs: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 120, y: 80 },
        { x: 50, y: 150 },
        { x: -20, y: 70 },
      ],
      pegDiameterMm: 2,
    });

    const testLooms = [circleLoom, rectLoom, customLoom];
    const sides: PegSide[] = [-1, 1];

    for (const testLoom of testLooms) {
      const N = testLoom.pegs.length;
      const testPairs = [
        [0, Math.floor(N / 2)],
        [Math.min(2, N - 1), (N - 3 + N) % N],
        [1, Math.min(3, N - 1)],
        [N - 1, 0],
      ];
      for (const [p1, p2] of testPairs) {
        for (const s1 of sides) {
          for (const s2 of sides) {
            const segForward = canonicalSegment(testLoom, p1, s1, p2, s2);
            // In reverse, entering direction reverses, so signs flip
            const segReverse = canonicalSegment(testLoom, p2, -s2 as PegSide, p1, -s1 as PegSide);

            expect(segForward.x0).toBe(segReverse.x0);
            expect(segForward.y0).toBe(segReverse.y0);
            expect(segForward.x1).toBe(segReverse.x1);
            expect(segForward.y1).toBe(segReverse.y1);
            expect(segForward.dx).toBe(segReverse.dx);
            expect(segForward.dy).toBe(segReverse.dy);
            expect(segForward.length).toBe(segReverse.length);
          }
        }
      }
    }
  });

  it('chordKey is strictly symmetric and collision-free', () => {
    const N = 20;
    const sides: PegSide[] = [-1, 1];
    const seenKeys = new Map<number, string>();

    for (let from = 0; from < N; from++) {
      for (let to = 0; to < N; to++) {
        if (from === to) continue;
        for (const sFrom of sides) {
          for (const sTo of sides) {
            const keyFwd = chordKey(from, sFrom, to, sTo, N);
            const keyRev = chordKey(to, -sTo as PegSide, from, -sFrom as PegSide, N);
            expect(keyFwd).toBe(keyRev);

            // Canonical pair identifier
            let cLo = from;
            let cHi = to;
            let csLo = sFrom;
            let csHi = sTo;
            if (from > to) {
              cLo = to;
              cHi = from;
              csLo = -sTo as PegSide;
              csHi = -sFrom as PegSide;
            }
            const repr = `${cLo}:${csLo}->${cHi}:${csHi}`;

            if (seenKeys.has(keyFwd)) {
              expect(seenKeys.get(keyFwd)).toBe(repr);
            } else {
              seenKeys.set(keyFwd, repr);
            }
          }
        }
      }
    }
  });
});

describe('raster (stubbed JS rasterizer)', () => {
  it('exposes typed stub returning 0 samples', () => {
    const r = new ChordRasterizer(100, 3);
    expect(r.size).toBe(100);
    expect(r.rasterize(10, 10, 90, 90, 1)).toBe(0);
  });
});
