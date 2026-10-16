/**
 * Preset engine: reactive presets and contextual slider visibility rules (ADR-005).
 */

export * from './preset-registry.js';

export {
  computeThreadBudgets,
  DEFAULT_OPTIONS,
  PRESETS,
  resolveOptions,
  validateOptions,
  type PresetName,
} from '@weaver-art/core';
import type { LoomShape, SolverAlgorithm, SpoolStrategy } from '../domain-contracts';

/** Contextual visibility predicate for UI controls based on active preset and solver mode. */
export interface SliderVisibilityRule {
  readonly controlId: string;
  readonly visibleWhenShapes?: readonly LoomShape[];
  readonly visibleWhenAlgorithms?: readonly SolverAlgorithm[];
  readonly visibleWhenStrategies?: readonly SpoolStrategy[];
}

/** Active UI state evaluated against contextual slider visibility rules. */
export interface PresetVisibilityContext {
  readonly shape: LoomShape;
  readonly algorithm: SolverAlgorithm;
  readonly strategy: SpoolStrategy;
}

/** Evaluates whether a UI control should be visible under the current preset context (ADR-005). */
export function isSliderVisible(rule: SliderVisibilityRule, context: PresetVisibilityContext): boolean {
  if (rule.visibleWhenShapes && rule.visibleWhenShapes.length > 0 && !rule.visibleWhenShapes.includes(context.shape)) {
    return false;
  }
  if (
    rule.visibleWhenAlgorithms &&
    rule.visibleWhenAlgorithms.length > 0 &&
    !rule.visibleWhenAlgorithms.includes(context.algorithm)
  ) {
    return false;
  }
  if (
    rule.visibleWhenStrategies &&
    rule.visibleWhenStrategies.length > 0 &&
    !rule.visibleWhenStrategies.includes(context.strategy)
  ) {
    return false;
  }
  return true;
}
