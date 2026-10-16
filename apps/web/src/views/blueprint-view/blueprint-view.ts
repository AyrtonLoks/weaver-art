/**
 * Blueprint & CAM View Controller (ADR-004 / Sprint 4 Task 4.2).
 *
 * Implements the technical engineering CAD canvas for physical loom rim drilling,
 * interactive zoom & pan down to tenths of a millimeter, free wall inspection,
 * 1:1 tiled print grid overlay (A4, A3, Carta), mechanical diagnostics card,
 * coordinate table, and CAM/CNC export pipelines integrated with `weaver-cam` via Web Worker Wasm.
 */

import { createLoom, toTemplatePDF, toTemplateSVG, type Loom, type LoomConfig } from '@weaver-art/core';
import type { PaperSize } from './index.js';
import { BlueprintCanvas, type BlueprintCanvasOptions, type FreeWallInspectionInfo } from './blueprint-canvas.js';
import type { WeaverEngineClient } from '../../core-bridge/index.js';

export interface BlueprintViewElements {
  canvas: HTMLCanvasElement;
  paperSelect: HTMLSelectElement;
  drillDiameterInput: HTMLInputElement;
  marginInput: HTMLInputElement;
  overlapInput: HTMLInputElement;
  toggleGridInput: HTMLInputElement;
  toggleDimensionsInput: HTMLInputElement;
  togglePegNumbersInput: HTMLInputElement;
  linearPitchEl: HTMLElement;
  freeWallEl: HTMLElement;
  statusBadgeEl: HTMLElement;
  pegsTableBody: HTMLElement;
  btnZoomIn: HTMLButtonElement;
  btnZoomOut: HTMLButtonElement;
  btnZoomFit: HTMLButtonElement;
  btnZoomWall: HTMLButtonElement;
  btnExportPdf: HTMLButtonElement;
  btnExportSvg: HTMLButtonElement;
  btnExportCsv: HTMLButtonElement;
  btnExportGcode: HTMLButtonElement;
  // Optional CNC parameter inputs
  cncSpindleRpmInput?: HTMLInputElement;
  cncPlungeFeedInput?: HTMLInputElement;
  cncDrillDepthInput?: HTMLInputElement;
  cncPeckDepthInput?: HTMLInputElement;
  cncSafeZInput?: HTMLInputElement;
  cncRetractRInput?: HTMLInputElement;
}

export interface CncDrillingParams {
  spindleRpm: number;
  plungeFeedMmMin: number;
  safeZMm: number;
  drillDepthMm: number;
  peckDepthMm: number | null;
  retractRMm: number;
}

export class BlueprintView {
  private readonly el: BlueprintViewElements;
  private loomConfig: LoomConfig;
  private loom: Loom;
  private drillDiameterMm: number;
  private marginMm: number;
  private overlapMm: number;
  private paper: PaperSize = 'A4';
  private showPrintGrid = true;
  private showDimensions = true;
  private showPegNumbers = true;

  private blueprintCanvas: BlueprintCanvas;
  private engineClient: WeaverEngineClient | null = null;
  private highlightedPegIndex: number | null = null;

  constructor(el: BlueprintViewElements, initialLoom: LoomConfig) {
    this.el = el;
    this.loomConfig = structuredClone(initialLoom);
    this.loom = createLoom(this.loomConfig);
    this.drillDiameterMm = Number(el.drillDiameterInput.value) || 2.0;
    this.marginMm = Number(el.marginInput.value) || 15.0;
    this.overlapMm = Number(el.overlapInput.value) || 10.0;
    this.paper = (el.paperSelect.value as PaperSize) || 'A4';

    const canvasOptions: BlueprintCanvasOptions = {
      drillDiameterMm: this.drillDiameterMm,
      marginMm: this.marginMm,
      overlapMm: this.overlapMm,
      paper: this.paper,
      showPrintGrid: this.showPrintGrid,
      showDimensions: this.showDimensions,
      showPegNumbers: this.showPegNumbers,
    };

    this.blueprintCanvas = new BlueprintCanvas(el.canvas, this.loom, canvasOptions);

    this.blueprintCanvas.onPegHover = (idx, info) => {
      this.handlePegHover(idx, info);
    };

    this.blueprintCanvas.onPegSelect = (idx, info) => {
      this.handlePegSelect(idx, info);
    };

    this.bindEvents();
    this.updateDiagnosticsAndTable();
    this.blueprintCanvas.fitView();
  }

  public setEngineClient(client: WeaverEngineClient): void {
    this.engineClient = client;
  }

  public setLoomConfig(cfg: LoomConfig, drillBitMm?: number): void {
    this.loomConfig = structuredClone(cfg);
    this.loom = createLoom(this.loomConfig);
    if (drillBitMm !== undefined && drillBitMm > 0) {
      this.drillDiameterMm = drillBitMm;
      this.el.drillDiameterInput.value = String(drillBitMm);
    }

    this.blueprintCanvas.setLoom(this.loom, {
      drillDiameterMm: this.drillDiameterMm,
      marginMm: this.marginMm,
      overlapMm: this.overlapMm,
      paper: this.paper,
    });

    this.updateDiagnosticsAndTable();
  }

  public resize(): void {
    this.blueprintCanvas.resize();
  }

  public fitView(): void {
    this.blueprintCanvas.fitView();
  }

  public zoomFreeWall(): void {
    this.blueprintCanvas.zoomFreeWall(this.highlightedPegIndex ?? 0);
  }

  public render(): void {
    this.blueprintCanvas.render();
  }

  private bindEvents(): void {
    // Toolbar buttons
    this.el.btnZoomIn.addEventListener('click', () => this.blueprintCanvas.zoomIn());
    this.el.btnZoomOut.addEventListener('click', () => this.blueprintCanvas.zoomOut());
    this.el.btnZoomFit.addEventListener('click', () => this.fitView());
    this.el.btnZoomWall.addEventListener('click', () => this.zoomFreeWall());

    // Inputs & Toggles
    this.el.paperSelect.addEventListener('change', () => {
      this.paper = this.el.paperSelect.value as PaperSize;
      this.blueprintCanvas.updateOptions({ paper: this.paper });
    });

    this.el.drillDiameterInput.addEventListener('input', () => {
      this.drillDiameterMm = Math.max(0.2, Number(this.el.drillDiameterInput.value) || 2.0);
      this.blueprintCanvas.updateOptions({ drillDiameterMm: this.drillDiameterMm });
      this.updateDiagnosticsAndTable();
    });

    this.el.marginInput.addEventListener('input', () => {
      this.marginMm = Math.max(2.0, Number(this.el.marginInput.value) || 15.0);
      this.blueprintCanvas.updateOptions({ marginMm: this.marginMm });
    });

    this.el.overlapInput.addEventListener('input', () => {
      this.overlapMm = Math.max(0, Number(this.el.overlapInput.value) || 10.0);
      this.blueprintCanvas.updateOptions({ overlapMm: this.overlapMm });
    });

    this.el.toggleGridInput.addEventListener('change', () => {
      this.showPrintGrid = this.el.toggleGridInput.checked;
      this.blueprintCanvas.updateOptions({ showPrintGrid: this.showPrintGrid });
    });

    this.el.toggleDimensionsInput.addEventListener('change', () => {
      this.showDimensions = this.el.toggleDimensionsInput.checked;
      this.blueprintCanvas.updateOptions({ showDimensions: this.showDimensions });
    });

    this.el.togglePegNumbersInput.addEventListener('change', () => {
      this.showPegNumbers = this.el.togglePegNumbersInput.checked;
      this.blueprintCanvas.updateOptions({ showPegNumbers: this.showPegNumbers });
    });

    // Exports
    this.el.btnExportPdf.addEventListener('click', () => void this.exportPdf());
    this.el.btnExportSvg.addEventListener('click', () => void this.exportSvg());
    this.el.btnExportCsv.addEventListener('click', () => void this.exportCsv());
    this.el.btnExportGcode.addEventListener('click', () => void this.exportGcode());

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', () => {
        this.resize();
      });
    }
  }

  private handlePegHover(index: number | null, info?: FreeWallInspectionInfo): void {
    if (index !== null && info) {
      this.updateDiagnosticsWithInfo(info);
      this.highlightTableRow(index);
    } else if (this.highlightedPegIndex !== null) {
      const selInfo = this.blueprintCanvas.getInspectedFreeWallInfo(this.highlightedPegIndex);
      this.updateDiagnosticsWithInfo(selInfo);
    } else {
      this.updateDiagnosticsAndTable();
    }
  }

  private handlePegSelect(index: number, info: FreeWallInspectionInfo): void {
    this.highlightedPegIndex = index;
    this.updateDiagnosticsWithInfo(info);
    this.highlightTableRow(index);
  }

  private highlightTableRow(index: number): void {
    const rows = this.el.pegsTableBody.querySelectorAll<HTMLTableRowElement>('tr');
    rows.forEach((row) => {
      const idx = Number(row.getAttribute('data-peg-index'));
      if (idx === index) {
        row.style.background = 'rgba(56, 189, 248, 0.2)';
        row.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      } else {
        row.style.background = '';
      }
    });
  }

  private updateDiagnosticsWithInfo(info: FreeWallInspectionInfo): void {
    this.el.linearPitchEl.textContent = `${info.centerDistanceMm.toFixed(2)} mm`;
    this.el.freeWallEl.textContent = `${info.freeWallMm.toFixed(2)} mm`;

    const badge = this.el.statusBadgeEl;
    badge.className = 'badge';

    if (info.status === 'safe') {
      badge.classList.add('badge-success');
      badge.textContent = info.statusLabel;
    } else if (info.status === 'warning') {
      badge.classList.add('badge-warning');
      badge.textContent = info.statusLabel;
    } else {
      badge.classList.add('badge-danger');
      badge.textContent = info.statusLabel;
    }
  }

  public updateDiagnosticsAndTable(): void {
    const pegs = this.loom.pegs;
    const n = pegs.length;
    let minLinearPitchMm = this.loom.minSpacingMm;

    if (this.loomConfig.shape === 'circle') {
      const r = this.loom.radiusMm;
      minLinearPitchMm = 2 * r * Math.sin(Math.PI / n);
    }

    const freeWallMm = minLinearPitchMm - this.drillDiameterMm;

    this.el.linearPitchEl.textContent = `${minLinearPitchMm.toFixed(2)} mm`;
    this.el.freeWallEl.textContent = `${freeWallMm.toFixed(2)} mm`;

    const badge = this.el.statusBadgeEl;
    badge.className = 'badge';

    if (freeWallMm >= 1.5) {
      badge.classList.add('badge-success');
      badge.textContent = 'Seguro (parede ≥ 1.5 mm)';
    } else if (freeWallMm >= 0.5) {
      badge.classList.add('badge-warning');
      badge.textContent = 'Alerta Parede Fina (< 1.5 mm)';
    } else {
      badge.classList.add('badge-danger');
      badge.textContent = 'Erro Colisão de Broca (< 0.5 mm)';
    }

    // Populate Coordinate Table
    const ox = this.loom.extentMm / 2;
    const oy = this.loom.extentMm / 2;

    const rows: string[] = [];
    for (const p of pegs) {
      const xm = p.x - ox;
      const ym = p.y - oy;
      const deg = ((p.angle * 180) / Math.PI + 360) % 360;
      rows.push(`
        <tr data-peg-index="${p.index}">
          <td style="text-align: left; font-weight: 600">${p.index + 1}</td>
          <td>${deg.toFixed(1)}°</td>
          <td>${xm.toFixed(2)}</td>
          <td>${ym.toFixed(2)}</td>
        </tr>
      `);
    }

    this.el.pegsTableBody.innerHTML = rows.join('');

    // Row click listeners
    this.el.pegsTableBody.querySelectorAll('tr').forEach((tr) => {
      tr.addEventListener('click', () => {
        const idx = Number(tr.getAttribute('data-peg-index'));
        this.highlightPeg(idx);
      });
    });
  }

  private highlightPeg(index: number): void {
    this.highlightedPegIndex = index;
    this.blueprintCanvas.highlightPeg(index);
    const info = this.blueprintCanvas.getInspectedFreeWallInfo(index);
    this.updateDiagnosticsWithInfo(info);
    this.highlightTableRow(index);
  }

  private getWasmConfigJson(): string {
    const shape =
      this.loomConfig.shape === 'rectangle'
        ? 'RECTANGULAR'
        : this.loomConfig.shape === 'custom'
          ? 'CIRCULAR'
          : 'CIRCULAR';
    return JSON.stringify({
      shape,
      pinCount: this.loom.pegs.length,
      diameterMm: 'diameterMm' in this.loomConfig ? this.loomConfig.diameterMm : this.loom.extentMm,
      widthMm: this.loom.widthMm,
      heightMm: this.loom.heightMm,
      pinDiameterMm: this.loom.pegRadiusMm * 2,
      drillBitMm: this.drillDiameterMm,
      edgeMarginMm: this.marginMm,
    });
  }

  // =========================================================================
  // CAM & Technical Exports
  // =========================================================================

  public async exportPdf(): Promise<void> {
    try {
      if (this.engineClient?.isReady()) {
        try {
          const pdfBytes = await this.engineClient.exportCam('blueprint_pdf', this.getWasmConfigJson());
          if (pdfBytes instanceof Uint8Array && pdfBytes.length > 0) {
            this.downloadBlob(`gabarito-furacao-${this.loomConfig.shape}-1a1.pdf`, pdfBytes, 'application/pdf');
            return;
          }
        } catch (wasmErr) {
          console.warn('Wasm PDF export fallback:', wasmErr);
        }
      }

      // Fallback: TypeScript Core PDF generator
      const pdf = toTemplatePDF(this.loomConfig, {
        paper: this.paper,
        drillDiameterMm: this.drillDiameterMm,
        marginMm: this.marginMm,
        overlapMm: this.overlapMm,
      });
      this.downloadBlob(`gabarito-furacao-${this.loomConfig.shape}.pdf`, pdf, 'application/pdf');
    } catch (err) {
      this.notifyError('Erro ao gerar Gabarito PDF', err);
    }
  }

  public async exportSvg(): Promise<void> {
    try {
      if (this.engineClient?.isReady()) {
        try {
          const svg = await this.engineClient.exportCam('blueprint_svg', this.getWasmConfigJson());
          if (typeof svg === 'string' && svg.startsWith('<svg')) {
            this.downloadBlob(`gabarito-furacao-${this.loomConfig.shape}-1a1.svg`, svg, 'image/svg+xml');
            return;
          }
        } catch (wasmErr) {
          console.warn('Wasm SVG export fallback:', wasmErr);
        }
      }

      // Fallback: TypeScript Core SVG generator
      const svg = toTemplateSVG(this.loomConfig, {
        drillDiameterMm: this.drillDiameterMm,
        marginMm: this.marginMm,
      });
      this.downloadBlob(`gabarito-furacao-${this.loomConfig.shape}.svg`, svg, 'image/svg+xml');
    } catch (err) {
      this.notifyError('Erro ao gerar Gabarito SVG', err);
    }
  }

  public async exportCsv(): Promise<void> {
    try {
      if (this.engineClient?.isReady()) {
        try {
          const csv = await this.engineClient.exportCam('drilling_csv', this.getWasmConfigJson());
          if (typeof csv === 'string' && csv.includes('pin_number')) {
            this.downloadBlob(`tabela-furacao-${this.loomConfig.shape}.csv`, csv, 'text/csv;charset=utf-8');
            return;
          }
        } catch (wasmErr) {
          console.warn('Wasm CSV export fallback:', wasmErr);
        }
      }

      // Comprehensive Mechanical CSV matching weaver-cam format:
      // pin_number,angle_deg,x_mm,y_mm,normal_x,normal_y,chord_to_next_mm,free_wall_mm
      const pegs = this.loom.pegs;
      const n = pegs.length;
      const ox = this.loom.extentMm / 2;
      const oy = this.loom.extentMm / 2;
      const lines: string[] = ['pin_number,angle_deg,x_mm,y_mm,normal_x,normal_y,chord_to_next_mm,free_wall_mm'];

      for (let i = 0; i < n; i++) {
        const p = pegs[i];
        const pNext = pegs[(i + 1) % n];
        const xm = p.x - ox;
        const ym = p.y - oy;
        const deg = ((p.angle * 180) / Math.PI + 360) % 360;

        const chordToNext = n > 1 ? Math.hypot(pNext.x - p.x, pNext.y - p.y) : 0.0;
        const freeWall = n > 1 ? chordToNext - this.drillDiameterMm : 0.0;

        lines.push(
          `${p.index + 1},${deg.toFixed(4)},${xm.toFixed(4)},${ym.toFixed(4)},${p.nx.toFixed(4)},${p.ny.toFixed(4)},${chordToNext.toFixed(4)},${freeWall.toFixed(4)}`,
        );
      }

      const csvContent = lines.join('\n') + '\n';
      this.downloadBlob(`tabela-furacao-${this.loomConfig.shape}.csv`, csvContent, 'text/csv;charset=utf-8');
    } catch (err) {
      this.notifyError('Erro ao gerar Tabela de Furos CSV', err);
    }
  }

  public async exportGcode(): Promise<void> {
    try {
      // Read machining parameters from UI elements or defaults
      const spindleRpm = Number(this.el.cncSpindleRpmInput?.value) || 12000;
      const plungeFeedMmMin = Number(this.el.cncPlungeFeedInput?.value) || 300.0;
      const drillDepthMm = Number(this.el.cncDrillDepthInput?.value) || 10.0;
      const rawPeck = this.el.cncPeckDepthInput ? Number(this.el.cncPeckDepthInput.value) : 2.0;
      const peckDepthMm = rawPeck > 0 ? rawPeck : null;
      const safeZMm = Number(this.el.cncSafeZInput?.value) || 5.0;
      const retractRMm = Number(this.el.cncRetractRInput?.value) || 1.0;

      const params: CncDrillingParams = {
        spindleRpm,
        plungeFeedMmMin,
        drillDepthMm,
        peckDepthMm,
        safeZMm,
        retractRMm,
      };

      // Generate standard ISO/GRBL G-code matching weaver-cam gcode_exporter.rs
      const gcode = this.generateDrillingGcode(params);
      this.downloadBlob(`furacao-${this.loomConfig.shape}-cnc.gcode`, gcode, 'text/plain;charset=utf-8');
    } catch (err) {
      this.notifyError('Erro ao gerar G-code CNC', err);
    }
  }

  public generateDrillingGcode(params: CncDrillingParams): string {
    const pegs = this.loom.pegs;
    const n = pegs.length;
    const ox = this.loom.extentMm / 2;
    const oy = this.loom.extentMm / 2;

    const safeZ = Math.abs(params.safeZMm);
    const zDepth = Math.abs(params.drillDepthMm);
    const rPlane = Math.abs(params.retractRMm);
    const feed = params.plungeFeedMmMin;
    const usePeck = params.peckDepthMm !== null && params.peckDepthMm > 0;
    const peckQ = params.peckDepthMm ?? 0.0;

    const cycleName = usePeck ? `G83 Ciclo Pica-Pau (Q = ${peckQ.toFixed(2)} mm)` : 'G81 Ciclo de Furacao Simples';

    const lines: string[] = [
      `( ========================================================= )`,
      `( Weaver Art -- Programa CNC de Furacao do Aro             )`,
      `( Total de Furos: ${n}, Broca: Ø ${this.drillDiameterMm.toFixed(2)} mm, Pinos: ${n} )`,
      `( Fuso: ${params.spindleRpm} RPM, Avanco: ${feed.toFixed(1)} mm/min, Ciclo: ${cycleName} )`,
      `( Z Seguro: ${safeZ.toFixed(2)} mm, Profundidade Z: -${zDepth.toFixed(2)} mm, Plano R: ${rPlane.toFixed(2)} mm )`,
      `( ========================================================= )`,
      ``,
      `G21 ( Unidades em milimetros )`,
      `G90 ( Coordenadas absolutas )`,
      `G17 ( Plano de trabalho XY )`,
      `G94 ( Avanco em mm/min )`,
      `S${params.spindleRpm} M03 ( Liga fuso sentido horario )`,
      `G00 Z${safeZ.toFixed(4)} ( Posiciona em Z seguro )`,
      ``,
      `( --- Inicio da Furacao Perimetrica Sequencial --- )`,
    ];

    for (let i = 0; i < n; i++) {
      const p = pegs[i];
      const x = (p.x - ox).toFixed(4);
      const y = (-(p.y - oy)).toFixed(4); // Invert Y for standard CNC Cartesian plane (Y+ forward)

      if (usePeck) {
        lines.push(
          `G83 X${x} Y${y} Z-${zDepth.toFixed(4)} R${rPlane.toFixed(4)} Q${peckQ.toFixed(4)} F${feed.toFixed(1)} ( Furo ${i + 1}/${n} )`,
        );
      } else {
        lines.push(
          `G81 X${x} Y${y} Z-${zDepth.toFixed(4)} R${rPlane.toFixed(4)} F${feed.toFixed(1)} ( Furo ${i + 1}/${n} )`,
        );
      }
    }

    lines.push(
      ``,
      `( --- Fim da Furacao e Retracao Final --- )`,
      `G80 ( Cancela ciclo enlatado de furacao )`,
      `G00 Z${(safeZ * 3).toFixed(4)} ( Recuo final para Z seguro )`,
      `M05 ( Desliga fuso )`,
      `G00 X0.0000 Y0.0000 ( Retorno a origem XY )`,
      `M30 ( Fim do programa e rebobina )`,
      ``,
    );

    return lines.join('\n');
  }

  private downloadBlob(filename: string, content: BlobPart | Uint8Array, mimeType: string): void {
    let blobPart: BlobPart;
    if (content instanceof Uint8Array) {
      const copy = new ArrayBuffer(content.byteLength);
      new Uint8Array(copy).set(content);
      blobPart = copy;
    } else {
      blobPart = content as BlobPart;
    }
    const blob = content instanceof Blob ? content : new Blob([blobPart], { type: mimeType });
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      const url = URL.createObjectURL(blob);
      if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    }
  }

  private notifyError(prefix: string, err: unknown): void {
    const msg = `${prefix}: ${err instanceof Error ? err.message : String(err)}`;
    if (typeof alert !== 'undefined') {
      alert(msg);
    } else {
      console.error(msg);
    }
  }
}
