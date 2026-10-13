import './style.css';
import {
  calibrateThreadColor,
  extractPalette,
  PRESETS,
  resolveOptions,
  toCSV,
  toInstructions,
  toSVG,
  type CustomPaletteResult,
  type PresetName,
  type WeaveOptions,
  type WeaveResult,
} from '@weaver-art/core';
import { KnitPlayer } from './player';
import type { FromWorker, ToWorker } from './protocol';

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
let customPalette: CustomPaletteResult | null = null;
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

// --------------------------------------------------------------- elements
const fileInput = $<HTMLInputElement>('file');
const drop = $('drop');
const dropLabel = $('drop-label');
const preset = $<HTMLSelectElement>('preset');
const optCustom = $<HTMLOptionElement>('opt-custom');
const paletteKInput = $<HTMLInputElement>('paletteK');
const btnExtractPalette = $<HTMLButtonElement>('btnExtractPalette');
const palettePreview = $('palettePreview');
const runBtn = $<HTMLButtonElement>('run');
const stopBtn = $<HTMLButtonElement>('stop');
const simCanvas = $<HTMLCanvasElement>('sim');
const targetCanvas = $<HTMLCanvasElement>('target');
const bar = $('bar');
const exportButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-export]')];

const num = (id: string): HTMLInputElement => $<HTMLInputElement>(id);
const colorStrategy = $<HTMLSelectElement>('colorStrategy');
const stopImprovement = $<HTMLInputElement>('stopImprovement');
const repeatsHint = $('repeats-hint');
const halftoneControls = $('halftone-controls');

const fields = {
  pegs: num('pegs'),
  diameter: num('diameter'),
  pegDiameter: num('pegDiameter'),
  threadWidth: num('threadWidth'),
  lines: num('lines'),
  gap: num('gap'),
  repeats: num('repeats'),
  resolution: num('resolution'),
  lengthPenalty: num('lengthPenalty'),
  refinePasses: num('refinePasses'),
  viewingDistance: num('viewingDistance'),
  contrast: num('contrast'),
  brightness: num('brightness'),
  gamma: num('gamma'),
  shadowLift: num('shadowLift'),
  edgeEmphasis: num('edgeEmphasis'),
  clahe: $<HTMLInputElement>('clahe'),
  claheClip: num('claheClip'),
  invert: num('invert'),
  halftoneMixing: $<HTMLInputElement>('halftoneMixing'),
  halftoneRadius: num('halftoneRadius'),
};

const calibrateFileInput = $<HTMLInputElement>('calibrateFile');
const calibrateOutput = $('calibrateOutput');
const calibrateSwatch = $('calibrateSwatch');
const calibrateText = $('calibrateText');

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

fields.clahe.addEventListener('change', () => {
  $('clahe-controls').hidden = !fields.clahe.checked;
});

fields.halftoneMixing.addEventListener('change', () => {
  halftoneControls.hidden = !fields.halftoneMixing.checked;
});

function renderPalettePreview(res: CustomPaletteResult): void {
  palettePreview.innerHTML = '';
  res.threads.forEach((t, i) => {
    const quotaPct = ((res.threadLineBudgets[i] ?? 0) * 100).toFixed(0);
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '0.5rem';
    row.innerHTML =
      `<span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:${t.color};border:1px solid #fff"></span>` +
      `<span><strong>${escapeHtml(t.name)}</strong> (${t.color}) · ${quotaPct}%</span>`;
    palettePreview.appendChild(row);
  });
  palettePreview.hidden = false;
}

btnExtractPalette.addEventListener('click', () => {
  if (!image) return;
  const k = Math.max(2, Math.min(8, Number(paletteKInput.value) || 4));
  try {
    customPalette = extractPalette({ width: image.width, height: image.height, data: image.data }, k);
    renderPalettePreview(customPalette);
    optCustom.disabled = false;
    preset.value = 'custom';
    fillForm(getCustomPresetOptions());
  } catch (err) {
    showError(err);
  }
});

function getCustomPresetOptions(): WeaveOptions {
  if (!customPalette) return PRESETS['vrellis-mono'];
  return {
    ...PRESETS['vrellis-mono'],
    threads: customPalette.threads,
    threadLineBudgets: customPalette.threadLineBudgets,
    colorStrategy: 'layered',
    maxLines: 6000,
    preprocess: { ...PRESETS['vrellis-mono'].preprocess, grayscale: false },
  };
}

const player = new KnitPlayer({
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
});

// ------------------------------------------------------------------- form
function checkRepeatsHint(): void {
  const lines = Number(fields.lines.value);
  const repeats = Number(fields.repeats.value);
  repeatsHint.hidden = !(lines > 5000 && repeats === 1);
}

function fillForm(o: WeaveOptions): void {
  fields.pegs.value = String(o.loom.pegCount);
  fields.diameter.value = o.loom.diameterMm.toFixed(1);
  fields.pegDiameter.value = String(o.loom.pegDiameterMm);
  fields.threadWidth.value = String(o.threads[0].widthMm);
  fields.lines.value = String(o.maxLines);
  fields.gap.value = String(o.minPegGap);
  fields.repeats.value = String(o.maxChordRepeats);
  fields.resolution.value = String(o.resolutionPx);
  fields.lengthPenalty.value = String(o.lengthPenalty ?? 0);
  fields.refinePasses.value = String(o.refinePasses ?? 0);
  fields.viewingDistance.value = String(o.viewingDistanceM ?? o.preprocess.viewingDistanceM ?? 0);
  fields.contrast.value = String(o.preprocess.contrast);
  fields.brightness.value = String(o.preprocess.brightness);
  fields.gamma.value = String(o.preprocess.gamma);
  fields.shadowLift.value = String(o.preprocess.shadowLift ?? 0);
  fields.edgeEmphasis.value = String(o.preprocess.edgeEmphasis ?? 0);
  fields.clahe.checked = Boolean(o.preprocess.clahe);
  fields.claheClip.value = String(o.preprocess.claheClipLimit ?? 2);
  $('clahe-controls').hidden = !fields.clahe.checked;
  fields.halftoneMixing.checked = Boolean(o.halftoneMixing);
  fields.halftoneRadius.value = String(o.halftoneRadiusMm ?? 0.75);
  halftoneControls.hidden = !fields.halftoneMixing.checked;
  fields.invert.checked = o.preprocess.invert;
  colorStrategy.value = o.colorStrategy ?? 'layered';
  stopImprovement.checked = o.stopWhenNoImprovement;
  updateOutputs();
  checkRepeatsHint();
}

function updateOutputs(): void {
  for (const id of [
    'contrast',
    'brightness',
    'gamma',
    'shadowLift',
    'edgeEmphasis',
    'lengthPenalty',
    'viewingDistance',
    'claheClip',
    'halftoneRadius',
  ] as const) {
    const el = document.getElementById(`${id}-out`);
    if (el) el.textContent = Number(fields[id].value).toFixed(2);
  }
}

function readOptions(): WeaveOptions {
  const base = preset.value === 'custom' ? getCustomPresetOptions() : PRESETS[preset.value as PresetName];
  const pegCount = Number(fields.pegs.value);
  const width = Number(fields.threadWidth.value);
  return resolveOptions(
    {
      loom: {
        pegCount,
        diameterMm: Number(fields.diameter.value),
        pegDiameterMm: Number(fields.pegDiameter.value),
      },
      // Spread thread tie-on pegs evenly when the peg count changes.
      threads: base.threads.map((t, i) => ({
        ...t,
        widthMm: width,
        startPeg: Math.floor((i * pegCount) / base.threads.length),
      })),
      threadLineBudgets: base.threadLineBudgets,
      maxLines: Number(fields.lines.value),
      minPegGap: Number(fields.gap.value),
      maxChordRepeats: Number(fields.repeats.value),
      resolutionPx: Number(fields.resolution.value),
      colorStrategy: colorStrategy.value as 'layered' | 'interleaved-balanced' | 'free',
      stopWhenNoImprovement: stopImprovement.checked,
      lengthPenalty: Number(fields.lengthPenalty.value),
      viewingDistanceM: Number(fields.viewingDistance.value),
      refinePasses: Number(fields.refinePasses.value),
      halftoneMixing: fields.halftoneMixing.checked,
      halftoneRadiusMm: Number(fields.halftoneRadius.value),
      preprocess: {
        contrast: Number(fields.contrast.value),
        brightness: Number(fields.brightness.value),
        gamma: Number(fields.gamma.value),
        shadowLift: Number(fields.shadowLift.value),
        edgeEmphasis: Number(fields.edgeEmphasis.value),
        clahe: fields.clahe.checked,
        claheClipLimit: Number(fields.claheClip.value),
        viewingDistanceM: Number(fields.viewingDistance.value),
        invert: fields.invert.checked,
      },
    },
    base,
  );
}

preset.addEventListener('change', () => {
  if (preset.value === 'custom') {
    fillForm(getCustomPresetOptions());
  } else {
    fillForm(PRESETS[preset.value as PresetName]);
  }
});
for (const id of [
  'contrast',
  'brightness',
  'gamma',
  'shadowLift',
  'edgeEmphasis',
  'lengthPenalty',
  'viewingDistance',
  'claheClip',
  'halftoneRadius',
] as const) {
  fields[id].addEventListener('input', updateOutputs);
}
fields.lines.addEventListener('input', checkRepeatsHint);
fields.repeats.addEventListener('input', checkRepeatsHint);
fillForm(PRESETS['vrellis-mono']);

// ------------------------------------------------------------------ image
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
  btnExtractPalette.disabled = false;
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

// ------------------------------------------------------------------- run
function paint(canvas: HTMLCanvasElement, size: number, rgba: ArrayBuffer): void {
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
): void {
  const isLayered = colorStrategy.value === 'layered';
  const threadInfo = currentThread
    ? isLayered
      ? ` · Camada ${currentLayer ?? 1}: ${currentThread}`
      : ` · Fio: ${currentThread}`
    : '';
  $('s-lines').textContent = `${lines.toLocaleString('pt-BR')}${threadInfo}`;
  $('s-length').textContent = `${(lengthMm / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} m`;
  $('s-rmse').textContent = rmse === null ? '…' : rmse.toFixed(4);
  $('s-deltaE').textContent = deltaE !== undefined && deltaE !== null ? deltaE.toFixed(2) : '…';
  $('s-ssim').textContent = ssim !== undefined && ssim !== null ? ssim.toFixed(3) : '…';
  $('s-time').textContent = `${(ms / 1000).toFixed(1)} s`;
}

function setRunning(on: boolean): void {
  running = on;
  runBtn.disabled = on || !image;
  stopBtn.disabled = !on;
  document.body.classList.toggle('running', on);
}

let currentMaxLines = 1;
runBtn.addEventListener('click', () => {
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
  exportButtons.forEach((b) => (b.disabled = true));
  setRunning(true);
  const data = image.data.slice().buffer;
  const msg: ToWorker = { type: 'start', image: { width: image.width, height: image.height, data }, options };
  worker.postMessage(msg, [data]);
});

stopBtn.addEventListener('click', () => worker.postMessage({ type: 'stop' } satisfies ToWorker));

worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'target':
      paint(targetCanvas, msg.size, msg.rgba);
      break;
    case 'progress':
      paint(simCanvas, msg.size, msg.rgba);
      bar.style.width = `${(msg.lines / currentMaxLines) * 100}%`;
      setStats(msg.lines, msg.lengthMm, null, msg.elapsedMs, msg.currentThread, msg.currentLayer);
      break;
    case 'done':
      paint(simCanvas, msg.size, msg.rgba);
      result = msg.result;
      bar.style.width = '100%';
      setStats(
        result.steps.length,
        result.totalLengthMm,
        result.rmse,
        result.durationMs,
        undefined,
        undefined,
        result.metrics?.deltaELab,
        result.metrics?.ssim,
      );
      exportButtons.forEach((b) => (b.disabled = false));
      setRunning(false);
      player.load(result);
      break;
    case 'error':
      setRunning(false);
      showError(new Error(msg.message));
      break;
  }
};

// ---------------------------------------------------------------- export
function download(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

for (const btn of exportButtons) {
  btn.addEventListener('click', () => {
    if (!result) return;
    const base = `${imageName}.weave`;
    switch (btn.dataset.export) {
      case 'json':
        download(`${base}.json`, JSON.stringify(result), 'application/json');
        break;
      case 'txt':
        download(`${base}.txt`, toInstructions(result), 'text/plain;charset=utf-8');
        break;
      case 'csv':
        download(`${base}.csv`, toCSV(result), 'text/csv;charset=utf-8');
        break;
      case 'svg':
        download(`${base}.svg`, toSVG(result), 'image/svg+xml');
        break;
      case 'png':
        simCanvas.toBlob((blob) => blob && download(`${base}.png`, blob, 'image/png'));
        break;
    }
  });
}

// ----------------------------------------------------------- knit tab
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

const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tab')];
for (const tab of tabs) {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === tab.dataset.tab));
    if (tab.dataset.tab === 'knit') player.refresh();
  });
}
document.addEventListener('keydown', (e) => {
  if ($('knit').classList.contains('active')) player.handleKey(e);
});

// ----------------------------------------------------------------- utils
function showError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(err);
  alert(message);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
