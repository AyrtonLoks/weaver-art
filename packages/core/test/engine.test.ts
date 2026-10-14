import { describe, expect, it } from 'vitest';
import {
  CMYK_THREADS,
  computeThreadBudgets,
  DEFAULT_OPTIONS,
  loomPegCount,
  pegDistance,
  prepareTarget,
  PRESETS,
  resolveOptions,
  toCSV,
  toInstructions,
  toSVG,
  WeaveEngine,
  type DeepPartial,
  type WeaveOptions,
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

describe('WeaveEngine', () => {
  it('reduces the error monotonically and respects loom constraints', () => {
    const engine = WeaveEngine.create(discImage(), small);
    const before = engine.rmse();
    const result = engine.run();
    expect(result.steps.length).toBeGreaterThan(20);
    expect(result.rmse).toBeLessThan(before);

    const N = loomPegCount(result.options.loom);
    const used = new Map<string, number>();
    result.steps.forEach((s, i) => {
      expect(s.gain).toBeGreaterThan(0);
      expect(pegDistance(s.from, s.to, N)).toBeGreaterThanOrEqual(result.options.minPegGap);
      if (i > 0) {
        // Single continuous thread: each chord starts where the previous ended, on the same side.
        expect(s.from).toBe(result.steps[i - 1].to);
        expect(s.fromSide).toBe(result.steps[i - 1].toSide);
      }
      const key = [Math.min(s.from, s.to), Math.max(s.from, s.to)].join('-');
      used.set(key, (used.get(key) ?? 0) + 1);
    });
    for (const count of used.values()) expect(count).toBeLessThanOrEqual(result.options.maxChordRepeats);
  });

  it('accounts for the full physical thread length (segments + wraps)', () => {
    const result = WeaveEngine.create(discImage(), small).run();
    const sum = result.steps.reduce((acc, s) => acc + s.segmentMm + s.wrapMm, 0);
    expect(result.totalLengthMm).toBeCloseTo(sum, 6);
    expect(result.steps.slice(1).every((s) => s.wrapMm > 0)).toBe(true);
    expect(result.threads[0].pegs).toHaveLength(result.steps.length + 1);
  });

  it('lays no thread on a blank (white) image', () => {
    const blank = syntheticImage(64, 64, () => 255);
    const result = WeaveEngine.create(blank, small).run();
    expect(result.steps).toHaveLength(0);
    expect(result.stopReason).toBe('no-improvement');
  });

  it('honours maxLines', () => {
    const result = WeaveEngine.create(discImage(), { ...small, maxLines: 10 }).run();
    expect(result.steps).toHaveLength(10);
    expect(result.stopReason).toBe('max-lines');
  });

  it('weaves several coloured threads, each continuous', () => {
    const image = syntheticImage(120, 120, (x) => (x < 60 ? 20 : 255));
    const result = WeaveEngine.create(image, {
      ...small,
      preprocess: { grayscale: false },
      threads: [
        { id: 'black', name: 'Preto', color: '#000000', widthMm: 0.3, opacity: 1, startPeg: 0 },
        { id: 'blue', name: 'Azul', color: '#1d3fbb', widthMm: 0.3, opacity: 1, startPeg: 60 },
      ],
    }).run();
    expect(result.threads).toHaveLength(2);
    for (let t = 0; t < 2; t++) {
      const steps = result.steps.filter((s) => s.thread === t);
      steps.slice(1).forEach((s, i) => expect(s.from).toBe(steps[i].to));
    }
  });

  it('weaves layered colors in sequence with each thread fulfilling its quota', () => {
    const multiColorRaster = {
      width: 100,
      height: 100,
      data: new Uint8ClampedArray(100 * 100 * 4),
    };
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) {
        const idx = (y * 100 + x) * 4;
        multiColorRaster.data[idx] = x < 50 ? 240 : 20;
        multiColorRaster.data[idx + 1] = y < 50 ? 200 : 30;
        multiColorRaster.data[idx + 2] = x + y < 100 ? 50 : 220;
        multiColorRaster.data[idx + 3] = 255;
      }
    }

    const cmykConfig: DeepPartial<WeaveOptions> = {
      resolutionPx: 160,
      maxLines: 60,
      minPegGap: 8,
      colorStrategy: 'layered',
      preprocess: { grayscale: false },
      threads: CMYK_THREADS,
      threadLineBudgets: [0.25, 0.25, 0.25, 0.25],
    };

    const engine = WeaveEngine.create(multiColorRaster, cmykConfig);
    const result = engine.run();

    expect(result.steps.length).toBeGreaterThan(20);
    const threadsUsed = result.threads.filter((t) => t.lines > 0);
    expect(threadsUsed.length).toBe(4);

    let maxLayerSeen = -1;
    for (const step of result.steps) {
      const layer = step.layerIndex ?? step.thread;
      expect(layer).toBeGreaterThanOrEqual(maxLayerSeen);
      maxLayerSeen = Math.max(maxLayerSeen, layer);
    }
  });

  it('weaves interleaved colors with fair distribution', () => {
    const multiColorRaster = {
      width: 100,
      height: 100,
      data: new Uint8ClampedArray(100 * 100 * 4),
    };
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) {
        const idx = (y * 100 + x) * 4;
        multiColorRaster.data[idx] = x < 50 ? 200 : 40;
        multiColorRaster.data[idx + 1] = y < 50 ? 180 : 50;
        multiColorRaster.data[idx + 2] = x + y > 100 ? 210 : 30;
        multiColorRaster.data[idx + 3] = 255;
      }
    }

    const balancedConfig: DeepPartial<WeaveOptions> = {
      resolutionPx: 160,
      maxLines: 60,
      minPegGap: 8,
      colorStrategy: 'interleaved-balanced',
      preprocess: { grayscale: false },
      threads: CMYK_THREADS,
      threadLineBudgets: [0.25, 0.25, 0.25, 0.25],
    };

    const engine = WeaveEngine.create(multiColorRaster, balancedConfig);
    const result = engine.run();

    expect(result.steps.length).toBeGreaterThan(20);
    for (const t of result.threads) {
      expect(t.lines).toBeGreaterThan(0);
    }
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

  it('accurately tracks currentThreadIndex and currentLayerIndex in both layered and interleaved modes', () => {
    const multiColorRaster = {
      width: 60,
      height: 60,
      data: new Uint8ClampedArray(60 * 60 * 4),
    };
    for (let i = 0; i < 60 * 60; i++) {
      multiColorRaster.data[i * 4] = 40;
      multiColorRaster.data[i * 4 + 1] = 40;
      multiColorRaster.data[i * 4 + 2] = 200;
      multiColorRaster.data[i * 4 + 3] = 255;
    }

    const layeredEngine = WeaveEngine.create(multiColorRaster, {
      ...small,
      loom: { pegCount: 200 },
      maxLines: 15,
      colorStrategy: 'layered',
      preprocess: { grayscale: false },
      threads: CMYK_THREADS,
    });
    layeredEngine.step();
    expect(layeredEngine.currentThreadIndex).toBeGreaterThanOrEqual(0);
    expect(layeredEngine.currentLayerIndex).toBeGreaterThanOrEqual(0);

    const interleavedEngine = WeaveEngine.create(multiColorRaster, {
      ...small,
      loom: { pegCount: 200 },
      maxLines: 15,
      colorStrategy: 'interleaved-balanced',
      preprocess: { grayscale: false },
      threads: CMYK_THREADS,
    });
    interleavedEngine.step();
    expect(interleavedEngine.currentThreadIndex).toBeGreaterThanOrEqual(0);
  });

  it('transfers stalled thread budget to black in interleaved strategy so total lines are preserved', () => {
    // Pure dark blue circle: yellow provides no gain over white/blue, but black and cyan do.
    const darkBlueRaster = syntheticImage(60, 60, () => 30);
    const engine = WeaveEngine.create(darkBlueRaster, {
      loom: { pegCount: 80 },
      resolutionPx: 120,
      maxLines: 40,
      minPegGap: 6,
      colorStrategy: 'interleaved-balanced',
      preprocess: { grayscale: false },
      threads: [
        { id: 'yellow', name: 'Amarelo', color: '#fff100', widthMm: 0.2, opacity: 1, startPeg: 0 },
        { id: 'black', name: 'Preto', color: '#000000', widthMm: 0.2, opacity: 1, startPeg: 40 },
      ],
      threadLineBudgets: [0.5, 0.5],
    });
    const result = engine.run();
    // Yellow cannot make gain on dark grayscale image, so its unused quota rolls over to black
    expect(result.steps.length).toBe(40);
    expect(result.threads[1].lines).toBeGreaterThanOrEqual(20);
  });
});

describe('exports', () => {
  const result = WeaveEngine.create(discImage(), { ...small, maxLines: 25 }).run();

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
    const multiColorRaster = syntheticImage(64, 64, () => 30);
    const res = WeaveEngine.create(multiColorRaster, {
      ...small,
      maxLines: 20,
      colorStrategy: 'layered',
      preprocess: { grayscale: false },
      threads: [
        { id: 'yellow', name: 'Amarelo', color: '#fff100', widthMm: 0.2, opacity: 1, startPeg: 0 },
        { id: 'black', name: 'Preto', color: '#000000', widthMm: 0.2, opacity: 1, startPeg: 60 },
      ],
    }).run();

    const txt = toInstructions(res);
    expect(txt).toContain('=== CAMADA');
  });

  it('does not emit layer headers between alternating chords in interleaved mode', () => {
    const multiColorRaster = syntheticImage(64, 64, () => 30);
    const res = WeaveEngine.create(multiColorRaster, {
      ...small,
      maxLines: 20,
      colorStrategy: 'interleaved-balanced',
      preprocess: { grayscale: false },
      threads: [
        { id: 'yellow', name: 'Amarelo', color: '#fff100', widthMm: 0.2, opacity: 1, startPeg: 0 },
        { id: 'black', name: 'Preto', color: '#000000', widthMm: 0.2, opacity: 1, startPeg: 60 },
      ],
    }).run();

    const txt = toInstructions(res);
    expect(txt).not.toContain('=== CAMADA');
  });

  it('favors shorter chords when lengthPenalty > 0', () => {
    const img = discImage();
    const resDefault = WeaveEngine.create(img, { ...small, maxLines: 30, lengthPenalty: 0 }).run();
    const resPenalized = WeaveEngine.create(img, { ...small, maxLines: 30, lengthPenalty: 0.3 }).run();

    expect(resDefault.steps.length).toBeGreaterThan(0);
    expect(resPenalized.steps.length).toBeGreaterThan(0);

    const avgLenDefault = resDefault.totalLengthMm / resDefault.steps.length;
    const avgLenPenalized = resPenalized.totalLengthMm / resPenalized.steps.length;

    expect(avgLenPenalized).toBeLessThanOrEqual(avgLenDefault);
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
      100, // Small loom diameter (100mm) makes retinal blur visible on 64px grid
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
    // Blurred image should have softened high frequencies
    expect(targetWithBlur.data[32 * 64 + 32]).not.toBe(targetNoBlur.data[32 * 64 + 32]);
  });

  it('runs global refinement automatically when refinePasses > 0', () => {
    const img = discImage();
    const res = WeaveEngine.create(img, { ...small, maxLines: 25, refinePasses: 1 }).run();
    expect(res.steps.length).toBe(25);
    expect(res.metrics).toBeDefined();
    expect(res.metrics?.rmse).toBeCloseTo(res.rmse, 6);
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

  it('weaves successfully on a rectangular loom, respecting chordMask and reducing RMSE', () => {
    const img = discImage();
    const rectLoom = {
      shape: 'rectangle' as const,
      widthMm: 400,
      heightMm: 300,
      pegsX: 12,
      pegsY: 10,
      pegDiameterMm: 1.5,
    };
    const engine = WeaveEngine.create(img, {
      ...small,
      loom: rectLoom,
      maxLines: 20,
      minPegGap: 2,
    });

    const result = engine.run();

    expect(result.steps.length).toBe(20);
    expect(result.rmse).toBeGreaterThan(0);
    expect(result.steps.every((s) => s.gain > 0)).toBe(true);

    // Verify no chosen chord lies on the same straight edge
    for (const step of result.steps) {
      const pA = engine.loom.pegs[step.from];
      const pB = engine.loom.pegs[step.to];
      if (pA.edges !== 0 && pB.edges !== 0) {
        expect((pA.edges & pB.edges) === 0).toBe(true);
      }
    }
  });

  it('weaves successfully on a custom loom imported from CSV-style coordinates', () => {
    const img = discImage();
    const customPegs = [
      { x: 50, y: 0 },
      { x: 150, y: 0 },
      { x: 200, y: 80 },
      { x: 170, y: 160 },
      { x: 30, y: 160 },
      { x: 0, y: 80 },
    ];
    const engine = WeaveEngine.create(img, {
      ...small,
      loom: {
        shape: 'custom' as const,
        pegs: customPegs,
        pegDiameterMm: 1,
      },
      maxLines: 15,
      minPegGap: 1,
    });

    const result = engine.run();

    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.rmse).toBeGreaterThan(0);
    expect(result.steps.every((s) => s.gain > 0)).toBe(true);
  });

  it('produces bit-identical weave steps with rasterCacheMb: 0 vs 128 across mono, CMYK, and rectangular loom', () => {
    const img = discImage();

    // 1. Mono circle
    const monoOpts: DeepPartial<WeaveOptions> = { ...small, maxLines: 25 };
    const eMonoUncached = WeaveEngine.create(img, { ...monoOpts, rasterCacheMb: 0 });
    const rMonoUncached = eMonoUncached.run();
    const eMonoCached = WeaveEngine.create(img, { ...monoOpts, rasterCacheMb: 128 });
    const rMonoCached = eMonoCached.run();

    expect(rMonoCached.steps.length).toBe(rMonoUncached.steps.length);
    for (let i = 0; i < rMonoCached.steps.length; i++) {
      expect(rMonoCached.steps[i].from).toBe(rMonoUncached.steps[i].from);
      expect(rMonoCached.steps[i].to).toBe(rMonoUncached.steps[i].to);
      expect(rMonoCached.steps[i].fromSide).toBe(rMonoUncached.steps[i].fromSide);
      expect(rMonoCached.steps[i].toSide).toBe(rMonoUncached.steps[i].toSide);
      expect(rMonoCached.steps[i].gain).toBe(rMonoUncached.steps[i].gain);
    }
    expect(eMonoCached.perf.cacheHits).toBeGreaterThan(0);

    // 2. CMYK circle
    const cmykOpts: DeepPartial<WeaveOptions> = {
      ...small,
      maxLines: 20,
      threads: CMYK_THREADS.map((t, i) => ({ ...t, startPeg: i * 10 })),
      preprocess: { grayscale: false },
    };
    const eCmykUncached = WeaveEngine.create(img, { ...cmykOpts, rasterCacheMb: 0 });
    const rCmykUncached = eCmykUncached.run();
    const eCmykCached = WeaveEngine.create(img, { ...cmykOpts, rasterCacheMb: 128 });
    const rCmykCached = eCmykCached.run();

    expect(rCmykCached.steps.length).toBe(rCmykUncached.steps.length);
    for (let i = 0; i < rCmykCached.steps.length; i++) {
      expect(rCmykCached.steps[i].thread).toBe(rCmykUncached.steps[i].thread);
      expect(rCmykCached.steps[i].from).toBe(rCmykUncached.steps[i].from);
      expect(rCmykCached.steps[i].to).toBe(rCmykUncached.steps[i].to);
      expect(rCmykCached.steps[i].gain).toBe(rCmykUncached.steps[i].gain);
    }

    // 3. Rectangular loom
    const rectOpts: DeepPartial<WeaveOptions> = {
      ...small,
      maxLines: 20,
      minPegGap: 2,
      loom: {
        shape: 'rectangle' as const,
        widthMm: 200,
        heightMm: 150,
        pegsX: 12,
        pegsY: 8,
        pegDiameterMm: 1.5,
      },
    };
    const eRectUncached = WeaveEngine.create(img, { ...rectOpts, rasterCacheMb: 0 });
    const rRectUncached = eRectUncached.run();
    const eRectCached = WeaveEngine.create(img, { ...rectOpts, rasterCacheMb: 128 });
    const rRectCached = eRectCached.run();

    expect(rRectCached.steps.length).toBe(rRectUncached.steps.length);
    for (let i = 0; i < rRectCached.steps.length; i++) {
      expect(rRectCached.steps[i].from).toBe(rRectUncached.steps[i].from);
      expect(rRectCached.steps[i].to).toBe(rRectUncached.steps[i].to);
      expect(rRectCached.steps[i].gain).toBe(rRectUncached.steps[i].gain);
    }
  });
});
