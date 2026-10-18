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

/** Resultado do enquadramento automático (zoom/pan do recorte + rostos detectados). */
export interface SmartFrameOutcome {
  zoom: number;
  panXPercent: number;
  panYPercent: number;
  faceCount?: number;
  faceIndex?: number;
}

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

  // Listeners & Wasm Brush / SmartFraming callbacks
  private onFramingChange?: () => void;
  private onBrushApplyHandler?: (weights: Float32Array) => Promise<ArrayBuffer | void> | void;
  private onSmartFrameHandler?: () => Promise<SmartFrameOutcome | null> | void;
  private onStageChange?: (stage: TargetInspectionStage) => void;
  private onBrushCommitted?: () => void;
  private brushThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBrushDispatchTime = 0;
  private brushSeq = 0;
  private brushCursorEl: HTMLElement | null = null;
  private captionResetTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(el: StudioFramingElements, onFramingChange?: () => void) {
    this.el = el;
    this.onFramingChange = onFramingChange;
    this.bindEvents();
    this.updateBrushModeUI();
  }

  private get isBrushInteraction(): boolean {
    return this.brushActive && this.activeStage === 'importance';
  }

  public getActiveStage(): TargetInspectionStage {
    return this.activeStage;
  }

  public setActiveStage(stage: TargetInspectionStage): void {
    this.activeStage = stage;
    this.el.stageTabs.forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.stage === stage);
    });

    if (stage !== 'importance' && this.brushActive) {
      this.setBrushMode(false);
    }

    this.updateCaption();
    this.refreshCurrentStage();
    this.onStageChange?.(stage);
  }

  public isBrushModeActive(): boolean {
    return this.brushActive;
  }

  public setBrushMode(active: boolean): void {
    this.brushActive = active;
    if (active && this.activeStage !== 'importance') {
      this.activeStage = 'importance';
      this.el.stageTabs.forEach((tab) => {
        tab.classList.toggle('active', tab.dataset.stage === 'importance');
      });
      this.refreshCurrentStage();
      this.onStageChange?.('importance');
    }
    if (this.el.btnToggleBrush) {
      this.el.btnToggleBrush.classList.toggle('primary', active);
      this.el.btnToggleBrush.textContent = active ? 'Pincel de Foco (Ativo)' : 'Pincel de Foco Manual';
    }
    this.updateBrushModeUI();
    this.el.targetCanvas.style.cursor = active ? 'none' : 'grab';
    if (!active && this.brushCursorEl) {
      this.brushCursorEl.hidden = true;
    }
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
    const b = this.el.btnBrushMode;
    if (!b) return;
    b.textContent = this.brushMode === 'boost' ? 'Modo: + Reforçar' : 'Modo: − Reduzir';
    b.classList.toggle('mode-boost', this.brushMode === 'boost');
    b.classList.toggle('mode-reduce', this.brushMode === 'reduce');
    b.disabled = !this.brushActive;
    b.title = 'Alterna entre reforçar (mais fios) e reduzir (menos fios) na região pintada';
  }

  public setStageChangeHandler(fn: (stage: TargetInspectionStage) => void): void {
    this.onStageChange = fn;
  }

  public setBrushCommittedHandler(fn: () => void): void {
    this.onBrushCommitted = fn;
  }

  public setBrushApplyHandler(handler: (weights: Float32Array) => Promise<ArrayBuffer | void> | void): void {
    this.onBrushApplyHandler = handler;
  }

  public setSmartFrameHandler(handler: () => Promise<SmartFrameOutcome | null> | void): void {
    this.onSmartFrameHandler = handler;
  }

  /**
   * Executa o enquadramento automático (rosto ou cabeça e ombros) e aplica
   * zoom/pan aos sliders. Retorna o resultado aplicado ou `null`.
   */
  public async runSmartFrame(): Promise<SmartFrameOutcome | null> {
    if (!this.onSmartFrameHandler) return null;
    const btn = this.el.btnSmartFrame;
    const originalLabel = btn?.dataset.label ?? btn?.textContent ?? '';
    if (btn) {
      btn.dataset.label = originalLabel;
      btn.disabled = true;
      btn.textContent = 'Detectando…';
    }
    try {
      const res = await this.onSmartFrameHandler();
      if (!res) return null;
      const zoom = Math.max(0.5, Math.min(6, Number(res.zoom) || 1));
      const panX = Math.round(Math.max(-200, Math.min(200, Number(res.panXPercent) || 0)));
      const panY = Math.round(Math.max(-200, Math.min(200, Number(res.panYPercent) || 0)));
      this.el.zoomInput.value = zoom.toFixed(2);
      this.el.panXInput.value = String(panX);
      this.el.panYInput.value = String(panY);
      this.onFramingChange?.();
      if (btn && (res.faceCount ?? 0) > 1) {
        btn.textContent = `${originalLabel} (${(res.faceIndex ?? 0) + 1}/${res.faceCount})`;
        return { ...res, zoom, panXPercent: panX, panYPercent: panY };
      }
      if (btn) btn.textContent = originalLabel;
      return { ...res, zoom, panXPercent: panX, panYPercent: panY };
    } catch (err) {
      console.warn('[Weaver Art] Enquadramento automático falhou:', err);
      if (btn) btn.textContent = originalLabel;
      return null;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  public getManualBrushMask(): Float32Array | null {
    return this.manualImportanceMask;
  }

  public hasBrushStrokes(): boolean {
    const m = this.manualImportanceMask;
    if (!m) return false;
    for (let i = 0; i < m.length; i++) {
      if (m[i] !== 0) return true;
    }
    return false;
  }

  public resetBrushMask(): void {
    this.manualImportanceMask?.fill(0);
    this.refreshCurrentStage();
  }

  /** Chamado quando o enquadramento muda (Decisão 2): a máscara deixa de corresponder à foto. */
  public onFramingInvalidated(): void {
    if (!this.hasBrushStrokes()) return;
    this.resetBrushMask();
    this.flashCaption('Pincel limpo (enquadramento alterado)');
  }

  public flashCaption(text: string, durationMs = 2500): void {
    const captionEl =
      this.el.targetCaption ?? (typeof document !== 'undefined' ? document.getElementById('targetCaption') : null);
    if (!captionEl) return;
    if (this.captionResetTimer) clearTimeout(this.captionResetTimer);
    captionEl.textContent = text;
    this.captionResetTimer = setTimeout(() => {
      this.captionResetTimer = null;
      this.updateCaption();
    }, durationMs);
  }

  public clearManualBrush(): void {
    if (this.manualImportanceMask) {
      this.manualImportanceMask.fill(0);
      this.dispatchBrushApply(true);
      this.refreshCurrentStage();
      this.onBrushCommitted?.();
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
    if (buffers.dimensions && buffers.dimensions.length >= 4) {
      this.diagnosticDimensions = buffers.dimensions;
      const iw = buffers.dimensions[2] || buffers.dimensions[0];
      const ih = buffers.dimensions[3] || buffers.dimensions[1];
      if (iw !== this.maskWidth || ih !== this.maskHeight || !this.manualImportanceMask) {
        this.maskWidth = iw;
        this.maskHeight = ih;
        this.manualImportanceMask = new Float32Array(iw * ih);
      }
    } else if (buffers.dimensions && buffers.dimensions.length >= 2) {
      this.diagnosticDimensions = buffers.dimensions;
      const iw = buffers.dimensions[0] || 256;
      const ih = buffers.dimensions[1] || 256;
      if (iw !== this.maskWidth || ih !== this.maskHeight || !this.manualImportanceMask) {
        this.maskWidth = iw;
        this.maskHeight = ih;
        this.manualImportanceMask = new Float32Array(iw * ih);
      }
    } else if (!this.manualImportanceMask || this.manualImportanceMask.length !== this.maskWidth * this.maskHeight) {
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
      // Se o buffer tiver tamanho diferente de width x height (ex: 256x256 vs 500x500),
      // ajusta automaticamente para a dimensão real do buffer, evitando faixas corrompidas!
      let actualW = width;
      let actualH = height;
      if (data.length !== actualW * actualH * 4) {
        const side = Math.round(Math.sqrt(data.length / 4));
        if (side * side * 4 === data.length && side > 0) {
          actualW = side;
          actualH = side;
        } else {
          return;
        }
      }

      if (this.el.targetCanvas.width !== actualW || this.el.targetCanvas.height !== actualH) {
        this.el.targetCanvas.width = actualW;
        this.el.targetCanvas.height = actualH;
      }
      const idata = ctx.createImageData(actualW, actualH);
      idata.data.set(data);
      ctx.putImageData(idata, 0, 0);
    };

    switch (this.activeStage) {
      case 'prepared': {
        if (this.wasmPreparedRgba) {
          putData(this.wasmPreparedRgba, w, h);
        } else if (this.cachedPreparedRgba) {
          putData(this.cachedPreparedRgba, this.maskWidth, this.maskHeight);
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

  private normalizedPointer(e: PointerEvent | WheelEvent): { u: number; v: number } {
    const r = this.el.targetCanvas.getBoundingClientRect();
    return {
      u: Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width))),
      v: Math.min(1, Math.max(0, (e.clientY - r.top) / Math.max(1, r.height))),
    };
  }

  private paintBrushAtNormalized(u: number, v: number): void {
    this.paintBrushAt(u * this.maskWidth, v * this.maskHeight);
  }

  private ensureBrushCursor(): HTMLElement | null {
    if (this.brushCursorEl) return this.brushCursorEl;
    const canvas = this.el.targetCanvas;
    const container = canvas?.parentElement;
    if (!container) return null;
    let cur =
      typeof container.querySelector === 'function' ? container.querySelector<HTMLElement>('.brush-cursor') : null;
    if (!cur && typeof document !== 'undefined') {
      cur = document.createElement('div');
      cur.className = 'brush-cursor';
      cur.hidden = true;
      container.appendChild(cur);
    }
    if (cur) this.brushCursorEl = cur;
    return cur;
  }

  private updateBrushCursor(e: PointerEvent | WheelEvent): void {
    const cur = this.ensureBrushCursor();
    if (!cur) return;
    if (!this.isBrushInteraction) {
      cur.hidden = true;
      return;
    }
    const rect = this.el.targetCanvas.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const relY = e.clientY - rect.top;
    if (relX < 0 || relX > rect.width || relY < 0 || relY > rect.height) {
      cur.hidden = true;
      return;
    }
    cur.hidden = false;
    const pxDiameter = 2 * this.brushRadius * (rect.width / Math.max(1, this.maskWidth));
    cur.style.width = `${pxDiameter.toFixed(1)}px`;
    cur.style.height = `${pxDiameter.toFixed(1)}px`;
    cur.style.left = `${(relX + this.el.targetCanvas.offsetLeft).toFixed(1)}px`;
    cur.style.top = `${(relY + this.el.targetCanvas.offsetTop).toFixed(1)}px`;
  }

  private bindEvents(): void {
    const canvas = this.el.targetCanvas;
    if (typeof canvas.addEventListener !== 'function') return;

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let startPanX = 0;
    let startPanY = 0;

    canvas.addEventListener('pointerenter', (e) => {
      if (this.isBrushInteraction) this.updateBrushCursor(e);
    });

    canvas.addEventListener('pointerleave', () => {
      if (this.brushCursorEl) this.brushCursorEl.hidden = true;
    });

    canvas.addEventListener('pointerdown', (e) => {
      this.updateBrushCursor(e);
      const { u, v } = this.normalizedPointer(e);

      if (this.isBrushInteraction) {
        this.paintBrushAtNormalized(u, v);
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
      this.updateBrushCursor(e);
      if (!isDragging) return;

      if (this.isBrushInteraction) {
        const { u, v } = this.normalizedPointer(e);
        this.paintBrushAtNormalized(u, v);
        return;
      }

      // Drag to Pan
      const rect = canvas.getBoundingClientRect();
      let dx = e.clientX - startX;
      let dy = e.clientY - startY;

      const rotDeg = Number(this.el.rotationInput?.value) || 0;
      if (rotDeg !== 0) {
        const rotRad = (-rotDeg * Math.PI) / 180;
        const cos = Math.cos(rotRad);
        const sin = Math.sin(rotRad);
        const rdx = dx * cos - dy * sin;
        const rdy = dx * sin + dy * cos;
        dx = rdx;
        dy = rdy;
      }

      const zoom = Math.max(0.4, Number(this.el.zoomInput.value) || 1.0);

      const deltaPanX = (dx / rect.width) * (200 / zoom);
      const deltaPanY = (dy / rect.height) * (200 / zoom);

      const newPanX = Math.round(Math.max(-200, Math.min(200, startPanX + deltaPanX)));
      const newPanY = Math.round(Math.max(-200, Math.min(200, startPanY + deltaPanY)));

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
        canvas.style.cursor = this.isBrushInteraction ? 'none' : 'grab';
        if (this.isBrushInteraction) {
          this.dispatchBrushApply(true);
          this.onBrushCommitted?.();
        }
      }
    };
    canvas.addEventListener('pointerup', stopDrag);
    canvas.addEventListener('pointercancel', stopDrag);

    // Mouse wheel for Zoom
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (this.isBrushInteraction) {
          // Wheel adjusts brush radius in brush mode!
          this.brushRadius = Math.max(5, Math.min(60, this.brushRadius + (e.deltaY < 0 ? 2 : -2)));
          this.updateBrushCursor(e);
          return;
        }
        const currentZoom = Number(this.el.zoomInput.value) || 1.0;
        const zoomDelta = e.deltaY < 0 ? 0.05 : -0.05;
        const newZoom = Math.max(0.5, Math.min(6.0, currentZoom + zoomDelta));
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

    // Enquadramento automático pelo rosto (detector Viola-Jones no Wasm).
    // Cliques repetidos alternam entre os rostos detectados (fotos com mais de uma pessoa).
    this.el.btnSmartFrame?.addEventListener('click', () => {
      this.runSmartFrame();
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
    this.dispatchBrushApply(false);
  }

  private dispatchBrushApply(flushImmediate = false): void {
    if (!this.onBrushApplyHandler || !this.manualImportanceMask) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const timeSinceLast = now - this.lastBrushDispatchTime;
    const THROTTLE_MS = 150;

    if (flushImmediate || timeSinceLast >= THROTTLE_MS) {
      if (this.brushThrottleTimer) {
        clearTimeout(this.brushThrottleTimer);
        this.brushThrottleTimer = null;
      }
      this.lastBrushDispatchTime = now;
      this.executeBrushDispatch();
    } else if (!this.brushThrottleTimer) {
      this.brushThrottleTimer = setTimeout(() => {
        this.brushThrottleTimer = null;
        this.lastBrushDispatchTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
        this.executeBrushDispatch();
      }, THROTTLE_MS - timeSinceLast);
    }
  }

  private executeBrushDispatch(): void {
    if (!this.onBrushApplyHandler || !this.manualImportanceMask) return;
    const seq = ++this.brushSeq;
    const maskCopy = this.manualImportanceMask.slice();
    const result = this.onBrushApplyHandler(maskCopy);
    if (result && typeof (result as Promise<ArrayBuffer | void>).then === 'function') {
      (result as Promise<ArrayBuffer | void>)
        .then((newBuf) => {
          if (seq === this.brushSeq && newBuf instanceof ArrayBuffer) {
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
