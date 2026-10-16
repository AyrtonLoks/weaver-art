/**
 * Studio View Controller & Multi-Stage Inspection (ADR-005 / Sprint 4 Task 4.1).
 *
 * Implements:
 * 1. Hybrid Framing (drag Pan X/Y, wheel Zoom, and Auto Face 80% framing).
 * 2. Multi-stage inspection tabs connected to Wasm PreviewBuffers:
 *    - 1. Alvo Preparado (PreparedTargetRGBA)
 *    - 2. Mapa de Importância W(x,y) (ImportanceMapRGBA)
 *    - 3. Bordas (Sobel / Canny) (EdgesRGBA)
 *    - 4. Sinograma de Radon (RadonSinogramRGBA)
 *    - 5. Erro Residual Instantâneo |T - S|
 * 3. Interactive Focus Brush on W(x,y) with dual modes:
 *    - '+ Reforçar Nitidez' (increases importance for eyes/glasses/features)
 *    - '- Reduzir Peso' (decreases weight for background/torso)
 *    Directly dispatched to `apply_user_importance_brush` in the Wasm worker.
 */

export type TargetInspectionStage = 'prepared' | 'importance' | 'edges' | 'radon' | 'residual';
export type BrushInteractionMode = 'boost' | 'reduce';

export interface DiagnosticBuffersPayload {
  preparedRgba?: ArrayBuffer | Uint8ClampedArray;
  importanceRgba?: ArrayBuffer | Uint8ClampedArray;
  edgesRgba?: ArrayBuffer | Uint8ClampedArray;
  radonRgba?: ArrayBuffer | Uint8ClampedArray;
  dimensions?: number[]; // [prepW, prepH, impW, impH, edgeW, edgeH, radonW, radonH]
}

export interface StudioFramingElements {
  targetCanvas: HTMLCanvasElement;
  zoomInput: HTMLInputElement;
  panXInput: HTMLInputElement;
  panYInput: HTMLInputElement;
  rotationInput: HTMLInputElement;
  btnSmartFrame: HTMLButtonElement;
  btnResetCrop: HTMLButtonElement;
  btnToggleBrush?: HTMLButtonElement;
  btnBrushMode?: HTMLButtonElement;
  btnClearBrush?: HTMLButtonElement;
  stageTabs: NodeListOf<HTMLButtonElement>;
  targetCaption?: HTMLElement;
}

export class StudioViewManager {
  private readonly el: StudioFramingElements;
  private activeStage: TargetInspectionStage = 'prepared';

  // Manual brush state
  private brushActive = false;
  private brushMode: BrushInteractionMode = 'boost';
  private brushRadius = 18;
  private brushWeight = 2.5;
  private manualImportanceMask: Float32Array | null = null;
  private maskWidth = 256;
  private maskHeight = 256;

  // Wasm diagnostic preview buffers
  private wasmPreparedRgba: Uint8ClampedArray | null = null;
  private wasmImportanceRgba: Uint8ClampedArray | null = null;
  private wasmEdgesRgba: Uint8ClampedArray | null = null;
  private wasmRadonRgba: Uint8ClampedArray | null = null;
  private diagnosticDimensions: number[] | null = null;

  // Cached stage renders (JS fallback)
  private cachedPreparedRgba: Uint8ClampedArray | null = null;
  private cachedSimRgba: Uint8ClampedArray | null = null;

  // Listeners & Wasm Brush callback
  private onFramingChange?: () => void;
  private onBrushApplyHandler?: (weights: Float32Array) => Promise<ArrayBuffer | void> | void;
  private brushApplyDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(el: StudioFramingElements, onFramingChange?: () => void) {
    this.el = el;
    this.onFramingChange = onFramingChange;
    this.bindEvents();
  }

  public getActiveStage(): TargetInspectionStage {
    return this.activeStage;
  }

  public setActiveStage(stage: TargetInspectionStage): void {
    this.activeStage = stage;
    this.el.stageTabs.forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.stage === stage);
    });

    if (stage === 'importance') {
      this.setBrushMode(true);
    }

    this.updateCaption();
    this.refreshCurrentStage();
  }

  public isBrushModeActive(): boolean {
    return this.brushActive;
  }

  public setBrushMode(active: boolean): void {
    this.brushActive = active;
    if (this.el.btnToggleBrush) {
      this.el.btnToggleBrush.classList.toggle('primary', active);
      this.el.btnToggleBrush.textContent = active ? 'Pincel de Foco (Ativo)' : 'Pincel de Foco Manual';
    }
    this.el.targetCanvas.style.cursor = active ? 'crosshair' : 'grab';
    this.updateCaption();
  }

  public getBrushMode(): BrushInteractionMode {
    return this.brushMode;
  }

  public setBrushInteractionMode(mode: BrushInteractionMode): void {
    this.brushMode = mode;
    this.updateBrushModeUI();
  }

  public toggleBrushMode(): BrushInteractionMode {
    this.brushMode = this.brushMode === 'boost' ? 'reduce' : 'boost';
    this.updateBrushModeUI();
    return this.brushMode;
  }

  private updateBrushModeUI(): void {
    if (this.el.btnBrushMode) {
      if (this.brushMode === 'boost') {
        this.el.btnBrushMode.textContent = '+ Reforçar Nitidez';
        this.el.btnBrushMode.style.color = 'var(--accent, #4cd964)';
      } else {
        this.el.btnBrushMode.textContent = '- Reduzir Peso';
        this.el.btnBrushMode.style.color = '#ff9500';
      }
    }
  }

  public setBrushApplyHandler(handler: (weights: Float32Array) => Promise<ArrayBuffer | void> | void): void {
    this.onBrushApplyHandler = handler;
  }

  public getManualBrushMask(): Float32Array | null {
    return this.manualImportanceMask;
  }

  public clearManualBrush(): void {
    if (this.manualImportanceMask) {
      this.manualImportanceMask.fill(0);
      this.dispatchBrushApply();
      this.refreshCurrentStage();
    }
  }

  // --- Diagnostic Buffers from Wasm ---

  public setDiagnosticBuffers(buffers: DiagnosticBuffersPayload): void {
    if (buffers.preparedRgba) {
      this.wasmPreparedRgba =
        buffers.preparedRgba instanceof Uint8ClampedArray
          ? buffers.preparedRgba
          : new Uint8ClampedArray(buffers.preparedRgba);
      this.cachedPreparedRgba = this.wasmPreparedRgba;
    }
    if (buffers.importanceRgba) {
      this.wasmImportanceRgba =
        buffers.importanceRgba instanceof Uint8ClampedArray
          ? buffers.importanceRgba
          : new Uint8ClampedArray(buffers.importanceRgba);
    }
    if (buffers.edgesRgba) {
      this.wasmEdgesRgba =
        buffers.edgesRgba instanceof Uint8ClampedArray ? buffers.edgesRgba : new Uint8ClampedArray(buffers.edgesRgba);
    }
    if (buffers.radonRgba) {
      this.wasmRadonRgba =
        buffers.radonRgba instanceof Uint8ClampedArray ? buffers.radonRgba : new Uint8ClampedArray(buffers.radonRgba);
    }
    if (buffers.dimensions && buffers.dimensions.length >= 2) {
      this.diagnosticDimensions = buffers.dimensions;
      this.maskWidth = buffers.dimensions[0] || 256;
      this.maskHeight = buffers.dimensions[1] || 256;
    }

    if (!this.manualImportanceMask || this.manualImportanceMask.length !== this.maskWidth * this.maskHeight) {
      this.manualImportanceMask = new Float32Array(this.maskWidth * this.maskHeight);
    }

    this.refreshCurrentStage();
  }

  public updateImportanceBuffer(rgba: ArrayBuffer | Uint8ClampedArray, width?: number, height?: number): void {
    this.wasmImportanceRgba = rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba);
    if (width && height) {
      this.maskWidth = width;
      this.maskHeight = height;
    }
    if (this.activeStage === 'importance') {
      this.refreshCurrentStage();
    }
  }

  public setCachedSimulation(rgba: ArrayBuffer | Uint8ClampedArray): void {
    this.cachedSimRgba = rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba);
    if (this.activeStage === 'residual') {
      this.refreshCurrentStage();
    }
  }

  public updateTargetData(rgba: ArrayBuffer | Uint8ClampedArray, width: number, height: number): void {
    this.maskWidth = width;
    this.maskHeight = height;
    this.cachedPreparedRgba = rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba);
    if (!this.manualImportanceMask || this.manualImportanceMask.length !== width * height) {
      this.manualImportanceMask = new Float32Array(width * height);
    }
    this.refreshCurrentStage();
  }

  // --- Display Refresh & Fallbacks ---

  public refreshCurrentStage(): void {
    const ctx = this.el.targetCanvas.getContext('2d');
    if (!ctx) return;

    let w = this.maskWidth;
    let h = this.maskHeight;

    const dims = this.diagnosticDimensions;
    if (dims && dims.length >= 8) {
      switch (this.activeStage) {
        case 'prepared':
          w = dims[0];
          h = dims[1];
          break;
        case 'importance':
          w = dims[2];
          h = dims[3];
          break;
        case 'edges':
          w = dims[4];
          h = dims[5];
          break;
        case 'radon':
          w = dims[6];
          h = dims[7];
          break;
        case 'residual':
          w = dims[0];
          h = dims[1];
          break;
      }
    }

    if (this.el.targetCanvas.width !== w || this.el.targetCanvas.height !== h) {
      this.el.targetCanvas.width = w;
      this.el.targetCanvas.height = h;
    }

    const putData = (data: Uint8ClampedArray, width = w, height = h): void => {
      if (this.el.targetCanvas.width !== width || this.el.targetCanvas.height !== height) {
        this.el.targetCanvas.width = width;
        this.el.targetCanvas.height = height;
      }
      const idata = ctx.createImageData(width, height);
      idata.data.set(data);
      ctx.putImageData(idata, 0, 0);
    };

    switch (this.activeStage) {
      case 'prepared': {
        if (this.wasmPreparedRgba) {
          putData(this.wasmPreparedRgba, w, h);
        } else if (this.cachedPreparedRgba) {
          putData(this.cachedPreparedRgba, w, h);
        }
        break;
      }
      case 'importance': {
        if (this.wasmImportanceRgba) {
          putData(this.wasmImportanceRgba, w, h);
        } else {
          const imp = this.computeImportanceMapRgba(w, h);
          putData(imp, w, h);
        }
        break;
      }
      case 'edges': {
        if (this.wasmEdgesRgba) {
          putData(this.wasmEdgesRgba, w, h);
        } else {
          const edges = this.computeSobelEdgesRgba(w, h);
          putData(edges, w, h);
        }
        break;
      }
      case 'radon': {
        if (this.wasmRadonRgba) {
          putData(this.wasmRadonRgba, w, h);
        } else {
          const radon = this.computeRadonSinogramRgba(w, h);
          putData(radon, w, h);
        }
        break;
      }
      case 'residual': {
        const res = this.computeResidualErrorRgba(w, h);
        putData(res, w, h);
        break;
      }
    }
  }

  private updateCaption(): void {
    const captionEl =
      this.el.targetCaption ?? (typeof document !== 'undefined' ? document.getElementById('targetCaption') : null);
    if (!captionEl) return;

    switch (this.activeStage) {
      case 'prepared':
        captionEl.textContent = '1. Alvo Preparado (luz linear)';
        break;
      case 'importance':
        captionEl.textContent = `2. Mapa de Importância W(x,y) [Pincel: ${this.brushMode === 'boost' ? '+ Reforçar' : '- Reduzir'}]`;
        break;
      case 'edges':
        captionEl.textContent = '3. Bordas Estruturais (Sobel / Canny)';
        break;
      case 'radon':
        captionEl.textContent = '4. Sinograma de Radon Filtrado';
        break;
      case 'residual':
        captionEl.textContent = '5. Erro Residual Instantâneo |T - S|';
        break;
    }
  }

  // --- Events and Pointer Interaction ---

  private bindEvents(): void {
    const canvas = this.el.targetCanvas;
    if (typeof canvas.addEventListener !== 'function') return;

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let startPanX = 0;
    let startPanY = 0;

    canvas.addEventListener('pointerdown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / Math.max(1, rect.width);
      const scaleY = canvas.height / Math.max(1, rect.height);
      const px = (e.clientX - rect.left) * scaleX;
      const py = (e.clientY - rect.top) * scaleY;

      if (this.brushActive || this.activeStage === 'importance') {
        this.paintBrushAt(px, py);
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        isDragging = true;
        return;
      }

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startPanX = Number(this.el.panXInput.value) || 0;
      startPanY = Number(this.el.panYInput.value) || 0;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      canvas.style.cursor = 'grabbing';
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!isDragging) return;

      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / Math.max(1, rect.width);
      const scaleY = canvas.height / Math.max(1, rect.height);
      const px = (e.clientX - rect.left) * scaleX;
      const py = (e.clientY - rect.top) * scaleY;

      if (this.brushActive || this.activeStage === 'importance') {
        this.paintBrushAt(px, py);
        return;
      }

      // Drag to Pan
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const zoom = Math.max(0.5, Number(this.el.zoomInput.value) || 1.0);

      const deltaPanX = (dx / rect.width) * (80 / zoom);
      const deltaPanY = (dy / rect.height) * (80 / zoom);

      const newPanX = Math.round(Math.max(-50, Math.min(50, startPanX + deltaPanX)));
      const newPanY = Math.round(Math.max(-50, Math.min(50, startPanY + deltaPanY)));

      this.el.panXInput.value = String(newPanX);
      this.el.panYInput.value = String(newPanY);
      this.onFramingChange?.();
    });

    const stopDrag = (e: PointerEvent): void => {
      if (isDragging) {
        isDragging = false;
        try {
          canvas.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        canvas.style.cursor = this.brushActive || this.activeStage === 'importance' ? 'crosshair' : 'grab';
        if (this.brushActive || this.activeStage === 'importance') {
          this.dispatchBrushApply();
        }
      }
    };
    canvas.addEventListener('pointerup', stopDrag);
    canvas.addEventListener('pointercancel', stopDrag);

    // Mouse wheel for Zoom
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (this.brushActive || this.activeStage === 'importance') {
          // Wheel adjusts brush radius in brush mode!
          e.preventDefault();
          this.brushRadius = Math.max(5, Math.min(60, this.brushRadius + (e.deltaY < 0 ? 2 : -2)));
          return;
        }
        e.preventDefault();
        const currentZoom = Number(this.el.zoomInput.value) || 1.0;
        const zoomDelta = e.deltaY < 0 ? 0.05 : -0.05;
        const newZoom = Math.max(0.8, Math.min(3.0, currentZoom + zoomDelta));
        this.el.zoomInput.value = newZoom.toFixed(2);
        this.onFramingChange?.();
      },
      { passive: false },
    );

    // Stage pills
    this.el.stageTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const stage = (tab.dataset.stage as TargetInspectionStage) || 'prepared';
        this.setActiveStage(stage);
      });
    });

    // Smart frame 80% (Petros Vrellis standard)
    this.el.btnSmartFrame?.addEventListener('click', () => {
      this.el.zoomInput.value = '1.25';
      this.el.panYInput.value = '-6';
      this.el.panXInput.value = '0';
      if (this.el.rotationInput) this.el.rotationInput.value = '0';
      this.onFramingChange?.();
    });

    // Reset crop
    this.el.btnResetCrop?.addEventListener('click', () => {
      this.el.zoomInput.value = '1.0';
      this.el.panXInput.value = '0';
      this.el.panYInput.value = '0';
      if (this.el.rotationInput) this.el.rotationInput.value = '0';
      this.onFramingChange?.();
    });

    // Brush controls
    this.el.btnToggleBrush?.addEventListener('click', () => {
      this.setBrushMode(!this.brushActive);
    });

    this.el.btnBrushMode?.addEventListener('click', () => {
      this.toggleBrushMode();
    });

    this.el.btnClearBrush?.addEventListener('click', () => {
      this.clearManualBrush();
    });
  }

  private paintBrushAt(px: number, py: number): void {
    if (!this.manualImportanceMask) {
      this.manualImportanceMask = new Float32Array(this.maskWidth * this.maskHeight);
    }
    const w = this.maskWidth;
    const h = this.maskHeight;
    const r = this.brushRadius;
    const sign = this.brushMode === 'boost' ? 1.0 : -1.0;
    const weight = this.brushWeight * sign;

    const minX = Math.max(0, Math.floor(px - r));
    const maxX = Math.min(w - 1, Math.ceil(px + r));
    const minY = Math.max(0, Math.floor(py - r));
    const maxY = Math.min(h - 1, Math.ceil(py + r));

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dist = Math.hypot(x - px, y - py);
        if (dist <= r) {
          const falloff = 1.0 - dist / r;
          const idx = y * w + x;
          const delta = weight * falloff * 0.25;
          this.manualImportanceMask[idx] = Math.max(-10.0, Math.min(10.0, this.manualImportanceMask[idx] + delta));
        }
      }
    }

    this.refreshCurrentStage();

    // Throttled brush dispatch to worker
    if (this.brushApplyDebounceTimer) {
      clearTimeout(this.brushApplyDebounceTimer);
    }
    this.brushApplyDebounceTimer = setTimeout(() => {
      this.dispatchBrushApply();
    }, 60);
  }

  private dispatchBrushApply(): void {
    if (!this.onBrushApplyHandler || !this.manualImportanceMask) return;
    const result = this.onBrushApplyHandler(this.manualImportanceMask);
    if (result && typeof result.then === 'function') {
      result
        .then((newBuf) => {
          if (newBuf instanceof ArrayBuffer) {
            this.updateImportanceBuffer(newBuf);
          }
        })
        .catch((err) => {
          console.warn('Erro ao atualizar pincel no Worker Wasm:', err);
        });
    }
  }

  // --- Fallback Stage Generators ---

  private computeImportanceMapRgba(w: number, h: number): Uint8ClampedArray {
    const rgba = new Uint8ClampedArray(w * h * 4);
    const cx = w / 2;
    const cy = h * 0.45;
    const rx = w * 0.32;
    const ry = h * 0.38;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const normDist = Math.hypot((x - cx) / rx, (y - cy) / ry);
        const facialWeight = Math.max(0, 1.0 - normDist);
        const manual = this.manualImportanceMask ? this.manualImportanceMask[y * w + x] : 0;
        const total = Math.max(0.0, Math.min(1.0, (facialWeight + manual) * 0.7));

        if (total < 0.33) {
          rgba[i] = Math.round((total / 0.33) * 180);
          rgba[i + 1] = 0;
          rgba[i + 2] = 0;
        } else if (total < 0.66) {
          rgba[i] = 255;
          rgba[i + 1] = Math.round(((total - 0.33) / 0.33) * 200);
          rgba[i + 2] = 0;
        } else {
          rgba[i] = 255;
          rgba[i + 1] = 255;
          rgba[i + 2] = Math.round(((total - 0.66) / 0.34) * 255);
        }
        rgba[i + 3] = 255;
      }
    }
    return rgba;
  }

  private computeSobelEdgesRgba(w: number, h: number): Uint8ClampedArray {
    const src = this.wasmPreparedRgba ?? this.cachedPreparedRgba;
    if (!src) return new Uint8ClampedArray(w * h * 4);
    const rgba = new Uint8ClampedArray(w * h * 4);

    const getLum = (x: number, y: number): number => {
      const clampedX = Math.max(0, Math.min(w - 1, x));
      const clampedY = Math.max(0, Math.min(h - 1, y));
      const idx = (clampedY * w + clampedX) * 4;
      return 0.299 * src[idx] + 0.587 * src[idx + 1] + 0.114 * src[idx + 2];
    };

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        const gx =
          -1 * getLum(x - 1, y - 1) +
          1 * getLum(x + 1, y - 1) +
          -2 * getLum(x - 1, y) +
          2 * getLum(x + 1, y) +
          -1 * getLum(x - 1, y + 1) +
          1 * getLum(x + 1, y + 1);

        const gy =
          -1 * getLum(x - 1, y - 1) +
          -2 * getLum(x, y - 1) +
          -1 * getLum(x + 1, y - 1) +
          1 * getLum(x - 1, y + 1) +
          2 * getLum(x, y + 1) +
          1 * getLum(x + 1, y + 1);

        const mag = Math.min(255, Math.hypot(gx, gy) * 1.5);
        rgba[idx] = Math.round(mag * 0.2);
        rgba[idx + 1] = Math.round(mag * 0.8);
        rgba[idx + 2] = Math.round(mag);
        rgba[idx + 3] = 255;
      }
    }
    return rgba;
  }

  private computeRadonSinogramRgba(w: number, h: number): Uint8ClampedArray {
    const src = this.wasmPreparedRgba ?? this.cachedPreparedRgba;
    if (!src) return new Uint8ClampedArray(w * h * 4);
    const rgba = new Uint8ClampedArray(w * h * 4);

    const numAngles = w;
    const numBins = h;
    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.hypot(cx, cy);

    for (let col = 0; col < numAngles; col++) {
      const theta = (col / numAngles) * Math.PI;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);

      for (let row = 0; row < numBins; row++) {
        const s = ((row - numBins / 2) / (numBins / 2)) * maxR;
        let sum = 0;
        let count = 0;

        for (let t = -maxR; t <= maxR; t += 4) {
          const px = Math.round(cx + s * cosT - t * sinT);
          const py = Math.round(cy + s * sinT + t * cosT);
          if (px >= 0 && px < w && py >= 0 && py < h) {
            const idx = (py * w + px) * 4;
            const dark = 255 - (0.299 * src[idx] + 0.587 * src[idx + 1] + 0.114 * src[idx + 2]);
            sum += dark;
            count++;
          }
        }

        const avg = count > 0 ? Math.min(255, (sum / count) * 2.2) : 0;
        const i = (row * w + col) * 4;
        rgba[i] = Math.round(avg * 0.3);
        rgba[i + 1] = Math.round(avg * 0.7);
        rgba[i + 2] = Math.round(avg);
        rgba[i + 3] = 255;
      }
    }
    return rgba;
  }

  private computeResidualErrorRgba(w: number, h: number): Uint8ClampedArray {
    const tgt = this.wasmPreparedRgba ?? this.cachedPreparedRgba;
    const sim = this.cachedSimRgba;
    const rgba = new Uint8ClampedArray(w * h * 4);
    if (!tgt) return rgba;

    for (let i = 0; i < w * h * 4; i += 4) {
      const tLum = 0.299 * tgt[i] + 0.587 * tgt[i + 1] + 0.114 * tgt[i + 2];
      const sLum = sim ? 0.299 * sim[i] + 0.587 * sim[i + 1] + 0.114 * sim[i + 2] : 255;
      const err = Math.min(255, Math.abs(tLum - sLum) * 1.5);

      rgba[i] = Math.round(err);
      rgba[i + 1] = Math.round(err * 0.3);
      rgba[i + 2] = Math.round(err * 0.1);
      rgba[i + 3] = 255;
    }
    return rgba;
  }
}
