/**
 * Public types for the Weaver Art core engine.
 *
 * Units: every physical quantity is expressed in millimetres (mm). Pixel
 * quantities only exist inside the simulation grid and are always suffixed
 * with `Px`.
 */

/** Platform-neutral RGBA8 raster (compatible with browser `ImageData` and `sharp` raw output). */
export interface RasterImage {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel, row-major, length = width * height * 4. */
  data: Uint8ClampedArray | Uint8Array;
}

/** Base configuration shared across all loom shapes. */
export interface LoomBase {
  /**
   * Peg diameter in mm. When > 0 the thread is modelled as wrapping around
   * real cylinders (tangent segments + wrap arcs). When 0, pegs are ideal points.
   */
  pegDiameterMm: number;
}

/** Circular loom (Petros Vrellis' original design). */
export interface CircleLoomConfig extends LoomBase {
  shape: 'circle';
  /** Diameter of the circle that passes through the peg centres, in mm. */
  diameterMm: number;
  /** Number of anchor pegs, equally spaced. */
  pegCount: number;
  /** Angle of peg #0 in degrees (0 = right, 90 = bottom, -90 = top; screen coordinates). */
  startAngleDeg: number;
}

/** Rectangular (or square) frame. Pegs numbered clockwise from the top-left corner. */
export interface RectangleLoomConfig extends LoomBase {
  shape: 'rectangle';
  /** Frame width in mm (X axis). */
  widthMm: number;
  /** Frame height in mm (Y axis). */
  heightMm: number;
  /** Pegs along the top and bottom edges (corners included, >= 2). */
  pegsX: number;
  /** Pegs along the left and right edges (corners included, >= 2). */
  pegsY: number;
}

/** Arbitrary peg positions (e.g. imported CSV), in mm, listed in perimeter order. */
export interface CustomLoomConfig extends LoomBase {
  shape: 'custom';
  pegs: { x: number; y: number }[];
}

/** Physical description of the loom (the frame with anchor pegs). */
export type LoomConfig = CircleLoomConfig | RectangleLoomConfig | CustomLoomConfig;

/** Knitting progress saved for cross-device resume. */
export interface WeaveProgress {
  /** 0-based step index reached in knitting. */
  index: number;
  /** ISO timestamp of last update. */
  updatedAt: string;
}

/** A single continuous thread. */
export interface ThreadConfig {
  /** Stable identifier (e.g. `black`). */
  id: string;
  /** Human-readable name (e.g. `Preto`). */
  name: string;
  /** sRGB colour, `#rrggbb`. */
  color: string;
  /** Apparent thread width in mm (governs how much of a pixel one pass covers). */
  widthMm: number;
  /** Opacity of the thread in [0, 1]. Real threads are ~1; lower values model fuzz/translucency. */
  opacity: number;
  /** Peg where this thread is tied at the start. */
  startPeg: number;
}

/** Image preparation options (how the photograph becomes the optimisation target). */
export interface PreprocessOptions {
  /** Convert the target to luminance only. Forced on when every thread and the background are achromatic. */
  grayscale: boolean;
  /** Contrast multiplier applied in perceptual (sRGB) space around mid-grey. 1 = unchanged. */
  contrast: number;
  /** Brightness offset in perceptual space, [-1, 1]. 0 = unchanged. */
  brightness: number;
  /** Gamma applied in perceptual space (> 1 darkens mid-tones, < 1 brightens). 1 = unchanged. */
  gamma: number;
  /** Invert the image (useful for white thread on dark boards). */
  invert: boolean;
  /** Shadow lift: prevents dark clothing from dominating chords [0, 0.5]. 0 = unchanged. */
  shadowLift?: number;
  /** Edge emphasis: Sobel gradient saliency boost on facial features/edges [0, 1]. 0 = unchanged. */
  edgeEmphasis?: number;
  /** Contrast-limited adaptive histogram equalization (CLAHE). */
  clahe?: boolean;
  /** CLAHE clip limit factor (typical: 2.0). */
  claheClipLimit?: number;
  /** CLAHE tile grid size (typical: 8 for 8x8). */
  claheGridSize?: number;
  /** Retinal perceptual blur in mm (simulating human eye visual acuity). */
  perceptualBlurMm?: number;
  /** Viewing distance in meters (Birsak et al., 2018). Converted to perceptual blur. */
  viewingDistanceM?: number;
  /** Optional square crop in source pixels. Defaults to the centred largest square. */
  crop?: { x: number; y: number; size: number };
  /** Proteção assimétrica de realces: penaliza sobre-escurecimento de tons claros [0, 10]. Padrão: 0 (2.0 a 4.0 em retratos). */
  highlightProtection?: number;
  /** Raio do filtro de unsharp mask para reforçar microdetalhes (óculos, cílios). */
  sharpenSigma?: number;
  /** Feathering suave da borda inferior para atenuar o tronco e roupas escuras [0, 0.5]. */
  torsoFeathering?: number | boolean;
}

/** Strategy for choosing thread colours during multi-thread weaving. */
export type ColorStrategy = 'layered';

/** Options controlling the optimisation itself. */
export interface WeaveOptions {
  loom: LoomConfig;
  threads: ThreadConfig[];
  /** sRGB colour of the background visible through the loom (`#ffffff` in Vrellis' works). */
  background: string;
  /** Size (in pixels) of the square simulation grid that spans the loom diameter. */
  resolutionPx: number;
  /** Maximum number of chords (all threads combined). Vrellis: 3 000 – 4 000. */
  maxLines: number;
  /** Minimum circular distance (in pegs) between consecutive pegs. Avoids useless chords hugging the rim. */
  minPegGap: number;
  /** How many times the same peg pair may be used (regardless of wrap side). */
  maxChordRepeats: number;
  /** Colour strategy for multi-thread weaving. Default: 'layered'. */
  colorStrategy?: ColorStrategy;
  /** Line budgets or proportions per thread (e.g. [0.2, 0.2, 0.2, 0.1, 0.3]). */
  threadLineBudgets?: number[];
  /** Viewing distance in meters (Birsak et al., 2018). Default: 0 (disabled). */
  viewingDistanceM?: number;
  /** Proteção assimétrica de realces: atalho de nível superior para preprocess.highlightProtection. */
  highlightProtection?: number;
  /** Image preparation. */
  preprocess: PreprocessOptions;
}

/** Options for automatic palette extraction. */
export interface PaletteOptions {
  /** Maximum number of pixels to sample inside the loom circle. Default: 10000. */
  maxSamples?: number;
  /** Maximum K-Means iterations. Default: 25. */
  maxIterations?: number;
  /** Custom seed for reproducible initialization. */
  seed?: number;
  /** Apparent thread width in mm. Default: 0.2. */
  threadWidthMm?: number;
  /** Thread opacity in (0, 1]. Default: 1.0. */
  opacity?: number;
  /** Quota for the darkest anchor thread [0.2, 0.6]. Default: 0.35 to 0.40. */
  darkAnchorQuota?: number;
  /** Loom configuration to sample within. */
  loom?: LoomConfig;
  /** Peg count of the loom to space out starting pegs. Default: 200. */
  loomPegCount?: number;
}

/** Result of automatic palette extraction. */
export interface CustomPaletteResult {
  threads: ThreadConfig[];
  threadLineBudgets: number[];
  colorsHex: string[];
}

/** Deep-partial helper used for user-supplied overrides. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * Side of the peg the thread passes on, relative to the travel direction.
 * `+1`/`-1` select the two tangent lines; with ideal (zero-diameter) pegs only `+1` is used.
 * The side is preserved while the thread wraps around a peg.
 */
export type PegSide = 1 | -1;

/** One chord laid by the engine. */
export interface WeaveStep {
  /** 0-based index in the global sequence. */
  index: number;
  /** Index into `WeaveOptions.threads`. */
  thread: number;
  /** 0-based peg indices. */
  from: number;
  to: number;
  fromSide: PegSide;
  toSide: PegSide;
  /** Error reduction obtained by this chord (weighted squared error, linear light). */
  gain: number;
  /** Physical length of the straight segment, in mm. */
  segmentMm: number;
  /** Length of thread wrapped around the `from` peg before this segment, in mm. */
  wrapMm: number;
  /** 0-based layer index in layered execution. */
  layerIndex?: number;
}

/** Summary of a single thread after weaving. */
export interface ThreadSummary {
  id: string;
  name: string;
  color: string;
  /** Peg sequence (0-based), starting with the tie-on peg. */
  pegs: number[];
  /** Total physical thread length in mm (segments + wraps). */
  lengthMm: number;
  lines: number;
}

/** Perceptual metrics comparing simulation and target. */
export interface WeaveMetrics {
  rmse: number;
  deltaELab: number;
  ssim: number;
}

/** Final result of a weaving run. */
export interface WeaveResult {
  version: 1;
  options: WeaveOptions;
  steps: WeaveStep[];
  threads: ThreadSummary[];
  totalLengthMm: number;
  /** Root-mean-square error between simulation and target, in linear light, inside the loom. */
  rmse: number;
  /** Perceptual metrics (CIELAB ΔE and SSIM, v0.2+). */
  metrics?: WeaveMetrics;
  /** Why the run stopped. */
  stopReason: StopReason;
  durationMs: number;
  /** Saved progress for resume. */
  progress?: WeaveProgress;
}

export type StopReason = 'max-lines' | 'no-improvement' | 'no-candidates' | 'aborted';
