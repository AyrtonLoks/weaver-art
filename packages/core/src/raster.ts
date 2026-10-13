/**
 * Anti-aliased rasterisation of a thread of finite width.
 *
 * For each pixel column (x-major lines) or row (y-major lines) the thread is
 * treated as a band of thickness `w·√(1+m²)` centred on the line, and the exact
 * overlap of that band with every pixel of the column is used as the pixel
 * *coverage* (fraction of the pixel area hidden by the thread). This is a box
 * filter — the physically meaningful quantity for the mixing model — and it is
 * valid for any thread width, including sub-pixel threads.
 */
export class ChordRasterizer {
  readonly size: number;
  /** Pixel indices (y * size + x) of the last rasterised chord. */
  readonly idx: Int32Array;
  /** Coverage in [0, 1] for each entry of `idx`. */
  readonly cov: Float32Array;

  constructor(size: number, maxWidthPx: number) {
    this.size = size;
    const perStep = Math.ceil(maxWidthPx * Math.SQRT2) + 2;
    const capacity = size * perStep + 16;
    this.idx = new Int32Array(capacity);
    this.cov = new Float32Array(capacity);
  }

  /**
   * Rasterise the segment (x0,y0)–(x1,y1), given in pixel units, with thread width `widthPx`.
   * Returns the number of samples written into `idx` / `cov`.
   */
  rasterize(x0: number, y0: number, x1: number, y1: number, widthPx: number): number {
    const size = this.size;
    const idx = this.idx;
    const cov = this.cov;
    let n = 0;
    const dx = x1 - x0;
    const dy = y1 - y0;

    if (Math.abs(dx) >= Math.abs(dy)) {
      if (dx === 0) return 0;
      if (x0 > x1) {
        [x0, x1] = [x1, x0];
        [y0, y1] = [y1, y0];
      }
      const m = (y1 - y0) / (x1 - x0);
      const half = (widthPx * Math.sqrt(1 + m * m)) / 2;
      const iStart = Math.max(0, Math.ceil(x0 - 0.5));
      const iEnd = Math.min(size - 1, Math.floor(x1 - 0.5));
      for (let i = iStart; i <= iEnd; i++) {
        const yc = y0 + (i + 0.5 - x0) * m;
        const top = yc - half;
        const bot = yc + half;
        const kStart = Math.max(0, Math.floor(top));
        const kEnd = Math.min(size - 1, Math.floor(bot));
        for (let k = kStart; k <= kEnd; k++) {
          const c = Math.min(bot, k + 1) - Math.max(top, k);
          if (c > 1e-6) {
            idx[n] = k * size + i;
            cov[n] = c;
            n++;
          }
        }
      }
    } else {
      if (y0 > y1) {
        [x0, x1] = [x1, x0];
        [y0, y1] = [y1, y0];
      }
      const m = (x1 - x0) / (y1 - y0);
      const half = (widthPx * Math.sqrt(1 + m * m)) / 2;
      const jStart = Math.max(0, Math.ceil(y0 - 0.5));
      const jEnd = Math.min(size - 1, Math.floor(y1 - 0.5));
      for (let j = jStart; j <= jEnd; j++) {
        const xc = x0 + (j + 0.5 - y0) * m;
        const left = xc - half;
        const right = xc + half;
        const kStart = Math.max(0, Math.floor(left));
        const kEnd = Math.min(size - 1, Math.floor(right));
        const row = j * size;
        for (let k = kStart; k <= kEnd; k++) {
          const c = Math.min(right, k + 1) - Math.max(left, k);
          if (c > 1e-6) {
            idx[n] = row + k;
            cov[n] = c;
            n++;
          }
        }
      }
    }
    return n;
  }
}
