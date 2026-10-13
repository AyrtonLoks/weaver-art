import { estimateWeave, formatDuration } from './estimate.js';
import { createLoom, loomPegCount, tangentSegment, wrapAngle } from './geometry.js';
import type { LoomConfig, PegSide, WeaveResult } from './types.js';

export interface InstructionOptions {
  /** Number displayed for peg #0 (physical looms are usually labelled from 1). */
  pegNumberBase?: number;
  /** Include estimated weaving time and spool requirements in header. */
  estimate?: boolean;
}

/** Human label for the wrap direction (seen from the front of the loom). */
export function sideLabel(side: PegSide): string {
  return side === 1 ? 'anti-horário' : 'horário';
}

function fmtMeters(mm: number): string {
  return `${(mm / 1000).toFixed(1)} m`;
}

/** Format a human-readable description of the loom geometry. */
export function describeLoom(cfg: LoomConfig): string {
  switch (cfg.shape) {
    case 'circle':
      return `Tear: círculo de ${cfg.diameterMm.toFixed(1)} mm, ${cfg.pegCount} pinos (Ø ${cfg.pegDiameterMm} mm)`;
    case 'rectangle':
      return `Tear: retângulo ${cfg.widthMm.toFixed(1)} × ${cfg.heightMm.toFixed(1)} mm, ${loomPegCount(cfg)} pinos (${cfg.pegsX}×${cfg.pegsY}, Ø ${cfg.pegDiameterMm} mm)`;
    case 'custom':
      return `Tear: personalizado, ${cfg.pegs.length} pinos (Ø ${cfg.pegDiameterMm} mm)`;
  }
}

/**
 * Step-by-step knitting instructions in Portuguese — the equivalent of the
 * computer-dictated instructions Vrellis followed while knitting by hand.
 */
export function toInstructions(result: WeaveResult, opts: InstructionOptions = {}): string {
  const base = opts.pegNumberBase ?? 1;
  const { loom, threads } = result.options;
  const withSides = loom.pegDiameterMm > 0;
  const pad = String(result.steps.length).length;
  const lines: string[] = [];

  lines.push('WEAVER ART — INSTRUÇÕES DE TECELAGEM');
  lines.push('');
  lines.push(describeLoom(loom));
  if (loom.shape === 'circle') {
    lines.push(
      `Numeração dos pinos: ${base} a ${loom.pegCount - 1 + base}, a partir do pino ${base} no ângulo ${loom.startAngleDeg}°, sentido horário`,
    );
  } else {
    const totalPegs = loomPegCount(loom);
    lines.push(`Numeração dos pinos: ${base} a ${totalPegs - 1 + base}, a partir do pino ${base}, sentido horário`);
  }
  lines.push(`Linhas: ${result.steps.length}   Fio total: ${fmtMeters(result.totalLengthMm)}`);
  for (const t of result.threads) {
    lines.push(
      `  • ${t.name} (${t.color}): ${t.lines} linhas, ${fmtMeters(t.lengthMm)}, amarrar no pino ${t.pegs[0] + base}`,
    );
  }
  lines.push('');

  if (opts.estimate) {
    const est = estimateWeave(result);
    lines.push('ESTIMATIVA DE FABRICAÇÃO:');
    lines.push(
      `  Tempo manual total: ${formatDuration(est.totalSeconds)} (${formatDuration(est.weavingSeconds)} tecendo, ${formatDuration(est.overheadSeconds)} nós/trocas)`,
    );
    lines.push(`  Consumo total com margem (+10%): ${fmtMeters(est.totalRequiredMm)}`);
    for (const t of est.threads) {
      lines.push(
        `    • ${t.name}: ${t.spools} carretel(eis) (${t.spoolUsagePct.toFixed(1)}% de uso, ${fmtMeters(t.requiredMm)} necessários)`,
      );
    }
    lines.push('');
  }

  if (withSides) {
    lines.push('Sentido = direção em que o fio contorna o pino de chegada, visto de frente.');
    lines.push('');
  }

  const isLayered = (result.options.colorStrategy ?? 'layered') === 'layered';
  const layerCounts = new Map<number, number>();
  if (isLayered) {
    for (const s of result.steps) {
      const layer = s.layerIndex ?? s.thread;
      layerCounts.set(layer, (layerCounts.get(layer) ?? 0) + 1);
    }
  }

  let currentLayer = -1;
  for (const s of result.steps) {
    const thread = threads[s.thread];
    const layer = s.layerIndex ?? s.thread;
    if (isLayered && threads.length > 1 && layer !== currentLayer) {
      currentLayer = layer;
      const count = layerCounts.get(layer) ?? 0;
      lines.push('');
      lines.push(
        `=== CAMADA ${layer + 1}: ${thread.name.toUpperCase()} (${count} cordas · amarrar no pino ${thread.startPeg + base}) ===`,
      );
      lines.push('');
    }

    const n = String(s.index + 1).padStart(pad, '0');
    const name = threads.length > 1 ? `${thread.name.padEnd(8)} ` : '';
    const side = withSides ? `  (${sideLabel(s.toSide)})` : '';
    lines.push(`${n}  ${name}${String(s.from + base).padStart(3)} → ${String(s.to + base).padStart(3)}${side}`);
  }
  return lines.join('\n') + '\n';
}

/** CSV with one row per chord. */
export function toCSV(result: WeaveResult, opts: InstructionOptions = {}): string {
  const base = opts.pegNumberBase ?? 1;
  const header = 'step,thread,from,to,from_side,to_side,segment_mm,wrap_mm,gain';
  const rows = result.steps.map((s) =>
    [
      s.index + 1,
      result.options.threads[s.thread].id,
      s.from + base,
      s.to + base,
      s.fromSide,
      s.toSide,
      s.segmentMm.toFixed(2),
      s.wrapMm.toFixed(2),
      s.gain.toExponential(4),
    ].join(','),
  );
  return [header, ...rows].join('\n') + '\n';
}

/** A drawable piece of the thread path, in mm. */
export type PathPiece =
  | { kind: 'line'; x0: number; y0: number; x1: number; y1: number }
  | {
      kind: 'arc';
      cx: number;
      cy: number;
      r: number;
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      turn: number;
      side: PegSide;
    };

/** Physical path (segments + wrap arcs) of one thread, reconstructed from the steps. */
export function threadPath(result: WeaveResult, thread: number): PathPiece[] {
  const loom = createLoom(result.options.loom);
  const r = loom.pegRadiusMm;
  const pieces: PathPiece[] = [];
  let prev: { x: number; y: number; dx: number; dy: number } | null = null;
  for (const s of result.steps) {
    if (s.thread !== thread) continue;
    const a = loom.pegs[s.from];
    const seg = tangentSegment(a, s.fromSide, loom.pegs[s.to], s.toSide, r);
    if (prev && r > 0) {
      pieces.push({
        kind: 'arc',
        cx: a.x,
        cy: a.y,
        r,
        x0: prev.x,
        y0: prev.y,
        x1: seg.x0,
        y1: seg.y0,
        turn: wrapAngle(prev.dx, prev.dy, seg.dx, seg.dy, s.fromSide),
        side: s.fromSide,
      });
    }
    pieces.push({ kind: 'line', x0: seg.x0, y0: seg.y0, x1: seg.x1, y1: seg.y1 });
    prev = { x: seg.x1, y: seg.y1, dx: seg.dx, dy: seg.dy };
  }
  return pieces;
}

export interface SvgOptions {
  /** Margin around the loom, mm. */
  marginMm?: number;
  /** Draw pegs and their numbers. */
  showPegs?: boolean;
  pegNumberBase?: number;
}

/** Vector rendering at real scale (1 user unit = 1 mm), ready for print or plotting. */
export function toSVG(result: WeaveResult, opts: SvgOptions = {}): string {
  const margin = opts.marginMm ?? 20;
  const base = opts.pegNumberBase ?? 1;
  const { loom: cfg, background, threads } = result.options;
  const loom = createLoom(cfg);
  const widthMm = Number((loom.widthMm + 2 * margin).toFixed(3));
  const heightMm = Number((loom.heightMm + 2 * margin).toFixed(3));
  const ox = (loom.extentMm - loom.widthMm) / 2;
  const oy = (loom.extentMm - loom.heightMm) / 2;
  const fx = (v: number): string => (v - ox + margin).toFixed(3);
  const fy = (v: number): string => (v - oy + margin).toFixed(3);
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${widthMm} ${heightMm}">`,
  );
  out.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);

  if (cfg.shape === 'circle') {
    out.push(`<circle cx="${fx(loom.radiusMm)}" cy="${fy(loom.radiusMm)}" r="${loom.radiusMm}" fill="${background}"/>`);
  } else if (loom.outline) {
    const polyPts = loom.outline.map((pt) => `${fx(pt.x)},${fy(pt.y)}`).join(' ');
    out.push(`<polygon points="${polyPts}" fill="${background}"/>`);
  } else {
    out.push(
      `<rect x="${fx(ox)}" y="${fy(oy)}" width="${loom.widthMm}" height="${loom.heightMm}" fill="${background}"/>`,
    );
  }

  threads.forEach((t, i) => {
    const pieces = threadPath(result, i);
    if (pieces.length === 0) return;
    const d: string[] = [];
    let first = true;
    for (const p of pieces) {
      if (p.kind === 'line') {
        if (first) d.push(`M${fx(p.x0)} ${fy(p.y0)}`);
        d.push(`L${fx(p.x1)} ${fy(p.y1)}`);
        first = false;
      } else {
        // side +1 = counter-clockwise on screen = SVG sweep-flag 0.
        const large = p.turn > Math.PI ? 1 : 0;
        const sweep = p.side === 1 ? 0 : 1;
        d.push(`A${p.r} ${p.r} 0 ${large} ${sweep} ${fx(p.x1)} ${fy(p.y1)}`);
      }
    }
    const layerId = `layer-${t.id}`;
    out.push(`<g id="${layerId}">`);
    out.push(
      `  <path d="${d.join(' ')}" fill="none" stroke="${t.color}" stroke-opacity="${t.opacity}" stroke-width="${t.widthMm}" stroke-linejoin="round" stroke-linecap="round"/>`,
    );
    out.push('</g>');
  });

  if (opts.showPegs ?? true) {
    out.push('<g fill="#888" font-family="sans-serif" font-size="3" text-anchor="middle" dominant-baseline="central">');
    for (const p of loom.pegs) {
      out.push(`<circle cx="${fx(p.x)}" cy="${fy(p.y)}" r="${Math.max(loom.pegRadiusMm, 0.5)}"/>`);
      const lx = p.x + p.nx * 6;
      const ly = p.y + p.ny * 6;
      out.push(`<text x="${fx(lx)}" y="${fy(ly)}">${p.index + base}</text>`);
    }
    out.push('</g>');
  }
  out.push('</svg>');
  return out.join('\n') + '\n';
}
