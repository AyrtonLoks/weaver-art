import { describe, expect, it } from 'vitest';
import {
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
});

describe('raster', () => {
  const size = 100;
  const sum = (r: ChordRasterizer, n: number): number => {
    let s = 0;
    for (let i = 0; i < n; i++) s += r.cov[i];
    return s;
  };

  it('conserves thread area (coverage ≈ width × length)', () => {
    const r = new ChordRasterizer(size, 3);
    for (const [x0, y0, x1, y1] of [
      [10, 50.3, 90, 50.3],
      [10, 10, 90, 90],
      [20, 5, 35, 95],
    ]) {
      for (const w of [0.2, 1, 2.5]) {
        const n = r.rasterize(x0, y0, x1, y1, w);
        const length = Math.hypot(x1 - x0, y1 - y0);
        expect(sum(r, n) / (w * length)).toBeCloseTo(1, 1);
      }
    }
  });

  it('never exceeds full coverage nor leaves the grid', () => {
    const r = new ChordRasterizer(size, 3);
    const n = r.rasterize(-20, 30, 130, 70, 3);
    for (let i = 0; i < n; i++) {
      expect(r.cov[i]).toBeGreaterThan(0);
      expect(r.cov[i]).toBeLessThanOrEqual(1 + 1e-6);
      expect(r.idx[i]).toBeGreaterThanOrEqual(0);
      expect(r.idx[i]).toBeLessThan(size * size);
    }
  });
});
