import { describe, expect, it } from 'vitest';
import {
  describeColor,
  extractPalette,
  generateCustomThreads,
  labToHex,
  labToLinearRgb,
  linearRgbToHex,
  linearRgbToLab,
  VRELLIS_LOOM,
  type RasterImage,
} from '../src/index.js';

function makeColorImage(
  width: number,
  height: number,
  fn: (x: number, y: number) => [number, number, number],
): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fn(x, y);
      const o = (y * width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

describe('CIELAB color conversions and naming', () => {
  it('converts between linear RGB and CIELAB accurately', () => {
    // Pure black
    const labBlack = linearRgbToLab(0, 0, 0);
    expect(labBlack[0]).toBeCloseTo(0, 1);
    expect(labToHex(labBlack[0], labBlack[1], labBlack[2])).toBe('#000000');

    // Pure white
    const labWhite = linearRgbToLab(1, 1, 1);
    expect(labWhite[0]).toBeCloseTo(100, 1);
    expect(labToHex(labWhite[0], labWhite[1], labWhite[2])).toBe('#ffffff');

    // Roundtrip for red [1, 0, 0]
    const labRed = linearRgbToLab(1, 0, 0);
    const [r, g, b] = labToLinearRgb(labRed[0], labRed[1], labRed[2]);
    expect(r).toBeCloseTo(1, 2);
    expect(g).toBeCloseTo(0, 2);
    expect(b).toBeCloseTo(0, 2);
    expect(linearRgbToHex(r, g, b)).toBe('#ff0000');
  });

  it('describes colors in friendly Portuguese with proper IDs', () => {
    const yellow = describeColor(linearRgbToLab(1, 1, 0));
    expect(yellow.name).toBe('Amarelo');
    expect(yellow.id).toBe('yellow');

    const cyan = describeColor(linearRgbToLab(0, 1, 1));
    expect(cyan.name).toBe('Ciano');
    expect(cyan.id).toBe('cyan');

    const blue = describeColor(linearRgbToLab(0, 0, 1));
    expect(blue.name).toBe('Azul');
    expect(blue.id).toBe('blue');

    const magenta = describeColor(linearRgbToLab(1, 0, 1));
    expect(magenta.name).toBe('Magenta');
    expect(magenta.id).toBe('magenta');

    const green = describeColor(linearRgbToLab(0, 0.4, 0));
    expect(green.name).toBe('Verde');
    expect(green.id).toBe('green');

    const black = describeColor(linearRgbToLab(0, 0, 0));
    expect(black.name).toBe('Preto');
    expect(black.id).toBe('black');

    const gray = describeColor(linearRgbToLab(0.5, 0.5, 0.5));
    expect(gray.name).toMatch(/Cinza/);
  });
});

describe('extractPalette and generateCustomThreads', () => {
  // Test image with 4 quadrants inside the circle: Yellow, Cyan, Magenta, Black
  // and outer corners filled with bright neon green (which must be ignored because it is outside the circle)
  const testImg = makeColorImage(200, 200, (x, y) => {
    const dx = x - 100;
    const dy = y - 100;
    if (dx * dx + dy * dy > 100 * 100) {
      // Outside loom circle: bright green
      return [0, 255, 0];
    }
    // Inside circle: 4 quadrants
    if (x < 100 && y < 100) return [255, 240, 0]; // Yellow
    if (x >= 100 && y < 100) return [0, 180, 240]; // Cyan
    if (x < 100 && y >= 100) return [220, 0, 120]; // Magenta
    return [20, 20, 20]; // Near black
  });

  it('samples only inside the circular loom mask and extracts k colors', () => {
    const result = extractPalette(testImg, 4, { seed: 123 });
    expect(result.threads).toHaveLength(4);
    expect(result.colorsHex).toHaveLength(4);
    expect(result.threadLineBudgets).toHaveLength(4);

    // Verify that the outside bright green ([0, 255, 0]) was NOT chosen as a cluster
    // Bright green has hex #00ff00 or similar with very negative a* and high b*
    for (const hex of result.colorsHex) {
      expect(hex.toLowerCase()).not.toBe('#00ff00');
    }
  });

  it('samples fairly from the bottom of the circle without early truncation', () => {
    // 200x200 image where top 60% (y < 120) is pure white and bottom 40% (y >= 140) is blue.
    // Early truncation previously aborted before y=130 and missed blue completely!
    const splitImg = makeColorImage(200, 200, (_x, y) => {
      return y < 130 ? [255, 255, 255] : [0, 0, 255];
    });

    const result = extractPalette(splitImg, 2, { seed: 42 });
    expect(result.threads).toHaveLength(2);
    // Must contain both a light tone (white) and a blue tone from the bottom
    const names = result.threads.map((t) => t.name);
    expect(names.some((n) => n.includes('Branco') || n.includes('Cinza'))).toBe(true);
    expect(names.some((n) => n.includes('Azul'))).toBe(true);
  });

  it('strictly orders threads by luminance descending (brightest first, dark anchor last)', () => {
    const result = extractPalette(testImg, 4, { seed: 42 });

    // Thread 0 should be the brightest (e.g. yellow)
    // Thread 3 should be the dark anchor (near black)
    const thread0 = result.threads[0];
    const threadLast = result.threads[3];

    expect(thread0.name).toBe('Amarelo');
    expect(threadLast.name).toMatch(/Preto|Grafite/);

    // Verify sum of quotas equals 1.0
    const sumQuota = result.threadLineBudgets.reduce((a, b) => a + b, 0);
    expect(sumQuota).toBeCloseTo(1.0, 5);

    // Dark anchor has 35%-40% quota
    expect(result.threadLineBudgets[3]).toBeGreaterThanOrEqual(0.35);
    expect(result.threadLineBudgets[3]).toBeLessThanOrEqual(0.45);
  });

  it('guarantees distinct colors and avoids collapse on monochromatic images', () => {
    // Pure white image
    const whiteImg = makeColorImage(100, 100, () => [255, 255, 255]);
    const resWhite = extractPalette(whiteImg, 4);
    expect(resWhite.threads).toHaveLength(4);

    // All 4 threads must have distinct colors (not all identical #ffffff)
    const uniqueHex = new Set(resWhite.colorsHex);
    expect(uniqueHex.size).toBe(4);

    // Dark anchor must be significantly darker than thread 0
    expect(resWhite.threads[0].color).not.toBe(resWhite.threads[3].color);
  });

  it('guarantees distinct colors for 2-color images when k=4', () => {
    // Left half white, right half blue
    const twoColorImg = makeColorImage(100, 100, (x, _y) => {
      return x < 50 ? [255, 255, 255] : [0, 0, 255];
    });

    const res = extractPalette(twoColorImg, 4, { seed: 42 });
    expect(res.threads).toHaveLength(4);
    const uniqueHex = new Set(res.colorsHex);
    expect(uniqueHex.size).toBe(4);
  });

  it('distributes start pegs evenly around the loom rim', () => {
    const custom = generateCustomThreads(testImg, 4, VRELLIS_LOOM, { seed: 42 });
    expect(custom.threads[0].startPeg).toBe(0);
    expect(custom.threads[1].startPeg).toBe(50);
    expect(custom.threads[2].startPeg).toBe(100);
    expect(custom.threads[3].startPeg).toBe(150);
  });

  it('is deterministic when seed is provided', () => {
    const res1 = extractPalette(testImg, 4, { seed: 999 });
    const res2 = extractPalette(testImg, 4, { seed: 999 });
    expect(res1.colorsHex).toEqual(res2.colorsHex);
    expect(res1.threads.map((t) => t.name)).toEqual(res2.threads.map((t) => t.name));
  });

  it('handles edge case k=2, k=5, and invalid k cleanly', () => {
    const res2 = extractPalette(testImg, 2, { seed: 42 });
    expect(res2.threads).toHaveLength(2);
    expect(res2.threadLineBudgets.reduce((a, b) => a + b, 0)).toBeCloseTo(1.0, 5);

    const res5 = extractPalette(testImg, 5, { seed: 42 });
    expect(res5.threads).toHaveLength(5);
    expect(res5.threadLineBudgets.reduce((a, b) => a + b, 0)).toBeCloseTo(1.0, 5);

    // Invalid / NaN k falls back safely to 4
    const resNaN = extractPalette(testImg, Number.NaN as unknown as number);
    expect(resNaN.threads).toHaveLength(4);
  });
});
