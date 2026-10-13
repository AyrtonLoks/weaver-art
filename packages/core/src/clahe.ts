/**
 * Contrast-Limited Adaptive Histogram Equalization (CLAHE).
 *
 * Divides the image into a grid of contextual tiles (default 8x8),
 * computes a 256-bin histogram per tile, clips excessive contrast amplification,
 * redistributes clipped pixels uniformly, and bilinearly interpolates
 * between tile transformation functions to eliminate tile boundary artifacts.
 */

export interface ClaheOptions {
  /** Contrast clip limit factor (1 = no clipping/max equalization, >1 = typical 2-4). */
  clipLimit?: number;
  /** Number of tiles per dimension (e.g. 8 for an 8x8 grid). */
  gridSize?: number;
}

/**
 * Apply CLAHE to a single-channel 2D Float32Array with values in [0, 1].
 */
export function applyClahe(
  input: Float32Array,
  width: number,
  height: number,
  options: ClaheOptions = {},
): Float32Array {
  const clipLimit = options.clipLimit ?? 2.0;
  const gridSize = Math.max(2, Math.min(32, Math.floor(options.gridSize ?? 8)));

  const tileW = width / gridSize;
  const tileH = height / gridSize;

  // Precompute CDF LUTs for each tile in the grid
  // LUTs shape: gridSize x gridSize x 256
  const luts: Float32Array[][] = [];

  for (let ty = 0; ty < gridSize; ty++) {
    const rowLuts: Float32Array[] = [];
    const yStart = Math.floor(ty * tileH);
    const yEnd = Math.floor((ty + 1) * tileH);

    for (let tx = 0; tx < gridSize; tx++) {
      const xStart = Math.floor(tx * tileW);
      const xEnd = Math.floor((tx + 1) * tileW);
      const pixelCount = (xEnd - xStart) * (yEnd - yStart);

      const hist = new Uint32Array(256);
      for (let y = yStart; y < yEnd; y++) {
        const rowOffset = y * width;
        for (let x = xStart; x < xEnd; x++) {
          const val = input[rowOffset + x];
          const bin = Math.min(255, Math.max(0, Math.floor(val * 255.999)));
          hist[bin]++;
        }
      }

      // Clip histogram
      if (clipLimit > 0 && pixelCount > 0) {
        const clipThreshold = Math.max(1, Math.round((clipLimit * pixelCount) / 256));
        let excess = 0;
        for (let b = 0; b < 256; b++) {
          if (hist[b] > clipThreshold) {
            excess += hist[b] - clipThreshold;
            hist[b] = clipThreshold;
          }
        }

        const addPerBin = Math.floor(excess / 256);
        let remainder = excess % 256;
        for (let b = 0; b < 256; b++) {
          hist[b] += addPerBin;
        }
        if (remainder > 0) {
          const step = Math.max(1, Math.floor(256 / remainder));
          for (let b = 0; b < 256 && remainder > 0; b += step) {
            hist[b]++;
            remainder--;
          }
        }
      }

      // Compute normalized CDF
      const lut = new Float32Array(256);
      let cdf = 0;
      const total = pixelCount > 0 ? pixelCount : 1;
      for (let b = 0; b < 256; b++) {
        cdf += hist[b];
        lut[b] = Math.min(1, Math.max(0, cdf / total));
      }

      rowLuts.push(lut);
    }
    luts.push(rowLuts);
  }

  const output = new Float32Array(width * height);

  // Bilinear interpolation between contextual tile centers
  for (let y = 0; y < height; y++) {
    const fy = y / tileH - 0.5;
    let ty0 = Math.floor(fy);
    let ty1 = ty0 + 1;
    let wy = fy - ty0;

    if (ty0 < 0) {
      ty0 = 0;
      ty1 = 0;
      wy = 0;
    } else if (ty1 >= gridSize) {
      ty0 = gridSize - 1;
      ty1 = gridSize - 1;
      wy = 0;
    }

    const rowOffset = y * width;

    for (let x = 0; x < width; x++) {
      const fx = x / tileW - 0.5;
      let tx0 = Math.floor(fx);
      let tx1 = tx0 + 1;
      let wx = fx - tx0;

      if (tx0 < 0) {
        tx0 = 0;
        tx1 = 0;
        wx = 0;
      } else if (tx1 >= gridSize) {
        tx0 = gridSize - 1;
        tx1 = gridSize - 1;
        wx = 0;
      }

      const val = input[rowOffset + x];
      const bin = Math.min(255, Math.max(0, Math.floor(val * 255.999)));

      const lut00 = luts[ty0][tx0][bin];
      const lut10 = luts[ty0][tx1][bin];
      const lut01 = luts[ty1][tx0][bin];
      const lut11 = luts[ty1][tx1][bin];

      const interpolated =
        (1 - wx) * (1 - wy) * lut00 + wx * (1 - wy) * lut10 + (1 - wx) * wy * lut01 + wx * wy * lut11;

      output[rowOffset + x] = Math.min(1, Math.max(0, interpolated));
    }
  }

  return output;
}
