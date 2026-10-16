import { describe, expect, it } from 'vitest';
import {
  CMYK_THREADS,
  computeThreadBudgets,
  DEFAULT_OPTIONS,
  prepareTarget,
  PRESETS,
  resolveOptions,
  toCSV,
  toInstructions,
  toSVG,
  WeaveEngine,
  type DeepPartial,
  type WeaveOptions,
  type WeaveResult,
} from '../src/index.js';
import { discImage, syntheticImage } from './fixtures.js';

const small: DeepPartial<WeaveOptions> = {
  resolutionPx: 160,
  maxLines: 150,
  loom: { pegCount: 120 },
  minPegGap: 8,
};

describe('options', () => {
  it('defaults follow the published Vrellis loom', () => {
    expect(DEFAULT_OPTIONS.loom.shape).toBe('circle');
    if (DEFAULT_OPTIONS.loom.shape === 'circle') {
      expect(DEFAULT_OPTIONS.loom.pegCount).toBe(200);
      expect(DEFAULT_OPTIONS.loom.diameterMm).toBeCloseTo(711.2, 6);
    }
    expect(DEFAULT_OPTIONS.maxLines).toBe(4000);
  });

  it('provides correct CMYK and Vrellis color presets with ordered subtractive layers', () => {
    expect(PRESETS.cmyk).toBeDefined();
    expect(PRESETS.cmyk.threads).toHaveLength(4);
    expect(PRESETS.cmyk.threads.map((t) => t.id)).toEqual(['yellow', 'cyan', 'magenta', 'black']);
    expect(PRESETS.cmyk.threadLineBudgets).toEqual([0.2, 0.2, 0.2, 0.4]);

    expect(PRESETS['vrellis-color'].threads).toHaveLength(5);
    expect(PRESETS['vrellis-color'].threads.map((t) => t.id)).toEqual(['yellow', 'magenta', 'blue', 'green', 'black']);
    expect(PRESETS['vrellis-color'].threadLineBudgets).toEqual([0.2, 0.2, 0.2, 0.1, 0.3]);
  });

  it('computes thread line budgets accurately', () => {
    const cmykOptions = resolveOptions({ maxLines: 10000 }, PRESETS.cmyk);
    const budgets = computeThreadBudgets(cmykOptions);
    expect(budgets).toEqual([2000, 2000, 2000, 4000]);
    expect(budgets.reduce((a, b) => a + b, 0)).toBe(10000);

    const vrellisOptions = resolveOptions({ maxLines: 10000 }, PRESETS['vrellis-color']);
    const vBudgets = computeThreadBudgets(vrellisOptions);
    expect(vBudgets).toEqual([2000, 2000, 2000, 1000, 3000]);
    expect(vBudgets.reduce((a, b) => a + b, 0)).toBe(10000);
  });

  it('rejects invalid configurations', () => {
    expect(() => resolveOptions({ loom: { pegCount: 2 } })).toThrow(/pegCount/);
    expect(() => resolveOptions({ loom: { pegDiameterMm: 20 } })).toThrow(/espaçamento/);
    expect(() => resolveOptions({ threads: [] })).toThrow(/fio/);
    expect(() => resolveOptions({ colorStrategy: 'invalid' as unknown as WeaveOptions['colorStrategy'] })).toThrow(
      /colorStrategy/,
    );
    expect(() => resolveOptions({ threadLineBudgets: [0.5, 0.5] })).toThrow(/threadLineBudgets/);
    expect(() => resolveOptions({ threadLineBudgets: [-0.5] })).toThrow(/threadLineBudgets/);
    expect(() => resolveOptions({ preprocess: { shadowLift: -0.1 } })).toThrow(/shadowLift/);
    expect(() => resolveOptions({ preprocess: { edgeEmphasis: 1.5 } })).toThrow(/edgeEmphasis/);
  });
});

describe('WeaveEngine (stubbed JS engine)', () => {
  it('initializes target and returns a valid WeaveResult stub without running legacy JS loop', () => {
    const engine = WeaveEngine.create(discImage(), small);
    expect(engine.rmse()).toBeGreaterThan(0);
    const result = engine.run();
    expect(result.version).toBe(1);
    expect(result.steps).toHaveLength(0);
    expect(result.stopReason).toBe('no-candidates');
  });

  it('applies shadow lift and edge emphasis', () => {
    const highContrastRaster = {
      width: 64,
      height: 64,
      data: new Uint8ClampedArray(64 * 64 * 4),
    };
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const idx = (y * 64 + x) * 4;
        const val = x > 20 && x < 44 && y > 20 && y < 44 ? 0 : 255;
        highContrastRaster.data[idx] = val;
        highContrastRaster.data[idx + 1] = val;
        highContrastRaster.data[idx + 2] = val;
        highContrastRaster.data[idx + 3] = 255;
      }
    }

    const baseOpts = {
      grayscale: true,
      contrast: 1,
      brightness: 0,
      gamma: 1,
      invert: false,
      shadowLift: 0,
      edgeEmphasis: 0,
    };
    const targetBase = prepareTarget(highContrastRaster, 64, baseOpts, 1);

    const liftedOpts = { ...baseOpts, shadowLift: 0.15, edgeEmphasis: 0.5 };
    const targetLifted = prepareTarget(highContrastRaster, 64, liftedOpts, 1);

    const centerIdx = 32 * 64 + 32;
    expect(targetLifted.data[centerIdx]).toBeGreaterThan(targetBase.data[centerIdx]);

    const edgeIdx = 32 * 64 + 20;
    expect(targetLifted.weight[edgeIdx]).toBeGreaterThan(targetBase.weight[edgeIdx]);
  });

  it('prepares target with viewing distance retinal blur and CLAHE', () => {
    const img = syntheticImage(64, 64, (x, y) => (x % 4 === 0 || y % 4 === 0 ? 0 : 255));
    const targetNoBlur = prepareTarget(img, 64, { ...DEFAULT_OPTIONS.preprocess, grayscale: true }, 1);
    const targetWithBlur = prepareTarget(
      img,
      64,
      { ...DEFAULT_OPTIONS.preprocess, grayscale: true, viewingDistanceM: 5.0 },
      1,
      undefined,
      100,
    );
    const targetWithClahe = prepareTarget(
      img,
      64,
      { ...DEFAULT_OPTIONS.preprocess, grayscale: true, clahe: true, claheClipLimit: 2.0 },
      1,
    );

    expect(targetNoBlur.data.length).toBe(64 * 64);
    expect(targetWithBlur.data.length).toBe(64 * 64);
    expect(targetWithClahe.data.length).toBe(64 * 64);
    expect(targetWithBlur.data[32 * 64 + 32]).not.toBe(targetNoBlur.data[32 * 64 + 32]);
  });

  it('applies viewingDistanceM specified at root WeaveOptions to engine.target', () => {
    const img = syntheticImage(64, 64, (x, y) => (x % 4 === 0 || y % 4 === 0 ? 0 : 255));
    const engineNoBlur = WeaveEngine.create(img, {
      ...small,
      resolutionPx: 64,
      loom: { diameterMm: 300, pegDiameterMm: 1 },
      viewingDistanceM: 0,
    });
    const engineWithBlur = WeaveEngine.create(img, {
      ...small,
      resolutionPx: 64,
      loom: { diameterMm: 300, pegDiameterMm: 1 },
      viewingDistanceM: 5.0,
    });

    expect(engineWithBlur.target.data[32 * 64 + 32]).not.toBe(engineNoBlur.target.data[32 * 64 + 32]);
  });
});

describe('exports', () => {
  const options = resolveOptions({
    ...small,
    colorStrategy: 'layered',
    threads: CMYK_THREADS.slice(0, 2),
  });
  const result: WeaveResult = {
    version: 1,
    options,
    steps: [
      {
        index: 0,
        thread: 0,
        from: 0,
        to: 40,
        fromSide: 1,
        toSide: 1,
        gain: 0.1,
        segmentMm: 300,
        wrapMm: 0,
        layerIndex: 0,
      },
      {
        index: 1,
        thread: 1,
        from: 50,
        to: 90,
        fromSide: 1,
        toSide: -1,
        gain: 0.08,
        segmentMm: 310,
        wrapMm: 2,
        layerIndex: 1,
      },
    ],
    threads: [
      { ...options.threads[0], pegs: [0, 40], lengthMm: 300, lines: 1 },
      { ...options.threads[1], pegs: [50, 90], lengthMm: 312, lines: 1 },
    ],
    totalLengthMm: 612,
    rmse: 0.12,
    stopReason: 'max-lines',
    durationMs: 10,
  };

  it('writes numbered instructions starting at peg 1', () => {
    const txt = toInstructions(result);
    expect(txt).toContain('INSTRUÇÕES');
    const first = result.steps[0];
    expect(txt).toContain(`${first.from + 1} → ${String(first.to + 1).padStart(3)}`);
  });

  it('writes CSV and real-scale SVG', () => {
    expect(toCSV(result).trim().split('\n')).toHaveLength(result.steps.length + 1);
    const svg = toSVG(result);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('width="751.2mm"');
    expect(svg).toContain('<path');
    expect(svg).toContain('<g id="layer-');
  });

  it('groups instructions with layer headers for layered multi-color', () => {
    const txt = toInstructions(result);
    expect(txt).toContain('=== CAMADA');
  });
});
