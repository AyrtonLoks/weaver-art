import './style.css';
import {
  calibrateThreadColor,
  createLoom,
  describeLoom,
  estimateWeave,
  extractPalette,
  formatDuration,
  loomPegCount,
  parsePegsCSV,
  PRESETS,
  resolveOptions,
  toCSV,
  toGcode,
  toInstructions,
  toPegsCSV,
  toSVG,
  toTemplatePDF,
  toTemplateSVG,
  type CustomPaletteResult,
  type GcodeOptions,
  type LoomConfig,
  type PaperSize,
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
let customPegsList: { x: number; y: number }[] | null = null;
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

// Loom shape controls
const loomShape = $<HTMLSelectElement>('loomShape');
const loomCircleControls = $('loomCircleControls');
const loomSquareControls = $('loomSquareControls');
const loomRectControls = $('loomRectControls');
const loomCustomControls = $('loomCustomControls');
const squareSide = num('squareSide');
const squarePegsPerSide = num('squarePegsPerSide');
const rectWidth = num('rectWidth');
const rectHeight = num('rectHeight');
const rectPegsX = num('rectPegsX');
const rectPegsY = num('rectPegsY');
const customPegsFile = $<HTMLInputElement>('customPegsFile');
const customPegsSummary = $('customPegsSummary');
const miniLoomCanvas = $<HTMLCanvasElement>('miniLoom');
const miniLoomSummary = $('miniLoomSummary');

// Fabrication elements
const paperSize = $<HTMLSelectElement>('paperSize');
const drillDiameter = num('drillDiameter');
const btnTemplateSVG = $<HTMLButtonElement>('btnTemplateSVG');
const btnTemplatePDF = $<HTMLButtonElement>('btnTemplatePDF');
const btnPegsCSV = $<HTMLButtonElement>('btnPegsCSV');
const btnExportGcode = $<HTMLButtonElement>('btnExportGcode');
const gcodeClearance = num('gcodeClearance');
const gcodeFeed = num('gcodeFeed');
const gcodeOrigin = $<HTMLSelectElement>('gcodeOrigin');

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
  remaining: $('k-remaining'),
  code: $<HTMLInputElement>('k-code'),
  copyCodeBtn: $<HTMLButtonElement>('k-copy-code'),
  pasteCodeBtn: $<HTMLButtonElement>('k-paste-code'),
  exportResumeBtn: $<HTMLButtonElement>('k-export-resume'),
});

// ------------------------------------------------------------------- loom & form
function getCurrentLoomConfig(): LoomConfig {
  const shape = loomShape.value;
  const pegDiameterMm = Number(fields.pegDiameter.value) || 2;

  if (shape === 'square') {
    const side = Number(squareSide.value) || 500;
    const n = Math.max(2, Math.round(Number(squarePegsPerSide.value) || 41));
    return {
      shape: 'rectangle',
      widthMm: side,
      heightMm: side,
      pegsX: n,
      pegsY: n,
      pegDiameterMm,
    };
  }

  if (shape === 'rectangle') {
    const w = Number(rectWidth.value) || 600;
    const h = Number(rectHeight.value) || 400;
    const px = Math.max(2, Math.round(Number(rectPegsX.value) || 61));
    const py = Math.max(2, Math.round(Number(rectPegsY.value) || 41));
    return {
      shape: 'rectangle',
      widthMm: w,
      heightMm: h,
      pegsX: px,
      pegsY: py,
      pegDiameterMm,
    };
  }

  if (shape === 'custom') {
    if (!customPegsList || customPegsList.length < 3) {
      throw new Error('Carregue um arquivo CSV com pelo menos 3 pinos para usar o formato personalizado.');
    }
    return {
      shape: 'custom',
      pegs: customPegsList,
      pegDiameterMm,
    };
  }

  // Padrão: círculo
  return {
    shape: 'circle',
    diameterMm: Number(fields.diameter.value) || 711.2,
    pegCount: Math.max(3, Math.round(Number(fields.pegs.value) || 200)),
    pegDiameterMm,
    startAngleDeg: -90,
  };
}

function updateLoomPreview(): void {
  try {
    const cfg = getCurrentLoomConfig();
    const loom = createLoom(cfg);
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
  } catch {
    miniLoomSummary.textContent = 'Configuração incompleta ou carregue um arquivo CSV.';
  }
}

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

loomShape.addEventListener('change', () => {
  const s = loomShape.value;
  document.body.dataset.loomShape = s;
  loomCircleControls.hidden = s !== 'circle';
  loomSquareControls.hidden = s !== 'square';
  loomRectControls.hidden = s !== 'rectangle';
  loomCustomControls.hidden = s !== 'custom';
  updateLoomPreview();
});

for (const el of [
  fields.pegs,
  fields.diameter,
  fields.pegDiameter,
  squareSide,
  squarePegsPerSide,
  rectWidth,
  rectHeight,
  rectPegsX,
  rectPegsY,
]) {
  el.addEventListener('input', updateLoomPreview);
}

function checkRepeatsHint(): void {
  const lines = Number(fields.lines.value);
  const repeats = Number(fields.repeats.value);
  repeatsHint.hidden = !(lines > 5000 && repeats === 1);
}

function fillForm(o: WeaveOptions): void {
  const { loom } = o;
  if (loom.shape === 'circle') {
    loomShape.value = 'circle';
    fields.pegs.value = String(loom.pegCount);
    fields.diameter.value = loom.diameterMm.toFixed(1);
  } else if (loom.shape === 'rectangle') {
    if (loom.widthMm === loom.heightMm && loom.pegsX === loom.pegsY) {
      loomShape.value = 'square';
      squareSide.value = loom.widthMm.toFixed(1);
      squarePegsPerSide.value = String(loom.pegsX);
    } else {
      loomShape.value = 'rectangle';
      rectWidth.value = loom.widthMm.toFixed(1);
      rectHeight.value = loom.heightMm.toFixed(1);
      rectPegsX.value = String(loom.pegsX);
      rectPegsY.value = String(loom.pegsY);
    }
  } else if (loom.shape === 'custom') {
    loomShape.value = 'custom';
    customPegsList = loom.pegs.slice();
    customPegsSummary.textContent = `✔ ${loom.pegs.length} pinos definidos`;
  }

  const s = loomShape.value;
  document.body.dataset.loomShape = s;
  loomCircleControls.hidden = s !== 'circle';
  loomSquareControls.hidden = s !== 'square';
  loomRectControls.hidden = s !== 'rectangle';
  loomCustomControls.hidden = s !== 'custom';

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
  updateLoomPreview();
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
  btnExportGcode.disabled = true;
  spoolBreakdown.hidden = true;
  sEstTime.textContent = '…';
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
      renderSpoolTable(result);
      btnExportGcode.disabled = false;
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

// ---------------------------------------------------------------- export & fabrication
function download(name: string, data: BlobPart | Uint8Array, type: string): void {
  const blob = data instanceof Blob ? data : new Blob([data as unknown as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

btnTemplateSVG.addEventListener('click', () => {
  try {
    const cfg = getCurrentLoomConfig();
    const svg = toTemplateSVG(cfg, {
      drillDiameterMm: Number(drillDiameter.value) || 2,
    });
    download(`gabarito-${cfg.shape}.svg`, svg, 'image/svg+xml');
  } catch (err) {
    showError(err);
  }
});

btnTemplatePDF.addEventListener('click', () => {
  try {
    const cfg = getCurrentLoomConfig();
    const pdf = toTemplatePDF(cfg, {
      paper: paperSize.value as PaperSize,
      drillDiameterMm: Number(drillDiameter.value) || 2,
    });
    download(`gabarito-${cfg.shape}.pdf`, pdf, 'application/pdf');
  } catch (err) {
    showError(err);
  }
});

btnPegsCSV.addEventListener('click', () => {
  try {
    const cfg = getCurrentLoomConfig();
    const csv = toPegsCSV(cfg);
    download(`pinos-${cfg.shape}.csv`, csv, 'text/csv;charset=utf-8');
  } catch (err) {
    showError(err);
  }
});

btnExportGcode.addEventListener('click', () => {
  if (!result) return;
  try {
    const gcode = toGcode(result, {
      clearanceMm: Number(gcodeClearance.value) || 1.5,
      feedMmPerMin: Number(gcodeFeed.value) || 3000,
      origin: gcodeOrigin.value as GcodeOptions['origin'],
    });
    download(`${imageName}.weave.gcode`, gcode, 'text/plain;charset=utf-8');
  } catch (err) {
    showError(err);
  }
});

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
