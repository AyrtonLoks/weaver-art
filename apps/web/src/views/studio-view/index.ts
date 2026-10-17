/**
 * Studio view: main workspace view for portrait framing, target preprocessing,
 * multi-stage inspection (Prepared, Importance, Edges, Radon, Residual) and optimization.
 */

export * from './studio-view.js';
import type { WeaveOptions, WeaveResult } from '../../domain-contracts/index.js';

/** Studio viewport comparison modes. */
export type StudioComparisonMode = 'simulation' | 'split' | 'target';

/** State snapshot of the Studio & Optimization view. */
export interface StudioViewState {
  readonly comparisonMode: StudioComparisonMode;
  readonly options: WeaveOptions;
  readonly lastResult: WeaveResult | null;
}
export * from './distance-view.js';
