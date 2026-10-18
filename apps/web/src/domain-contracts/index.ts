/**
 * Domain contracts: pure interfaces, configuration types, solver algorithms and loom shapes.
 */

export * from './types.js';

export type {
  CircleLoomConfig,
  ColorStrategy,
  CustomLoomConfig,
  CustomPaletteResult,
  DeepPartial,
  LoomBase,
  LoomConfig,
  PaletteOptions,
  PegSide,
  PreprocessOptions,
  RasterImage,
  RectangleLoomConfig,
  StopReason,
  ThreadConfig,
  ThreadSummary,
  WeaveMetrics,
  WeaveOptions,
  WeaveProgress,
  WeaveResult,
  WeaveStep,
} from '@weaver-art/core';

/** Supported loom geometric shapes. */
export type LoomShape = 'circle' | 'rectangle';

/** Supported optimization solver algorithms. */
export type SolverAlgorithm = 'greedy' | 'beam-search';

/** Supported spool / palette strategies (all using sequential physical layers). */
export type SpoolStrategy = 'mono' | 'vrellis-5';
