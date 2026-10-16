/**
 * Blueprint view: dedicated mechanical rim drilling plot, CAD canvas and 1:1 A4/A3/Letter template pagination.
 */

export * from './blueprint-view.js';
export * from './blueprint-canvas.js';
export type { PaperOrientation, PaperSize, TemplatePdfOptions, TemplateSvgOptions } from '@weaver-art/core';

/** Mechanical blueprint export formats. */
export type BlueprintExportFormat = 'pdf' | 'svg' | 'csv' | 'gcode';

/** Configuration state for the mechanical drilling blueprint view. */
export interface BlueprintViewConfig {
  readonly drillDiameterMm: number;
  readonly marginMm: number;
  readonly showRegistrationMarks: boolean;
  readonly showCalibrationRulerMm: boolean;
}
