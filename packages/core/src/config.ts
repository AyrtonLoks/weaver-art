import type {
  CircleLoomConfig,
  DeepPartial,
  LoomConfig,
  RectangleLoomConfig,
  ThreadConfig,
  WeaveOptions,
} from './types.js';

/** 1 inch in millimetres. */
export const INCH_MM = 25.4;

/**
 * Loom of "A new way to knit" (2016): a 28″ aluminium rim with 200 anchor pegs.
 * Source: https://artof01.com/vrellis/works/knit.html
 *
 * The peg diameter is not published; 2 mm is an engineering estimate and should be
 * calibrated against the physical loom being used.
 */
export const VRELLIS_LOOM: CircleLoomConfig = {
  shape: 'circle',
  diameterMm: 28 * INCH_MM,
  pegCount: 200,
  pegDiameterMm: 2,
  startAngleDeg: -90,
};

/** Example square loom: 500 × 500 mm frame, 50 pegs per side (196 total pegs). */
export const SQUARE_LOOM: RectangleLoomConfig = {
  shape: 'rectangle',
  widthMm: 500,
  heightMm: 500,
  pegsX: 50,
  pegsY: 50,
  pegDiameterMm: 2,
};

/** Single black thread — the grayscale works ("Knit 1: Christ Saviour", etc.). */
export const BLACK_THREAD: ThreadConfig = {
  id: 'black',
  name: 'Preto',
  color: '#000000',
  widthMm: 0.2,
  opacity: 1,
  startPeg: 0,
};

/**
 * Limited palette used by Vrellis in the colour works: yellow, magenta, blue, green and black.
 * Ordered by natural subtractive layering: light/warm foundation first, black details last.
 * Hex values are approximations — calibrate with photos of the real threads.
 */
export const VRELLIS_COLOR_THREADS: ThreadConfig[] = [
  { id: 'yellow', name: 'Amarelo', color: '#f2c500', widthMm: 0.2, opacity: 1, startPeg: 0 },
  { id: 'magenta', name: 'Magenta', color: '#c2187a', widthMm: 0.2, opacity: 1, startPeg: 40 },
  { id: 'blue', name: 'Azul', color: '#1d3fbb', widthMm: 0.2, opacity: 1, startPeg: 80 },
  { id: 'green', name: 'Verde', color: '#1e8a3c', widthMm: 0.2, opacity: 1, startPeg: 120 },
  { id: 'black', name: 'Preto', color: '#000000', widthMm: 0.2, opacity: 1, startPeg: 160 },
];

/**
 * Classic 4-colour CMYK palette: yellow, cyan, magenta, and black.
 * Produces exceptional continuous-tone blending and skin tones.
 */
export const CMYK_THREADS: ThreadConfig[] = [
  { id: 'yellow', name: 'Amarelo', color: '#fff100', widthMm: 0.2, opacity: 1, startPeg: 0 },
  { id: 'cyan', name: 'Ciano', color: '#00a0e9', widthMm: 0.2, opacity: 1, startPeg: 50 },
  { id: 'magenta', name: 'Magenta', color: '#e4007f', widthMm: 0.2, opacity: 1, startPeg: 100 },
  { id: 'black', name: 'Preto', color: '#000000', widthMm: 0.2, opacity: 1, startPeg: 150 },
];

/** Defaults reproduce the grayscale setup of Vrellis' original series. */
export const DEFAULT_OPTIONS: WeaveOptions = {
  loom: VRELLIS_LOOM,
  threads: [BLACK_THREAD],
  background: '#ffffff',
  /**
   * Grid size doubles as the viewing-distance model: each pixel averages ~1.8 mm of the artwork.
   * Finer grids (e.g. 700 px) chase sub-millimetre detail and lose facial features in tests.
   */
  resolutionPx: 400,
  maxLines: 4000,
  minPegGap: 12,
  maxChordRepeats: 1,
  colorStrategy: 'layered',
  viewingDistanceM: 0,
  highlightProtection: 0,
  preprocess: {
    grayscale: true,
    contrast: 1,
    brightness: 0,
    gamma: 1,
    invert: false,
    shadowLift: 0,
    edgeEmphasis: 0,
    clahe: false,
    claheClipLimit: 2,
    claheGridSize: 8,
    perceptualBlurMm: 0,
    viewingDistanceM: 0,
    highlightProtection: 0,
    sharpenSigma: 0,
    torsoFeathering: 0,
  },
};

/** Named presets exposed to the CLI and the web app. */
export const PRESETS = {
  'portrait-mono': {
    ...DEFAULT_OPTIONS,
    resolutionPx: 500,
    maxLines: 4000,
    maxChordRepeats: 2,
    highlightProtection: 2.5,
    preprocess: {
      ...DEFAULT_OPTIONS.preprocess,
      grayscale: true,
      clahe: true,
      edgeEmphasis: 0.8,
      highlightProtection: 2.5,
      shadowLift: 0.12,
      sharpenSigma: 1.5,
      torsoFeathering: 0.25,
    },
  },
  'portrait-cmyk': {
    ...DEFAULT_OPTIONS,
    threads: CMYK_THREADS,
    resolutionPx: 500,
    maxLines: 6000,
    maxChordRepeats: 2,
    colorStrategy: 'layered',
    threadLineBudgets: [0.3, 0.05, 0.25, 0.4],
    highlightProtection: 2.5,
    preprocess: {
      ...DEFAULT_OPTIONS.preprocess,
      grayscale: false,
      clahe: true,
      edgeEmphasis: 0.8,
      highlightProtection: 2.5,
      shadowLift: 0.12,
      sharpenSigma: 1.5,
      torsoFeathering: 0.25,
    },
  },
  'vrellis-mono': DEFAULT_OPTIONS,
  'vrellis-color': {
    ...DEFAULT_OPTIONS,
    threads: VRELLIS_COLOR_THREADS,
    maxLines: 6000,
    colorStrategy: 'layered',
    threadLineBudgets: [0.2, 0.2, 0.2, 0.1, 0.3],
    preprocess: { ...DEFAULT_OPTIONS.preprocess, grayscale: false },
  },
  cmyk: {
    ...DEFAULT_OPTIONS,
    threads: CMYK_THREADS,
    maxLines: 6000,
    colorStrategy: 'layered',
    threadLineBudgets: [0.2, 0.2, 0.2, 0.4],
    preprocess: { ...DEFAULT_OPTIONS.preprocess, grayscale: false },
  },
} satisfies Record<string, WeaveOptions>;

export type PresetName = keyof typeof PRESETS;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(override) || !isPlainObject(base)) {
    return (override === undefined ? base : override) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) ? deepMerge(out[key], value) : value;
  }
  return out as T;
}

/** Compute integer line budgets per thread according to threadLineBudgets or equal split. */
export function computeThreadBudgets(options: WeaveOptions): number[] {
  const T = options.threads.length;
  if (T === 0) return [];
  const total = options.maxLines;
  const rawBudgets = options.threadLineBudgets;

  let proportions: number[];
  if (rawBudgets && rawBudgets.length === T && rawBudgets.every((b) => b > 0)) {
    const sum = rawBudgets.reduce((a, b) => a + b, 0);
    proportions = rawBudgets.map((b) => (sum > 0 ? b / sum : 1 / T));
  } else {
    proportions = new Array(T).fill(1 / T);
  }

  const counts = proportions.map((p) => Math.floor(p * total));
  const allocated = counts.reduce((a, b) => a + b, 0);
  const diff = total - allocated;
  if (diff > 0 && T > 0) {
    counts[T - 1] += diff;
  }
  return counts;
}

/** Merge user overrides onto a base configuration and validate the result. */
export function resolveOptions(
  overrides: DeepPartial<WeaveOptions> = {},
  base: WeaveOptions = DEFAULT_OPTIONS,
): WeaveOptions {
  const baseCopy = JSON.parse(JSON.stringify(base)) as WeaveOptions;
  if (overrides.loom?.shape && overrides.loom.shape !== base.loom.shape) {
    baseCopy.loom = overrides.loom as LoomConfig;
  }
  const merged = deepMerge(baseCopy, overrides);
  if (merged.viewingDistanceM !== undefined && overrides.preprocess?.viewingDistanceM === undefined) {
    merged.preprocess.viewingDistanceM = merged.viewingDistanceM;
  }
  if (merged.highlightProtection !== undefined && overrides.preprocess?.highlightProtection === undefined) {
    merged.preprocess.highlightProtection = merged.highlightProtection;
  }
  validateOptions(merged);
  return merged;
}

/** Throws a descriptive error when options are physically or computationally invalid. */
export function validateOptions(o: WeaveOptions): void {
  const errors: string[] = [];
  const { loom } = o;
  let pegSpacing = Infinity;
  let totalPegs = 0;

  if (loom.shape === 'circle') {
    if (!(loom.diameterMm > 0)) errors.push('loom.diameterMm deve ser > 0');
    if (!Number.isInteger(loom.pegCount) || loom.pegCount < 3) errors.push('loom.pegCount deve ser inteiro >= 3');
    totalPegs = loom.pegCount;
    if (loom.diameterMm > 0 && loom.pegCount >= 3) {
      pegSpacing = (Math.PI * loom.diameterMm) / loom.pegCount;
    }
  } else if (loom.shape === 'rectangle') {
    if (!(loom.widthMm > 0)) errors.push('loom.widthMm deve ser > 0');
    if (!(loom.heightMm > 0)) errors.push('loom.heightMm deve ser > 0');
    if (!Number.isInteger(loom.pegsX) || loom.pegsX < 2) errors.push('loom.pegsX deve ser inteiro >= 2');
    if (!Number.isInteger(loom.pegsY) || loom.pegsY < 2) errors.push('loom.pegsY deve ser inteiro >= 2');
    totalPegs = 2 * (loom.pegsX + loom.pegsY) - 4;
    if (loom.widthMm > 0 && loom.heightMm > 0 && loom.pegsX >= 2 && loom.pegsY >= 2) {
      pegSpacing = Math.min(loom.widthMm / (loom.pegsX - 1), loom.heightMm / (loom.pegsY - 1));
    }
  } else if (loom.shape === 'custom') {
    if (!Array.isArray(loom.pegs) || loom.pegs.length < 3) {
      errors.push('loom.pegs deve ser um array com ao menos 3 pinos');
    } else {
      totalPegs = loom.pegs.length;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      let hasInvalidCoord = false;

      for (let i = 0; i < loom.pegs.length; i++) {
        const p = loom.pegs[i];
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
          errors.push(`loom.pegs[${i}] deve conter coordenadas numéricas finitas x e y`);
          hasInvalidCoord = true;
          break;
        }
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }

      if (!hasInvalidCoord) {
        if (maxX - minX < 0.01 || maxY - minY < 0.01) {
          errors.push('loom.pegs deve cobrir um plano 2D com largura e altura > 0');
        }

        let signedArea = 0;
        for (let i = 0; i < loom.pegs.length; i++) {
          const next = loom.pegs[(i + 1) % loom.pegs.length];
          signedArea += loom.pegs[i].x * next.y - next.x * loom.pegs[i].y;
          const dist = Math.hypot(next.x - loom.pegs[i].x, next.y - loom.pegs[i].y);
          if (dist < 1e-4) {
            errors.push(`loom.pegs possui pinos consecutivos duplicados ou com distância nula no índice ${i}`);
          }
          if (dist < pegSpacing) pegSpacing = dist;
        }

        if (Math.abs(signedArea) < 0.01) {
          errors.push('loom.pegs formam uma área nula ou pinos colineares');
        }
      }
    }
  } else {
    errors.push(`loom.shape "${String((loom as { shape?: unknown }).shape)}" não suportado`);
  }

  if (!(loom.pegDiameterMm >= 0)) errors.push('loom.pegDiameterMm deve ser >= 0');
  if (Number.isFinite(pegSpacing) && loom.pegDiameterMm >= pegSpacing) {
    errors.push(
      `loom.pegDiameterMm (${loom.pegDiameterMm}) deve ser menor que o espaçamento entre pinos (${pegSpacing.toFixed(2)} mm)`,
    );
  }

  if (o.threads.length === 0) errors.push('ao menos um fio é necessário');
  o.threads.forEach((t, i) => {
    if (!/^#[0-9a-f]{6}$/i.test(t.color)) errors.push(`threads[${i}].color deve ser #rrggbb`);
    if (!(t.widthMm > 0)) errors.push(`threads[${i}].widthMm deve ser > 0`);
    if (!(t.opacity > 0 && t.opacity <= 1)) errors.push(`threads[${i}].opacity deve estar em (0, 1]`);
    if (totalPegs > 0) {
      if (!Number.isInteger(t.startPeg) || t.startPeg < 0 || t.startPeg >= totalPegs) {
        errors.push(`threads[${i}].startPeg deve estar em [0, ${totalPegs - 1}]`);
      }
    }
  });
  if (!/^#[0-9a-f]{6}$/i.test(o.background)) errors.push('background deve ser #rrggbb');
  if (!Number.isInteger(o.resolutionPx) || o.resolutionPx < 64 || o.resolutionPx > 4096) {
    errors.push('resolutionPx deve ser inteiro em [64, 4096]');
  }
  if (!Number.isInteger(o.maxLines) || o.maxLines < 1) errors.push('maxLines deve ser inteiro >= 1');
  if (totalPegs > 0) {
    if (!Number.isInteger(o.minPegGap) || o.minPegGap < 1 || o.minPegGap >= totalPegs / 2) {
      errors.push(`minPegGap deve ser inteiro em [1, ${Math.floor(totalPegs / 2) - 1}]`);
    }
  }
  if (!Number.isInteger(o.maxChordRepeats) || o.maxChordRepeats < 1)
    errors.push('maxChordRepeats deve ser inteiro >= 1');
  if (o.colorStrategy !== undefined && !['layered'].includes(o.colorStrategy)) {
    errors.push(`colorStrategy "${String(o.colorStrategy)}" inválida (use: layered)`);
  }
  if (o.threadLineBudgets !== undefined) {
    if (!Array.isArray(o.threadLineBudgets) || o.threadLineBudgets.length !== o.threads.length) {
      errors.push(`threadLineBudgets deve ter o mesmo tamanho que threads (${o.threads.length})`);
    } else if (o.threadLineBudgets.some((b) => typeof b !== 'number' || !(b > 0))) {
      errors.push('todos os valores em threadLineBudgets devem ser números > 0');
    }
  }
  if (!(o.preprocess.contrast > 0)) errors.push('preprocess.contrast deve ser > 0');
  if (!(o.preprocess.gamma > 0)) errors.push('preprocess.gamma deve ser > 0');
  if (o.preprocess.shadowLift !== undefined && (!(o.preprocess.shadowLift >= 0) || o.preprocess.shadowLift > 1)) {
    errors.push('preprocess.shadowLift deve estar em [0, 1]');
  }
  if (o.preprocess.edgeEmphasis !== undefined && (!(o.preprocess.edgeEmphasis >= 0) || o.preprocess.edgeEmphasis > 1)) {
    errors.push('preprocess.edgeEmphasis deve estar em [0, 1]');
  }
  if (o.viewingDistanceM !== undefined && !(o.viewingDistanceM >= 0)) {
    errors.push('viewingDistanceM deve ser >= 0');
  }
  if (o.preprocess.claheClipLimit !== undefined && !(o.preprocess.claheClipLimit > 0)) {
    errors.push('preprocess.claheClipLimit deve ser > 0');
  }
  if (
    o.preprocess.claheGridSize !== undefined &&
    (!Number.isInteger(o.preprocess.claheGridSize) || o.preprocess.claheGridSize < 2 || o.preprocess.claheGridSize > 32)
  ) {
    errors.push('preprocess.claheGridSize deve ser inteiro em [2, 32]');
  }
  if (o.preprocess.perceptualBlurMm !== undefined && !(o.preprocess.perceptualBlurMm >= 0)) {
    errors.push('preprocess.perceptualBlurMm deve ser >= 0');
  }
  if (o.preprocess.viewingDistanceM !== undefined && !(o.preprocess.viewingDistanceM >= 0)) {
    errors.push('preprocess.viewingDistanceM deve ser >= 0');
  }
  if (
    o.preprocess.highlightProtection !== undefined &&
    (!(o.preprocess.highlightProtection >= 0) || o.preprocess.highlightProtection > 10)
  ) {
    errors.push('preprocess.highlightProtection deve estar em [0, 10]');
  }
  if (
    o.preprocess.sharpenSigma !== undefined &&
    (!(o.preprocess.sharpenSigma >= 0) || o.preprocess.sharpenSigma > 50)
  ) {
    errors.push('preprocess.sharpenSigma deve ser >= 0');
  }
  if (errors.length > 0) throw new Error(`Configuração inválida:\n- ${errors.join('\n- ')}`);
}
