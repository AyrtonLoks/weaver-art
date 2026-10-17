/**
 * Utilitários leves de geometria de tear, formatação e exportação (@weaver-art/core substituto limpo).
 */

export interface Peg {
  index: number;
  x: number;
  y: number;
  angle: number;
  nx: number;
  ny: number;
}

export interface CircleLoomConfig {
  shape: 'circle';
  diameterMm: number;
  pegCount: number;
  pegDiameterMm?: number;
  startAngleDeg?: number;
}

export interface RectLoomConfig {
  shape: 'rectangle';
  widthMm: number;
  heightMm: number;
  pegsX: number;
  pegsY: number;
  pegDiameterMm?: number;
}

export interface CustomLoomConfig {
  shape: 'custom';
  pegs: { x: number; y: number }[];
  pegDiameterMm?: number;
}

export type LoomConfig = CircleLoomConfig | RectLoomConfig | CustomLoomConfig;

export interface Loom {
  config: LoomConfig;
  pegs: Peg[];
  radiusMm: number;
  widthMm: number;
  heightMm: number;
  extentMm: number;
  pegRadiusMm: number;
  outline: { x: number; y: number }[];
}

export interface ThreadSpec {
  id: string;
  name: string;
  color: string;
  widthMm: number;
  opacity: number;
  startPeg: number;
}

export interface PreprocessOptions {
  contrast: number;
  brightness: number;
  gamma: number;
  shadowLift?: number;
  edgeEmphasis?: number;
  highlightProtection?: number;
  sharpenSigma?: number;
  torsoFeathering?: number;
  crop?: { x: number; y: number; size: number };
  clahe: boolean;
  claheClipLimit: number;
  viewingDistanceM?: number;
  invert?: boolean;
  grayscale?: boolean;
}

export interface WeaveOptions {
  loom: LoomConfig;
  threads: ThreadSpec[];
  threadLineBudgets?: number[];
  maxLines: number;
  minPegGap: number;
  maxChordRepeats: number;
  resolutionPx: number;
  colorStrategy: string;
  viewingDistanceM?: number;
  highlightProtection?: number;
  preprocess: PreprocessOptions;
}

export interface WeaveStep {
  index: number;
  thread: number;
  from: number;
  to: number;
  fromSide: 1 | -1;
  toSide: 1 | -1;
  gain: number;
  segmentMm: number;
  wrapMm: number;
}

export interface ThreadSummary {
  id: string;
  name: string;
  color: string;
  pegs: number[];
  lengthMm: number;
  lines: number;
}

export interface WeaveResult {
  version: number;
  options: WeaveOptions;
  steps: WeaveStep[];
  threads: ThreadSummary[];
  totalLengthMm: number;
  rmse: number;
  metrics?: {
    rmse: number;
    deltaELab?: number;
    ssim?: number;
  };
  stopReason: string;
  durationMs: number;
}

export interface ThreadEstimate {
  id: string;
  name: string;
  color: string;
  lines: number;
  lengthMm: number;
  requiredMm: number;
  spools: number;
  spoolUsagePct: number;
}

export interface WeaveEstimate {
  threads: ThreadEstimate[];
  weavingSeconds: number;
  overheadSeconds: number;
  totalSeconds: number;
  tieOns: number;
  switches: number;
}

export const DEFAULT_PREPROCESS: PreprocessOptions = {
  contrast: 1.0,
  brightness: 0.0,
  gamma: 1.0,
  shadowLift: 0.0,
  edgeEmphasis: 0.2,
  highlightProtection: 0.0,
  sharpenSigma: 1.0,
  torsoFeathering: 0.0,
  clahe: true,
  claheClipLimit: 2.0,
  viewingDistanceM: 1.5,
  invert: false,
  grayscale: false,
};

export const PRESETS: Record<string, WeaveOptions> = {
  'portrait-mono': {
    loom: { shape: 'circle', diameterMm: 600, pegCount: 200, pegDiameterMm: 2 },
    threads: [{ id: 'k', name: 'Preto', color: '#141414', widthMm: 0.18, opacity: 0.35, startPeg: 0 }],
    maxLines: 4000,
    minPegGap: 12,
    maxChordRepeats: 3,
    resolutionPx: 500,
    colorStrategy: 'layered',
    preprocess: { ...DEFAULT_PREPROCESS, grayscale: true },
  },
  'portrait-cmyk': {
    loom: { shape: 'circle', diameterMm: 600, pegCount: 288, pegDiameterMm: 2 },
    threads: [
      { id: 'y', name: 'Amarelo', color: '#f5dd05', widthMm: 0.18, opacity: 0.22, startPeg: 0 },
      { id: 'm', name: 'Magenta', color: '#d90a75', widthMm: 0.18, opacity: 0.24, startPeg: 72 },
      { id: 'c', name: 'Ciano', color: '#0594d9', widthMm: 0.18, opacity: 0.24, startPeg: 144 },
      { id: 'k', name: 'Preto', color: '#141414', widthMm: 0.18, opacity: 0.35, startPeg: 216 },
    ],
    maxLines: 6500,
    minPegGap: 12,
    maxChordRepeats: 3,
    resolutionPx: 500,
    colorStrategy: 'layered',
    preprocess: { ...DEFAULT_PREPROCESS, grayscale: false },
  },
};

export function resolveOptions(partial: Partial<WeaveOptions>, base = PRESETS['portrait-mono']): WeaveOptions {
  return {
    ...base,
    ...partial,
    preprocess: {
      ...base.preprocess,
      ...(partial.preprocess ?? {}),
    },
  };
}

export function loomPegCount(cfg: LoomConfig): number {
  if (cfg.shape === 'circle') return cfg.pegCount;
  if (cfg.shape === 'rectangle') return 2 * (cfg.pegsX + cfg.pegsY) - 4;
  return cfg.pegs.length;
}

export function describeLoom(cfg: LoomConfig): string {
  const pDiam = cfg.pegDiameterMm ?? 2;
  if (cfg.shape === 'circle') {
    return `Tear circular: ${cfg.diameterMm.toFixed(1)} mm, ${cfg.pegCount} pinos (Ø ${pDiam} mm)`;
  }
  if (cfg.shape === 'rectangle') {
    const n = loomPegCount(cfg);
    return `Tear retangular: ${cfg.widthMm}×${cfg.heightMm} mm, ${n} pinos (Ø ${pDiam} mm)`;
  }
  return `Tear customizado: ${cfg.pegs.length} pinos (Ø ${pDiam} mm)`;
}

export function createLoom(cfg: LoomConfig): Loom {
  const pegRadiusMm = (cfg.pegDiameterMm ?? 2) / 2;

  if (cfg.shape === 'circle') {
    const r = cfg.diameterMm / 2;
    const startRad = ((cfg.startAngleDeg ?? -90) * Math.PI) / 180;
    const pegs: Peg[] = [];
    const outline: { x: number; y: number }[] = [];

    for (let i = 0; i < cfg.pegCount; i++) {
      const angle = startRad + (2 * Math.PI * i) / cfg.pegCount;
      const nx = Math.cos(angle);
      const ny = Math.sin(angle);
      const x = r + r * nx;
      const y = r + r * ny;
      pegs.push({ index: i, x, y, angle, nx, ny });
      outline.push({ x, y });
    }

    return {
      config: cfg,
      pegs,
      radiusMm: r,
      widthMm: cfg.diameterMm,
      heightMm: cfg.diameterMm,
      extentMm: cfg.diameterMm,
      pegRadiusMm,
      outline,
    };
  }

  if (cfg.shape === 'rectangle') {
    const w = cfg.widthMm;
    const h = cfg.heightMm;
    const extent = Math.max(w, h);
    const ox = (extent - w) / 2;
    const oy = (extent - h) / 2;
    const rawPts: { x: number; y: number; nx: number; ny: number }[] = [];

    for (let i = 0; i < cfg.pegsX; i++) {
      rawPts.push({ x: ox + (w * i) / (cfg.pegsX - 1), y: oy, nx: 0, ny: -1 });
    }
    for (let j = 1; j < cfg.pegsY; j++) {
      rawPts.push({ x: ox + w, y: oy + (h * j) / (cfg.pegsY - 1), nx: 1, ny: 0 });
    }
    for (let i = cfg.pegsX - 2; i >= 0; i--) {
      rawPts.push({ x: ox + (w * i) / (cfg.pegsX - 1), y: oy + h, nx: 0, ny: 1 });
    }
    for (let j = cfg.pegsY - 2; j >= 1; j--) {
      rawPts.push({ x: ox, y: oy + (h * j) / (cfg.pegsY - 1), nx: -1, ny: 0 });
    }

    const cx = extent / 2;
    const cy = extent / 2;
    const pegs: Peg[] = rawPts.map((pt, idx) => ({
      index: idx,
      x: pt.x,
      y: pt.y,
      angle: Math.atan2(pt.y - cy, pt.x - cx),
      nx: pt.nx,
      ny: pt.ny,
    }));

    return {
      config: cfg,
      pegs,
      radiusMm: extent / 2,
      widthMm: w,
      heightMm: h,
      extentMm: extent,
      pegRadiusMm,
      outline: [
        { x: ox, y: oy },
        { x: ox + w, y: oy },
        { x: ox + w, y: oy + h },
        { x: ox, y: oy + h },
      ],
    };
  }

  // Custom / Elliptical / Polygon
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of cfg.pegs) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const w = Math.max(10, maxX - minX);
  const h = Math.max(10, maxY - minY);
  const extent = Math.max(w, h, maxX, maxY);
  const cx = extent / 2;
  const cy = extent / 2;

  const pegs: Peg[] = cfg.pegs.map((pt, idx) => {
    const dx = pt.x - cx;
    const dy = pt.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return {
      index: idx,
      x: pt.x,
      y: pt.y,
      angle: Math.atan2(dy, dx),
      nx: dx / len,
      ny: dy / len,
    };
  });

  return {
    config: cfg,
    pegs,
    radiusMm: extent / 2,
    widthMm: w,
    heightMm: h,
    extentMm: extent,
    pegRadiusMm,
    outline: cfg.pegs.map((p) => ({ x: p.x, y: p.y })),
  };
}

export function parsePegsCSV(csvText: string): { x: number; y: number }[] {
  const lines = csvText.trim().split(/\r?\n/);
  const pts: { x: number; y: number }[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || /^[a-zA-Z]/.test(trimmed)) continue;
    const parts = trimmed.split(/[,;\t]+/).map((s) => Number(s.trim()));
    if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
      const x = parts.length >= 4 ? parts[2] : parts[0];
      const y = parts.length >= 4 ? parts[3] : parts[1];
      pts.push({ x, y });
    }
  }
  return pts;
}

export function formatDuration(totalSeconds: number): string {
  const sec = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h} h${m} min`;
  return `${m} min`;
}

export function estimateWeave(res: WeaveResult): WeaveEstimate {
  const margin = 1.1;
  const spoolLenMm = 1_000_000;
  let switches = 0;
  for (let i = 1; i < res.steps.length; i++) {
    if (res.steps[i].thread !== res.steps[i - 1].thread) switches++;
  }
  const tieOns = res.steps.length > 0 ? switches + 1 : 0;
  const weavingSeconds = res.steps.length * 4.5;
  const overheadSeconds = tieOns * 90;

  const threads: ThreadEstimate[] = res.threads.map((t) => {
    const reqMm = t.lengthMm * margin;
    const spools = t.lines > 0 ? Math.max(1, Math.ceil(reqMm / spoolLenMm)) : 0;
    const spoolUsagePct = (reqMm / spoolLenMm) * 100;
    return {
      id: t.id,
      name: t.name,
      color: t.color,
      lines: t.lines,
      lengthMm: t.lengthMm,
      requiredMm: reqMm,
      spools,
      spoolUsagePct,
    };
  });

  return {
    threads,
    weavingSeconds,
    overheadSeconds,
    totalSeconds: weavingSeconds + overheadSeconds,
    tieOns,
    switches,
  };
}

export function calibrateThreadColor(img: { width: number; height: number; data: Uint8ClampedArray }): {
  hex: string;
  rgb: [number, number, number];
} {
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let count = 0;
  const cx = img.width / 2;
  const cy = img.height / 2;
  const rad = Math.min(cx, cy) * 0.5;

  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (Math.hypot(x - cx, y - cy) <= rad) {
        const idx = (y * img.width + x) * 4;
        rSum += img.data[idx];
        gSum += img.data[idx + 1];
        bSum += img.data[idx + 2];
        count++;
      }
    }
  }
  const n = Math.max(1, count);
  const r = Math.round(rSum / n);
  const g = Math.round(gSum / n);
  const b = Math.round(bSum / n);
  const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  return { hex, rgb: [r, g, b] };
}

export function prepareTarget(
  src: { width: number; height: number; data: Uint8ClampedArray },
  size: number,
  preprocess: PreprocessOptions,
  channels: 1 | 3 = 3,
): { data: Float32Array; channels: 1 | 3; mask: Uint8Array } {
  const out = new Float32Array(size * size * channels);
  const mask = new Uint8Array(size * size);
  const crop = preprocess.crop ?? {
    x: 0,
    y: 0,
    size: Math.min(src.width, src.height),
  };

  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const pIdx = y * size + x;
      if (Math.hypot(x - r, y - r) <= r) {
        mask[pIdx] = 1;
      }
      const sx = Math.min(src.width - 1, Math.max(0, Math.floor(crop.x + (x / size) * crop.size)));
      const sy = Math.min(src.height - 1, Math.max(0, Math.floor(crop.y + (y / size) * crop.size)));
      const sIdx = (sy * src.width + sx) * 4;

      const rv = src.data[sIdx] / 255;
      const gv = src.data[sIdx + 1] / 255;
      const bv = src.data[sIdx + 2] / 255;

      if (channels === 1) {
        out[pIdx] = 0.299 * rv + 0.587 * gv + 0.114 * bv;
      } else {
        out[pIdx * 3] = rv;
        out[pIdx * 3 + 1] = gv;
        out[pIdx * 3 + 2] = bv;
      }
    }
  }
  return { data: out, channels, mask };
}

export function toRGBA(data: Float32Array, channels: 1 | 3, mask: Uint8Array): Uint8ClampedArray {
  const total = mask.length;
  const rgba = new Uint8ClampedArray(total * 4);
  for (let i = 0; i < total; i++) {
    if (!mask[i]) {
      rgba[i * 4] = 255;
      rgba[i * 4 + 1] = 255;
      rgba[i * 4 + 2] = 255;
      rgba[i * 4 + 3] = 255;
      continue;
    }
    if (channels === 1) {
      const v = Math.round(Math.max(0, Math.min(1, data[i])) * 255);
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    } else {
      rgba[i * 4] = Math.round(Math.max(0, Math.min(1, data[i * 3])) * 255);
      rgba[i * 4 + 1] = Math.round(Math.max(0, Math.min(1, data[i * 3 + 1])) * 255);
      rgba[i * 4 + 2] = Math.round(Math.max(0, Math.min(1, data[i * 3 + 2])) * 255);
      rgba[i * 4 + 3] = 255;
    }
  }
  return rgba;
}

export function toInstructions(res: WeaveResult): string {
  const lines: string[] = [
    `# WEAVER ART - GUIA DE TECELAGEM`,
    `# Total de passos: ${res.steps.length}`,
    `# Comprimento estimado: ${(res.totalLengthMm / 1000).toFixed(1)} m`,
    ``,
  ];
  let lastThread = -1;
  for (const st of res.steps) {
    if (st.thread !== lastThread) {
      const tName = res.threads[st.thread]?.name ?? `Carretel ${st.thread}`;
      lines.push(`\n=== TROCA DE CARRETEL: ${tName.toUpperCase()} ===`);
      lastThread = st.thread;
    }
    const dir = st.toSide === 1 ? 'anti-horário' : 'horário';
    lines.push(`${String(st.index + 1).padStart(4, '0')}: Pino ${st.from + 1} -> Pino ${st.to + 1} (${dir})`);
  }
  return lines.join('\n');
}

export function toCSV(res: WeaveResult): string {
  const rows = ['step,spool_id,spool_name,from_pin,to_pin,direction'];
  for (const st of res.steps) {
    const tName = res.threads[st.thread]?.name ?? `Spool_${st.thread}`;
    const dir = st.toSide === 1 ? 'CCW' : 'CW';
    rows.push(`${st.index + 1},${st.thread},${tName},${st.from + 1},${st.to + 1},${dir}`);
  }
  return rows.join('\n');
}

export function toSVG(res: WeaveResult): string {
  const loom = createLoom(res.options.loom);
  const ext = loom.extentMm;
  const lines: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ext} ${ext}" width="${ext}mm" height="${ext}mm">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
  ];
  for (const st of res.steps) {
    const p1 = loom.pegs[st.from % loom.pegs.length];
    const p2 = loom.pegs[st.to % loom.pegs.length];
    const thread = res.threads[st.thread] ?? res.threads[0];
    const color = thread?.color ?? '#141414';
    const w = res.options.threads[st.thread]?.widthMm ?? 0.18;
    if (p1 && p2) {
      lines.push(
        `<line x1="${p1.x.toFixed(2)}" y1="${p1.y.toFixed(2)}" x2="${p2.x.toFixed(2)}" y2="${p2.y.toFixed(2)}" stroke="${color}" stroke-width="${w}" stroke-opacity="0.35" />`,
      );
    }
  }
  lines.push(`</svg>`);
  return lines.join('\n');
}

export function tangentSegment(
  pegA: Peg,
  sideA: 1 | -1,
  pegB: Peg,
  sideB: 1 | -1,
  pegRadiusMm: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const dx = pegB.x - pegA.x;
  const dy = pegB.y - pegA.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= 1e-6 || pegRadiusMm <= 0) {
    return { x0: pegA.x, y0: pegA.y, x1: pegB.x, y1: pegB.y };
  }
  const ux = dx / dist;
  const uy = dy / dist;
  // Vetor normal perpendicular à linha de centro
  const nx = -uy;
  const ny = ux;

  return {
    x0: pegA.x + nx * sideA * pegRadiusMm,
    y0: pegA.y + ny * sideA * pegRadiusMm,
    x1: pegB.x + nx * sideB * pegRadiusMm,
    y1: pegB.y + ny * sideB * pegRadiusMm,
  };
}
