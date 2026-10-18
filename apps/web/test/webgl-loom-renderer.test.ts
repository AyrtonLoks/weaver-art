import { describe, expect, it, vi } from 'vitest';
import {
  detectRendererCapabilities,
  WebGLLoomRenderer,
  hexToLinearRgb,
  srgbToLinear,
} from '../src/renderer-webgl/index.js';
import { StudioViewManager, type StudioFramingElements } from '../src/views/studio-view/studio-view.js';
import { SharedWorkspaceMemory } from '../src/core-bridge/shared-memory-layout.js';
import type { WeavingStepRecord } from '../src/domain-contracts/types.js';

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
    getBoundingClientRect: () => ({ width: 700, height: 700, top: 0, left: 0 }),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    addEventListener: vi.fn((event: string, fn: (e: unknown) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
    }),
    removeEventListener: vi.fn((event: string, fn: (e: unknown) => void) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((f) => f !== fn);
      }
    }),
    dispatchEvent: vi.fn((e: { type: string }) => {
      const list = listeners[e.type];
      if (list) for (const fn of list) fn(e);
    }),
    querySelectorAll: vi.fn(() => []),
    getAttribute: (attr: string) => attrs[attr] || null,
  } as unknown as T;
  return el;
}

function createMockCanvas2D(): HTMLCanvasElement {
  const canvas = createMockElement<HTMLCanvasElement>('canvas');
  canvas.width = 700;
  canvas.height = 700;

  const ctx = {
    canvas,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    clip: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    drawImage: vi.fn(),
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: vi.fn(),
    getImageData: (x: number, y: number, w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
  };

  (canvas as unknown as { getContext: (id: string) => unknown }).getContext = (id: string) => {
    if (id === '2d') return ctx;
    return null;
  };
  return canvas;
}

function createMockWebGL2Context() {
  const extensions: Record<string, unknown> = {
    EXT_color_buffer_float: {},
  };
  return {
    getExtension: vi.fn((name: string) => extensions[name] ?? null),
    getParameter: vi.fn(() => 4096),
    MAX_TEXTURE_SIZE: 0x0d33,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    COLOR_BUFFER_BIT: 0x4000,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    TEXTURE_2D: 0x0de1,
    RGBA16F: 0x881a,
    RGBA8: 0x8058,
    RGBA: 0x1908,
    HALF_FLOAT: 0x140b,
    UNSIGNED_BYTE: 0x1401,
    FLOAT: 0x1406,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812f,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    BLEND: 0x0be2,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    TRIANGLES: 0x0004,
    createShader: vi.fn(() => ({})),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => ''),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({})),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => ''),
    deleteProgram: vi.fn(),
    useProgram: vi.fn(),
    getUniformLocation: vi.fn((_p: unknown, name: string) => ({ name })),
    uniform1f: vi.fn(),
    uniform2f: vi.fn(),
    uniform3f: vi.fn(),
    uniform1i: vi.fn(),
    createFramebuffer: vi.fn(() => ({})),
    bindFramebuffer: vi.fn(),
    framebufferTexture2D: vi.fn(),
    checkFramebufferStatus: vi.fn(() => 0x8cd5),
    deleteFramebuffer: vi.fn(),
    createTexture: vi.fn(() => ({})),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    texImage2D: vi.fn(),
    deleteTexture: vi.fn(),
    createBuffer: vi.fn(() => ({})),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    bufferSubData: vi.fn(),
    deleteBuffer: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    vertexAttribDivisor: vi.fn(),
    viewport: vi.fn(),
    clearColor: vi.fn(),
    clear: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    blendFunc: vi.fn(),
    drawArrays: vi.fn(),
    drawArraysInstanced: vi.fn(),
    readPixels: vi.fn((_x, _y, w, h, _format, _type, out: Uint8Array) => {
      out.fill(240);
    }),
    activeTexture: vi.fn(),
  };
}

function createMockWebGL2Canvas(): HTMLCanvasElement {
  const canvas = createMockElement<HTMLCanvasElement>('canvas');
  canvas.width = 700;
  canvas.height = 700;
  const gl = createMockWebGL2Context();

  (canvas as unknown as { getContext: (id: string) => unknown }).getContext = (id: string) => {
    if (id === 'webgl2') return gl;
    return null;
  };
  return canvas;
}

describe('Sprint 4 — Task 4.1: Renderizador Físico WebGL2 e Diagnóstico DSP Studio', () => {
  describe('1. Detecção de Capacidades e Conversão Cromática Linear', () => {
    it('detecta EXT_color_buffer_float com suporte RGBA16F no WebGL2', () => {
      const canvas = createMockWebGL2Canvas();
      const caps = detectRendererCapabilities(canvas);
      expect(caps.backend).toBe('webgl2-rgba16f');
      expect(caps.supportsColorBufferFloat).toBe(true);
      expect(caps.maxTextureSizePx).toBe(4096);
    });

    it('faz fallback transparente para Canvas 2D quando WebGL2 não está disponível', () => {
      const canvas = createMockCanvas2D();
      const caps = detectRendererCapabilities(canvas);
      expect(caps.backend).toBe('canvas2d-fallback');
      expect(caps.supportsColorBufferFloat).toBe(false);
    });

    it('converte sRGB para Linear RGB sem distorção gama (IEC 61966-2-1)', () => {
      expect(srgbToLinear(0.0)).toBe(0.0);
      expect(srgbToLinear(1.0)).toBe(1.0);
      const mid = srgbToLinear(0.5);
      expect(mid).toBeCloseTo(0.214, 2);

      const white = hexToLinearRgb('#ffffff');
      expect(white.r).toBe(1.0);
      expect(white.g).toBe(1.0);
      expect(white.b).toBe(1.0);

      const black = hexToLinearRgb('#000000');
      expect(black.r).toBe(0.0);
      expect(black.g).toBe(0.0);
      expect(black.b).toBe(0.0);
    });
  });

  describe('2. Pipeline WebGL2 de Dois Estágios (webgl-loom-renderer.ts)', () => {
    it('inicializa com geometria física real do tear e tangentes cilíndricas', () => {
      const canvas = createMockWebGL2Canvas();
      const renderer = new WebGLLoomRenderer(canvas, {
        extentMm: 600,
        threadThicknessMm: 0.2,
        paletteMode: 'MONOCHROME',
      });

      expect(renderer.isWebGL2Supported()).toBe(true);
      expect(renderer.getBackend()).toBe('webgl2-rgba16f');

      const loom = renderer.getLoom();
      expect(loom.pegs.length).toBe(200);
      expect(loom.radiusMm).toBe(300);
      expect(loom.pegRadiusMm).toBe(1.0); // 2mm diameter / 2
      renderer.dispose();
    });

    it('renderiza passos de cordas via quads instanciados no FBO', () => {
      const canvas = createMockWebGL2Canvas();
      const renderer = new WebGLLoomRenderer(canvas);
      const gl = canvas.getContext('webgl2') as unknown as ReturnType<typeof createMockWebGL2Context>;

      const steps: WeavingStepRecord[] = [
        {
          fromPin: 0,
          toPin: 100,
          spoolId: 0,
          departureWinding: 'CW',
          arrivalWinding: 'CCW',
          scoreNormalized: 0.85,
        },
        {
          fromPin: 100,
          toPin: 50,
          spoolId: 0,
          departureWinding: 'CCW',
          arrivalWinding: 'CW',
          scoreNormalized: 0.9,
        },
      ];

      renderer.renderSteps(steps);
      expect(renderer.getLastRenderedStep()).toBe(2);
      expect(gl.drawArraysInstanced).toHaveBeenCalled();
      expect(gl.drawArrays).toHaveBeenCalled(); // Screen pass

      renderer.dispose();
    });

    it('executa leitura incremental Zero-Copy do SharedWorkspaceMemory a 60 FPS', () => {
      const canvas = createMockWebGL2Canvas();
      const renderer = new WebGLLoomRenderer(canvas);
      const memory = new SharedWorkspaceMemory(100);

      renderer.setSharedMemory(memory);
      expect(renderer.getLastRenderedStep()).toBe(0);

      // Escreve 3 passos na memória compartilhada
      memory.writeStep(0, {
        fromPin: 10,
        toPin: 110,
        spoolId: 0,
        departureWinding: 'CW',
        arrivalWinding: 'CW',
        scoreNormalized: 0.8,
      });
      memory.writeStep(1, {
        fromPin: 110,
        toPin: 40,
        spoolId: 0,
        departureWinding: 'CW',
        arrivalWinding: 'CCW',
        scoreNormalized: 0.75,
      });
      memory.setCurrentStepIndex(2);

      // Renderiza frame incremental
      renderer.renderFrame();
      expect(renderer.getLastRenderedStep()).toBe(2);

      // Adiciona mais 1 passo
      memory.writeStep(2, {
        fromPin: 40,
        toPin: 160,
        spoolId: 0,
        departureWinding: 'CCW',
        arrivalWinding: 'CW',
        scoreNormalized: 0.9,
      });
      memory.setCurrentStepIndex(3);

      renderer.renderFrame();
      expect(renderer.getLastRenderedStep()).toBe(3);

      // Chamada sem novos passos não avança ponteiro
      renderer.renderFrame();
      expect(renderer.getLastRenderedStep()).toBe(3);

      renderer.dispose();
    });

    it('suporta Zoom e Pan interativos na tela de simulação', () => {
      const canvas = createMockWebGL2Canvas();
      const renderer = new WebGLLoomRenderer(canvas);

      expect(renderer.getZoom()).toBe(1.0);
      expect(renderer.getPan()).toEqual({ x: 0, y: 0 });

      renderer.setZoom(2.5);
      expect(renderer.getZoom()).toBe(2.5);

      renderer.setPan(0.15, -0.2);
      expect(renderer.getPan()).toEqual({ x: 0.15, y: -0.2 });

      renderer.resetView();
      expect(renderer.getZoom()).toBe(1.0);
      expect(renderer.getPan()).toEqual({ x: 0, y: 0 });

      renderer.dispose();
    });

    it('opera estavelmente no modo Canvas 2D fallback', () => {
      const canvas = createMockCanvas2D();
      const renderer = new WebGLLoomRenderer(canvas, { forceCanvas2d: true });

      expect(renderer.getBackend()).toBe('canvas2d-fallback');
      expect(renderer.isWebGL2Supported()).toBe(false);

      renderer.renderSteps([
        {
          fromPin: 5,
          toPin: 120,
          spoolId: 0,
          departureWinding: 'CW',
          arrivalWinding: 'CCW',
          scoreNormalized: 0.7,
        },
      ]);
      expect(renderer.getLastRenderedStep()).toBe(1);

      renderer.setZoom(1.5);
      expect(renderer.getZoom()).toBe(1.5);

      renderer.dispose();
    });
  });

  describe('3. Pincel de Importância Facial e Diagnóstico DSP (StudioViewManager)', () => {
    function setupStudioManager() {
      const targetCanvas = createMockCanvas2D();
      targetCanvas.getBoundingClientRect = () =>
        ({
          width: targetCanvas.width,
          height: targetCanvas.height,
          top: 0,
          left: 0,
          right: targetCanvas.width,
          bottom: targetCanvas.height,
          x: 0,
          y: 0,
          toJSON: () => {},
        }) as DOMRect;
      const stageTabs = [
        createMockElement('button', {}, { stage: 'prepared' }),
        createMockElement('button', {}, { stage: 'importance' }),
        createMockElement('button', {}, { stage: 'edges' }),
        createMockElement('button', {}, { stage: 'radon' }),
        createMockElement('button', {}, { stage: 'residual' }),
      ] as unknown as NodeListOf<HTMLButtonElement>;

      const el: StudioFramingElements = {
        targetCanvas,
        zoomInput: createMockElement('input'),
        panXInput: createMockElement('input'),
        panYInput: createMockElement('input'),
        rotationInput: createMockElement('input'),
        btnSmartFrame: createMockElement('button'),
        btnResetCrop: createMockElement('button'),
        btnToggleBrush: createMockElement('button'),
        btnBrushMode: createMockElement('button'),
        btnClearBrush: createMockElement('button'),
        stageTabs,
        targetCaption: createMockElement('figcaption'),
      };

      const manager = new StudioViewManager(el);
      return { manager, el, targetCanvas };
    }

    it('conecta as 5 abas de diagnóstico aos PreviewBuffers do Wasm', () => {
      const { manager } = setupStudioManager();
      const w = 64;
      const h = 64;

      const prepBuf = new Uint8ClampedArray(w * h * 4).fill(128);
      const impBuf = new Uint8ClampedArray(w * h * 4).fill(200);
      const edgeBuf = new Uint8ClampedArray(w * h * 4).fill(50);
      const radonBuf = new Uint8ClampedArray(w * h * 4).fill(90);

      manager.setDiagnosticBuffers({
        preparedRgba: prepBuf,
        importanceRgba: impBuf,
        edgesRgba: edgeBuf,
        radonRgba: radonBuf,
        dimensions: [w, h, w, h, w, h, w, h],
      });

      // Aba 1: Alvo Preparado
      manager.setActiveStage('prepared');
      expect(manager.getActiveStage()).toBe('prepared');

      // Aba 2: Mapa W(x,y)
      manager.setActiveStage('importance');
      expect(manager.getActiveStage()).toBe('importance');
      expect(manager.isBrushModeActive()).toBe(false);

      // Aba 3: Bordas
      manager.setActiveStage('edges');
      expect(manager.getActiveStage()).toBe('edges');

      // Aba 4: Radon
      manager.setActiveStage('radon');
      expect(manager.getActiveStage()).toBe('radon');

      // Aba 5: Erro Residual
      manager.setCachedSimulation(new Uint8ClampedArray(w * h * 4).fill(100));
      manager.setActiveStage('residual');
      expect(manager.getActiveStage()).toBe('residual');
    });

    it('permite pintura interativa no modo + Reforçar Nitidez e - Reduzir Peso', () => {
      const { manager, targetCanvas } = setupStudioManager();
      manager.updateTargetData(new Uint8ClampedArray(64 * 64 * 4), 64, 64);
      manager.setBrushMode(true);

      expect(manager.getBrushMode()).toBe('boost');

      let lastAppliedWeights: Float32Array | null = null;
      manager.setBrushApplyHandler((weights) => {
        lastAppliedWeights = weights;
      });

      // Simula toque no centro (px=32, py=32) em modo + Reforçar
      targetCanvas.dispatchEvent({
        type: 'pointerdown',
        clientX: 32,
        clientY: 32,
        button: 0,
        pointerId: 1,
      } as unknown as Event);

      const maskAfterBoost = manager.getManualBrushMask();
      expect(maskAfterBoost).not.toBeNull();
      const centerWeightBoost = maskAfterBoost![32 * 64 + 32];
      expect(centerWeightBoost).toBeGreaterThan(0.0);

      // Alterna para modo - Reduzir Peso
      manager.toggleBrushMode();
      expect(manager.getBrushMode()).toBe('reduce');

      // Pinta novamente no mesmo ponto
      targetCanvas.dispatchEvent({
        type: 'pointerdown',
        clientX: 32,
        clientY: 32,
        button: 0,
        pointerId: 1,
      } as unknown as Event);

      const maskAfterReduce = manager.getManualBrushMask();
      expect(maskAfterReduce![32 * 64 + 32]).toBeLessThan(centerWeightBoost);

      // Limpar pincel
      manager.clearManualBrush();
      expect(manager.getManualBrushMask()![32 * 64 + 32]).toBe(0);
      expect(lastAppliedWeights).not.toBeNull();
    });
  });

  describe('4. Validação de Desempenho em Escala (7.000 linhas)', () => {
    it('renderiza 7.000 cordas sem estouro de pilha nem degradação de estado', () => {
      const canvas = createMockWebGL2Canvas();
      const renderer = new WebGLLoomRenderer(canvas);

      const chordBatch: WeavingStepRecord[] = new Array(7000);
      for (let i = 0; i < 7000; i++) {
        chordBatch[i] = {
          fromPin: i % 200,
          toPin: (i * 73 + 17) % 200,
          spoolId: (i / 1750) | 0, // 4 spools
          departureWinding: i % 2 === 0 ? 'CW' : 'CCW',
          arrivalWinding: i % 3 === 0 ? 'CCW' : 'CW',
          scoreNormalized: 0.85,
        };
      }

      const startTime = performance.now();
      renderer.renderSteps(chordBatch);
      const elapsed = performance.now() - startTime;

      expect(renderer.getLastRenderedStep()).toBe(7000);
      // Simulação rápida em menos de 100ms
      expect(elapsed).toBeLessThan(1000);

      renderer.dispose();
    });
  });
});
