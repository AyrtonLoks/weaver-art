/**
 * High-performance WebGL2 Physical Loom Renderer (Sprint 4 Task 4.1 / ADR-002).
 *
 * Implements:
 * 1. Two-Stage Optical Simulation Pipeline:
 *    - Stage 1: Linear-light accumulation on an offscreen RGBA16F framebuffer
 *      with exact sub-pixel cylindrical thread sections and Porter-Duff blending.
 *    - Stage 2: Screen tone-mapping pass (Linear -> sRGB IEC 61966-2-1),
 *      micro-fiber directional sheen, physical outer rim and metallic pins.
 * 2. Zero-Copy incremental reading from SharedWorkspaceMemory at 60 FPS.
 * 3. Interactive Zoom & Pan on the central simulation viewport.
 * 4. Transparent Canvas 2D fallback for headless/unsupported environments.
 */

import { createLoom, tangentSegment, type Loom, type LoomConfig } from '@weaver-art/core';
import type { ColorPaletteMode, WeavingStepRecord } from '../domain-contracts/types.js';
import type { SharedWorkspaceMemory } from '../core-bridge/shared-memory-layout.js';
import { ACCUMULATION_FS, ACCUMULATION_VS, SCREEN_FS, SCREEN_VS, createProgram } from './webgl-shaders.js';
import { detectRendererCapabilities, type RendererBackend, type RendererCapabilities } from './index.js';

export interface WebGLLoomRendererOptions {
  offscreenResolutionPx?: number;
  extentMm?: number;
  threadThicknessMm?: number;
  initialZoom?: number;
  backgroundColor?: string;
  paletteMode?: ColorPaletteMode;
  showFrame?: boolean;
  showPins?: boolean;
  forceCanvas2d?: boolean;
}

export interface LinearRgb {
  r: number;
  g: number;
  b: number;
}

/** Standard piecewise IEC 61966-2-1 sRGB to Linear RGB conversion. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Parses hex color ('#ffffff') into Linear RGB floats in [0, 1]. */
export function hexToLinearRgb(hex: string): LinearRgb {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;
  return {
    r: srgbToLinear(r),
    g: srgbToLinear(g),
    b: srgbToLinear(b),
  };
}

/** Opacidades físicas sub-pixel calibradas com o solver (evita saturação neon/escura). */
export const DEFAULT_PALETTES: Record<ColorPaletteMode, [number, number, number, number][]> = {
  MONOCHROME: [
    [0.02, 0.02, 0.02, 0.14], // Preto com densidade óptica real
  ],
  CMYK_SUBTRACTIVE: [
    [0.95, 0.82, 0.02, 0.09], // Amarelo
    [0.82, 0.04, 0.45, 0.10], // Magenta
    [0.02, 0.55, 0.85, 0.10], // Ciano
    [0.02, 0.02, 0.02, 0.15], // Preto (K)
  ],
  RGB_OCCLUSIVE: [
    [0.85, 0.05, 0.05, 0.11],
    [0.05, 0.75, 0.10, 0.11],
    [0.05, 0.15, 0.85, 0.11],
    [0.02, 0.02, 0.02, 0.15],
  ],
  USER_CUSTOM: [
    [0.85, 0.1, 0.1, 0.11],
    [0.1, 0.7, 0.2, 0.11],
    [0.1, 0.3, 0.9, 0.11],
    [0.02, 0.02, 0.02, 0.15],
  ],
};

const FLOATS_PER_INSTANCE = 9; // x0, y0, x1, y1, r, g, b, a, thickness
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;

export class WebGLLoomRenderer {
  public readonly canvas: HTMLCanvasElement;
  public readonly capabilities: RendererCapabilities;

  private gl: WebGL2RenderingContext | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private offscreenCanvas2d: HTMLCanvasElement | null = null;

  // WebGL resources
  private accumProgram: WebGLProgram | null = null;
  private screenProgram: WebGLProgram | null = null;
  private fbo: WebGLFramebuffer | null = null;
  private accumTexture: WebGLTexture | null = null;
  private unitQuadVbo: WebGLBuffer | null = null;
  private instanceVbo: WebGLBuffer | null = null;
  private screenQuadVbo: WebGLBuffer | null = null;

  private instanceCapacity = 4096;
  private instanceFloatData = new Float32Array(this.instanceCapacity * FLOATS_PER_INSTANCE);

  // Physical Loom Specification & Geometry
  private loom: Loom;
  private threadThicknessMm: number;
  private offscreenRes: number;
  private backgroundLinear: LinearRgb;

  // Palette colors per spoolId: [r, g, b, a] in Linear RGB
  private spoolColors: [number, number, number, number][];

  // Incremental rendering state
  private lastRenderedStep = 0;
  private sharedMemory: SharedWorkspaceMemory | null = null;
  private isAnimLoopRunning = false;
  private animFrameId: number | null = null;

  // Viewport transforms (Zoom & Pan)
  private zoom = 1.0;
  private panX = 0.0;
  private panY = 0.0;
  private isInteracting = false;
  private showFrame = true;
  private showPins = true;

  // Cleanup listeners
  private detachControls?: () => void;

  constructor(canvas: HTMLCanvasElement, options?: WebGLLoomRendererOptions) {
    this.canvas = canvas;
    this.offscreenRes = options?.offscreenResolutionPx ?? 1024;
    this.threadThicknessMm = options?.threadThicknessMm ?? 0.2;
    this.zoom = options?.initialZoom ?? 1.0;
    this.showFrame = options?.showFrame ?? true;
    this.showPins = options?.showPins ?? true;

    const bgHex = options?.backgroundColor ?? '#ffffff';
    this.backgroundLinear = hexToLinearRgb(bgHex);

    const initialPalette = options?.paletteMode ?? 'MONOCHROME';
    this.spoolColors = DEFAULT_PALETTES[initialPalette].slice();

    // Default 200-pin circular loom
    const defaultLoomConfig: LoomConfig = {
      shape: 'circle',
      diameterMm: options?.extentMm ?? 600,
      pegCount: 200,
      pegDiameterMm: 2.0,
      startAngleDeg: -90,
    };
    this.loom = createLoom(defaultLoomConfig);

    // Probe rendering capabilities
    this.capabilities = options?.forceCanvas2d
      ? { backend: 'canvas2d-fallback', supportsColorBufferFloat: false, maxTextureSizePx: 4096 }
      : detectRendererCapabilities(this.canvas);

    if (this.capabilities.backend === 'webgl2-rgba16f') {
      try {
        this.initWebGL();
      } catch (err) {
        console.warn('Falha ao inicializar WebGL2, alternando para Canvas 2D fallback:', err);
        this.initCanvas2DFallback();
      }
    } else {
      this.initCanvas2DFallback();
    }

    this.attachInteractiveControls();
  }

  // ----------------------------------------------------------- Initializations

  private initWebGL(): void {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    }) as WebGL2RenderingContext | null;

    if (!gl) {
      throw new Error('Contexto WebGL2 não suportado');
    }
    this.gl = gl;

    // Enable color float extension for RGBA16F FBO rendering
    gl.getExtension('EXT_color_buffer_float');

    // Compile programs
    this.accumProgram = createProgram(gl, ACCUMULATION_VS, ACCUMULATION_FS);
    this.screenProgram = createProgram(gl, SCREEN_VS, SCREEN_FS);

    // Setup Stage 1 Offscreen Framebuffer (RGBA16F or RGBA8 fallback)
    this.setupOffscreenFramebuffer();

    // Setup Unit Quad VBO (6 vertices for instanced chord quads)
    // Quad coordinates: u in [0, 1] along chord length, v in [-1, 1] across chord width
    const unitQuad = new Float32Array([0.0, -1.0, 1.0, -1.0, 0.0, 1.0, 0.0, 1.0, 1.0, -1.0, 1.0, 1.0]);
    this.unitQuadVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, unitQuad, gl.STATIC_DRAW);

    // Setup Instance VBO
    this.instanceVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceCapacity * BYTES_PER_INSTANCE, gl.DYNAMIC_DRAW);

    // Setup Fullscreen Quad VBO for Screen Pass (Stage 2)
    const screenQuad = new Float32Array([-1.0, -1.0, 1.0, -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0, 1.0]);
    this.screenQuadVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.screenQuadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, screenQuad, gl.STATIC_DRAW);

    // Initial clear of the accumulation buffer
    this.clearAccumulationBuffer();
  }

  private setupOffscreenFramebuffer(): void {
    if (!this.gl) return;
    const gl = this.gl;
    const res = this.offscreenRes;

    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.accumTexture) gl.deleteTexture(this.accumTexture);

    this.fbo = gl.createFramebuffer();
    this.accumTexture = gl.createTexture();

    gl.bindTexture(gl.TEXTURE_2D, this.accumTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    if (this.capabilities.supportsColorBufferFloat) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, res, res, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, res, res, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.accumTexture, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Framebuffer incomplete: 0x${status.toString(16)}`);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private initCanvas2DFallback(): void {
    this.ctx2d = this.canvas.getContext('2d');
    if (typeof document !== 'undefined') {
      this.offscreenCanvas2d = document.createElement('canvas');
      this.offscreenCanvas2d.width = this.offscreenRes;
      this.offscreenCanvas2d.height = this.offscreenRes;
    }
    this.clearAccumulationBuffer();
  }

  // ----------------------------------------------------------- Configuration

  public setLoom(loomOrConfig: Loom | LoomConfig): void {
    if ('pegs' in loomOrConfig && Array.isArray((loomOrConfig as Loom).pegs)) {
      this.loom = loomOrConfig as Loom;
    } else {
      this.loom = createLoom(loomOrConfig as LoomConfig);
    }
    const maybeThick = loomOrConfig as unknown as { threadThicknessMm?: number };
    if (typeof maybeThick.threadThicknessMm === 'number') {
      this.threadThicknessMm = maybeThick.threadThicknessMm;
    }
    this.reset();
  }

  public getLoom(): Loom {
    return this.loom;
  }

  public setThreadThickness(thicknessMm: number): void {
    this.threadThicknessMm = Math.max(0.01, thicknessMm);
  }

  public setBackgroundColor(colorHexOrRgb: string | LinearRgb): void {
    if (typeof colorHexOrRgb === 'string') {
      this.backgroundLinear = hexToLinearRgb(colorHexOrRgb);
    } else {
      this.backgroundLinear = colorHexOrRgb;
    }
    this.reset();
  }

  public setPalette(mode: ColorPaletteMode, customColors?: [number, number, number, number][]): void {
    if (customColors && customColors.length > 0) {
      this.spoolColors = customColors.slice();
    } else if (mode in DEFAULT_PALETTES) {
      this.spoolColors = DEFAULT_PALETTES[mode].slice();
    }
    this.reset();
  }

  public setSpoolColor(spoolId: number, colorLinear: LinearRgb, opacity = 0.35): void {
    while (this.spoolColors.length <= spoolId) {
      this.spoolColors.push([0.0, 0.0, 0.0, 0.35]);
    }
    this.spoolColors[spoolId] = [colorLinear.r, colorLinear.g, colorLinear.b, opacity];
  }

  public setSharedMemory(memory: SharedWorkspaceMemory): void {
    this.sharedMemory = memory;
  }

  public getBackend(): RendererBackend {
    return this.gl ? 'webgl2-rgba16f' : 'canvas2d-fallback';
  }

  public isWebGL2Supported(): boolean {
    return this.gl !== null;
  }

  public getLastRenderedStep(): number {
    return this.lastRenderedStep;
  }

  // ----------------------------------------------------------- Zoom & Pan API

  public getZoom(): number {
    return this.zoom;
  }

  public setZoom(zoom: number): void {
    this.zoom = Math.max(0.5, Math.min(25.0, zoom));
    this.renderScreenPass();
  }

  public getPan(): { x: number; y: number } {
    return { x: this.panX, y: this.panY };
  }

  public setPan(x: number, y: number): void {
    this.panX = Math.max(-2.0, Math.min(2.0, x));
    this.panY = Math.max(-2.0, Math.min(2.0, y));
    this.renderScreenPass();
  }

  public resetView(): void {
    this.zoom = 1.0;
    this.panX = 0.0;
    this.panY = 0.0;
    this.renderScreenPass();
  }

  // ----------------------------------------------------------- Incremental Render Loop

  public clearAccumulationBuffer(): void {
    this.lastRenderedStep = 0;

    if (this.gl && this.fbo) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.viewport(0, 0, this.offscreenRes, this.offscreenRes);
      gl.clearColor(this.backgroundLinear.r, this.backgroundLinear.g, this.backgroundLinear.b, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    if (this.offscreenCanvas2d) {
      const ctx = this.offscreenCanvas2d.getContext('2d');
      if (ctx) {
        ctx.fillStyle = `rgb(${Math.round(this.backgroundLinear.r * 255)}, ${Math.round(this.backgroundLinear.g * 255)}, ${Math.round(this.backgroundLinear.b * 255)})`;
        ctx.fillRect(0, 0, this.offscreenRes, this.offscreenRes);
      }
    }

    this.renderScreenPass();
  }

  public reset(): void {
    this.clearAccumulationBuffer();
  }

  /**
   * Renders newly added chords since `lastRenderedStep` and updates the screen pass.
   * Can be called synchronously or driven by `startAnimationLoop()`.
   */
  public renderFrame(): void {
    if (this.sharedMemory) {
      const currentStep = this.sharedMemory.getCurrentStepIndex();
      if (currentStep < this.lastRenderedStep) {
        // Step rewind/reset occurred
        this.reset();
      }
      if (currentStep > this.lastRenderedStep) {
        const count = currentStep - this.lastRenderedStep;
        this.renderIncrementalFromMemory(this.lastRenderedStep, count);
        this.lastRenderedStep = currentStep;
      }
    }

    this.renderScreenPass();
  }

  /**
   * Directly renders a contiguous array of chord steps (useful for results playback and testing).
   */
  public renderSteps(steps: WeavingStepRecord[]): void {
    if (steps.length === 0) {
      this.renderScreenPass();
      return;
    }

    if (this.gl && this.fbo) {
      this.renderStepsWebGL(steps);
    } else {
      this.renderStepsCanvas2D(steps);
    }

    this.lastRenderedStep += steps.length;
    this.renderScreenPass();
  }

  private renderIncrementalFromMemory(startStep: number, count: number): void {
    if (!this.sharedMemory || count <= 0) return;

    if (this.gl && this.fbo) {
      this.renderMemorySliceWebGL(startStep, count);
    } else {
      this.renderMemorySliceCanvas2D(startStep, count);
    }
  }

  // --- WebGL Stage 1: Offscreen Chord Accumulation ---

  private ensureInstanceBufferCapacity(requiredCount: number): void {
    if (requiredCount <= this.instanceCapacity) return;
    this.instanceCapacity = Math.max(requiredCount * 2, this.instanceCapacity * 2);
    this.instanceFloatData = new Float32Array(this.instanceCapacity * FLOATS_PER_INSTANCE);

    if (this.gl && this.instanceVbo) {
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instanceVbo);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, this.instanceCapacity * BYTES_PER_INSTANCE, this.gl.DYNAMIC_DRAW);
    }
  }

  private renderMemorySliceWebGL(startStep: number, count: number): void {
    if (!this.gl || !this.fbo || !this.accumProgram || !this.sharedMemory) return;
    this.ensureInstanceBufferCapacity(count);

    const mem = this.sharedMemory;
    const loom = this.loom;
    const extentMm = loom.extentMm;
    const pegRadiusMm = loom.pegRadiusMm;
    const pegs = loom.pegs;
    const pegCount = pegs.length;
    const floats = this.instanceFloatData;

    let writeIdx = 0;
    for (let i = 0; i < count; i++) {
      const stepIdx = startStep + i;
      const fromPin = mem.getStepFromPin(stepIdx) % pegCount;
      const toPin = mem.getStepToPin(stepIdx) % pegCount;
      const spoolId = mem.getStepSpoolId(stepIdx);
      const depWinding = mem.getStepDepartureWinding(stepIdx);
      const arrWinding = mem.getStepArrivalWinding(stepIdx);

      const sa = depWinding === 'CCW' ? 1 : -1;
      const sb = arrWinding === 'CCW' ? 1 : -1;

      const seg = tangentSegment(pegs[fromPin], sa, pegs[toPin], sb, pegRadiusMm);
      const spool = this.spoolColors[spoolId] ?? this.spoolColors[0] ?? [0, 0, 0, 0.15];

      // Converte Y de coordenadas de ecrã (0 no topo) para WebGL (extentMm no topo)
      floats[writeIdx++] = seg.x0;
      floats[writeIdx++] = extentMm - seg.y0;
      floats[writeIdx++] = seg.x1;
      floats[writeIdx++] = extentMm - seg.y1;
      floats[writeIdx++] = spool[0];
      floats[writeIdx++] = spool[1];
      floats[writeIdx++] = spool[2];
      floats[writeIdx++] = spool[3];
      floats[writeIdx++] = this.threadThicknessMm;
    }

    this.drawChordsInstancedWebGL(count);
  }

  private renderStepsWebGL(steps: WeavingStepRecord[]): void {
    if (!this.gl || !this.fbo || !this.accumProgram) return;
    const count = steps.length;
    this.ensureInstanceBufferCapacity(count);

    const loom = this.loom;
    const extentMm = loom.extentMm;
    const pegRadiusMm = loom.pegRadiusMm;
    const pegs = loom.pegs;
    const pegCount = pegs.length;
    const floats = this.instanceFloatData;

    let writeIdx = 0;
    for (let i = 0; i < count; i++) {
      const s = steps[i];
      const fromPin = s.fromPin % pegCount;
      const toPin = s.toPin % pegCount;
      const sa = s.departureWinding === 'CCW' ? 1 : -1;
      const sb = s.arrivalWinding === 'CCW' ? 1 : -1;

      const seg = tangentSegment(pegs[fromPin], sa, pegs[toPin], sb, pegRadiusMm);
      const spool = this.spoolColors[s.spoolId] ?? this.spoolColors[0] ?? [0, 0, 0, 0.15];

      floats[writeIdx++] = seg.x0;
      floats[writeIdx++] = extentMm - seg.y0;
      floats[writeIdx++] = seg.x1;
      floats[writeIdx++] = extentMm - seg.y1;
      floats[writeIdx++] = spool[0];
      floats[writeIdx++] = spool[1];
      floats[writeIdx++] = spool[2];
      floats[writeIdx++] = spool[3];
      floats[writeIdx++] = this.threadThicknessMm;
    }

    this.drawChordsInstancedWebGL(count);
  }

  private drawChordsInstancedWebGL(instanceCount: number): void {
    const gl = this.gl;
    if (!gl || !this.fbo || !this.accumProgram || instanceCount <= 0) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.offscreenRes, this.offscreenRes);

    gl.useProgram(this.accumProgram);

    // Uniforms
    const uExtent = gl.getUniformLocation(this.accumProgram, 'u_extentMm');
    const uAaPadding = gl.getUniformLocation(this.accumProgram, 'u_aaPaddingMm');
    const uAaRamp = gl.getUniformLocation(this.accumProgram, 'u_aaRamp');

    const pixelMm = this.loom.extentMm / this.offscreenRes;
    const aaPaddingMm = pixelMm * 0.65;

    gl.uniform1f(uExtent, this.loom.extentMm);
    gl.uniform1f(uAaPadding, aaPaddingMm);
    gl.uniform1f(uAaRamp, 0.35);

    // Upload instance attributes
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceFloatData.subarray(0, instanceCount * FLOATS_PER_INSTANCE));

    // Attributes setup
    // 0: Unit quad (per-vertex, divisor 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuadVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.vertexAttribDivisor(0, 0);

    // 1..4: Instances (divisor 1)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVbo);

    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, BYTES_PER_INSTANCE, 0); // startMm
    gl.vertexAttribDivisor(1, 1);

    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, BYTES_PER_INSTANCE, 8); // endMm
    gl.vertexAttribDivisor(2, 1);

    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, BYTES_PER_INSTANCE, 16); // color
    gl.vertexAttribDivisor(3, 1);

    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, BYTES_PER_INSTANCE, 32); // thickness
    gl.vertexAttribDivisor(4, 1);

    // Porter-Duff source-over blending in Linear RGB
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, instanceCount);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // --- Stage 2: Screen Pass Rendering (Tone Mapping & Frame) ---

  public renderScreenPass(): void {
    if (this.gl && this.screenProgram) {
      this.renderScreenPassWebGL();
    } else if (this.ctx2d) {
      this.renderScreenPassCanvas2D();
    }
  }

  private renderScreenPassWebGL(): void {
    const gl = this.gl;
    if (!gl || !this.screenProgram || !this.accumTexture) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    gl.useProgram(this.screenProgram);

    // Uniforms
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.accumTexture);
    gl.uniform1i(gl.getUniformLocation(this.screenProgram, 'u_accumTexture'), 0);

    gl.uniform1f(gl.getUniformLocation(this.screenProgram, 'u_zoom'), this.zoom);
    gl.uniform2f(gl.getUniformLocation(this.screenProgram, 'u_pan'), this.panX, this.panY);

    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    gl.uniform1f(gl.getUniformLocation(this.screenProgram, 'u_aspect'), aspect);

    const extentMm = this.loom.extentMm;
    const loomRadiusNorm = this.loom.radiusMm / extentMm;
    const rimWidthNorm = 20.0 / extentMm; // 20mm outer frame margin
    const pinRadiusNorm = this.loom.pegRadiusMm / extentMm;

    gl.uniform1f(gl.getUniformLocation(this.screenProgram, 'u_loomRadius'), loomRadiusNorm);
    gl.uniform1f(gl.getUniformLocation(this.screenProgram, 'u_rimWidth'), rimWidthNorm);
    gl.uniform1i(gl.getUniformLocation(this.screenProgram, 'u_pinCount'), this.loom.pegs.length);
    gl.uniform1f(gl.getUniformLocation(this.screenProgram, 'u_pinRadius'), pinRadiusNorm);
    gl.uniform1i(gl.getUniformLocation(this.screenProgram, 'u_showFrame'), this.showFrame ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(this.screenProgram, 'u_showPins'), this.showPins ? 1 : 0);
    gl.uniform3f(
      gl.getUniformLocation(this.screenProgram, 'u_backgroundColor'),
      this.backgroundLinear.r,
      this.backgroundLinear.g,
      this.backgroundLinear.b,
    );

    // Draw Screen Quad
    gl.bindBuffer(gl.ARRAY_BUFFER, this.screenQuadVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.vertexAttribDivisor(0, 0);

    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // --- Canvas 2D Fallback Implementation ---

  private renderMemorySliceCanvas2D(startStep: number, count: number): void {
    if (!this.offscreenCanvas2d || !this.sharedMemory) return;
    const ctx = this.offscreenCanvas2d.getContext('2d');
    if (!ctx) return;

    const loom = this.loom;
    const scale = this.offscreenRes / loom.extentMm;
    const mem = this.sharedMemory;
    const pegs = loom.pegs;
    const pegCount = pegs.length;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(0.5, this.threadThicknessMm * scale);

    for (let i = 0; i < count; i++) {
      const stepIdx = startStep + i;
      const fromPin = mem.getStepFromPin(stepIdx) % pegCount;
      const toPin = mem.getStepToPin(stepIdx) % pegCount;
      const spoolId = mem.getStepSpoolId(stepIdx);
      const depWinding = mem.getStepDepartureWinding(stepIdx);
      const arrWinding = mem.getStepArrivalWinding(stepIdx);

      const sa = depWinding === 'CCW' ? 1 : -1;
      const sb = arrWinding === 'CCW' ? 1 : -1;
      const seg = tangentSegment(pegs[fromPin], sa, pegs[toPin], sb, loom.pegRadiusMm);

      const spool = this.spoolColors[spoolId] ?? this.spoolColors[0] ?? [0, 0, 0, 0.35];
      ctx.strokeStyle = `rgba(${Math.round(spool[0] * 255)}, ${Math.round(spool[1] * 255)}, ${Math.round(spool[2] * 255)}, ${spool[3]})`;

      ctx.beginPath();
      ctx.moveTo(seg.x0 * scale, seg.y0 * scale);
      ctx.lineTo(seg.x1 * scale, seg.y1 * scale);
      ctx.stroke();
    }
    ctx.restore();
  }

  private renderStepsCanvas2D(steps: WeavingStepRecord[]): void {
    if (!this.offscreenCanvas2d) return;
    const ctx = this.offscreenCanvas2d.getContext('2d');
    if (!ctx) return;

    const loom = this.loom;
    const scale = this.offscreenRes / loom.extentMm;
    const pegs = loom.pegs;
    const pegCount = pegs.length;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(0.5, this.threadThicknessMm * scale);

    for (const s of steps) {
      const fromPin = s.fromPin % pegCount;
      const toPin = s.toPin % pegCount;
      const sa = s.departureWinding === 'CCW' ? 1 : -1;
      const sb = s.arrivalWinding === 'CCW' ? 1 : -1;
      const seg = tangentSegment(pegs[fromPin], sa, pegs[toPin], sb, loom.pegRadiusMm);

      const spool = this.spoolColors[s.spoolId] ?? this.spoolColors[0] ?? [0, 0, 0, 0.35];
      ctx.strokeStyle = `rgba(${Math.round(spool[0] * 255)}, ${Math.round(spool[1] * 255)}, ${Math.round(spool[2] * 255)}, ${spool[3]})`;

      ctx.beginPath();
      ctx.moveTo(seg.x0 * scale, seg.y0 * scale);
      ctx.lineTo(seg.x1 * scale, seg.y1 * scale);
      ctx.stroke();
    }
    ctx.restore();
  }

  private renderScreenPassCanvas2D(): void {
    if (!this.ctx2d) return;
    const ctx = this.ctx2d;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Dark backdrop
    ctx.fillStyle = '#141413';
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(w / 2 + this.panX * w, h / 2 + this.panY * h);
    ctx.scale(this.zoom, this.zoom);

    const radius = Math.min(w, h) * (this.loom.radiusMm / this.loom.extentMm);

    // Outer frame hoop
    if (this.showFrame) {
      ctx.fillStyle = '#222120';
      ctx.beginPath();
      ctx.arc(0, 0, radius + 18, 0, Math.PI * 2);
      ctx.fill();
    }

    // Loom background circle
    ctx.fillStyle = `rgb(${Math.round(this.backgroundLinear.r * 255)}, ${Math.round(this.backgroundLinear.g * 255)}, ${Math.round(this.backgroundLinear.b * 255)})`;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();

    // Draw accumulated chords
    if (this.offscreenCanvas2d) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(this.offscreenCanvas2d, -radius, -radius, radius * 2, radius * 2);
      ctx.restore();
    }

    // Pins
    if (this.showPins) {
      ctx.fillStyle = '#b0b4ba';
      ctx.strokeStyle = '#6e737c';
      ctx.lineWidth = 1;
      const pinCount = this.loom.pegs.length;
      for (let i = 0; i < pinCount; i++) {
        const angle = -Math.PI / 2 + (2 * Math.PI * i) / pinCount;
        const px = radius * Math.cos(angle);
        const py = radius * Math.sin(angle);
        ctx.beginPath();
        ctx.arc(px, py, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  // ----------------------------------------------------------- Animation Loop

  public startAnimationLoop(): void {
    if (this.isAnimLoopRunning) return;
    this.isAnimLoopRunning = true;

    const loop = (): void => {
      if (!this.isAnimLoopRunning) return;
      this.renderFrame();
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        this.animFrameId = window.requestAnimationFrame(loop);
      }
    };

    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      this.animFrameId = window.requestAnimationFrame(loop);
    } else {
      this.renderFrame();
    }
  }

  public stopAnimationLoop(): void {
    this.isAnimLoopRunning = false;
    if (
      this.animFrameId !== null &&
      typeof window !== 'undefined' &&
      typeof window.cancelAnimationFrame === 'function'
    ) {
      window.cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  // ----------------------------------------------------------- Interactive Controls

  public attachInteractiveControls(targetElement?: HTMLCanvasElement): void {
    const el = targetElement ?? this.canvas;
    if (typeof el.addEventListener !== 'function') return;

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let startPanX = 0;
    let startPanY = 0;

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
      const newZoom = Math.max(0.8, Math.min(20.0, this.zoom * zoomFactor));

      const rect = el.getBoundingClientRect();
      const cursorX = (e.clientX - rect.left) / rect.width - 0.5;
      const cursorY = 0.5 - (e.clientY - rect.top) / rect.height; // Eixo Y WebGL para cima

      this.panX += cursorX * (1 / this.zoom - 1 / newZoom);
      this.panY += cursorY * (1 / this.zoom - 1 / newZoom);
      this.zoom = newZoom;

      this.renderScreenPass();
    };

    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startPanX = this.panX;
      startPanY = this.panY;

      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // Safe fallback in test environments
      }
      el.style.cursor = 'grabbing';
    };

    const onPointerMove = (e: PointerEvent): void => {
      if (!isDragging) return;
      const rect = el.getBoundingClientRect();
      const dx = (e.clientX - startX) / (rect.width * this.zoom);
      const dy = (e.clientY - startY) / (rect.height * this.zoom);

      this.panX = startPanX + dx;
      // No WebGL o eixo Y cresce para cima, portanto subtrai-se dy (ou soma-se no Canvas2D)
      this.panY = this.gl ? startPanY - dy : startPanY + dy;
      this.renderScreenPass();
    };

    const onPointerUp = (e: PointerEvent): void => {
      if (isDragging) {
        isDragging = false;
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        el.style.cursor = 'grab';
      }
    };

    const onDblClick = (): void => {
      this.resetView();
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('dblclick', onDblClick);
    el.style.cursor = 'grab';

    this.detachControls = (): void => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('dblclick', onDblClick);
    };
  }

  // ----------------------------------------------------------- Readback & Cleanup

  /** Reads back simulation pixels in RGBA format (useful for tests and PNG exports). */
  public readRgbaPixels(out?: Uint8ClampedArray): Uint8ClampedArray {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const result = out ?? new Uint8ClampedArray(w * h * 4);

    if (this.gl) {
      const gl = this.gl;
      const u8 = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, u8);
      // Flip vertical from WebGL lower-left origin
      for (let y = 0; y < h; y++) {
        const srcRow = (h - 1 - y) * w * 4;
        const dstRow = y * w * 4;
        result.set(u8.subarray(srcRow, srcRow + w * 4), dstRow);
      }
    } else if (this.ctx2d) {
      const idata = this.ctx2d.getImageData(0, 0, w, h);
      result.set(idata.data);
    }

    return result;
  }

  public dispose(): void {
    this.stopAnimationLoop();
    this.detachControls?.();

    if (this.gl) {
      const gl = this.gl;
      if (this.fbo) gl.deleteFramebuffer(this.fbo);
      if (this.accumTexture) gl.deleteTexture(this.accumTexture);
      if (this.unitQuadVbo) gl.deleteBuffer(this.unitQuadVbo);
      if (this.instanceVbo) gl.deleteBuffer(this.instanceVbo);
      if (this.screenQuadVbo) gl.deleteBuffer(this.screenQuadVbo);
      if (this.accumProgram) gl.deleteProgram(this.accumProgram);
      if (this.screenProgram) gl.deleteProgram(this.screenProgram);
      this.gl = null;
    }

    this.ctx2d = null;
    this.offscreenCanvas2d = null;
  }
}
