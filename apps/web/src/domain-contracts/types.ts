/**
 * Formal domain types and interfaces for the Weaver Art architecture.
 *
 * Implements strict, pure contracts without runtime dependencies or DOM bindings.
 */

/** Supported geometric shapes for physical string-art looms. */
export type LoomShapeType = 'CIRCULAR' | 'SQUARE';

/** Physical manufacturing and geometric specification of a string-art loom. */
export interface LoomPhysicalSpec {
  shape: LoomShapeType;
  pinCount: number;
  diameterMm: number;
  widthMm: number;
  heightMm: number;
  pinDiameterMm: number;
  threadThicknessMm: number;
  drillBitMm: number;
  edgeMarginMm: number;
}

/** Color palette modes defining chromatic behavior and thread spool composition. */
export type ColorPaletteMode = 'MONOCHROME' | 'CMYK_SUBTRACTIVE' | 'VRELLIS_5_COLOR';

/** Optical thread blending and physical transmittance models. */
export type OpticalMixModelType = 'LINEAR_SUBTRACTIVE' | 'PORTER_DUFF_OCCLUSION' | 'BEER_LAMBERT';

/** Perceptual and mathematical color error metric formulations. */
export type ColorErrorMetricType = 'LINEAR_RGB' | 'REDMEAN_WEIGHTED' | 'CIELAB_DELTA_E2000';

/** String-art optimization algorithms. */
export type SolverAlgorithmType = 'ITERATIVE_GREEDY' | 'BEAM_SEARCH';

/** Multi-spool switching strategies for physical weaving. */
export type SpoolSwitchStrategyType =
  'FREE_GREEDY' | 'HYSTERESIS_PENALTY' | 'MIN_RUN_LENGTH' | 'COARSE_TO_FINE_EPOCHS' | 'SEPARATED_CHANNELS';

/** Line rasterization algorithms for discrete simulation grid sampling. */
export type RasterizerType = 'BRESENHAM_BINARY' | 'XIAOLIN_WU_ANTIALIASED';

/** Mathematical morphology operations for tone and feature enhancement. */
export type MorphologyOpType = 'NONE' | 'EROSION' | 'DILATION' | 'OPENING' | 'CLOSING' | 'GRADIENT';

/** Digital signal processing edge detection filters. */
export type EdgeDetectorType = 'NONE' | 'SOBEL' | 'CANNY';

/** 2D Framing, pan, zoom and facial guide transformation parameters. */
export interface FramingTransform {
  zoom: number;
  panXPercent: number;
  panYPercent: number;
  rotationDeg: number;
  autoFaceTargetRatio: number;
}

/** Direction of thread winding around a cylindrical peg ('CW' clockwise, 'CCW' counter-clockwise). */
export type PinWindingDirection = 'CW' | 'CCW';

/** Status flags representing solver execution state in atomic memory. */
export const SolverStatusFlag = {
  IDLE: 0,
  RUNNING: 1,
  PAUSED: 2,
  DONE: 3,
  ABORT: 4,
} as const;

export type SolverStatusFlagValue = (typeof SolverStatusFlag)[keyof typeof SolverStatusFlag];

/** Zero-copy decoded record for an individual weaving path chord step. */
export interface WeavingStepRecord {
  fromPin: number;
  toPin: number;
  spoolId: number;
  departureWinding: PinWindingDirection;
  arrivalWinding: PinWindingDirection;
  scoreNormalized: number;
}

/** Schedule ratios for coarse-to-fine epoch multi-spool weaving. */
export interface EpochSchedule {
  baseCmyRatio: number;
  refineRatio: number;
  detailBlackWhiteTopRatio: number;
}

/** Identifier for predefined algorithmic and physical weaving preset profiles. */
export type WeaverPresetProfileId = 'VRELLIS_CLASSIC_MONO' | 'VRELLIS_COLOR';

/** Complete reactive configuration state encompassing physics, solver, and DSP options. */
export interface WeaverConfig extends LoomPhysicalSpec {
  // Preset Profile
  presetProfileId: WeaverPresetProfileId;

  // Color & Optics
  paletteMode: ColorPaletteMode;
  opticalMixModel: OpticalMixModelType;
  errorMetric: ColorErrorMetricType;

  // Solver & Line Budgets
  solver: SolverAlgorithmType;
  maxLines: number;
  maxChordRepeats: number;

  // Spool & Scheduling
  spoolStrategy: SpoolSwitchStrategyType;
  switchPenaltyLambda: number;
  minRunLength: number;
  epochSchedule?: EpochSchedule;
  painterLayersPerColor?: number;

  // Beam Search Parameters (optional)
  beamWidth?: number;
  beamDepth?: number;

  // DSP & Feature Enhancement
  rasterizer: RasterizerType;
  claheClipLimit: number;
  faceImportanceWeight: number;
  /** Realce de feições escuras do rosto (olhos, sobrancelhas, boca) no mapa de importância. 0 = desligado. */
  featureEmphasisWeight: number;
  /** "Pele mais limpa": clareia sombras suaves da pele antes da otimização (0–1). 0 = desligado. */
  skinLift: number;
  edgeDetector: EdgeDetectorType;
  edgeBlendWeight: number;
  morphologyOp: MorphologyOpType;

  // Framing
  framing: FramingTransform;
}
