import { describe, expect, it, vi } from 'vitest';
import { createLoom } from '@weaver-art/core';
import type { LoomConfig } from '../src/domain-contracts/index.js';
import { BlueprintView, type BlueprintViewElements } from '../src/views/blueprint-view/blueprint-view.js';
import { StudioViewManager, type StudioFramingElements } from '../src/views/studio-view/studio-view.js';

function createMockElement<T extends HTMLElement>(
  tagName = 'div',
  attrs: Record<string, string> = {},
  dataset: Record<string, string> = {},
): T {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const el = {
    tagName: tagName.toUpperCase(),
    value: '',
    textContent: '',
    innerHTML: '',
    dataset,
    click() {
      const list = listeners['click'];
      if (list) {
        for (const fn of list) fn({ type: 'click' });
      }
    },
    trigger(event: string, data: unknown = {}) {
      const list = listeners[event];
      if (list) {
        for (const fn of list) fn(data);
      }
    },
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
      getBoundingClientRect: () => ({ width: 800, height: 800, top: 0, left: 0 }),
    },
    getBoundingClientRect: () => ({ width: 800, height: 800, top: 0, left: 0 }),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    addEventListener: vi.fn((event: string, fn: (e: unknown) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
    }),
    dispatchEvent: vi.fn(),
    querySelectorAll: vi.fn(() => []),
    getAttribute: (attr: string) => attrs[attr] || null,
  } as unknown as T;
  return el;
}

function createMockCanvas(): HTMLCanvasElement {
  const canvas = createMockElement<HTMLCanvasElement>('canvas');
  canvas.width = 800;
  canvas.height = 800;

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
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: vi.fn(),
    measureText: vi.fn((s: string) => ({ width: s.length * 8 })),
  };

  (canvas as unknown as { getContext: () => typeof ctx }).getContext = () => ctx;
  return canvas;
}

describe('Task 0.4 — Refatoração em 3 Vistas e CAM Blueprint', () => {
  describe('1. BlueprintView & Diagnóstico Mecânico CAM', () => {
    it('calcula passo linear, espessura de parede livre e status Seguro', () => {
      const canvas = createMockCanvas();
      const el: BlueprintViewElements = {
        canvas,
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
      };

      el.drillDiameterInput.value = '2.0';
      el.marginInput.value = '15.0';
      el.overlapInput.value = '10.0';
      el.paperSelect.value = 'A4';

      const loomConfig: LoomConfig = {
        shape: 'circle',
        diameterMm: 600,
        pegCount: 200,
        pegDiameterMm: 2.0,
        startAngleDeg: -90,
      };

      const bp = new BlueprintView(el, loomConfig);

      // Passo linear para D=600mm, N=200: 2 * 300 * sin(pi / 200) ≈ 9.42 mm
      expect(el.linearPitchEl.textContent).toBe('9.42 mm');
      // Parede livre: 9.42 - 2.0 = 7.42 mm
      expect(el.freeWallEl.textContent).toBe('7.42 mm');
      expect(el.statusBadgeEl.textContent).toContain('Seguro');
      expect(el.statusBadgeEl.classList.contains('badge-success')).toBe(true);

      // Tabela de furos gerada com 200 linhas
      expect(el.pegsTableBody.innerHTML).toContain('data-peg-index="0"');
      expect(el.pegsTableBody.innerHTML).toContain('data-peg-index="199"');

      // Exportação G-Code gera ciclo G81
      let exportedContent = '';
      const origCreate = URL.createObjectURL;
      const origRevoke = URL.revokeObjectURL;
      URL.createObjectURL = vi.fn((blob: Blob) => {
        blob.text().then((t) => {
          exportedContent = t;
        });
        return 'blob:mock-url';
      });
      URL.revokeObjectURL = vi.fn();

      bp.exportGcode();
      expect(exportedContent).toBeDefined();

      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    });

    it('identifica Alerta de Parede Fina e Erro de Colisão de Broca', () => {
      const canvas = createMockCanvas();
      const el: BlueprintViewElements = {
        canvas,
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
      };

      // 1. Alerta: D=300mm, N=280 pinos -> passo ~3.36mm, broca 2.5mm -> parede ~0.86mm (< 1.5mm)
      const loomAlert: LoomConfig = {
        shape: 'circle',
        diameterMm: 300,
        pegCount: 280,
        pegDiameterMm: 2.5,
        startAngleDeg: -90,
      };
      el.drillDiameterInput.value = '2.5';
      const bp = new BlueprintView(el, loomAlert);
      expect(el.statusBadgeEl.textContent).toContain('Alerta Parede Fina');
      expect(el.statusBadgeEl.classList.contains('badge-warning')).toBe(true);

      // 2. Erro colisão: D=200mm, N=400 pinos -> passo ~1.57mm, broca 2.0mm -> parede < 0mm (colisão)
      const loomCollision: LoomConfig = {
        shape: 'circle',
        diameterMm: 200,
        pegCount: 400,
        pegDiameterMm: 2.0,
        startAngleDeg: -90,
      };
      el.drillDiameterInput.value = '2.0';
      bp.setLoomConfig(loomCollision, 2.0);
      expect(el.statusBadgeEl.textContent).toContain('Erro Colisão de Broca');
      expect(el.statusBadgeEl.classList.contains('badge-danger')).toBe(true);
    });
  });

  describe('2. StudioViewManager & Inspeção Multi-Estágio', () => {
    it('alterna abas de inspeção entre alvo, mapa W(x,y), bordas, radon e residual', () => {
      const targetCanvas = createMockCanvas();
      const stageTabs = [
        createMockElement<HTMLButtonElement>('button', { 'data-stage': 'prepared' }, { stage: 'prepared' }),
        createMockElement<HTMLButtonElement>('button', { 'data-stage': 'importance' }, { stage: 'importance' }),
        createMockElement<HTMLButtonElement>('button', { 'data-stage': 'edges' }, { stage: 'edges' }),
        createMockElement<HTMLButtonElement>('button', { 'data-stage': 'radon' }, { stage: 'radon' }),
        createMockElement<HTMLButtonElement>('button', { 'data-stage': 'residual' }, { stage: 'residual' }),
      ] as unknown as NodeListOf<HTMLButtonElement>;

      const framingEl: StudioFramingElements = {
        targetCanvas,
        zoomInput: createMockElement('input'),
        panXInput: createMockElement('input'),
        panYInput: createMockElement('input'),
        rotationInput: createMockElement('input'),
        btnSmartFrame: createMockElement('button'),
        btnResetCrop: createMockElement('button'),
        btnToggleBrush: createMockElement('button'),
        btnClearBrush: createMockElement('button'),
        stageTabs,
      };

      const studio = new StudioViewManager(framingEl);
      expect(studio.getActiveStage()).toBe('prepared');

      // Alimenta imagem 64x64
      const dummyRgba = new Uint8ClampedArray(64 * 64 * 4);
      dummyRgba.fill(128);
      studio.updateTargetData(dummyRgba, 64, 64);

      // Simula clique na aba "importance"
      stageTabs[1].click();
      expect(studio.getActiveStage()).toBe('importance');

      // Simula clique na aba "edges"
      stageTabs[2].click();
      expect(studio.getActiveStage()).toBe('edges');

      // Simula clique na aba "radon"
      stageTabs[3].click();
      expect(studio.getActiveStage()).toBe('radon');

      // Simula clique na aba "residual"
      stageTabs[4].click();
      expect(studio.getActiveStage()).toBe('residual');
    });

    it('ativa pincel manual de foco e reseta máscara de importância', () => {
      const targetCanvas = createMockCanvas();
      const stageTabs = [] as unknown as NodeListOf<HTMLButtonElement>;
      const btnToggleBrush = createMockElement<HTMLButtonElement>('button');
      const btnClearBrush = createMockElement<HTMLButtonElement>('button');

      const framingEl: StudioFramingElements = {
        targetCanvas,
        zoomInput: createMockElement('input'),
        panXInput: createMockElement('input'),
        panYInput: createMockElement('input'),
        rotationInput: createMockElement('input'),
        btnSmartFrame: createMockElement('button'),
        btnResetCrop: createMockElement('button'),
        btnToggleBrush,
        btnClearBrush,
        stageTabs,
      };

      const studio = new StudioViewManager(framingEl);
      expect(studio.isBrushModeActive()).toBe(false);

      studio.setBrushMode(true);
      expect(studio.isBrushModeActive()).toBe(true);

      const dummyRgba = new Uint8ClampedArray(64 * 64 * 4);
      dummyRgba.fill(200);
      studio.updateTargetData(dummyRgba, 64, 64);

      const mask = studio.getManualBrushMask();
      expect(mask).not.toBeNull();
      expect(mask?.length).toBe(64 * 64);

      // Limpa pincel
      studio.clearManualBrush();
      expect(mask?.[0]).toBe(0);
    });

    it('gerencia transição de modos e interação de pan vs pincel (T4 e T5)', () => {
      const targetCanvas = createMockCanvas();
      (
        targetCanvas as unknown as {
          getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
        }
      ).getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        width: 200,
        height: 200,
      });

      const tabPrepared = createMockElement<HTMLButtonElement>('button', {}, { stage: 'prepared' });
      const tabImportance = createMockElement<HTMLButtonElement>('button', {}, { stage: 'importance' });
      const stageTabs = [tabPrepared, tabImportance] as unknown as NodeListOf<HTMLButtonElement>;

      const zoomInput = createMockElement<HTMLInputElement>('input');
      zoomInput.value = '1.0';
      const panXInput = createMockElement<HTMLInputElement>('input');
      panXInput.value = '0';
      const panYInput = createMockElement<HTMLInputElement>('input');
      panYInput.value = '0';
      const rotationInput = createMockElement<HTMLInputElement>('input');
      rotationInput.value = '0';

      const btnToggleBrush = createMockElement<HTMLButtonElement>('button');
      const btnBrushMode = createMockElement<HTMLButtonElement>('button');
      const btnClearBrush = createMockElement<HTMLButtonElement>('button');
      const targetCaption = createMockElement<HTMLElement>('figcaption');

      const framingEl: StudioFramingElements = {
        targetCanvas,
        zoomInput,
        panXInput,
        panYInput,
        rotationInput,
        btnSmartFrame: createMockElement('button'),
        btnResetCrop: createMockElement('button'),
        btnToggleBrush,
        btnBrushMode,
        btnClearBrush,
        stageTabs,
        targetCaption,
      };

      const studio = new StudioViewManager(framingEl);

      // 1. Abrir W (aba importance) não ativa o pincel automaticamente
      studio.setActiveStage('importance');
      expect(studio.getActiveStage()).toBe('importance');
      expect(studio.isBrushModeActive()).toBe(false);

      // 2. Ligar o pincel ativa a aba importance e habilita o botão de modo
      const brushCursorMock = createMockElement<HTMLDivElement>('div');
      brushCursorMock.className = 'brush-cursor';
      brushCursorMock.hidden = true;
      const container = createMockElement<HTMLElement>('div');
      (container as unknown as { querySelector: () => typeof brushCursorMock }).querySelector = () => brushCursorMock;
      (targetCanvas as unknown as { parentElement: typeof container }).parentElement = container;

      studio.setActiveStage('prepared');
      studio.setBrushMode(true);
      expect(studio.isBrushModeActive()).toBe(true);
      expect(studio.getActiveStage()).toBe('importance');
      expect(btnBrushMode.disabled).toBe(false);
      expect(btnBrushMode.textContent).toContain('+ Reforçar');

      const trigger = (targetCanvas as unknown as { trigger: (e: string, d: unknown) => void }).trigger;
      trigger('pointerenter', { clientX: 100, clientY: 100 });
      expect(brushCursorMock.hidden).toBe(false);

      // 3. Sair de W para prepared desliga o pincel e oculta o cursor automaticamente
      studio.setActiveStage('prepared');
      expect(studio.isBrushModeActive()).toBe(false);
      expect(btnBrushMode.disabled).toBe(true);
      expect(brushCursorMock.hidden).toBe(true);

      // 4. Arraste faz pan após sair de W (fator 200 / zoom)
      // Com zoom 1.0, dx = 50 em largura 200 => deltaPanX = (50 / 200) * (200 / 1.0) = 50%
      trigger('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
      trigger('pointermove', { clientX: 150, clientY: 100, pointerId: 1 });
      trigger('pointerup', { pointerId: 1 });
      expect(panXInput.value).toBe('50');

      // 5. Fator de zoom: zoom 2.0 com dx = 50 => deltaPanX = (50 / 200) * (200 / 2.0) = 25%
      panXInput.value = '0';
      zoomInput.value = '2.0';
      trigger('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
      trigger('pointermove', { clientX: 150, clientY: 100, pointerId: 1 });
      trigger('pointerup', { pointerId: 1 });
      expect(panXInput.value).toBe('25');

      // 6. Coordenadas do pincel com máscara 500x500 e canvas 200x200
      studio.setDiagnosticBuffers({
        dimensions: [500, 500, 500, 500, 500, 500, 180, 180],
      });
      studio.setBrushMode(true); // leva para importance com brushActive=true
      expect(studio.hasBrushStrokes()).toBe(false);

      // Clica no centro (100, 100) do canvas (largura 200, altura 200) => u=0.5, v=0.5 => máscara (250, 250)
      trigger('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
      trigger('pointerup', { pointerId: 1 });

      const mask = studio.getManualBrushMask();
      expect(mask).not.toBeNull();
      expect(mask?.length).toBe(500 * 500);
      expect(mask![250 * 500 + 250]).toBeGreaterThan(0);
      expect(studio.hasBrushStrokes()).toBe(true);

      // 7. onFramingInvalidated limpa o pincel se houver traços
      studio.onFramingInvalidated();
      expect(studio.hasBrushStrokes()).toBe(false);
      expect(mask![250 * 500 + 250]).toBe(0);
    });
  });

  describe('3. Geometria de Tear Físico Multiformato', () => {
    it('valida criação e pinos de tear circular Petros Vrellis', () => {
      const loom = createLoom({
        shape: 'circle',
        diameterMm: 600,
        pegCount: 200,
        pegDiameterMm: 2.0,
        startAngleDeg: -90,
      });

      expect(loom.pegs.length).toBe(200);
      expect(loom.radiusMm).toBe(300);
      expect(loom.minSpacingMm).toBeCloseTo(9.42, 1);
    });

    it('valida criação e contorno de tear retangular', () => {
      const loom = createLoom({
        shape: 'rectangle',
        widthMm: 600,
        heightMm: 400,
        pegsX: 61,
        pegsY: 41,
        pegDiameterMm: 2.0,
      });

      // Pinos totais: 2 * (61 + 41) - 4 = 200 pinos
      expect(loom.pegs.length).toBe(200);
      expect(loom.widthMm).toBe(600);
      expect(loom.heightMm).toBe(400);
      expect(loom.outline).not.toBeNull();
    });
  });
});
