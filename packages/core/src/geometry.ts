import type { LoomConfig, PegSide } from './types.js';

/** A peg on the loom. Coordinates in mm, origin at the top-left of the loom's bounding square, y pointing down. */
export interface Peg {
  index: number;
  /** Angle in radians (screen coordinates: 0 = right, π/2 = bottom). */
  angle: number;
  x: number;
  y: number;
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
  /** Radius of the circle through the peg centres, mm. */
  radiusMm: number;
  /** Physical peg radius, mm (0 = ideal point pegs). */
  pegRadiusMm: number;
  /** Peg sides available for routing: both tangents for real pegs, a single one for ideal pegs. */
  sides: readonly PegSide[];
}

const BOTH_SIDES: readonly PegSide[] = [1, -1];
const SINGLE_SIDE: readonly PegSide[] = [1];

export function createLoom(config: LoomConfig): Loom {
  const radiusMm = config.diameterMm / 2;
  const start = (config.startAngleDeg * Math.PI) / 180;
  const pegs: Peg[] = [];
  for (let i = 0; i < config.pegCount; i++) {
    const angle = start + (2 * Math.PI * i) / config.pegCount;
    pegs.push({
      index: i,
      angle,
      x: radiusMm + radiusMm * Math.cos(angle),
      y: radiusMm + radiusMm * Math.sin(angle),
    });
  }
  const pegRadiusMm = config.pegDiameterMm / 2;
  return { config, pegs, radiusMm, pegRadiusMm, sides: pegRadiusMm > 0 ? BOTH_SIDES : SINGLE_SIDE };
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
