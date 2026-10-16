/**
 * Stub temporário de rasterização de cordas em JS (legado expurgado na Task 0.1).
 * A rasterização e avaliação física serão executadas em Rust/Wasm + WebGL2.
 */
export class ChordRasterizer {
  readonly size: number;
  readonly idx: Int32Array;
  readonly cov: Float32Array;

  constructor(size: number, _maxWidthPx = 1) {
    this.size = size;
    this.idx = new Int32Array(0);
    this.cov = new Float32Array(0);
  }

  rasterize(_x0: number, _y0: number, _x1: number, _y1: number, _widthPx: number): number {
    return 0;
  }
}
