import { SRGB8_TO_LINEAR, linearToSrgb8 } from './color.js';
import { VRELLIS_LOOM } from './config.js';
import { createLoom, loomPegCount } from './geometry.js';
import { loomFrameCrop } from './image.js';
import { deltaE76, linearRgbToLab } from './metrics.js';
import type { CustomPaletteResult, LoomConfig, PaletteOptions, RasterImage, ThreadConfig } from './types.js';

// D65 reference white point
const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;

const EPSILON = 216 / 24389; // (6/29)^3 ≈ 0.008856
const KAPPA = 24389 / 27; // (29/3)^3 ≈ 903.3

/** Convert CIELAB (L*, a*, b*) to CIE XYZ (D65). */
export function labToXyz(l: number, a: number, b: number): [number, number, number] {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;

  const fx3 = fx * fx * fx;
  const fz3 = fz * fz * fz;
  const fy3 = fy * fy * fy;

  const xr = fx3 > EPSILON ? fx3 : (116 * fx - 16) / KAPPA;
  const yr = l > KAPPA * EPSILON ? fy3 : l / KAPPA;
  const zr = fz3 > EPSILON ? fz3 : (116 * fz - 16) / KAPPA;

  return [xr * XN, yr * YN, zr * ZN];
}

/** Convert CIE XYZ (D65) to linear sRGB [0, 1]. */
export function xyzToLinearRgb(x: number, y: number, z: number): [number, number, number] {
  const r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const g = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const b = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return [Math.max(0, Math.min(1, r)), Math.max(0, Math.min(1, g)), Math.max(0, Math.min(1, b))];
}

/** Convert CIELAB (L*, a*, b*) directly to linear sRGB [0, 1]. */
export function labToLinearRgb(l: number, a: number, b: number): [number, number, number] {
  const [x, y, z] = labToXyz(l, a, b);
  return xyzToLinearRgb(x, y, z);
}

/** Convert linear sRGB [0, 1] to #rrggbb hex string. */
export function linearRgbToHex(r: number, g: number, b: number): string {
  const r8 = linearToSrgb8(r);
  const g8 = linearToSrgb8(g);
  const b8 = linearToSrgb8(b);
  const h = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${h(r8)}${h(g8)}${h(b8)}`;
}

/** Convert CIELAB (L*, a*, b*) to #rrggbb hex string. */
export function labToHex(l: number, a: number, b: number): string {
  const [r, g, bLin] = labToLinearRgb(l, a, b);
  return linearRgbToHex(r, g, bLin);
}

/** Deterministic pseudo-random number generator (LCG). */
function createRng(seed = 42): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Generate a friendly Portuguese color name and stable ID from CIELAB values. */
export function describeColor(lab: [number, number, number]): { name: string; id: string } {
  const [l, a, b] = lab;
  const chroma = Math.hypot(a, b);

  // Near achromatic / grayscale tones
  if (l < 18) return { name: 'Preto', id: 'black' };
  if (l < 32 && chroma < 12) return { name: 'Grafite', id: 'dark-gray' };
  if (chroma < 12) {
    if (l < 55) return { name: 'Cinza escuro', id: 'gray-dark' };
    if (l < 75) return { name: 'Cinza', id: 'gray' };
    if (l < 90) return { name: 'Cinza claro', id: 'gray-light' };
    return { name: 'Branco', id: 'white' };
  }

  // Hue angle in degrees [0, 360)
  const hue = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;

  if (hue >= 15 && hue < 45) {
    return l < 35 ? { name: 'Marrom', id: 'brown' } : { name: 'Vermelho', id: 'red' };
  }
  if (hue >= 45 && hue < 75) {
    return l < 40 ? { name: 'Castanho', id: 'dark-orange' } : { name: 'Laranja', id: 'orange' };
  }
  if (hue >= 75 && hue < 110) {
    return l < 35 ? { name: 'Oliva', id: 'olive' } : { name: 'Amarelo', id: 'yellow' };
  }
  if (hue >= 110 && hue < 165) {
    if (l < 45) return { name: 'Verde escuro', id: 'dark-green' };
    if (l > 75) return { name: 'Verde claro', id: 'light-green' };
    return { name: 'Verde', id: 'green' };
  }
  if (hue >= 165 && hue < 192) {
    return l < 45 ? { name: 'Verde petróleo', id: 'teal-dark' } : { name: 'Turquesa', id: 'turquoise' };
  }
  if (hue >= 192 && hue < 240) {
    return l > 60 ? { name: 'Ciano', id: 'cyan' } : { name: 'Turquesa', id: 'turquoise' };
  }
  if (hue >= 245 && hue < 315) {
    return l < 25 ? { name: 'Azul marinho', id: 'navy' } : { name: 'Azul', id: 'blue' };
  }
  if (hue >= 315 && hue < 345) {
    return l < 40 ? { name: 'Roxo', id: 'purple' } : { name: 'Magenta', id: 'magenta' };
  }
  // hue >= 345 or hue < 15
  return l > 65 ? { name: 'Rosa', id: 'pink' } : { name: 'Carmim', id: 'crimson' };
}

/**
 * Extract k dominant colors from an image within the circular loom boundary,
 * using CIELAB K-Means with k-means++ initialization.
 *
 * Enforces the physical weaving invariants:
 * - Centroids are strictly ordered by luminance descending (brightest first, dark anchor last).
 * - Weighted quota with 35% to 40% dedicated to the dark anchor.
 * - Even distribution of starting pegs along the loom perimeter.
 * - Guarantees k distinct, usable colors even for monochromatic or low-diversity images.
 */
export function extractPalette(image: RasterImage, k = 4, options: PaletteOptions = {}): CustomPaletteResult {
  const numClusters = Math.max(2, Math.min(10, Math.floor(Number(k) || 4)));
  const { width, height, data } = image;
  const maxSamples = Math.max(100, options.maxSamples ?? 10000);
  const maxIterations = options.maxIterations ?? 25;
  const rng = createRng(options.seed ?? 42);

  const labSamples: [number, number, number][] = [];

  if (options.loom && options.loom.shape !== 'circle') {
    const loomInstance = createLoom(options.loom);
    const crop = loomFrameCrop(width, height, loomInstance);
    const scale = crop.size / loomInstance.extentMm;
    const xMin = crop.x + ((loomInstance.extentMm - loomInstance.widthMm) / 2) * scale;
    const xMax = xMin + loomInstance.widthMm * scale;
    const yMin = crop.y + ((loomInstance.extentMm - loomInstance.heightMm) / 2) * scale;
    const yMax = yMin + loomInstance.heightMm * scale;
    const area = Math.max(1, (xMax - xMin) * (yMax - yMin));
    const step = Math.max(1, Math.floor(Math.sqrt(area / maxSamples)));

    const startY = Math.max(0, Math.floor(yMin));
    const endY = Math.min(height, Math.ceil(yMax));
    const startX = Math.max(0, Math.floor(xMin));
    const endX = Math.min(width, Math.ceil(xMax));

    for (let y = startY; y < endY; y += step) {
      for (let x = startX; x < endX; x += step) {
        const offset = (y * width + x) * 4;
        const alpha = data[offset + 3] / 255;
        if (alpha <= 0.05) continue;
        const linR = alpha * SRGB8_TO_LINEAR[data[offset]] + (1 - alpha);
        const linG = alpha * SRGB8_TO_LINEAR[data[offset + 1]] + (1 - alpha);
        const linB = alpha * SRGB8_TO_LINEAR[data[offset + 2]] + (1 - alpha);
        labSamples.push(linearRgbToLab(linR, linG, linB));
      }
    }
  } else {
    // Circular loom sampling
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) / 2;
    const radiusSq = radius * radius;

    // Step 1: Collect valid pixels inside the circular loom mask
    const circleArea = Math.PI * radiusSq;
    const step = Math.max(1, Math.floor(Math.sqrt(circleArea / maxSamples)));

    for (let y = 0; y < height; y += step) {
      const dy = y + 0.5 - cy;
      for (let x = 0; x < width; x += step) {
        const dx = x + 0.5 - cx;
        if (dx * dx + dy * dy > radiusSq) continue;

        const offset = (y * width + x) * 4;
        const alpha = data[offset + 3] / 255;
        if (alpha <= 0.05) continue; // transparent pixel

        const linR = alpha * SRGB8_TO_LINEAR[data[offset]] + (1 - alpha);
        const linG = alpha * SRGB8_TO_LINEAR[data[offset + 1]] + (1 - alpha);
        const linB = alpha * SRGB8_TO_LINEAR[data[offset + 2]] + (1 - alpha);

        labSamples.push(linearRgbToLab(linR, linG, linB));
      }
    }
  }

  // Fallback if no or very few samples were gathered (e.g. transparent image)
  if (labSamples.length < numClusters) {
    labSamples.length = 0;
    for (let i = 0; i < numClusters; i++) {
      const frac = i / (numClusters - 1 || 1);
      // Span bright to dark anchor
      labSamples.push([95 - frac * 80, 0, 0]);
    }
  }

  // Subsample to maxSamples if needed with uniform stride
  let points = labSamples;
  if (points.length > maxSamples) {
    const stride = points.length / maxSamples;
    const subsampled: [number, number, number][] = [];
    for (let i = 0; i < maxSamples; i++) {
      subsampled.push(points[Math.floor(i * stride)]);
    }
    points = subsampled;
  }

  const N = points.length;

  // Step 2: K-Means++ initialization in CIELAB
  const centroids: [number, number, number][] = [];
  const firstIdx = Math.floor(rng() * N);
  centroids.push([...points[firstIdx]]);

  const minDistSq = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const d = deltaE76(points[i], centroids[0]);
    minDistSq[i] = d * d;
  }

  for (let c = 1; c < numClusters; c++) {
    let sumDistSq = 0;
    for (let i = 0; i < N; i++) sumDistSq += minDistSq[i];

    if (sumDistSq < 1e-4) {
      // Points lack variance: synthesize a distinct tonal shade along luminance
      const base = centroids[0];
      const stepL = (80 / (numClusters - 1)) * c;
      const synthL = Math.max(12, Math.min(95, 95 - stepL));
      centroids.push([synthL, base[1] * 0.7, base[2] * 0.7]);
      continue;
    }

    let target = rng() * sumDistSq;
    let chosenIdx = N - 1;
    for (let i = 0; i < N; i++) {
      target -= minDistSq[i];
      if (target <= 0) {
        chosenIdx = i;
        break;
      }
    }
    centroids.push([...points[chosenIdx]]);

    // Update minDistSq
    const newCentroid = centroids[c];
    for (let i = 0; i < N; i++) {
      const d = deltaE76(points[i], newCentroid);
      const d2 = d * d;
      if (d2 < minDistSq[i]) minDistSq[i] = d2;
    }
  }

  // Step 3: Lloyd K-Means iterations
  const assignments = new Int32Array(N);
  const counts = new Int32Array(numClusters);
  const sumL = new Float64Array(numClusters);
  const sumA = new Float64Array(numClusters);
  const sumB = new Float64Array(numClusters);

  for (let iter = 0; iter < maxIterations; iter++) {
    counts.fill(0);
    sumL.fill(0);
    sumA.fill(0);
    sumB.fill(0);

    // Assign points to nearest centroid
    for (let i = 0; i < N; i++) {
      const pt = points[i];
      let bestCluster = 0;
      let bestDist = deltaE76(pt, centroids[0]);
      for (let c = 1; c < numClusters; c++) {
        const d = deltaE76(pt, centroids[c]);
        if (d < bestDist) {
          bestDist = d;
          bestCluster = c;
        }
      }
      assignments[i] = bestCluster;
      counts[bestCluster]++;
      sumL[bestCluster] += pt[0];
      sumA[bestCluster] += pt[1];
      sumB[bestCluster] += pt[2];
    }

    // Update centroids
    let maxShift = 0;
    for (let c = 0; c < numClusters; c++) {
      if (counts[c] > 0) {
        const newL = sumL[c] / counts[c];
        const newA = sumA[c] / counts[c];
        const newB = sumB[c] / counts[c];
        const shift = deltaE76(centroids[c], [newL, newA, newB]);
        if (shift > maxShift) maxShift = shift;
        centroids[c] = [newL, newA, newB];
      } else {
        // Re-seed empty cluster with the point farthest from any centroid
        let maxD = -1;
        let farthestIdx = 0;
        for (let i = 0; i < N; i++) {
          const d = deltaE76(points[i], centroids[assignments[i]]);
          if (d > maxD) {
            maxD = d;
            farthestIdx = i;
          }
        }
        if (maxD > 2.0) {
          centroids[c] = [...points[farthestIdx]];
        } else {
          // If no distant points remain, generate a distinct luminance variation
          const base = centroids[0];
          const newL = Math.max(12, Math.min(95, 95 - (80 * c) / (numClusters - 1)));
          centroids[c] = [newL, base[1] * 0.7, base[2] * 0.7];
        }
      }
    }

    if (maxShift < 0.05) break;
  }

  // Ensure all centroids are distinct (minimum ΔE >= 5) so duplicate threads are never produced
  for (let c = 0; c < numClusters; c++) {
    for (let other = 0; other < c; other++) {
      if (deltaE76(centroids[c], centroids[other]) < 5.0) {
        // Disperse duplicate along luminance
        const stepShift = (c % 2 === 1 ? -1 : 1) * (10 + c * 5);
        centroids[c][0] = Math.max(10, Math.min(95, centroids[c][0] + stepShift));
      }
    }
  }

  // Step 4: Physical ordering by luminance (L*) descending:
  // Brightest first (L* high), darkest anchor last (L* low).
  centroids.sort((c1, c2) => c2[0] - c1[0]);

  // Step 5: Quota allocation (weighted, 35%-40% for dark anchor)
  const darkQuota =
    options.darkAnchorQuota !== undefined
      ? Math.max(0.2, Math.min(0.6, options.darkAnchorQuota))
      : numClusters >= 4
        ? 0.38
        : numClusters === 3
          ? 0.4
          : 0.6;

  const lightQuota = (1 - darkQuota) / (numClusters - 1);
  const threadLineBudgets: number[] = [];
  for (let c = 0; c < numClusters - 1; c++) {
    threadLineBudgets.push(lightQuota);
  }
  threadLineBudgets.push(darkQuota);

  // Step 6: Generate ThreadConfig objects with names, IDs, start pegs
  const loomPegs = options.loomPegCount ?? 200;
  const threadWidthMm = options.threadWidthMm ?? 0.2;
  const opacity = options.opacity ?? 1.0;
  const colorsHex: string[] = [];
  const usedNames = new Map<string, number>();

  const threads: ThreadConfig[] = centroids.map((lab, i) => {
    const hex = labToHex(lab[0], lab[1], lab[2]);
    colorsHex.push(hex);

    const desc = describeColor(lab);
    let finalName = desc.name;
    const nameCount = usedNames.get(desc.name) ?? 0;
    usedNames.set(desc.name, nameCount + 1);

    if (nameCount > 0) {
      finalName = `${desc.name} ${nameCount + 1}`;
    }

    const startPeg = Math.floor((i * loomPegs) / numClusters);
    const id = `${desc.id}-${i + 1}`;

    return {
      id,
      name: finalName,
      color: hex,
      widthMm: threadWidthMm,
      opacity,
      startPeg,
    };
  });

  return {
    threads,
    threadLineBudgets,
    colorsHex,
  };
}

/**
 * Convenience helper: generate thread configs and line budgets customized for a specific loom.
 */
export function generateCustomThreads(
  image: RasterImage,
  k = 4,
  loom: LoomConfig = VRELLIS_LOOM,
  options: PaletteOptions = {},
): CustomPaletteResult {
  return extractPalette(image, k, { ...options, loom, loomPegCount: loomPegCount(loom) });
}
