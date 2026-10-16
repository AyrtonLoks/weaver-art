import './style.css';
import {
  calibrateThreadColor,
  createLoom,
  describeLoom,
  estimateWeave,
  formatDuration,
  loomPegCount,
  parsePegsCSV,
  prepareTarget,
  toCSV,
  toInstructions,
  toRGBA,
  toSVG,
  type WeaveStep,
  type ThreadSummary,
} from '@weaver-art/core';
import { WeaverEngineClient, type FromWorker, type ToWorker } from './core-bridge/index.js';
import type {
  ColorPaletteMode,
  LoomConfig,
  WeaveOptions,
  WeaveResult,
  WeaverConfig,
  WeaverPresetProfileId,
} from './domain-contracts/index.js';
import { PRESETS, resolveOptions, ReactivePresetStore, WEAVER_PRESET_PROFILES } from './preset-engine/index.js';
import { WebGLLoomRenderer } from './renderer-webgl/index.js';
import { BlueprintView } from './views/blueprint-view/index.js';
import { PlayerView } from './views/player-view/index.js';
import { StudioViewManager } from './views/studio-view/index.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} não encontrado`);
  return el as T;
};

const MAX_SOURCE_SIDE = 2048;

// ----------------------------------------------------------------- state
let image: ImageData | null = null;
let imageName = 'weave';
let result: WeaveResult | null = null;
let running = false;
let isWasmRunning = false;
let animFrameId: number | null = null;
let solverStartTime = 0;
let customPegsList: { x: number; y: number }[] | null = null;
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

// Preset Store (ADR-005)
const presetStore = new ReactivePresetStore('PORTRAIT_HIGH_SHARPNESS_EPOCHS');

// --------------------------------------------------------------- elements
const fileInput = $<HTMLInputElement>('file');
const drop = $('drop');
const dropLabel = $('drop-label');
const preset = $<HTMLSelectElement>('preset');
const btnResetPresetDefaults = $<HTMLButtonElement>('btnResetPresetDefaults');
const runBtn = $<HTMLButtonElement>('run');
const stopBtn = $<HTMLButtonElement>('stop');
const simCanvas = $<HTMLCanvasElement>('sim');
const targetCanvas = $<HTMLCanvasElement>('target');
const bar = $('bar');
const exportButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-export]')];

const num = (id: string): HTMLInputElement => $<HTMLInputElement>(id);

// Subsystem selectors
const loomShape = $<HTMLSelectElement>('loomShape');
const rasterizerSelect = $<HTMLSelectElement>('rasterizer');
const paletteModeSelect = $<HTMLSelectElement>('paletteMode');
const opticalMixModelSelect = $<HTMLSelectElement>('opticalMixModel');
const errorMetricSelect = $<HTMLSelectElement>('errorMetric');
const solverSelect = $<HTMLSelectElement>('solver');
const colorStrategy = $<HTMLSelectElement>('colorStrategy');
const morphologyOpSelect = $<HTMLSelectElement>('morphologyOp');
const edgeDetectorSelect = $<HTMLSelectElement>('edgeDetector');

// Shape containers
const controlDiameterMm = $('control-diameterMm');
const controlPolygonSides = $('control-polygonSides');
const controlWidthMm = $('control-widthMm');
const controlCustomPegs = $('control-customPegs');
const polygonSidesInput = num('polygonSides');
const polyPegsInput = num('polyPegs');
const rectWidthInput = num('rectWidth');
const rectHeightInput = num('rectHeight');
const rectPegsXInput = num('rectPegsX');
const rectPegsYInput = num('rectPegsY');
const customPegsFile = $<HTMLInputElement>('customPegsFile');
const customPegsSummary = $('customPegsSummary');
const miniLoomCanvas = $<HTMLCanvasElement>('miniLoom');
const miniLoomSummary = $('miniLoomSummary');

// Contextual algorithm control containers
const controlUserCustomPalette = $('control-userCustomPalette');
const controlSpoolStrategy = $('control-spoolStrategy');
const controlBeamWidth = $('control-beamWidth');
const controlFistaIterations = $('control-fistaIterations');
const controlSwitchPenaltyLambda = $('control-switchPenaltyLambda');
const controlMinRunLength = $('control-minRunLength');
const controlEdgeBlendWeight = $('control-edgeBlendWeight');

// Dynamic inputs
const beamWidthInput = num('beamWidth');
const beamDepthInput = num('beamDepth');
const fistaIterationsInput = num('fistaIterations');
const l1RegularizationLambdaInput = num('l1RegularizationLambda');
const switchPenaltyLambdaInput = num('switchPenaltyLambda');
const minRunLengthInput = num('minRunLength');
const edgeBlendWeightInput = num('edgeBlendWeight');
const faceImportanceWeightInput = num('faceImportanceWeight');
const cropRotationInput = num('cropRotation');
const repeatsHint = $('repeats-hint');

// Framing buttons
const btnSmartFrame = $<HTMLButtonElement>('btnSmartFrame');
const btnResetCrop = $<HTMLButtonElement>('btnResetCrop');

// Stats & spool
const sEstTime = $('s-est-time');
const spoolBreakdown = $('spoolBreakdown');
const spoolTableContainer = $('spoolTableContainer');

const fields = {
  pegs: num('pegs'),
  diameter: num('diameter'),
  pegDiameter: num('pegDiameter'),
  threadWidth: num('threadWidth'),
  lines: num('lines'),
  gap: num('gap'),
  repeats: num('repeats'),
  resolution: num('resolution'),
  viewingDistance: num('viewingDistance'),
  contrast: num('contrast'),
  brightness: num('brightness'),
  gamma: num('gamma'),
  shadowLift: num('shadowLift'),
  edgeEmphasis: num('edgeEmphasis'),
  highlightProtection: num('highlightProtection'),
  cropZoom: num('cropZoom'),
  cropPanX: num('cropPanX'),
  cropPanY: num('cropPanY'),
  clahe: $<HTMLInputElement>('clahe'),
  claheClip: num('claheClip'),
  invert: num('invert'),
};

const calibrateFileInput = $<HTMLInputElement>('calibrateFile');
const calibrateOutput = $('calibrateOutput');
const calibrateSwatch = $('calibrateSwatch');
const calibrateText = $('calibrateText');

// ------------------------------------------------------------ Subview Managers
const player = new PlayerView({
  canvas: $<HTMLCanvasElement>('loom'),
  empty: $('knit-empty'),
  live: $('knit-live'),
  step: $('k-step'),
  total: $('k-total'),
  swatch: $('k-swatch'),
  thread: $('k-thread'),
  from: $('k-from'),
  to: $('k-to'),
  side: $('k-side'),
  prev: $<HTMLButtonElement>('k-prev'),
  next: $<HTMLButtonElement>('k-next'),
  voice: $<HTMLInputElement>('k-voice'),
  auto: $<HTMLInputElement>('k-auto'),
  interval: $<HTMLInputElement>('k-interval'),
  goto: $<HTMLInputElement>('k-goto'),
  bar: $('k-bar'),
  remaining: $('k-remaining'),
  code: $<HTMLInputElement>('k-code'),
  copyCodeBtn: $<HTMLButtonElement>('k-copy-code'),
  pasteCodeBtn: $<HTMLButtonElement>('k-paste-code'),
  exportResumeBtn: $<HTMLButtonElement>('k-export-resume'),
  spoolAlert: document.getElementById('k-spool-alert') as HTMLElement | undefined,
  spoolAlertText: document.getElementById('k-spool-alert-text') as HTMLElement | undefined,
  spoolAlertDismissBtn: document.getElementById('k-spool-alert-dismiss') as HTMLButtonElement | undefined,
  qrBtn: document.getElementById('k-btn-qr') as HTMLButtonElement | undefined,
  qrModal: document.getElementById('k-qr-modal') as HTMLElement | undefined,
  qrContainer: document.getElementById('k-qr-container') as HTMLElement | undefined,
  qrCloseBtn: document.getElementById('k-qr-close') as HTMLButtonElement | undefined,
  qrUrlText: document.getElementById('k-qr-url') as HTMLElement | undefined,
});

const studioManager = new StudioViewManager(
  {
    targetCanvas,
    zoomInput: fields.cropZoom,
    panXInput: fields.cropPanX,
    panYInput: fields.cropPanY,
    rotationInput: cropRotationInput,
    btnSmartFrame,
    btnResetCrop,
    btnToggleBrush: document.getElementById('btnToggleBrush') as HTMLButtonElement | undefined,
    btnBrushMode: document.getElementById('btnBrushMode') as HTMLButtonElement | undefined,
    btnClearBrush: document.getElementById('btnClearBrush') as HTMLButtonElement | undefined,
    stageTabs: document.querySelectorAll<HTMLButtonElement>('.stage-pill'),
    targetCaption: document.getElementById('targetCaption') as HTMLElement | undefined,
  },
  () => {
    updateOutputs();
    updateTargetPreview();
  },
);

const loomRenderer = new WebGLLoomRenderer(simCanvas, {
  extentMm: Number(fields.diameter.value) || 600,
  threadThicknessMm: Number(fields.threadWidth.value) || 0.2,
  paletteMode: (paletteModeSelect?.value as ColorPaletteMode) || 'MONOCHROME',
});

const engineClient = new WeaverEngineClient();

const blueprintView = new BlueprintView(
  {
    canvas: $<HTMLCanvasElement>('blueprintCanvas'),
    paperSelect: $<HTMLSelectElement>('bpPaperSize'),
    drillDiameterInput: num('bpDrillDiameter'),
    marginInput: num('bpMargin'),
    overlapInput: num('bpOverlap'),
    toggleGridInput: $<HTMLInputElement>('bpToggleGrid'),
    toggleDimensionsInput: $<HTMLInputElement>('bpToggleDimensions'),
    togglePegNumbersInput: $<HTMLInputElement>('bpTogglePegNumbers'),
    linearPitchEl: $('bpLinearPitch'),
    freeWallEl: $('bpFreeWall'),
    statusBadgeEl: $('bpStatusBadge'),
    pegsTableBody: $('bpPegsTableBody'),
    btnZoomIn: $<HTMLButtonElement>('bpZoomIn'),
    btnZoomOut: $<HTMLButtonElement>('bpZoomOut'),
    btnZoomFit: $<HTMLButtonElement>('bpZoomFit'),
    btnZoomWall: $<HTMLButtonElement>('bpZoomWall'),
    btnExportPdf: $<HTMLButtonElement>('bpBtnExportPdf'),
    btnExportSvg: $<HTMLButtonElement>('bpBtnExportSvg'),
    btnExportCsv: $<HTMLButtonElement>('bpBtnExportCsv'),
    btnExportGcode: $<HTMLButtonElement>('bpBtnExportGcode'),
    cncSpindleRpmInput: document.getElementById('bpCncSpindleRpm') as HTMLInputElement | undefined,
    cncPlungeFeedInput: document.getElementById('bpCncPlungeFeed') as HTMLInputElement | undefined,
    cncDrillDepthInput: document.getElementById('bpCncDrillDepth') as HTMLInputElement | undefined,
    cncPeckDepthInput: document.getElementById('bpCncPeckDepth') as HTMLInputElement | undefined,
    cncSafeZInput: document.getElementById('bpCncSafeZ') as HTMLInputElement | undefined,
    cncRetractRInput: document.getElementById('bpCncRetractR') as HTMLInputElement | undefined,
  },
  getCurrentLoomConfig(),
);

engineClient
  .init()
  .then(() => {
    loomRenderer.setSharedMemory(engineClient.memory);
    blueprintView.setEngineClient(engineClient);
    studioManager.setBrushApplyHandler(async (weights) => {
      return await engineClient.applyImportanceBrush(weights);
    });
    engineClient.onDone(async () => {
      if (isWasmRunning) {
        await finishWasmRun(true);
      }
    });
    engineClient.onPaused(async () => {
      if (isWasmRunning) {
        await finishWasmRun(false);
      }
    });
    engineClient.onError((err) => {
      if (isWasmRunning) {
        if (animFrameId !== null) {
          cancelAnimationFrame(animFrameId);
          animFrameId = null;
        }
        isWasmRunning = false;
        setRunning(false);
      }
      showError(new Error(err));
    });
  })
  .catch((err) => {
    console.warn('Wasm solver engine worker indisponível, operando com fallback padrão:', err);
  });

// ------------------------------------------------------------------- Geometry
function generateEllipticalPegs(widthMm: number, heightMm: number, pegCount: number): { x: number; y: number }[] {
  const rx = widthMm / 2;
  const ry = heightMm / 2;
  const pegs: { x: number; y: number }[] = [];
  for (let i = 0; i < pegCount; i++) {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / pegCount;
    pegs.push({
      x: rx + rx * Math.cos(angle),
      y: ry + ry * Math.sin(angle),
    });
  }
  return pegs;
}

function generateRegularPolygonPegs(diameterMm: number, sides: number, totalPegs: number): { x: number; y: number }[] {
  const r = diameterMm / 2;
  const vertices: { x: number; y: number }[] = [];
  for (let s = 0; s < sides; s++) {
    const angle = -Math.PI / 2 + (2 * Math.PI * s) / sides;
    vertices.push({
      x: r + r * Math.cos(angle),
      y: r + r * Math.sin(angle),
    });
  }
  const pegs: { x: number; y: number }[] = [];
  const pegsPerSide = Math.max(2, Math.floor(totalPegs / sides));
  for (let s = 0; s < sides; s++) {
    const v1 = vertices[s];
    const v2 = vertices[(s + 1) % sides];
    for (let i = 0; i < pegsPerSide; i++) {
      const t = i / pegsPerSide;
      pegs.push({
        x: v1.x + t * (v2.x - v1.x),
        y: v1.y + t * (v2.y - v1.y),
      });
    }
  }
  return pegs;
}

export function getCurrentLoomConfig(): LoomConfig {
  const shape = loomShape.value;
  const pegDiameterMm = Number(fields.pegDiameter.value) || 2;

  if (shape === 'RECTANGULAR') {
    const w = Number(rectWidthInput.value) || 600;
    const h = Number(rectHeightInput.value) || 400;
    const px = Math.max(2, Math.round(Number(rectPegsXInput.value) || 61));
    const py = Math.max(2, Math.round(Number(rectPegsYInput.value) || 41));
    return {
      shape: 'rectangle',
      widthMm: w,
      heightMm: h,
      pegsX: px,
      pegsY: py,
      pegDiameterMm,
    };
  }

  if (shape === 'ELLIPTICAL') {
    const w = Number(rectWidthInput.value) || 600;
    const h = Number(rectHeightInput.value) || 450;
    const count = Math.max(20, Math.round(Number(fields.pegs.value) || 200));
    return {
      shape: 'custom',
      pegs: generateEllipticalPegs(w, h, count),
      pegDiameterMm,
    };
  }

  if (shape === 'REGULAR_POLYGON') {
    const d = Number(fields.diameter.value) || 600;
    const sides = Math.max(3, Math.min(16, Math.round(Number(polygonSidesInput.value) || 6)));
    const total = Math.max(12, Math.round(Number(polyPegsInput.value) || 240));
    return {
      shape: 'custom',
      pegs: generateRegularPolygonPegs(d, sides, total),
      pegDiameterMm,
    };
  }

  if (shape === 'custom') {
    if (!customPegsList || customPegsList.length < 3) {
      return {
        shape: 'circle',
        diameterMm: Number(fields.diameter.value) || 600,
        pegCount: Math.max(3, Math.round(Number(fields.pegs.value) || 200)),
        pegDiameterMm,
        startAngleDeg: -90,
      };
    }
    return {
      shape: 'custom',
      pegs: customPegsList,
      pegDiameterMm,
    };
  }

  // Padrão: Círculo
  return {
    shape: 'circle',
    diameterMm: Number(fields.diameter.value) || 600,
    pegCount: Math.max(3, Math.round(Number(fields.pegs.value) || 200)),
    pegDiameterMm,
    startAngleDeg: -90,
  };
}

function updateLoomPreview(): void {
  try {
    const cfg = getCurrentLoomConfig();
    const loom = createLoom(cfg);
    loomRenderer.setLoom(loom);
    miniLoomSummary.textContent = describeLoom(cfg);

    const ctx = miniLoomCanvas.getContext('2d');
    if (!ctx) return;
    const W = miniLoomCanvas.width;
    const margin = 5;
    const extent = loom.extentMm;
    const k = (W - 2 * margin) / extent;
    const X = (mm: number): number => margin + mm * k;

    ctx.clearRect(0, 0, W, W);

    // Borda do tear
    ctx.fillStyle = '#1e1e1e';
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;

    if (loom.config.shape === 'circle') {
      const cx = loom.extentMm / 2;
      const cy = loom.extentMm / 2;
      ctx.beginPath();
      ctx.arc(X(cx), X(cy), loom.radiusMm * k, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else if (loom.outline && loom.outline.length > 2) {
      ctx.beginPath();
      loom.outline.forEach((pt, i) => {
        if (i === 0) ctx.moveTo(X(pt.x), X(pt.y));
        else ctx.lineTo(X(pt.x), X(pt.y));
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // Pinos
    ctx.fillStyle = '#ff5a36';
    for (const p of loom.pegs) {
      ctx.fillRect(X(p.x) - 0.75, X(p.y) - 0.75, 1.5, 1.5);
    }

    // Atualiza também a visualização CAM
    blueprintView.setLoomConfig(cfg, Number(fields.pegDiameter.value));
  } catch {
    miniLoomSummary.textContent = 'Configuração incompleta.';
  }
}

// ------------------------------------------------------------- Preset Store Reactivity
function syncUIWithConfig(cfg: Readonly<WeaverConfig>, isDirty: boolean): void {
  // Sync shape
  loomShape.value = cfg.shape;
  document.body.dataset.loomShape = cfg.shape;

  controlDiameterMm.hidden = cfg.shape !== 'CIRCULAR';
  controlPolygonSides.hidden = cfg.shape !== 'REGULAR_POLYGON';
  controlWidthMm.hidden = cfg.shape !== 'RECTANGULAR' && cfg.shape !== 'ELLIPTICAL';
  controlCustomPegs.hidden = loomShape.value !== 'custom';

  fields.pegs.value = String(cfg.pinCount);
  fields.diameter.value = cfg.diameterMm.toFixed(1);
  fields.pegDiameter.value = String(cfg.pinDiameterMm);
  fields.threadWidth.value = String(cfg.threadThicknessMm);

  // Sync mode & models
  rasterizerSelect.value = cfg.rasterizer;
  paletteModeSelect.value = cfg.paletteMode;
  controlUserCustomPalette.hidden = cfg.paletteMode !== 'USER_CUSTOM';
  opticalMixModelSelect.value = cfg.opticalMixModel;
  errorMetricSelect.value = cfg.errorMetric;

  // Sync solver & spool
  solverSelect.value = cfg.solver;
  colorStrategy.value = cfg.spoolStrategy;
  fields.lines.value = String(cfg.maxLines);
  fields.repeats.value = String(cfg.maxChordRepeats);

  // Sync algorithm contextual visibility
  controlSpoolStrategy.hidden = cfg.paletteMode === 'MONOCHROME';
  controlBeamWidth.hidden = cfg.solver !== 'BEAM_SEARCH';
  controlFistaIterations.hidden = cfg.solver !== 'GLOBAL_NNLS_FISTA';
  controlSwitchPenaltyLambda.hidden = cfg.paletteMode === 'MONOCHROME' || cfg.spoolStrategy !== 'HYSTERESIS_PENALTY';
  controlMinRunLength.hidden =
    cfg.paletteMode === 'MONOCHROME' ||
    (cfg.spoolStrategy !== 'MIN_RUN_LENGTH' && cfg.spoolStrategy !== 'HYSTERESIS_PENALTY');

  beamWidthInput.value = String(cfg.beamWidth);
  beamDepthInput.value = String(cfg.beamDepth);
  fistaIterationsInput.value = String(cfg.fistaIterations);
  l1RegularizationLambdaInput.value = String(cfg.l1RegularizationLambda);
  switchPenaltyLambdaInput.value = String(cfg.switchPenaltyLambda);
  minRunLengthInput.value = String(cfg.minRunLength);

  // Sync DSP
  fields.claheClip.value = String(cfg.claheClipLimit);
  faceImportanceWeightInput.value = String(cfg.faceImportanceWeight);
  edgeDetectorSelect.value = cfg.edgeDetector;
  controlEdgeBlendWeight.hidden = cfg.edgeDetector === 'NONE';
  edgeBlendWeightInput.value = String(cfg.edgeBlendWeight);
  morphologyOpSelect.value = cfg.morphologyOp;

  // Sync Framing
  fields.cropZoom.value = cfg.framing.zoom.toFixed(2);
  fields.cropPanX.value = String(cfg.framing.panXPercent);
  fields.cropPanY.value = String(cfg.framing.panYPercent);
  cropRotationInput.value = String(cfg.framing.rotationDeg);

  // Dirty state reset button
  btnResetPresetDefaults.hidden = !isDirty;

  updateOutputs();
  checkRepeatsHint();
  updateLoomPreview();
}

presetStore.subscribe((cfg, isDirty) => {
  syncUIWithConfig(cfg, isDirty);
});

// Preset Select Event
preset.addEventListener('change', () => {
  const selected = preset.value;
  if (selected in WEAVER_PRESET_PROFILES) {
    presetStore.loadPreset(selected as WeaverPresetProfileId);
  } else if (selected === 'portrait-mono') {
    presetStore.loadPreset('PORTRAIT_HIGH_SHARPNESS_EPOCHS');
    presetStore.setParam('paletteMode', 'MONOCHROME');
  } else if (selected === 'portrait-cmyk' || selected === 'cmyk') {
    presetStore.loadPreset('PORTRAIT_HIGH_SHARPNESS_EPOCHS');
    presetStore.setParam('paletteMode', 'CMYK_SUBTRACTIVE');
  } else if (selected === 'vrellis-mono') {
    presetStore.loadPreset('VRELLIS_CLASSIC_MONO');
  } else if (selected === 'vrellis-color') {
    presetStore.loadPreset('PORTRAIT_HIGH_SHARPNESS_EPOCHS');
  }
  updateTargetPreview();
});

btnResetPresetDefaults.addEventListener('click', () => {
  presetStore.resetAllDirty();
  updateTargetPreview();
});

// Shape selection
loomShape.addEventListener('change', () => {
  const s = loomShape.value;
  document.body.dataset.loomShape = s;
  controlDiameterMm.hidden = s !== 'CIRCULAR';
  controlPolygonSides.hidden = s !== 'REGULAR_POLYGON';
  controlWidthMm.hidden = s !== 'RECTANGULAR' && s !== 'ELLIPTICAL';
  controlCustomPegs.hidden = s !== 'custom';
  if (s === 'CIRCULAR' || s === 'REGULAR_POLYGON' || s === 'RECTANGULAR' || s === 'ELLIPTICAL') {
    presetStore.setParam('shape', s);
  }
  updateLoomPreview();
});

paletteModeSelect.addEventListener('change', () => {
  const mode = paletteModeSelect.value as WeaverConfig['paletteMode'];
  presetStore.setParam('paletteMode', mode);
  loomRenderer.setPalette(mode);
  controlUserCustomPalette.hidden = mode !== 'USER_CUSTOM';
  controlSpoolStrategy.hidden = mode === 'MONOCHROME';
  updateTargetPreview();
});

solverSelect.addEventListener('change', () => {
  const s = solverSelect.value as WeaverConfig['solver'];
  presetStore.setParam('solver', s);
  controlBeamWidth.hidden = s !== 'BEAM_SEARCH';
  controlFistaIterations.hidden = s !== 'GLOBAL_NNLS_FISTA';
});

colorStrategy.addEventListener('change', () => {
  const strat = colorStrategy.value as WeaverConfig['spoolStrategy'];
  presetStore.setParam('spoolStrategy', strat);
  controlSwitchPenaltyLambda.hidden = strat !== 'HYSTERESIS_PENALTY';
  controlMinRunLength.hidden = strat !== 'MIN_RUN_LENGTH' && strat !== 'HYSTERESIS_PENALTY';
});

edgeDetectorSelect.addEventListener('change', () => {
  const ed = edgeDetectorSelect.value as WeaverConfig['edgeDetector'];
  presetStore.setParam('edgeDetector', ed);
  controlEdgeBlendWeight.hidden = ed === 'NONE';
  updateTargetPreview();
});

morphologyOpSelect.addEventListener('change', () => {
  const mop = morphologyOpSelect.value as WeaverConfig['morphologyOp'];
  presetStore.setParam('morphologyOp', mop);
  updateTargetPreview();
});

rasterizerSelect.addEventListener('change', () => {
  presetStore.setParam('rasterizer', rasterizerSelect.value as WeaverConfig['rasterizer']);
});

opticalMixModelSelect.addEventListener('change', () => {
  presetStore.setParam('opticalMixModel', opticalMixModelSelect.value as WeaverConfig['opticalMixModel']);
});

errorMetricSelect.addEventListener('change', () => {
  presetStore.setParam('errorMetric', errorMetricSelect.value as WeaverConfig['errorMetric']);
});

// Shape dimension listeners
for (const el of [
  fields.pegs,
  fields.diameter,
  fields.pegDiameter,
  fields.threadWidth,
  rectWidthInput,
  rectHeightInput,
  rectPegsXInput,
  rectPegsYInput,
  polygonSidesInput,
  polyPegsInput,
]) {
  el.addEventListener('input', () => {
    loomRenderer.setThreadThickness(Number(fields.threadWidth.value) || 0.2);
    updateLoomPreview();
    updateTargetPreview();
  });
}

// Algorithm slider dirty trackers
beamWidthInput.addEventListener('input', () => presetStore.setParam('beamWidth', Number(beamWidthInput.value)));
beamDepthInput.addEventListener('input', () => presetStore.setParam('beamDepth', Number(beamDepthInput.value)));
fistaIterationsInput.addEventListener('input', () =>
  presetStore.setParam('fistaIterations', Number(fistaIterationsInput.value)),
);
l1RegularizationLambdaInput.addEventListener('input', () =>
  presetStore.setParam('l1RegularizationLambda', Number(l1RegularizationLambdaInput.value)),
);
switchPenaltyLambdaInput.addEventListener('input', () => {
  presetStore.setParam('switchPenaltyLambda', Number(switchPenaltyLambdaInput.value));
  $('switchPenaltyLambda-out').textContent = Number(switchPenaltyLambdaInput.value).toFixed(2);
});
minRunLengthInput.addEventListener('input', () =>
  presetStore.setParam('minRunLength', Number(minRunLengthInput.value)),
);
edgeBlendWeightInput.addEventListener('input', () => {
  presetStore.setParam('edgeBlendWeight', Number(edgeBlendWeightInput.value));
  $('edgeBlendWeight-out').textContent = Number(edgeBlendWeightInput.value).toFixed(2);
  updateTargetPreview();
});
faceImportanceWeightInput.addEventListener('input', () => {
  presetStore.setParam('faceImportanceWeight', Number(faceImportanceWeightInput.value));
  $('faceImportanceWeight-out').textContent = Number(faceImportanceWeightInput.value).toFixed(1);
  updateTargetPreview();
});

customPegsFile.addEventListener('change', async () => {
  const f = customPegsFile.files?.[0];
  if (!f) return;
  try {
    const text = await f.text();
    const parsed = parsePegsCSV(text);
    if (parsed.length < 3) throw new Error('O CSV deve conter ao menos 3 pinos.');
    customPegsList = parsed;
    customPegsSummary.textContent = `✔ ${parsed.length} pinos carregados (${f.name})`;
    customPegsSummary.style.color = 'var(--accent-2)';
    updateLoomPreview();
  } catch (err) {
    showError(err);
  }
});

function checkRepeatsHint(): void {
  const lines = Number(fields.lines.value);
  const repeats = Number(fields.repeats.value);
  repeatsHint.hidden = !(lines > 5000 && repeats === 1);
}

function updateOutputs(): void {
  for (const id of [
    'contrast',
    'brightness',
    'gamma',
    'shadowLift',
    'edgeEmphasis',
    'highlightProtection',
    'viewingDistance',
    'claheClip',
  ] as const) {
    const el = document.getElementById(`${id}-out`);
    if (el) el.textContent = Number(fields[id].value).toFixed(2);
  }

  const zoomEl = document.getElementById('cropZoom-out');
  if (zoomEl) zoomEl.textContent = `${Number(fields.cropZoom.value).toFixed(2)}x`;

  const panXEl = document.getElementById('cropPanX-out');
  if (panXEl) panXEl.textContent = `${Math.round(Number(fields.cropPanX.value))}%`;

  const panYEl = document.getElementById('cropPanY-out');
  if (panYEl) panYEl.textContent = `${Math.round(Number(fields.cropPanY.value))}%`;

  const rotEl = document.getElementById('cropRotation-out');
  if (rotEl) rotEl.textContent = `${Math.round(Number(cropRotationInput.value))}°`;
}

function computeActiveCrop(): { x: number; y: number; size: number } | undefined {
  if (!image) return undefined;
  const zoom = Math.max(0.5, Number(fields.cropZoom.value) || 1.0);
  const panXFrac = (Number(fields.cropPanX.value) || 0) / 100;
  const panYFrac = (Number(fields.cropPanY.value) || 0) / 100;

  const baseSize = Math.min(image.width, image.height);
  const cropSize = Math.max(16, baseSize / zoom);

  const cx = image.width / 2 + panXFrac * baseSize;
  const cy = image.height / 2 + panYFrac * baseSize;

  let cropX = cx - cropSize / 2;
  let cropY = cy - cropSize / 2;

  cropX = Math.max(0, Math.min(image.width - cropSize, cropX));
  cropY = Math.max(0, Math.min(image.height - cropSize, cropY));

  return { x: cropX, y: cropY, size: cropSize };
}

function updateTargetPreview(): void {
  if (!image) return;
  try {
    const opts = readOptions();
    const previewSize = 256;
    const tgt = prepareTarget(
      { width: image.width, height: image.height, data: image.data },
      previewSize,
      opts.preprocess,
      opts.preprocess.grayscale ? 1 : 3,
      undefined,
      createLoom(getCurrentLoomConfig()),
    );
    const rgba = toRGBA(tgt.data, tgt.channels, tgt.mask);
    studioManager.updateTargetData(rgba.buffer as ArrayBuffer, previewSize, previewSize);

    if (engineClient.isReady()) {
      const cfg = presetStore.getConfig();
      engineClient
        .loadAndPrepareImage(image.data.slice().buffer, image.width, image.height, cfg)
        .then((res) => {
          studioManager.setDiagnosticBuffers(res);
        })
        .catch((err) => {
          console.warn('Wasm DSP preview indisponível:', err);
        });
    }
  } catch {
    // Non-fatal
  }
}

function readOptions(): WeaveOptions {
  const base = PRESETS['portrait-mono'];
  const loom = getCurrentLoomConfig();
  const totalPegs = loomPegCount(loom);
  const width = Number(fields.threadWidth.value);

  return resolveOptions(
    {
      loom,
      threads: base.threads.map((t, i) => ({
        ...t,
        widthMm: width,
        startPeg: Math.floor((i * totalPegs) / base.threads.length),
      })),
      threadLineBudgets: base.threadLineBudgets,
      maxLines: Number(fields.lines.value),
      minPegGap: Number(fields.gap.value),
      maxChordRepeats: Number(fields.repeats.value),
      resolutionPx: Number(fields.resolution.value),
      colorStrategy: 'layered',
      viewingDistanceM: Number(fields.viewingDistance.value),
      highlightProtection: Number(fields.highlightProtection.value),
      preprocess: {
        contrast: Number(fields.contrast.value),
        brightness: Number(fields.brightness.value),
        gamma: Number(fields.gamma.value),
        shadowLift: Number(fields.shadowLift.value),
        edgeEmphasis: Number(fields.edgeEmphasis.value),
        highlightProtection: Number(fields.highlightProtection.value),
        sharpenSigma: base.preprocess.sharpenSigma,
        torsoFeathering: base.preprocess.torsoFeathering,
        crop: computeActiveCrop(),
        clahe: fields.clahe.checked,
        claheClipLimit: Number(fields.claheClip.value),
        viewingDistanceM: Number(fields.viewingDistance.value),
        invert: fields.invert.checked,
      },
    },
    base,
  );
}

// Framing slider inputs
for (const id of [
  'contrast',
  'brightness',
  'gamma',
  'shadowLift',
  'edgeEmphasis',
  'highlightProtection',
  'cropZoom',
  'cropPanX',
  'cropPanY',
  'viewingDistance',
  'claheClip',
] as const) {
  fields[id].addEventListener('input', () => {
    updateOutputs();
    updateTargetPreview();
  });
}
cropRotationInput.addEventListener('input', () => {
  updateOutputs();
  updateTargetPreview();
});

fields.clahe.addEventListener('change', () => {
  $('clahe-controls').hidden = !fields.clahe.checked;
  updateTargetPreview();
});
fields.invert.addEventListener('change', () => updateTargetPreview());
fields.lines.addEventListener('input', checkRepeatsHint);
fields.repeats.addEventListener('input', checkRepeatsHint);

calibrateFileInput.addEventListener('change', async () => {
  const f = calibrateFileInput.files?.[0];
  if (!f) return;
  try {
    const bitmap = await createImageBitmap(f);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(bitmap, 0, 0);
    const idata = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const cal = calibrateThreadColor({ width: idata.width, height: idata.height, data: idata.data });
    calibrateSwatch.style.backgroundColor = cal.hex;
    calibrateText.textContent = `Calibrado: ${cal.hex} (clique para copiar)`;
    calibrateOutput.style.cursor = 'pointer';
    calibrateOutput.hidden = false;
    calibrateOutput.onclick = () => {
      navigator.clipboard?.writeText(cal.hex);
      calibrateText.textContent = `Copiado: ${cal.hex}!`;
      setTimeout(() => {
        calibrateText.textContent = `Calibrado: ${cal.hex} (clique para copiar)`;
      }, 2000);
    };
  } catch (err) {
    showError(err);
  }
});

// ------------------------------------------------------------------ Image Upload
async function loadFile(file: File): Promise<void> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SOURCE_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D indisponível');
  ctx.drawImage(bitmap, 0, 0, w, h);
  image = ctx.getImageData(0, 0, w, h);
  imageName = file.name.replace(/\.[^.]+$/, '') || 'weave';
  dropLabel.innerHTML = `<strong>${escapeHtml(file.name)}</strong><br /><small>${bitmap.width}×${bitmap.height}px · clique para trocar</small>`;
  drop.style.backgroundImage = `url(${URL.createObjectURL(file)})`;
  drop.classList.add('has-image');
  runBtn.disabled = running;
  updateTargetPreview();
}

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) loadFile(f).catch(showError);
});
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer?.files[0];
  if (f) loadFile(f).catch(showError);
});

// ------------------------------------------------------------------- Solver Execution
function paint(canvas: HTMLCanvasElement, size: number, rgba: ArrayBuffer): void {
  if (canvas === simCanvas && loomRenderer.isWebGL2Supported()) {
    loomRenderer.renderScreenPass();
    return;
  }
  if (canvas.width !== size) {
    canvas.width = size;
    canvas.height = size;
  }
  const ctx = canvas.getContext('2d');
  ctx?.putImageData(new ImageData(new Uint8ClampedArray(rgba), size, size), 0, 0);
}

function setStats(
  lines: number,
  lengthMm: number,
  rmse: number | null,
  ms: number,
  currentThread?: string,
  currentLayer?: number,
  deltaE?: number | null,
  ssim?: number | null,
  switches?: number | null,
  manualEstTime?: string | null,
): void {
  const isLayered = colorStrategy.value === 'COARSE_TO_FINE_EPOCHS' || colorStrategy.value === 'layered';
  const threadInfo = currentThread
    ? isLayered
      ? ` · Camada ${currentLayer ?? 1}: ${currentThread}`
      : ` · Fio: ${currentThread}`
    : '';
  $('s-lines').textContent = `${lines.toLocaleString('pt-BR')}${threadInfo}`;
  $('s-length').textContent = `${(lengthMm / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} m`;
  const switchesEl = document.getElementById('s-switches');
  if (switchesEl) {
    switchesEl.textContent = switches !== undefined && switches !== null ? switches.toLocaleString('pt-BR') : '0';
  }
  $('s-rmse').textContent = rmse === null ? '…' : rmse.toFixed(4);
  $('s-deltaE').textContent = deltaE !== undefined && deltaE !== null ? deltaE.toFixed(2) : '…';
  $('s-ssim').textContent = ssim !== undefined && ssim !== null ? ssim.toFixed(3) : '…';
  $('s-time').textContent = `${(ms / 1000).toFixed(1)} s`;
  if (manualEstTime) {
    sEstTime.textContent = manualEstTime;
  }
}

interface SpoolBomItemData {
  spool_id: number;
  name: string;
  color_hex: string;
  line_count: number;
  raw_length_meters: number;
  length_with_margin_meters: number;
  spools_needed: number;
  spool_usage_percent: number;
}

interface BomDataPayload {
  safety_margin_ratio: number;
  standard_spool_length_meters: number;
  weaving_time_seconds: number;
  knot_and_switch_time_seconds: number;
  total_time_seconds: number;
  formatted_total_time: string;
  tie_ons: number;
  total_switches: number;
  spools: SpoolBomItemData[];
}

function renderSpoolTableFromBom(bom: BomDataPayload): void {
  sEstTime.textContent = bom.formatted_total_time;

  let html = `
    <table class="spool-table" style="width: 100%; border-collapse: collapse; font-size: 0.82rem">
      <thead>
        <tr style="border-bottom: 1px solid var(--line); color: var(--muted)">
          <th style="padding: 6px 8px; text-align: left">Cor</th>
          <th style="padding: 6px 8px; text-align: right">Linhas</th>
          <th style="padding: 6px 8px; text-align: right">Fio</th>
          <th style="padding: 6px 8px; text-align: right">Com margem</th>
          <th style="padding: 6px 8px; text-align: right">Carretéis</th>
          <th style="padding: 6px 8px; text-align: right">Uso</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const s of bom.spools) {
    const lenM = s.raw_length_meters.toFixed(1) + ' m';
    const reqM = s.length_with_margin_meters.toFixed(1) + ' m';
    html += `
      <tr style="border-bottom: 1px solid #232321">
        <td style="padding: 6px 8px; display: flex; align-items: center; gap: 0.5rem">
          <span style="display: inline-block; width: 12px; height: 12px; border-radius: 2px; background: ${s.color_hex}; border: 1px solid #fff"></span>
          <span>${escapeHtml(s.name)}</span>
        </td>
        <td style="padding: 6px 8px; text-align: right">${s.line_count.toLocaleString('pt-BR')}</td>
        <td style="padding: 6px 8px; text-align: right">${lenM}</td>
        <td style="padding: 6px 8px; text-align: right">${reqM}</td>
        <td style="padding: 6px 8px; text-align: right"><strong>${s.spools_needed}</strong></td>
        <td style="padding: 6px 8px; text-align: right">${s.spool_usage_percent.toFixed(1)}%</td>
      </tr>
    `;
  }

  html += `
      </tbody>
    </table>
    <p style="margin: 0.5rem 0 0; font-size: 0.78rem; color: var(--muted)">
      Tempo tecendo: ${formatDuration(bom.weaving_time_seconds)} · Nós e trocas: ${formatDuration(bom.knot_and_switch_time_seconds)} (${bom.tie_ons} nós, ${bom.total_switches} trocas)
    </p>
  `;

  spoolTableContainer.innerHTML = html;
  spoolBreakdown.hidden = false;
}

function renderSpoolTable(res: WeaveResult): void {
  const est = estimateWeave(res);
  sEstTime.textContent = formatDuration(est.totalSeconds);

  let html = `
    <table class="spool-table" style="width: 100%; border-collapse: collapse; font-size: 0.82rem">
      <thead>
        <tr style="border-bottom: 1px solid var(--line); color: var(--muted)">
          <th style="padding: 6px 8px; text-align: left">Cor</th>
          <th style="padding: 6px 8px; text-align: right">Linhas</th>
          <th style="padding: 6px 8px; text-align: right">Fio</th>
          <th style="padding: 6px 8px; text-align: right">Com margem</th>
          <th style="padding: 6px 8px; text-align: right">Carretéis</th>
          <th style="padding: 6px 8px; text-align: right">Uso</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const t of est.threads) {
    const lenM = (t.lengthMm / 1000).toFixed(1) + ' m';
    const reqM = (t.requiredMm / 1000).toFixed(1) + ' m';
    html += `
      <tr style="border-bottom: 1px solid #232321">
        <td style="padding: 6px 8px; display: flex; align-items: center; gap: 0.5rem">
          <span style="display: inline-block; width: 12px; height: 12px; border-radius: 2px; background: ${t.color}; border: 1px solid #fff"></span>
          <span>${escapeHtml(t.name)}</span>
        </td>
        <td style="padding: 6px 8px; text-align: right">${t.lines.toLocaleString('pt-BR')}</td>
        <td style="padding: 6px 8px; text-align: right">${lenM}</td>
        <td style="padding: 6px 8px; text-align: right">${reqM}</td>
        <td style="padding: 6px 8px; text-align: right"><strong>${t.spools}</strong></td>
        <td style="padding: 6px 8px; text-align: right">${t.spoolUsagePct.toFixed(1)}%</td>
      </tr>
    `;
  }

  html += `
      </tbody>
    </table>
    <p style="margin: 0.5rem 0 0; font-size: 0.78rem; color: var(--muted)">
      Tempo tecendo: ${formatDuration(est.weavingSeconds)} · Nós e trocas: ${formatDuration(est.overheadSeconds)} (${est.tieOns} nós, ${est.switches} trocas)
    </p>
  `;

  spoolTableContainer.innerHTML = html;
  spoolBreakdown.hidden = false;
}

function setRunning(on: boolean): void {
  running = on;
  runBtn.disabled = on || !image;
  stopBtn.disabled = !on;
  document.body.classList.toggle('running', on);
}

function start60HzTelemetryLoop(): void {
  function tick(): void {
    if (!running) return;

    loomRenderer.renderFrame();

    const mem = engineClient.memory;
    const currentStep = mem.getCurrentStepIndex();
    const totalMeters = mem.getTotalThreadMeters();
    const switches = mem.getTotalSpoolSwitches();
    const rmse = mem.getCurrentRMSE();
    const deltaE = mem.getCurrentDeltaE();
    const ssim = mem.getCurrentSSIM();
    const status = mem.getStatus();

    const elapsedMs = performance.now() - solverStartTime;
    const manualSec = currentStep * 4.5 + (switches + 1) * 90.0;
    const estManual = currentStep > 0 ? formatDuration(manualSec) : '—';

    setStats(
      currentStep,
      totalMeters * 1000,
      rmse > 0 ? rmse : null,
      elapsedMs,
      undefined,
      undefined,
      deltaE > 0 ? deltaE : null,
      ssim > 0 ? ssim : null,
      switches,
      estManual,
    );
    bar.style.width = `${Math.min(100, (currentStep / currentMaxLines) * 100)}%`;

    if (status === 1 /* RUNNING */) {
      animFrameId = requestAnimationFrame(tick);
    }
  }
  animFrameId = requestAnimationFrame(tick);
}

async function finishWasmRun(isCompleted: boolean): Promise<void> {
  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  isWasmRunning = false;
  setRunning(false);
  loomRenderer.renderFrame();

  const mem = engineClient.memory;
  const currentStep = mem.getCurrentStepIndex();
  const totalMeters = mem.getTotalThreadMeters();
  const switches = mem.getTotalSpoolSwitches();
  const rmse = mem.getCurrentRMSE();
  const deltaE = mem.getCurrentDeltaE();
  const ssim = mem.getCurrentSSIM();
  const durationMs = performance.now() - solverStartTime;

  let bomLoaded = false;
  try {
    const bomJsonStr = await engineClient.exportCam('bom_json');
    if (typeof bomJsonStr === 'string' && bomJsonStr.includes('bom')) {
      const parsed = JSON.parse(bomJsonStr) as { bom?: BomDataPayload };
      if (parsed.bom) {
        renderSpoolTableFromBom(parsed.bom);
        bomLoaded = true;
      }
    }
  } catch (err) {
    console.warn('Falha ao obter BOM do weaver-cam:', err);
  }

  const rawSteps = mem.readSteps(0, currentStep);
  const options = readOptions();

  const weaveSteps: WeaveStep[] = rawSteps.map((st, i) => ({
    index: i,
    thread: st.spoolId,
    from: st.fromPin,
    to: st.toPin,
    fromSide: (st.departureWinding === 'CCW' ? 1 : -1) as 1 | -1,
    toSide: (st.arrivalWinding === 'CCW' ? 1 : -1) as 1 | -1,
    gain: st.scoreNormalized,
    segmentMm: 500,
    wrapMm: 3.14,
  }));

  const threadMap = new Map<number, { pegs: number[]; lengthMm: number; lines: number }>();
  for (const st of rawSteps) {
    let t = threadMap.get(st.spoolId);
    if (!t) {
      t = { pegs: [st.fromPin], lengthMm: 0, lines: 0 };
      threadMap.set(st.spoolId, t);
    }
    t.pegs.push(st.toPin);
    t.lines++;
  }

  const threadSummaries: ThreadSummary[] = options.threads.map((cfgThread, i) => {
    const tracked = threadMap.get(i);
    const spoolMeters = mem.getSpoolThreadMeters(i);
    return {
      id: cfgThread.id,
      name: cfgThread.name,
      color: cfgThread.color,
      pegs: tracked ? tracked.pegs : [cfgThread.startPeg],
      lengthMm: spoolMeters > 0 ? spoolMeters * 1000 : (tracked?.lines ?? 0) * 500,
      lines: tracked ? tracked.lines : 0,
    };
  });

  result = {
    version: 1,
    options,
    steps: weaveSteps,
    threads: threadSummaries,
    totalLengthMm: totalMeters * 1000,
    rmse,
    metrics: {
      rmse,
      deltaELab: deltaE,
      ssim,
    },
    stopReason: isCompleted ? 'max-lines' : 'aborted',
    durationMs,
  };

  if (!bomLoaded) {
    renderSpoolTable(result);
  }

  setStats(
    currentStep,
    totalMeters * 1000,
    rmse > 0 ? rmse : null,
    durationMs,
    undefined,
    undefined,
    deltaE > 0 ? deltaE : null,
    ssim > 0 ? ssim : null,
    switches,
    sEstTime.textContent,
  );

  bar.style.width = isCompleted ? '100%' : `${Math.min(100, (currentStep / currentMaxLines) * 100)}%`;
  exportButtons.forEach((b) => (b.disabled = false));
  player.load(result);
}

function runJsFallback(options: WeaveOptions): void {
  if (!image) return;
  const data = image.data.slice().buffer;
  const msg: ToWorker = {
    type: 'start',
    image: { width: image.width, height: image.height, data },
    options,
  };
  worker.postMessage(msg, [data]);
}

let currentMaxLines = 1;
runBtn.addEventListener('click', async () => {
  if (!image) return;
  let options: WeaveOptions;
  try {
    options = readOptions();
  } catch (err) {
    showError(err);
    return;
  }
  currentMaxLines = options.maxLines;
  result = null;
  loomRenderer.reset();
  loomRenderer.setLoom(options.loom);
  loomRenderer.setPalette(paletteModeSelect.value as ColorPaletteMode);
  exportButtons.forEach((b) => (b.disabled = true));
  spoolBreakdown.hidden = true;
  sEstTime.textContent = '…';
  setRunning(true);
  solverStartTime = performance.now();

  if (engineClient.isReady()) {
    try {
      isWasmRunning = true;
      const cfg = presetStore.getConfig();
      const configWithLines: WeaverConfig = {
        ...cfg,
        maxLines: options.maxLines,
        maxChordRepeats: options.maxChordRepeats,
      };
      await engineClient.loadAndPrepareImage(image.data.slice().buffer, image.width, image.height, configWithLines);
      await engineClient.initSolver(configWithLines);
      engineClient.startSolver(50);
      start60HzTelemetryLoop();
    } catch (err) {
      console.warn('Erro ao executar solver Wasm, utilizando fallback JS:', err);
      isWasmRunning = false;
      runJsFallback(options);
    }
  } else {
    isWasmRunning = false;
    runJsFallback(options);
  }
});

stopBtn.addEventListener('click', () => {
  if (isWasmRunning && engineClient.isReady()) {
    engineClient.pauseSolver();
  } else {
    worker.postMessage({ type: 'stop' } satisfies ToWorker);
  }
});

worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'target':
      studioManager.updateTargetData(msg.rgba, msg.size, msg.size);
      break;
    case 'progress':
      paint(simCanvas, msg.size, msg.rgba);
      studioManager.setCachedSimulation(msg.rgba);
      bar.style.width = `${(msg.lines / currentMaxLines) * 100}%`;
      setStats(msg.lines, msg.lengthMm, null, msg.elapsedMs, msg.currentThread, msg.currentLayer, null, null, 0);
      break;
    case 'done': {
      result = msg.result;
      if (!result) break;
      if (loomRenderer.isWebGL2Supported() && result.steps) {
        loomRenderer.reset();
        loomRenderer.renderSteps(
          result.steps.map((st) => ({
            fromPin: st.from,
            toPin: st.to,
            spoolId: st.thread ?? 0,
            departureWinding: st.fromSide === 1 ? 'CCW' : 'CW',
            arrivalWinding: st.toSide === 1 ? 'CCW' : 'CW',
            scoreNormalized: 1.0,
          })),
        );
      } else {
        paint(simCanvas, msg.size, msg.rgba);
      }
      studioManager.setCachedSimulation(msg.rgba);
      bar.style.width = '100%';
      const activeResult = result;
      const switches = activeResult.steps.filter((st, i) => i > 0 && st.thread !== activeResult.steps[i - 1].thread).length;
      setStats(
        activeResult.steps.length,
        activeResult.totalLengthMm,
        activeResult.rmse,
        activeResult.durationMs,
        undefined,
        undefined,
        activeResult.metrics?.deltaELab,
        activeResult.metrics?.ssim,
        switches,
      );
      renderSpoolTable(activeResult);
      exportButtons.forEach((b) => (b.disabled = false));
      setRunning(false);
      player.load(activeResult);
      break;
    }
    case 'error':
      setRunning(false);
      showError(new Error(msg.message));
      break;
  }
};

// ---------------------------------------------------------------- Export Utilities
function download(name: string, data: BlobPart | Uint8Array, type: string): void {
  const blob = data instanceof Blob ? data : new Blob([contentAsBlobPart(data)], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function contentAsBlobPart(data: BlobPart | Uint8Array): BlobPart {
  if (data instanceof Uint8Array) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return copy;
  }
  return data;
}

for (const btn of exportButtons) {
  btn.addEventListener('click', async () => {
    if (!result) return;
    const base = `${imageName}.weave`;
    switch (btn.dataset.export) {
      case 'json':
        if (engineClient.isReady()) {
          try {
            const bomJson = await engineClient.exportCam('bom_json');
            if (typeof bomJson === 'string' && bomJson.includes('schema_version')) {
              download(`${base}.json`, bomJson, 'application/json');
              break;
            }
          } catch {
            // fallback below
          }
        }
        download(`${base}.json`, JSON.stringify(result, null, 2), 'application/json');
        break;
      case 'txt':
        download(`${base}.txt`, toInstructions(result), 'text/plain;charset=utf-8');
        break;
      case 'csv':
        download(`${base}.csv`, toCSV(result), 'text/csv;charset=utf-8');
        break;
      case 'svg':
        if (engineClient.isReady()) {
          try {
            const svgArt = await engineClient.exportCam('artwork_svg');
            if (typeof svgArt === 'string' && svgArt.startsWith('<svg')) {
              download(`${base}.svg`, svgArt, 'image/svg+xml');
              break;
            }
          } catch {
            // fallback below
          }
        }
        download(`${base}.svg`, toSVG(result), 'image/svg+xml');
        break;
      case 'png':
        simCanvas.toBlob((blob) => blob && download(`${base}.png`, blob, 'image/png'));
        break;
    }
  });
}

// ----------------------------------------------------------- 3-View Tab Navigation
const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tab')];
for (const tab of tabs) {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === tab.dataset.tab));
    if (tab.dataset.tab === 'knit') player.refresh();
    if (tab.dataset.tab === 'blueprint') {
      blueprintView.resize();
      blueprintView.setLoomConfig(getCurrentLoomConfig(), Number(fields.pegDiameter.value));
      blueprintView.fitView();
    }
  });
}

document.addEventListener('keydown', (e) => {
  if ($('knit').classList.contains('active')) player.handleKey(e);
});

// Knit player JSON open
$<HTMLInputElement>('open-json').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  try {
    const parsed = JSON.parse(await f.text()) as WeaveResult;
    if (parsed.version !== 1 || !Array.isArray(parsed.steps)) throw new Error('Arquivo não é um projeto Weaver Art');
    player.load(parsed);
  } catch (err) {
    showError(err);
  }
});

function showError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(err);
  alert(message);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
