import { describe, expect, it } from 'vitest';
import {
  buildChordMask,
  convexHull,
  createLoom,
  loomPegCount,
  resolveOptions,
  validateOptions,
  VRELLIS_LOOM,
  type CustomLoomConfig,
  type RectangleLoomConfig,
} from '../src/index.js';

describe('Loom shapes & geometry (v0.4.0)', () => {
  it('preserves bit-for-bit identical properties for VRELLIS_LOOM circular loom', () => {
    const loom = createLoom(VRELLIS_LOOM);
    expect(loom.radiusMm).toBe(VRELLIS_LOOM.diameterMm / 2);
    expect(loom.extentMm).toBe(VRELLIS_LOOM.diameterMm);
    expect(loom.widthMm).toBe(VRELLIS_LOOM.diameterMm);
    expect(loom.heightMm).toBe(VRELLIS_LOOM.diameterMm);
    expect(loom.outline).toBeNull();
    expect(loom.pegs.length).toBe(200);
    expect(loomPegCount(VRELLIS_LOOM)).toBe(200);

    // Peg 0 at top (-90 degrees)
    const p0 = loom.pegs[0];
    expect(p0.x).toBeCloseTo(VRELLIS_LOOM.diameterMm / 2, 4);
    expect(p0.y).toBeCloseTo(0, 4);
    expect(p0.edges).toBe(0);
  });

  it('correctly constructs a rectangular loom with clockwise numbering from top-left', () => {
    const rectCfg: RectangleLoomConfig = {
      shape: 'rectangle',
      widthMm: 400,
      heightMm: 200,
      pegsX: 5,
      pegsY: 3,
      pegDiameterMm: 2,
    };
    // Expected total: 2*(5 + 3) - 4 = 12 pegs
    expect(loomPegCount(rectCfg)).toBe(12);

    const loom = createLoom(rectCfg);
    expect(loom.pegs.length).toBe(12);
    expect(loom.extentMm).toBe(400); // max(400, 200)
    expect(loom.widthMm).toBe(400);
    expect(loom.heightMm).toBe(200);

    // Centered in 400x400 frame: ox = (400 - 400)/2 = 0, oy = (400 - 200)/2 = 100
    // Peg 0: Top-left corner (0, 100)
    expect(loom.pegs[0].x).toBe(0);
    expect(loom.pegs[0].y).toBe(100);
    expect(loom.pegs[0].edges).toBe(1 | 8); // TOP | LEFT

    // Peg 4: Top-right corner (400, 100)
    expect(loom.pegs[4].x).toBe(400);
    expect(loom.pegs[4].y).toBe(100);
    expect(loom.pegs[4].edges).toBe(1 | 2); // TOP | RIGHT

    // Peg 6: Bottom-right corner (400, 300)
    expect(loom.pegs[6].x).toBe(400);
    expect(loom.pegs[6].y).toBe(300);
    expect(loom.pegs[6].edges).toBe(2 | 4); // RIGHT | BOTTOM

    // Peg 10: Bottom-left corner (0, 300)
    expect(loom.pegs[10].x).toBe(0);
    expect(loom.pegs[10].y).toBe(300);
    expect(loom.pegs[10].edges).toBe(4 | 8); // BOTTOM | LEFT

    // Peg 11: on left edge (0, 200)
    expect(loom.pegs[11].x).toBe(0);
    expect(loom.pegs[11].y).toBe(200);
    expect(loom.pegs[11].edges).toBe(8); // LEFT
  });

  it('buildChordMask forbids chords along the same straight edge', () => {
    const rectCfg: RectangleLoomConfig = {
      shape: 'rectangle',
      widthMm: 300,
      heightMm: 300,
      pegsX: 10,
      pegsY: 10,
      pegDiameterMm: 2,
    };
    const loom = createLoom(rectCfg);
    const mask = buildChordMask(loom, 3);
    const N = loom.pegs.length; // 2*(10+10)-4 = 36

    // Pegs 1 and 5 are both on top edge -> forbidden even though index distance = 4 >= minPegGap
    expect(mask[1 * N + 5]).toBe(0);
    expect(mask[5 * N + 1]).toBe(0);

    // Peg 1 (top edge) and peg 15 (right edge) -> allowed
    expect(mask[1 * N + 15]).toBe(1);

    // Adjacent pegs distance < 3 -> forbidden
    expect(mask[1 * N + 2]).toBe(0);
  });

  it('correctly constructs a custom loom with convex hull outline and centroid normals', () => {
    const customCfg: CustomLoomConfig = {
      shape: 'custom',
      pegs: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 150, y: 50 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
      pegDiameterMm: 2,
    };
    expect(loomPegCount(customCfg)).toBe(5);

    const loom = createLoom(customCfg);
    expect(loom.pegs.length).toBe(5);
    expect(loom.outline).not.toBeNull();
    expect(loom.outline!.length).toBeGreaterThanOrEqual(4);

    // Normals must be finite and unit length
    for (const p of loom.pegs) {
      const len = Math.hypot(p.nx, p.ny);
      expect(len).toBeCloseTo(1, 4);
    }
  });

  it('computes convexHull in clockwise order', () => {
    const points = [
      { x: 50, y: 50 },
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
      { x: 20, y: 20 },
    ];
    const hull = convexHull(points);
    expect(hull.length).toBe(4); // the 4 outer corners

    // Check signed area is positive (clockwise in screen coords Y down)
    let area = 0;
    for (let i = 0; i < hull.length; i++) {
      const next = hull[(i + 1) % hull.length];
      area += hull[i].x * next.y - next.x * hull[i].y;
    }
    expect(area).toBeGreaterThan(0);
  });

  it('validates rectangle and custom loom options properly', () => {
    // Valid rectangle options
    const rectOptions = resolveOptions({
      loom: {
        shape: 'rectangle',
        widthMm: 400,
        heightMm: 400,
        pegsX: 20,
        pegsY: 20,
        pegDiameterMm: 1,
      },
    });
    expect(rectOptions.loom.shape).toBe('rectangle');

    // Invalid rectangle: negative width
    expect(() =>
      validateOptions({
        ...rectOptions,
        loom: {
          ...rectOptions.loom,
          shape: 'rectangle',
          widthMm: -10,
          heightMm: 200,
          pegsX: 10,
          pegsY: 10,
          pegDiameterMm: 1,
        },
      }),
    ).toThrow();

    // Invalid custom: less than 3 pegs
    expect(() =>
      validateOptions({
        ...rectOptions,
        loom: {
          shape: 'custom',
          pegs: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
          pegDiameterMm: 1,
        },
      }),
    ).toThrow(/ao menos 3 pinos/);

    // Invalid custom: colinear pegs (zero area)
    expect(() =>
      validateOptions({
        ...rectOptions,
        loom: {
          shape: 'custom',
          pegs: [
            { x: 10, y: 10 },
            { x: 20, y: 20 },
            { x: 30, y: 30 },
          ],
          pegDiameterMm: 1,
        },
      }),
    ).toThrow(/colineares|área nula/);

    // Invalid custom: duplicate consecutive points
    expect(() =>
      validateOptions({
        ...rectOptions,
        loom: {
          shape: 'custom',
          pegs: [
            { x: 10, y: 10 },
            { x: 10, y: 10 },
            { x: 30, y: 30 },
          ],
          pegDiameterMm: 1,
        },
      }),
    ).toThrow(/duplicados/);
  });

  it('guarantees clockwise orientation and correct positive mask for CCW triangles', () => {
    // Points listed in counter-clockwise order in screen coordinates (Y down)
    const ccwPoints = [
      { x: 10, y: 10 },
      { x: 10, y: 100 },
      { x: 100, y: 10 },
    ];
    const hull = convexHull(ccwPoints);
    expect(hull.length).toBe(3);

    // Signed area must be strictly positive (clockwise)
    let area = 0;
    for (let i = 0; i < hull.length; i++) {
      const next = hull[(i + 1) % hull.length];
      area += hull[i].x * next.y - next.x * hull[i].y;
    }
    expect(area).toBeGreaterThan(0);
  });
});
