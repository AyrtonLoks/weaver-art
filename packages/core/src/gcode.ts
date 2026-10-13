import { createLoom, tangentSegment, wrapAngle } from './geometry.js';
import type { WeaveResult } from './types.js';

export interface GcodeOptions {
  /** Radial clearance beyond the peg radius in mm (default: 1.5). */
  clearanceMm?: number;
  /** Weaving feedrate in mm/min (default: 3000). */
  feedMmPerMin?: number;
  /** Rapid travel feedrate in mm/min between disconnected threads (default: 6000). */
  travelFeedMmPerMin?: number;
  /** Machine coordinate origin (default: 'bottom-left'). */
  origin?: 'bottom-left' | 'top-left' | 'center';
  /** Additional machine offset along X in mm (default: 0). */
  offsetXMm?: number;
  /** Additional machine offset along Y in mm (default: 0). */
  offsetYMm?: number;
  /** Insert M0 pause before switching thread spools (default: true). */
  pauseOnThreadChange?: boolean;
  /** Decimal places for coordinates (default: 3). */
  decimals?: number;
}

/**
 * Generate standard RS-274/G-code for XY gantry weaving machines / plotters.
 * Routes the toolhead around pegs using tangent lines (G1) and clearance circular arcs (G2/G3).
 */
export function toGcode(result: WeaveResult, opts: GcodeOptions = {}): string {
  const loom = createLoom(result.options.loom);
  const clearance = opts.clearanceMm ?? 1.5;
  const toolRadius = loom.pegRadiusMm + clearance;
  const feed = opts.feedMmPerMin ?? 3000;
  const travelFeed = opts.travelFeedMmPerMin ?? 6000;
  const origin = opts.origin ?? 'bottom-left';
  const offX = opts.offsetXMm ?? 0;
  const offY = opts.offsetYMm ?? 0;
  const pauseOnThread = opts.pauseOnThreadChange ?? true;
  const decimals = opts.decimals ?? 3;
  const invertY = origin !== 'top-left';

  const fmt = (n: number): string => n.toFixed(decimals);

  const toMachine = (x: number, y: number): { x: number; y: number } => {
    if (origin === 'bottom-left') {
      return { x: x + offX, y: loom.extentMm - y + offY };
    }
    if (origin === 'center') {
      return { x: x - loom.extentMm / 2 + offX, y: loom.extentMm / 2 - y + offY };
    }
    return { x: x + offX, y: y + offY };
  };

  const lines: string[] = [];
  lines.push('; =========================================================');
  lines.push('; Weaver Art -- G-code para Maquinas de Tecelagem (XY)');
  lines.push(`; Cordas: ${result.steps.length}`);
  lines.push(`; Raio de folga nos pinos: ${toolRadius.toFixed(2)} mm (folga: ${clearance.toFixed(2)} mm)`);
  lines.push(`; Origem: ${origin}`);
  lines.push('; =========================================================');
  lines.push('');
  lines.push('G21 ; Unidades em milimetros (mm)');
  lines.push('G90 ; Coordenadas absolutas');
  lines.push('G17 ; Selecao de plano XY');
  lines.push('G94 ; Avanco em mm/min');
  lines.push('');

  let currentThread = -1;
  let prevSeg: { x0: number; y0: number; x1: number; y1: number; dx: number; dy: number } | null = null;
  let prevPeg = -1;

  for (let i = 0; i < result.steps.length; i++) {
    const s = result.steps[i];
    const threadConfig = result.options.threads[s.thread];
    const pA = loom.pegs[s.from];
    const pB = loom.pegs[s.to];
    const seg = tangentSegment(pA, s.fromSide, pB, s.toSide, toolRadius);

    const mStart = toMachine(seg.x0, seg.y0);
    const mEnd = toMachine(seg.x1, seg.y1);

    // Check if new thread layer
    if (s.thread !== currentThread) {
      currentThread = s.thread;
      lines.push('');
      lines.push(`; --- FIO #${currentThread + 1}: ${threadConfig.name} (${threadConfig.color}) ---`);
      if (pauseOnThread) {
        lines.push(`M0 (Troque para ${threadConfig.name} -- amarre no pino ${s.from + 1})`);
      }
      lines.push(`G0 X${fmt(mStart.x)} Y${fmt(mStart.y)} F${travelFeed}`);
    } else if (prevSeg && prevPeg === s.from) {
      // Arc around peg pA from prevSeg end to currSeg start
      const mCenter = toMachine(pA.x, pA.y);
      const mArcStart = toMachine(prevSeg.x1, prevSeg.y1);
      const I = mCenter.x - mArcStart.x;
      const J = mCenter.y - mArcStart.y;

      const turn = wrapAngle(prevSeg.dx, prevSeg.dy, seg.dx, seg.dy, s.fromSide);
      // In CNC Cartesian space (Y up, X right): physical counter-clockwise (side=1) is G3, clockwise (side=-1) is G2.
      // With origin 'bottom-left' or 'center', Y is mapped with Y_cnc = extent - Y_screen (invertY = true),
      // which preserves physical orientation on the machine table, so side=1 is G3.
      // With origin 'top-left' (Y down, left-handed), the orientation inverts so side=1 is G2.
      const arcCmd = invertY ? (s.fromSide === 1 ? 'G3' : 'G2') : s.fromSide === 1 ? 'G2' : 'G3';

      if (toolRadius > 1e-4 && turn > Math.PI) {
        // Split arc > 180 degrees into two halves to prevent I/J ambiguity
        const halfTurn = turn / 2;
        // Rotate (prevSeg.x1 - pA.x, prevSeg.y1 - pA.y) by halfTurn along s.fromSide
        const vX = prevSeg.x1 - pA.x;
        const vY = prevSeg.y1 - pA.y;
        // Direction of rotation in screen coordinates (Y down):
        // side = 1 is CCW (angle = -halfTurn), side = -1 is CW (angle = +halfTurn)
        const rotAngle = -s.fromSide * halfTurn;
        const midX = pA.x + vX * Math.cos(rotAngle) - vY * Math.sin(rotAngle);
        const midY = pA.y + vX * Math.sin(rotAngle) + vY * Math.cos(rotAngle);
        const mMid = toMachine(midX, midY);

        const I1 = mCenter.x - mArcStart.x;
        const J1 = mCenter.y - mArcStart.y;
        lines.push(`${arcCmd} X${fmt(mMid.x)} Y${fmt(mMid.y)} I${fmt(I1)} J${fmt(J1)} F${feed}`);

        const I2 = mCenter.x - mMid.x;
        const J2 = mCenter.y - mMid.y;
        lines.push(`${arcCmd} X${fmt(mStart.x)} Y${fmt(mStart.y)} I${fmt(I2)} J${fmt(J2)} F${feed}`);
      } else if (toolRadius > 1e-4 && turn > 1e-4) {
        lines.push(`${arcCmd} X${fmt(mStart.x)} Y${fmt(mStart.y)} I${fmt(I)} J${fmt(J)} F${feed}`);
      } else if (Math.hypot(mStart.x - mArcStart.x, mStart.y - mArcStart.y) > 1e-3) {
        lines.push(`G1 X${fmt(mStart.x)} Y${fmt(mStart.y)} F${feed}`);
      }
    } else {
      lines.push(`G0 X${fmt(mStart.x)} Y${fmt(mStart.y)} F${travelFeed}`);
    }

    // Straight chord segment
    lines.push(`G1 X${fmt(mEnd.x)} Y${fmt(mEnd.y)} F${feed} ; Corda ${i + 1}: ${s.from + 1}->${s.to + 1}`);
    prevSeg = seg;
    prevPeg = s.to;
  }

  lines.push('');
  lines.push('M2 ; Fim do programa');
  return lines.join('\n') + '\n';
}

/**
 * Calculate total toolhead travel distance in mm (including rapid moves and arcs).
 */
export function gcodePathLengthMm(result: WeaveResult, opts: GcodeOptions = {}): number {
  const loom = createLoom(result.options.loom);
  const clearance = opts.clearanceMm ?? 1.5;
  const toolRadius = loom.pegRadiusMm + clearance;

  let totalDist = 0;
  let currentThread = -1;
  let prevSeg: { x0: number; y0: number; x1: number; y1: number; dx: number; dy: number } | null = null;
  let prevPeg = -1;

  for (const s of result.steps) {
    const pA = loom.pegs[s.from];
    const pB = loom.pegs[s.to];
    const seg = tangentSegment(pA, s.fromSide, pB, s.toSide, toolRadius);

    if (s.thread !== currentThread) {
      currentThread = s.thread;
      if (prevSeg) {
        totalDist += Math.hypot(seg.x0 - prevSeg.x1, seg.y0 - prevSeg.y1);
      }
    } else if (prevSeg && prevPeg === s.from) {
      const turn = wrapAngle(prevSeg.dx, prevSeg.dy, seg.dx, seg.dy, s.fromSide);
      totalDist += toolRadius * turn;
    } else if (prevSeg) {
      totalDist += Math.hypot(seg.x0 - prevSeg.x1, seg.y0 - prevSeg.y1);
    }

    totalDist += seg.length;
    prevSeg = seg;
    prevPeg = s.to;
  }

  return totalDist;
}
