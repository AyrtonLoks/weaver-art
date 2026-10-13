import type { RasterImage } from '../src/index.js';

/** Build an RGBA image from a function returning an 8-bit grey value per pixel. */
export function syntheticImage(width: number, height: number, grey: (x: number, y: number) => number): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = grey(x, y);
      const o = (y * width + x) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

/** White background with a dark disc in the centre — a simple "portrait". */
export function discImage(size = 200): RasterImage {
  return syntheticImage(size, size, (x, y) => (Math.hypot(x - size / 2, y - size / 2) < size * 0.22 ? 30 : 255));
}
