/**
 * WebGL2 renderer: linear-light RGBA16F accumulation pipeline and Canvas 2D fallback contracts.
 */

export * from './webgl-shaders.js';
export * from './webgl-loom-renderer.js';

/** Active rendering backend type. */
export type RendererBackend = 'webgl2-rgba16f' | 'canvas2d-fallback';

/** Detected GPU rendering capabilities for linear-light transmittance accumulation. */
export interface RendererCapabilities {
  readonly backend: RendererBackend;
  readonly supportsColorBufferFloat: boolean;
  readonly maxTextureSizePx: number;
}

/** Probes WebGL2 RGBA16F (`EXT_color_buffer_float`) support, falling back to Canvas 2D when unavailable. */
export function detectRendererCapabilities(
  canvas?: { getContext(contextId: string): unknown } | null,
): RendererCapabilities {
  if (canvas) {
    const gl = canvas.getContext('webgl2') as {
      getExtension?(name: string): unknown;
      getParameter?(pname: number): unknown;
      MAX_TEXTURE_SIZE?: number;
    } | null;
    if (gl && typeof gl.getExtension === 'function') {
      const ext = gl.getExtension('EXT_color_buffer_float');
      const maxTex =
        typeof gl.getParameter === 'function' && typeof gl.MAX_TEXTURE_SIZE === 'number'
          ? Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096
          : 4096;
      if (ext) {
        return {
          backend: 'webgl2-rgba16f',
          supportsColorBufferFloat: true,
          maxTextureSizePx: maxTex,
        };
      }
    }
  }
  return {
    backend: 'canvas2d-fallback',
    supportsColorBufferFloat: false,
    maxTextureSizePx: 4096,
  };
}
