import type { LoomConfig, PegSide } from './types.js';

/** A peg on the loom. Coordinates in mm, origin at the top-left of the loom's bounding square, y pointing down. */
export interface Peg {
  index: number;
  /** Angle in radians (screen coordinates: 0 = right, π/2 = bottom). */
  angle: number;
  x: number;
  y: number;
  /** Outward normal X (unit length). */
  nx: number;
  /** Outward normal Y (unit length). */
  ny: number;
  /** Bitmask of straight frame edges this peg lies on (0 for circle/custom). */
  edges: number;
}

/** A straight piece of thread between two pegs, in mm. */
export interface Segment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Unit direction. */
  dx: number;
  dy: number;
  length: number;
}

export interface Loom {
  config: LoomConfig;
  pegs: Peg[];
  /** Radius of the circle through the peg centres, mm (extentMm / 2 for non-circular looms). */
  radiusMm: number;
  /** Physical peg radius, mm (0 = ideal point pegs). */
  pegRadiusMm: number;
  /** Peg sides available for routing: both tangents for real pegs, a single one for ideal pegs. */
  sides: readonly PegSide[];
  /** Bounding box width of peg centres, mm. */
  widthMm: number;
  /** Bounding box height of peg centres, mm. */
  heightMm: number;
  /** Side length of the square simulation frame enclosing the loom, mm. */
  extentMm: number;
  /** Convex boundary polygon in simulation frame coordinates (null for circular looms). */
  outline: { x: number; y: number }[] | null;
  /** Minimum distance between consecutive pegs along the perimeter, mm. */
  minSpacingMm: number;
}

const BOTH_SIDES: readonly PegSide[] = [1, -1];
const SINGLE_SIDE: readonly PegSide[] = [1];

/** Compute the total peg count for any LoomConfig. */
export function loomPegCount(config: LoomConfig): number {
  switch (config.shape) {
    case 'circle':
      return config.pegCount;
    case 'rectangle':
      return 2 * (config.pegsX + config.pegsY) - 4;
    case 'custom':
      return config.pegs.length;
  }
}

/**
 * Convex hull of a 2D point cloud using Andrew's monotone chain algorithm.
 * Output vertices are guaranteed clockwise in screen coordinates (Y down).
 */
export function convexHull(points: readonly { x: number; y: number }[]): { x: number; y: number }[] {
  const sorted = points.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const unique: { x: number; y: number }[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0 || sorted[i].x !== sorted[i - 1].x || sorted[i].y !== sorted[i - 1].y) {
      unique.push(sorted[i]);
    }
  }
  if (unique.length <= 2) return unique.map((p) => ({ x: p.x, y: p.y }));
  if (unique.length === 3) {
    const p0 = unique[0];
    const p1 = unique[1];
    const p2 = unique[2];
    const signedArea = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
    if (Math.abs(signedArea) < 1e-6) {
      return [p0, p2]; // colinear points
    }
    // In screen coordinates (Y down): positive signedArea is clockwise
    return signedArea > 0 ? [p0, p1, p2] : [p0, p2, p1];
  }

  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: { x: number; y: number }[] = [];
  for (const p of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: { x: number; y: number }[] = [];
  for (let i = unique.length - 1; i >= 0; i--) {
    const p = unique[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);

  let area = 0;
  for (let i = 0; i < hull.length; i++) {
    const next = hull[(i + 1) % hull.length];
    area += hull[i].x * next.y - next.x * hull[i].y;
  }
  if (area < 0) hull.reverse();
  return hull;
}

/**
 * Builds a binary table of allowed chords between pegs.
 * A chord (a, b) is allowed if:
 * 1. circular index distance >= minPegGap
 * 2. pegs do not lie on the same straight edge (edges[a] & edges[b] === 0)
 */
export function buildChordMask(loom: Loom, minPegGap: number): Uint8Array {
  const N = loom.pegs.length;
  const mask = new Uint8Array(N * N);
  for (let a = 0; a < N; a++) {
    const pegA = loom.pegs[a];
    const rowOffset = a * N;
    for (let b = 0; b < N; b++) {
      if (a === b) continue;
      if (pegDistance(a, b, N) < minPegGap) continue;
      if (pegA.edges !== 0 && (pegA.edges & loom.pegs[b].edges) !== 0) continue;
      mask[rowOffset + b] = 1;
    }
  }
  return mask;
}

export function createLoom(config: LoomConfig): Loom {
  const pegRadiusMm = config.pegDiameterMm / 2;
  const sides = pegRadiusMm > 0 ? BOTH_SIDES : SINGLE_SIDE;

  if (config.shape === 'circle') {
    const radiusMm = config.diameterMm / 2;
    const widthMm = config.diameterMm;
    const heightMm = config.diameterMm;
    const extentMm = config.diameterMm;
    const start = (config.startAngleDeg * Math.PI) / 180;
    const pegs: Peg[] = [];
    for (let i = 0; i < config.pegCount; i++) {
      const angle = start + (2 * Math.PI * i) / config.pegCount;
      const nx = Math.cos(angle);
      const ny = Math.sin(angle);
      pegs.push({
        index: i,
        angle,
        x: radiusMm + radiusMm * nx,
        y: radiusMm + radiusMm * ny,
        nx,
        ny,
        edges: 0,
      });
    }
    const minSpacingMm = 2 * radiusMm * Math.sin(Math.PI / config.pegCount);
    return {
      config,
      pegs,
      radiusMm,
      pegRadiusMm,
      sides,
      widthMm,
      heightMm,
      extentMm,
      outline: null,
      minSpacingMm,
    };
  }

  if (config.shape === 'rectangle') {
    const { widthMm, heightMm, pegsX, pegsY } = config;
    const extentMm = Math.max(widthMm, heightMm);
    const radiusMm = extentMm / 2;
    const ox = (extentMm - widthMm) / 2;
    const oy = (extentMm - heightMm) / 2;

    const TOP = 1;
    const RIGHT = 2;
    const BOTTOM = 4;
    const LEFT = 8;
    const pegs: Peg[] = [];

    // Top edge: pegsX pegs from top-left to top-right
    for (let ix = 0; ix < pegsX; ix++) {
      const x = ox + (ix / (pegsX - 1)) * widthMm;
      const y = oy;
      let edges = TOP;
      if (ix === 0) edges |= LEFT;
      if (ix === pegsX - 1) edges |= RIGHT;

      let nx = 0;
      let ny = -1;
      if (edges === (TOP | LEFT)) {
        nx = -Math.SQRT1_2;
        ny = -Math.SQRT1_2;
      } else if (edges === (TOP | RIGHT)) {
        nx = Math.SQRT1_2;
        ny = -Math.SQRT1_2;
      }
      pegs.push({
        index: pegs.length,
        angle: Math.atan2(ny, nx),
        x,
        y,
        nx,
        ny,
        edges,
      });
    }

    // Right edge: pegsY - 1 pegs down to bottom-right corner
    for (let iy = 1; iy < pegsY; iy++) {
      const x = ox + widthMm;
      const y = oy + (iy / (pegsY - 1)) * heightMm;
      let edges = RIGHT;
      if (iy === pegsY - 1) edges |= BOTTOM;

      let nx = 1;
      let ny = 0;
      if (edges === (RIGHT | BOTTOM)) {
        nx = Math.SQRT1_2;
        ny = Math.SQRT1_2;
      }
      pegs.push({
        index: pegs.length,
        angle: Math.atan2(ny, nx),
        x,
        y,
        nx,
        ny,
        edges,
      });
    }

    // Bottom edge: pegsX - 1 pegs left to bottom-left corner
    for (let ix = 1; ix < pegsX; ix++) {
      const x = ox + widthMm - (ix / (pegsX - 1)) * widthMm;
      const y = oy + heightMm;
      let edges = BOTTOM;
      if (ix === pegsX - 1) edges |= LEFT;

      let nx = 0;
      let ny = 1;
      if (edges === (BOTTOM | LEFT)) {
        nx = -Math.SQRT1_2;
        ny = Math.SQRT1_2;
      }
      pegs.push({
        index: pegs.length,
        angle: Math.atan2(ny, nx),
        x,
        y,
        nx,
        ny,
        edges,
      });
    }

    // Left edge: pegsY - 2 pegs up towards top-left
    for (let iy = 1; iy < pegsY - 1; iy++) {
      const x = ox;
      const y = oy + heightMm - (iy / (pegsY - 1)) * heightMm;
      const edges = LEFT;
      const nx = -1;
      const ny = 0;
      pegs.push({
        index: pegs.length,
        angle: Math.atan2(ny, nx),
        x,
        y,
        nx,
        ny,
        edges,
      });
    }

    const outline = [
      { x: ox, y: oy },
      { x: ox + widthMm, y: oy },
      { x: ox + widthMm, y: oy + heightMm },
      { x: ox, y: oy + heightMm },
    ];
    const minSpacingMm = Math.min(widthMm / (pegsX - 1), heightMm / (pegsY - 1));

    return {
      config,
      pegs,
      radiusMm,
      pegRadiusMm,
      sides,
      widthMm,
      heightMm,
      extentMm,
      outline,
      minSpacingMm,
    };
  }

  // Custom loom
  const pts = config.pegs;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const widthMm = maxX > minX ? maxX - minX : 1;
  const heightMm = maxY > minY ? maxY - minY : 1;
  const extentMm = Math.max(widthMm, heightMm);
  const radiusMm = extentMm / 2;
  const ox = (extentMm - widthMm) / 2 - minX;
  const oy = (extentMm - heightMm) / 2 - minY;

  // Centroid of shifted pegs
  let sumX = 0;
  let sumY = 0;
  const pegs: Peg[] = [];
  for (let i = 0; i < pts.length; i++) {
    const x = pts[i].x + ox;
    const y = pts[i].y + oy;
    sumX += x;
    sumY += y;
  }
  const cx = sumX / (pts.length || 1);
  const cy = sumY / (pts.length || 1);

  let minSpacingMm = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const x = pts[i].x + ox;
    const y = pts[i].y + oy;
    const dx = x - cx;
    const dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    const nx = dx / len;
    const ny = dy / len;
    pegs.push({
      index: i,
      angle: Math.atan2(ny, nx),
      x,
      y,
      nx,
      ny,
      edges: 0,
    });
    const nextIdx = (i + 1) % pts.length;
    const nextX = pts[nextIdx].x + ox;
    const nextY = pts[nextIdx].y + oy;
    const dist = Math.hypot(nextX - x, nextY - y);
    if (dist < minSpacingMm) minSpacingMm = dist;
  }

  const outline = convexHull(pegs.map((p) => ({ x: p.x, y: p.y })));

  return {
    config,
    pegs,
    radiusMm,
    pegRadiusMm,
    sides,
    widthMm,
    heightMm,
    extentMm,
    outline,
    minSpacingMm: Number.isFinite(minSpacingMm) ? minSpacingMm : 1,
  };
}

/** Circular distance between two peg indices. */
export function pegDistance(a: number, b: number, pegCount: number): number {
  const d = Math.abs(a - b) % pegCount;
  return Math.min(d, pegCount - d);
}

/**
 * Straight thread segment from peg `a` to peg `b`, tangent to both pegs.
 *
 * With n = (−dy, dx) the normal of the travel direction d, the thread touches peg `a`
 * at `A + sa·r·n` and peg `b` at `B + sb·r·n`:
 * - `sa === sb` → outer tangent, parallel to the centre line;
 * - `sa !== sb` → inner (crossing) tangent, rotated by φ with sin φ = 2·sb·r / |AB|.
 *
 * In screen coordinates (y down) `side = +1` means the peg is on the thread's left,
 * i.e. the thread wraps **counter-clockwise** around it as seen from the front;
 * `side = −1` means clockwise.
 */
export function tangentSegment(a: Peg, sa: PegSide, b: Peg, sb: PegSide, r: number): Segment {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const dist = Math.hypot(vx, vy);
  const ux = vx / dist;
  const uy = vy / dist;
  let dx = ux;
  let dy = uy;
  let length = dist;
  if (r > 0 && sa !== sb) {
    length = Math.sqrt(Math.max(dist * dist - 4 * r * r, 0));
    const cos = length / dist;
    const sin = (2 * sb * r) / dist;
    dx = ux * cos - uy * sin;
    dy = ux * sin + uy * cos;
  }
  const nx = -dy;
  const ny = dx;
  return {
    x0: a.x + sa * r * nx,
    y0: a.y + sa * r * ny,
    x1: b.x + sb * r * nx,
    y1: b.y + sb * r * ny,
    dx,
    dy,
    length,
  };
}

/**
 * Angle (radians, in [0, 2π)) the thread turns while wrapping a peg on `side`,
 * going from direction (inX, inY) to direction (outX, outY).
 * The thread always turns *towards* the peg, so the sense of rotation is fixed by the side.
 */
export function wrapAngle(inX: number, inY: number, outX: number, outY: number, side: PegSide): number {
  const cross = inX * outY - inY * outX;
  const dot = inX * outX + inY * outY;
  // Positive θ = rotation from d towards n = (−dy, dx). The peg lies at −side·n.
  let turn = -side * Math.atan2(cross, dot);
  if (turn < 0) turn += 2 * Math.PI;
  return turn;
}
