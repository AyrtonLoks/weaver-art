/**
 * Reactive Preset Engine and Contextual Visibility Rules (ADR-005).
 *
 * Implements the 4 core preset profiles, per-parameter dirty state tracking,
 * and contextual UI control visibility predicates based on active mode/solver.
 */

import type { WeaverConfig, WeaverPresetProfileId } from '../domain-contracts/types.js';

export type WeaverControlId =
  | 'paletteMode'
  | 'spoolStrategy'
  | 'switchPenaltyLambda'
  | 'minRunLength'
  | 'epochSchedule'
  | 'painterLayersPerColor'
  | 'opticalMixModel'
  | 'errorMetric'
  | 'solver'
  | 'beamWidth'
  | 'beamDepth'
  | 'fistaIterations'
  | 'l1RegularizationLambda'
  | 'maxLines'
  | 'maxChordRepeats'
  | 'threadThicknessMm'
  | 'claheClipLimit'
  | 'faceImportanceWeight'
  | 'featureEmphasisWeight'
  | 'skinLift'
  | 'edgeDetector'
  | 'edgeBlendWeight'
  | 'morphologyOp'
  | 'rasterizer'
  | 'shape'
  | 'diameterMm'
  | 'widthMm'
  | 'heightMm'
  | 'polygonSides'
  | 'pinCount'
  | 'pinDiameterMm'
  | 'drillBitMm'
  | 'edgeMarginMm'
  | 'framingZoom'
  | 'framingPanX'
  | 'framingPanY'
  | 'framingRotation'
  | 'autoFaceTargetRatio';

export interface PresetProfile {
  readonly id: WeaverPresetProfileId;
  readonly name: string;
  readonly description: string;
  readonly config: Readonly<WeaverConfig>;
}

/** The 4 primary preset profiles defined in architecture ADR-005. */
export const WEAVER_PRESET_PROFILES: Readonly<Record<WeaverPresetProfileId, PresetProfile>> = {
  VRELLIS_CLASSIC_MONO: {
    id: 'VRELLIS_CLASSIC_MONO',
    name: 'Vrellis Clássico (Monocromático)',
    description: 'Monocromático com solver guloso clássico e antialiasing Xiaolin Wu.',
    config: {
      presetProfileId: 'VRELLIS_CLASSIC_MONO',
      shape: 'CIRCULAR',
      pinCount: 200,
      diameterMm: 622,
      widthMm: 622,
      heightMm: 622,
      polygonSides: 0,
      pinDiameterMm: 2.0,
      threadThicknessMm: 0.18,
      drillBitMm: 2.0,
      edgeMarginMm: 15.0,
      paletteMode: 'MONOCHROME',
      opticalMixModel: 'PORTER_DUFF_OCCLUSION',
      errorMetric: 'CIELAB_DELTA_E2000',
      solver: 'ITERATIVE_GREEDY',
      maxLines: 6000,
      maxChordRepeats: 2,
      spoolStrategy: 'FREE_GREEDY',
      switchPenaltyLambda: 0.0,
      minRunLength: 1,
      epochSchedule: {
        baseCmyRatio: 0.65,
        refineRatio: 0.2,
        detailBlackWhiteTopRatio: 0.15,
      },
      painterLayersPerColor: 1,
      beamWidth: 8,
      beamDepth: 3,
      fistaIterations: 100,
      l1RegularizationLambda: 0.05,
      rasterizer: 'XIAOLIN_WU_ANTIALIASED',
      claheClipLimit: 0,
      faceImportanceWeight: 2.0,
      featureEmphasisWeight: 0,
      skinLift: 0,
      edgeDetector: 'SOBEL',
      edgeBlendWeight: 0,
      morphologyOp: 'NONE',
      framing: {
        zoom: 1.0,
        panXPercent: 0,
        panYPercent: 0,
        rotationDeg: 0,
        autoFaceTargetRatio: 0.95,
      },
    },
  },

  PORTRAIT_HIGH_SHARPNESS_EPOCHS: {
    id: 'PORTRAIT_HIGH_SHARPNESS_EPOCHS',
    name: 'Retrato Nitidez Máxima (Épocas Coarse-to-Fine)',
    description: 'Retrato multiescala de alta nitidez com épocas coarse-to-fine e CIELAB ΔE2000.',
    config: {
      presetProfileId: 'PORTRAIT_HIGH_SHARPNESS_EPOCHS',
      shape: 'CIRCULAR',
      pinCount: 288,
      diameterMm: 622,
      widthMm: 622,
      heightMm: 622,
      polygonSides: 0,
      pinDiameterMm: 2.0,
      threadThicknessMm: 0.18,
      drillBitMm: 2.0,
      edgeMarginMm: 15.0,
      paletteMode: 'CMYK_SUBTRACTIVE',
      opticalMixModel: 'PORTER_DUFF_OCCLUSION',
      errorMetric: 'CIELAB_DELTA_E2000',
      solver: 'ITERATIVE_GREEDY',
      maxLines: 6500,
      maxChordRepeats: 3,
      spoolStrategy: 'COARSE_TO_FINE_EPOCHS',
      switchPenaltyLambda: 0.25,
      minRunLength: 50,
      epochSchedule: {
        baseCmyRatio: 0.65,
        refineRatio: 0.2,
        detailBlackWhiteTopRatio: 0.15,
      },
      painterLayersPerColor: 1,
      beamWidth: 8,
      beamDepth: 3,
      fistaIterations: 100,
      l1RegularizationLambda: 0.05,
      rasterizer: 'XIAOLIN_WU_ANTIALIASED',
      claheClipLimit: 0,
      faceImportanceWeight: 2.0,
      featureEmphasisWeight: 0,
      skinLift: 0,
      edgeDetector: 'SOBEL',
      edgeBlendWeight: 0,
      morphologyOp: 'NONE',
      framing: {
        zoom: 1.0,
        panXPercent: 0,
        panYPercent: 0,
        rotationDeg: 0,
        autoFaceTargetRatio: 0.95,
      },
    },
  },

  CMYK_DYNAMIC_HYSTERESIS: {
    id: 'CMYK_DYNAMIC_HYSTERESIS',
    name: 'CMYK / Paleta Customizada com Histerese Dinâmica',
    description: 'CMYK equilibrado com penalidade de troca de carretel por histerese e CIELAB ΔE2000.',
    config: {
      presetProfileId: 'CMYK_DYNAMIC_HYSTERESIS',
      shape: 'CIRCULAR',
      pinCount: 288,
      diameterMm: 622,
      widthMm: 622,
      heightMm: 622,
      polygonSides: 0,
      pinDiameterMm: 2.0,
      threadThicknessMm: 0.18,
      drillBitMm: 2.0,
      edgeMarginMm: 15.0,
      paletteMode: 'CMYK_SUBTRACTIVE',
      opticalMixModel: 'PORTER_DUFF_OCCLUSION',
      errorMetric: 'CIELAB_DELTA_E2000',
      solver: 'ITERATIVE_GREEDY',
      maxLines: 6000,
      maxChordRepeats: 3,
      spoolStrategy: 'HYSTERESIS_PENALTY',
      switchPenaltyLambda: 0.3,
      minRunLength: 80,
      epochSchedule: {
        baseCmyRatio: 0.65,
        refineRatio: 0.2,
        detailBlackWhiteTopRatio: 0.15,
      },
      painterLayersPerColor: 1,
      beamWidth: 8,
      beamDepth: 3,
      fistaIterations: 100,
      l1RegularizationLambda: 0.05,
      rasterizer: 'XIAOLIN_WU_ANTIALIASED',
      claheClipLimit: 0,
      faceImportanceWeight: 2.0,
      featureEmphasisWeight: 0,
      skinLift: 0,
      edgeDetector: 'SOBEL',
      edgeBlendWeight: 0,
      morphologyOp: 'NONE',
      framing: {
        zoom: 1.0,
        panXPercent: 0,
        panYPercent: 0,
        rotationDeg: 0,
        autoFaceTargetRatio: 0.95,
      },
    },
  },

  GLOBAL_RADON_FISTA: {
    id: 'GLOBAL_RADON_FISTA',
    name: 'Otimização Global NNLS / Radon (FISTA)',
    description: 'Solver global de mínimos quadrados não-negativos via FISTA e transformada de Radon.',
    config: {
      presetProfileId: 'GLOBAL_RADON_FISTA',
      shape: 'CIRCULAR',
      pinCount: 200,
      diameterMm: 622,
      widthMm: 622,
      heightMm: 622,
      polygonSides: 0,
      pinDiameterMm: 2.0,
      threadThicknessMm: 0.18,
      drillBitMm: 2.0,
      edgeMarginMm: 15.0,
      paletteMode: 'MONOCHROME',
      opticalMixModel: 'LINEAR_SUBTRACTIVE',
      errorMetric: 'LINEAR_RGB',
      solver: 'GLOBAL_NNLS_FISTA',
      maxLines: 5000,
      maxChordRepeats: 2,
      spoolStrategy: 'SEPARATED_CHANNELS',
      switchPenaltyLambda: 0.0,
      minRunLength: 1,
      epochSchedule: {
        baseCmyRatio: 0.65,
        refineRatio: 0.2,
        detailBlackWhiteTopRatio: 0.15,
      },
      painterLayersPerColor: 3,
      beamWidth: 8,
      beamDepth: 3,
      fistaIterations: 150,
      l1RegularizationLambda: 0.05,
      rasterizer: 'XIAOLIN_WU_ANTIALIASED',
      claheClipLimit: 0,
      faceImportanceWeight: 2.0,
      featureEmphasisWeight: 0,
      skinLift: 0,
      edgeDetector: 'NONE',
      edgeBlendWeight: 0,
      morphologyOp: 'NONE',
      framing: {
        zoom: 1.0,
        panXPercent: 0,
        panYPercent: 0,
        rotationDeg: 0,
        autoFaceTargetRatio: 0.95,
      },
    },
  },
};

/** Evaluates whether a UI control should be visible under the given configuration. */
export function isControlVisible(controlId: WeaverControlId, config: WeaverConfig): boolean {
  switch (controlId) {
    // Spool switch strategy controls
    case 'spoolStrategy':
      return config.paletteMode !== 'MONOCHROME';

    case 'switchPenaltyLambda':
      return config.paletteMode !== 'MONOCHROME' && config.spoolStrategy === 'HYSTERESIS_PENALTY';

    case 'minRunLength':
      return (
        config.paletteMode !== 'MONOCHROME' &&
        (config.spoolStrategy === 'MIN_RUN_LENGTH' || config.spoolStrategy === 'HYSTERESIS_PENALTY')
      );

    case 'epochSchedule':
      return config.paletteMode !== 'MONOCHROME' && config.spoolStrategy === 'COARSE_TO_FINE_EPOCHS';

    case 'painterLayersPerColor':
      return (
        config.solver === 'GLOBAL_NNLS_FISTA' ||
        (config.paletteMode !== 'MONOCHROME' && config.spoolStrategy === 'SEPARATED_CHANNELS')
      );

    // Solver-specific controls
    case 'beamWidth':
    case 'beamDepth':
      return config.solver === 'BEAM_SEARCH';

    case 'fistaIterations':
    case 'l1RegularizationLambda':
      return config.solver === 'GLOBAL_NNLS_FISTA';

    // Edge detector blend
    case 'edgeBlendWeight':
      return config.edgeDetector !== 'NONE';

    // Loom shape-specific controls
    case 'diameterMm':
      return config.shape === 'CIRCULAR';

    case 'widthMm':
    case 'heightMm':
      return config.shape === 'RECTANGULAR' || config.shape === 'ELLIPTICAL';

    case 'polygonSides':
      return config.shape === 'REGULAR_POLYGON';

    // Standard controls always visible
    default:
      return true;
  }
}

/** Computes the set of all currently visible controls for the given configuration. */
export function getVisibleControls(config: WeaverConfig): Set<WeaverControlId> {
  const visible = new Set<WeaverControlId>();
  const allControls: WeaverControlId[] = [
    'paletteMode',
    'spoolStrategy',
    'switchPenaltyLambda',
    'minRunLength',
    'epochSchedule',
    'painterLayersPerColor',
    'opticalMixModel',
    'errorMetric',
    'solver',
    'beamWidth',
    'beamDepth',
    'fistaIterations',
    'l1RegularizationLambda',
    'maxLines',
    'maxChordRepeats',
    'threadThicknessMm',
    'claheClipLimit',
    'faceImportanceWeight',
    'featureEmphasisWeight',
    'skinLift',
    'edgeDetector',
    'edgeBlendWeight',
    'morphologyOp',
    'rasterizer',
    'shape',
    'diameterMm',
    'widthMm',
    'heightMm',
    'polygonSides',
    'pinCount',
    'pinDiameterMm',
    'drillBitMm',
    'edgeMarginMm',
    'framingZoom',
    'framingPanX',
    'framingPanY',
    'framingRotation',
    'autoFaceTargetRatio',
  ];

  for (const controlId of allControls) {
    if (isControlVisible(controlId, config)) {
      visible.add(controlId);
    }
  }
  return visible;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/**
 * State store managing active presets, user modifications, and dirty state tracking.
 */
export class ReactivePresetStore {
  private activePresetId: WeaverPresetProfileId;
  private currentConfig: WeaverConfig;
  private readonly dirtyParams = new Set<keyof WeaverConfig>();
  private readonly listeners = new Set<(config: Readonly<WeaverConfig>, isDirty: boolean) => void>();

  constructor(initialPresetId: WeaverPresetProfileId = 'VRELLIS_CLASSIC_MONO') {
    this.activePresetId = initialPresetId;
    this.currentConfig = structuredClone(WEAVER_PRESET_PROFILES[initialPresetId].config);
  }

  public getPresetId(): WeaverPresetProfileId {
    return this.activePresetId;
  }

  public getConfig(): Readonly<WeaverConfig> {
    return this.currentConfig;
  }

  public loadPreset(presetId: WeaverPresetProfileId): Readonly<WeaverConfig> {
    const profile = WEAVER_PRESET_PROFILES[presetId];
    if (!profile) {
      throw new Error(`Unknown preset profile id: ${presetId}`);
    }
    this.activePresetId = presetId;
    this.currentConfig = structuredClone(profile.config);
    this.dirtyParams.clear();
    this.notify();
    return this.currentConfig;
  }

  public setParam<K extends keyof WeaverConfig>(key: K, value: WeaverConfig[K]): void {
    const presetDefault = WEAVER_PRESET_PROFILES[this.activePresetId].config[key];
    this.currentConfig[key] = value;

    if (!valuesEqual(value, presetDefault)) {
      this.dirtyParams.add(key);
    } else {
      this.dirtyParams.delete(key);
    }
    this.notify();
  }

  public updateConfig(patch: Partial<WeaverConfig>): void {
    for (const key of Object.keys(patch) as Array<keyof WeaverConfig>) {
      const val = patch[key];
      if (val !== undefined) {
        this.setParam(key, val as WeaverConfig[typeof key]);
      }
    }
  }

  public isDirty(key?: keyof WeaverConfig): boolean {
    if (key !== undefined) {
      return this.dirtyParams.has(key);
    }
    return this.dirtyParams.size > 0;
  }

  public getDirtyParams(): ReadonlySet<keyof WeaverConfig> {
    return this.dirtyParams;
  }

  public resetParam<K extends keyof WeaverConfig>(key: K): void {
    if (!this.dirtyParams.has(key)) return;
    const presetDefault = WEAVER_PRESET_PROFILES[this.activePresetId].config[key];
    this.setParam(key, structuredClone(presetDefault));
  }

  public resetAllDirty(): void {
    if (this.dirtyParams.size === 0) return;
    this.loadPreset(this.activePresetId);
  }

  public getVisibleControls(): Set<WeaverControlId> {
    return getVisibleControls(this.currentConfig);
  }

  public isControlVisible(controlId: WeaverControlId): boolean {
    return isControlVisible(controlId, this.currentConfig);
  }

  public subscribe(listener: (config: Readonly<WeaverConfig>, isDirty: boolean) => void): () => void {
    this.listeners.add(listener);
    listener(this.currentConfig, this.isDirty());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const isDirty = this.isDirty();
    for (const listener of this.listeners) {
      listener(this.currentConfig, isDirty);
    }
  }
}
