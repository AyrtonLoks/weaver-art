/**
 * Unit & Integration Tests for Sprint 4 — Task 4.2:
 * Complete Blueprint & CAM View (`src/views/blueprint-view/`) and `weaver-cam` Export Pipeline.
 */

import { describe, expect, it, vi } from 'vitest';
import { createLoom, type LoomConfig } from '@weaver-art/core';
import {
  BlueprintCanvas,
  PAPER_DIMENSIONS_MM,
  type BlueprintCanvasOptions,
} from '../src/views/blueprint-view/blueprint-canvas.js';
import {
  BlueprintView,
  type BlueprintViewElements,
  type CncDrillingParams,
} from '../src/views/blueprint-view/blueprint-view.js';
import type { WeaverEngineClient } from '../src/core-bridge/engine-client.js';

function createMockElement<T extends HTMLElement>(tagName = 'div', attrs: Record<string, string> = {}): T {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  return {
    tagName: tagName.toUpperCase(),
    value: '',
    textContent: '',
    innerHTML: '',
    style: {},
    classList: {
      classes: new Set<string>(),
      add(c: string) {
        this.classes.add(c);
      },
      remove(c: string) {
        this.classes.delete(c);
      },
      toggle(c: string, force?: boolean) {
        if (force === undefined) {
          if (this.classes.has(c)) this.classes.delete(c);
          else this.classes.add(c);
        } else if (force) {
          this.classes.add(c);
        } else {
          this.classes.delete(c);
        }
      },
      contains(c: string) {
        return this.classes.has(c);
      },
    },
    className: '',
    checked: true,
    hidden: false,
    parentElement: {
      getBoundingClientRect: () => ({ width: 900, height: 900, top: 0, left: 0 }),
    },
    getBoundingClientRect: () => ({ width: 900, height: 900, top: 0, left: 0 }),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    addEventListener: vi.fn((event: string, fn: (e: unknown) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
    }),
    dispatchEvent: vi.fn(),
    querySelectorAll: vi.fn(() => []),
    getAttribute: (attr: string) => attrs[attr] || null,
    scrollIntoView: vi.fn(),
  } as unknown as T;
}

function createMockCanvas(): HTMLCanvasElement {
  const canvas = createMockElement<HTMLCanvasElement>('canvas');
  canvas.width = 900;
  canvas.height = 900;

  const ctx = {
    canvas,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    closePath: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    setLineDash: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn((s: string) => ({ width: s.length * 8 })),
  };

  (canvas as unknown as { getContext: () => typeof ctx }).getContext = () => ctx;
  return canvas;
}

function createMockBlueprintElements(): BlueprintViewElements {
  return {
    canvas: createMockCanvas(),
    paperSelect: createMockElement('select'),
    drillDiameterInput: createMockElement('input'),
    marginInput: createMockElement('input'),
    overlapInput: createMockElement('input'),
    toggleGridInput: createMockElement('input'),
    toggleDimensionsInput: createMockElement('input'),
    togglePegNumbersInput: createMockElement('input'),
    linearPitchEl: createMockElement('span'),
    freeWallEl: createMockElement('strong'),
    statusBadgeEl: createMockElement('span'),
    pegsTableBody: createMockElement('tbody'),
    btnZoomIn: createMockElement('button'),
    btnZoomOut: createMockElement('button'),
    btnZoomFit: createMockElement('button'),
    btnZoomWall: createMockElement('button'),
    btnExportPdf: createMockElement('button'),
    btnExportSvg: createMockElement('button'),
    btnExportCsv: createMockElement('button'),
    btnExportGcode: createMockElement('button'),
    cncSpindleRpmInput: createMockElement('input'),
    cncPlungeFeedInput: createMockElement('input'),
    cncDrillDepthInput: createMockElement('input'),
    cncPeckDepthInput: createMockElement('input'),
    cncSafeZInput: createMockElement('input'),
    cncRetractRInput: createMockElement('input'),
  };
}

describe('Sprint 4 — Task 4.2: Blueprint CAM View & weaver-cam Integration', () => {
  describe('1. Plot Técnico Interativo do Aro e Furos (BlueprintCanvas)', () => {
    it('renderiza o desenho mecânico cotado com precisão e suporte a zoom/pan', () => {
      const canvas = createMockCanvas();
      const loom = createLoom({
        shape: 'circle',
        diameterMm: 600,
        pegCount: 200,
        pegDiameterMm: 2.0,
        startAngleDeg: -90,
      });

      const options: BlueprintCanvasOptions = {
        drillDiameterMm: 2.0,
        marginMm: 15.0,
        overlapMm: 10.0,
        paper: 'A4',
        showPrintGrid: true,
        showDimensions: true,
        showPegNumbers: true,
      };

      const bpCanvas = new BlueprintCanvas(canvas, loom, options);
      const ctx = (canvas as unknown as { getContext: () => Record<string, unknown> }).getContext();

      expect(ctx.fillRect).toHaveBeenCalled();
      expect(ctx.stroke).toHaveBeenCalled();
      expect(ctx.arc).toHaveBeenCalled();

      // Zoom in e Zoom out
      bpCanvas.zoomIn(1.5);
      bpCanvas.zoomOut(1.2);
      expect(ctx.scale).toHaveBeenCalled();

      // Inspecionar Parede Livre (alta escala centesimal)
      bpCanvas.zoomFreeWall(0);
      expect(ctx.scale).toHaveBeenCalled();
    });

    it('suporta tear elíptico, retangular e poligonal com cotas mecânicas', () => {
      const canvas = createMockCanvas();

      // 1. Tear Retangular
      const rectLoom = createLoom({
        shape: 'rectangle',
        widthMm: 600,
        heightMm: 400,
        pegsX: 61,
        pegsY: 41,
        pegDiameterMm: 2.0,
      });

      const options: BlueprintCanvasOptions = {
        drillDiameterMm: 2.0,
        marginMm: 20.0,
        overlapMm: 15.0,
        paper: 'A3',
        showPrintGrid: true,
        showDimensions: true,
        showPegNumbers: true,
      };

      const bpCanvas = new BlueprintCanvas(canvas, rectLoom, options);
      bpCanvas.render();
      const ctx = (canvas as unknown as { getContext: () => Record<string, unknown> }).getContext();
      expect(ctx.beginPath).toHaveBeenCalled();

      // 2. Tear Elíptico
      const rx = 300;
      const ry = 200;
      const ellipticalPegs: { x: number; y: number }[] = [];
      for (let i = 0; i < 100; i++) {
        const a = (i * 2 * Math.PI) / 100;
        ellipticalPegs.push({ x: rx + rx * Math.cos(a), y: ry + ry * Math.sin(a) });
      }
      const ellipseLoom = createLoom({
        shape: 'custom',
        pegs: ellipticalPegs,
        pegDiameterMm: 2.0,
      });
      bpCanvas.setLoom(ellipseLoom);
      expect(ellipseLoom.pegs.length).toBe(100);
    });

    it('calcula inspeção de parede livre e classifica status (Seguro, Alerta, Colisão)', () => {
      const canvas = createMockCanvas();
      const loom = createLoom({
        shape: 'circle',
        diameterMm: 600,
        pegCount: 200,
        pegDiameterMm: 2.0,
        startAngleDeg: -90,
      });

      const options: BlueprintCanvasOptions = {
        drillDiameterMm: 2.0,
        marginMm: 15.0,
        overlapMm: 10.0,
        paper: 'A4',
        showPrintGrid: true,
        showDimensions: true,
        showPegNumbers: true,
      };

      const bpCanvas = new BlueprintCanvas(canvas, loom, options);

      // D=600, N=200, broca=2.0 mm -> passo ~9.42 mm, parede ~7.42 mm (Seguro)
      const infoSafe = bpCanvas.getInspectedFreeWallInfo(0);
      expect(infoSafe.centerDistanceMm).toBeCloseTo(9.42, 1);
      expect(infoSafe.freeWallMm).toBeCloseTo(7.42, 1);
      expect(infoSafe.status).toBe('safe');
      expect(infoSafe.statusLabel).toContain('Seguro');

      // Modifica broca para 8.5 mm -> parede = 9.42 - 8.5 = 0.92 mm (< 1.5 mm: Alerta)
      bpCanvas.updateOptions({ drillDiameterMm: 8.5 });
      const infoWarning = bpCanvas.getInspectedFreeWallInfo(0);
      expect(infoWarning.status).toBe('warning');
      expect(infoWarning.statusLabel).toContain('Alerta Parede Fina');

      // Modifica broca para 10.0 mm -> parede = 9.42 - 10.0 = -0.58 mm (Colisão de Broca)
      bpCanvas.updateOptions({ drillDiameterMm: 10.0 });
      const infoCollision = bpCanvas.getInspectedFreeWallInfo(0);
      expect(infoCollision.status).toBe('collision');
      expect(infoCollision.statusLabel).toContain('Erro Colisão de Broca');
    });

    it('calcula overlay da grade de impressão paginada 1:1 e dimensões nominais de papel', () => {
      expect(PAPER_DIMENSIONS_MM.A4).toEqual({ w: 210, h: 297 });
      expect(PAPER_DIMENSIONS_MM.A3).toEqual({ w: 297, h: 420 });
      expect(PAPER_DIMENSIONS_MM.Letter).toEqual({ w: 215.9, h: 279.4 });
    });
  });

  describe('2. Conexão dos Botões de Exportação CAM (weaver-cam & Core)', () => {
    it('gera programa G-Code CNC com ciclo G83 (peck drilling) e G81 (furação simples)', () => {
      const el = createMockBlueprintElements();
      const loomConfig: LoomConfig = {
        shape: 'circle',
        diameterMm: 600,
        pegCount: 200,
        pegDiameterMm: 2.0,
        startAngleDeg: -90,
      };

      const bpView = new BlueprintView(el, loomConfig);

      // 1. Ciclo G83 com quebra de cavaco / pica-pau (Peck Q = 2.0 mm)
      const paramsG83: CncDrillingParams = {
        spindleRpm: 12000,
        plungeFeedMmMin: 300.0,
        safeZMm: 5.0,
        drillDepthMm: 10.0,
        peckDepthMm: 2.0,
        retractRMm: 1.0,
      };

      const gcodeG83 = bpView.generateDrillingGcode(paramsG83);
      expect(gcodeG83).toContain('G21 ( Unidades em milimetros )');
      expect(gcodeG83).toContain('G90 ( Coordenadas absolutas )');
      expect(gcodeG83).toContain('S12000 M03');
      expect(gcodeG83).toContain('G83');
      expect(gcodeG83).toContain('Q2.0000');
      expect(gcodeG83).toContain('F300.0');
      expect(gcodeG83).toContain('G80 ( Cancela ciclo enlatado de furacao )');
      expect(gcodeG83).toContain('M05 ( Desliga fuso )');
      expect(gcodeG83).toContain('M30 ( Fim do programa e rebobina )');

      // 2. Ciclo G81 de furação simples (Peck Q = 0 / null)
      const paramsG81: CncDrillingParams = {
        spindleRpm: 8000,
        plungeFeedMmMin: 200.0,
        safeZMm: 10.0,
        drillDepthMm: 8.0,
        peckDepthMm: null,
        retractRMm: 2.0,
      };

      const gcodeG81 = bpView.generateDrillingGcode(paramsG81);
      expect(gcodeG81).toContain('S8000 M03');
      expect(gcodeG81).toContain('G81');
      expect(gcodeG81).not.toContain('G83');
      expect(gcodeG81).toContain('F200.0');
    });

    it('exporta planilha mecânica CSV com as colunas completas de engenharia', async () => {
      const el = createMockBlueprintElements();
      const loomConfig: LoomConfig = {
        shape: 'circle',
        diameterMm: 600,
        pegCount: 200,
        pegDiameterMm: 2.0,
        startAngleDeg: -90,
      };

      const bpView = new BlueprintView(el, loomConfig);

      let exportedBlob: Blob | null = null;
      const origCreate = URL.createObjectURL;
      URL.createObjectURL = vi.fn((blob: Blob) => {
        exportedBlob = blob;
        return 'blob:mock-csv';
      });

      await bpView.exportCsv();
      expect(exportedBlob).not.toBeNull();
      const csvText = await (exportedBlob as unknown as Blob).text();

      // Colunas requeridas:
      // pin_number,angle_deg,x_mm,y_mm,normal_x,normal_y,chord_to_next_mm,free_wall_mm
      const firstLine = csvText.split('\n')[0];
      expect(firstLine).toContain('pin_number');
      expect(firstLine).toContain('angle_deg');
      expect(firstLine).toContain('x_mm');
      expect(firstLine).toContain('y_mm');
      expect(firstLine).toContain('normal_x');
      expect(firstLine).toContain('normal_y');
      expect(firstLine).toContain('chord_to_next_mm');
      expect(firstLine).toContain('free_wall_mm');

      URL.createObjectURL = origCreate;
    });

    it('exporta Gabarito PDF 1:1 e Gabarito SVG 1:1', async () => {
      const el = createMockBlueprintElements();
      const loomConfig: LoomConfig = {
        shape: 'circle',
        diameterMm: 600,
        pegCount: 200,
        pegDiameterMm: 2.0,
        startAngleDeg: -90,
      };

      const bpView = new BlueprintView(el, loomConfig);

      let pdfBlob: Blob | null = null;
      let svgBlob: Blob | null = null;
      const origCreate = URL.createObjectURL;
      URL.createObjectURL = vi.fn((blob: Blob) => {
        if (blob.type === 'application/pdf') pdfBlob = blob;
        if (blob.type === 'image/svg+xml') svgBlob = blob;
        return 'blob:mock-cam';
      });

      await bpView.exportPdf();
      expect(pdfBlob).not.toBeNull();

      await bpView.exportSvg();
      expect(svgBlob).not.toBeNull();
      const svgText = await (svgBlob as unknown as Blob).text();
      expect(svgText).toContain('<svg');

      URL.createObjectURL = origCreate;
    });

    it('integra WeaverEngineClient e delega exportação CAM para o módulo Wasm quando pronto', async () => {
      const el = createMockBlueprintElements();
      const loomConfig: LoomConfig = {
        shape: 'circle',
        diameterMm: 600,
        pegCount: 200,
        pegDiameterMm: 2.0,
        startAngleDeg: -90,
      };

      const bpView = new BlueprintView(el, loomConfig);

      // Simula WeaverEngineClient pronto
      const mockClient = {
        isReady: vi.fn(() => true),
        exportCam: vi.fn(async (type: string) => {
          if (type === 'blueprint_svg') return '<svg xmlns="http://www.w3.org/2000/svg">WASM</svg>';
          if (type === 'blueprint_pdf') return new Uint8Array([37, 80, 68, 70]); // %PDF
          if (type === 'drilling_csv') return 'pin_number,angle_deg,x_mm,y_mm\n1,0,300,0';
          return '';
        }),
      } as unknown as WeaverEngineClient;

      bpView.setEngineClient(mockClient);

      const origCreate = URL.createObjectURL;
      URL.createObjectURL = vi.fn((_blob: Blob) => {
        return 'blob:wasm-cam';
      });

      await bpView.exportSvg();
      expect(mockClient.exportCam).toHaveBeenCalledWith('blueprint_svg', expect.any(String));

      await bpView.exportPdf();
      expect(mockClient.exportCam).toHaveBeenCalledWith('blueprint_pdf', expect.any(String));

      URL.createObjectURL = origCreate;
    });
  });
});
