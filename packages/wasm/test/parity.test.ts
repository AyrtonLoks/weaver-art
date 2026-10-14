import { describe, expect, it } from 'vitest';
import { CMYK_THREADS, WeaveEngine, type DeepPartial, type RasterImage, type WeaveOptions } from '@weaver-art/core';
import { createWasmEvaluator } from '../src/index.js';

function createSyntheticImage(size = 80): RasterImage {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - size / 2;
      const dy = y - size / 2;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const val = dist < size * 0.35 ? Math.floor(40 + (dist / (size * 0.35)) * 100) : 255;
      data[idx] = val;
      data[idx + 1] = Math.floor(val * 0.9);
      data[idx + 2] = Math.floor(val * 0.8);
      data[idx + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

describe('WASM Kernel Parity with JS Evaluator', () => {
  const img = createSyntheticImage(80);

  const baseConfig: DeepPartial<WeaveOptions> = {
    resolutionPx: 80,
    maxLines: 20,
    minPegGap: 6,
    loom: {
      shape: 'circle',
      diameterMm: 200,
      pegCount: 30,
      pegDiameterMm: 2,
    },
  };

  it('yields bit-identical steps in monochrome circle', async () => {
    const wasmFactory = await createWasmEvaluator();

    const jsEngine = WeaveEngine.create(img, baseConfig);
    const jsResult = jsEngine.run();

    const wasmEngine = await WeaveEngine.createAsync(img, baseConfig, undefined, {
      evaluator: wasmFactory,
    });
    const wasmResult = wasmEngine.run();

    expect(wasmResult.steps.length).toBe(jsResult.steps.length);
    for (let i = 0; i < jsResult.steps.length; i++) {
      const jsStep = jsResult.steps[i];
      const wasmStep = wasmResult.steps[i];
      expect(wasmStep.from).toBe(jsStep.from);
      expect(wasmStep.to).toBe(jsStep.to);
      expect(wasmStep.fromSide).toBe(jsStep.fromSide);
      expect(wasmStep.toSide).toBe(jsStep.toSide);
      expect(wasmStep.gain).toBeCloseTo(jsStep.gain, 6);
    }
    expect(wasmResult.rmse).toBeCloseTo(jsResult.rmse, 6);
  });

  it('yields bit-identical steps in CMYK multi-color', async () => {
    const wasmFactory = await createWasmEvaluator();
    const cmykConfig: DeepPartial<WeaveOptions> = {
      ...baseConfig,
      maxLines: 25,
      threads: CMYK_THREADS.map((t, i) => ({ ...t, startPeg: i * 5 })),
      preprocess: { grayscale: false },
    };

    const jsEngine = WeaveEngine.create(img, cmykConfig);
    const jsResult = jsEngine.run();

    const wasmEngine = await WeaveEngine.createAsync(img, cmykConfig, undefined, {
      evaluator: wasmFactory,
    });
    const wasmResult = wasmEngine.run();

    expect(wasmResult.steps.length).toBe(jsResult.steps.length);
    for (let i = 0; i < jsResult.steps.length; i++) {
      expect(wasmResult.steps[i].thread).toBe(jsResult.steps[i].thread);
      expect(wasmResult.steps[i].from).toBe(jsResult.steps[i].from);
      expect(wasmResult.steps[i].to).toBe(jsResult.steps[i].to);
      expect(wasmResult.steps[i].gain).toBeCloseTo(jsResult.steps[i].gain, 6);
    }
  });

  it('yields bit-identical steps with lengthPenalty > 0', async () => {
    const wasmFactory = await createWasmEvaluator();
    const penaltyConfig: DeepPartial<WeaveOptions> = {
      ...baseConfig,
      lengthPenalty: 0.25,
    };

    const jsEngine = WeaveEngine.create(img, penaltyConfig);
    const jsResult = jsEngine.run();

    const wasmEngine = await WeaveEngine.createAsync(img, penaltyConfig, undefined, {
      evaluator: wasmFactory,
    });
    const wasmResult = wasmEngine.run();

    expect(wasmResult.steps.length).toBe(jsResult.steps.length);
    for (let i = 0; i < jsResult.steps.length; i++) {
      expect(wasmResult.steps[i].from).toBe(jsResult.steps[i].from);
      expect(wasmResult.steps[i].to).toBe(jsResult.steps[i].to);
      expect(wasmResult.steps[i].gain).toBeCloseTo(jsResult.steps[i].gain, 6);
    }
  });

  it('yields bit-identical steps with ideal pegs (radius = 0)', async () => {
    const wasmFactory = await createWasmEvaluator();
    const idealConfig: DeepPartial<WeaveOptions> = {
      ...baseConfig,
      loom: {
        ...baseConfig.loom,
        pegDiameterMm: 0,
      },
    };

    const jsEngine = WeaveEngine.create(img, idealConfig);
    const jsResult = jsEngine.run();

    const wasmEngine = await WeaveEngine.createAsync(img, idealConfig, undefined, {
      evaluator: wasmFactory,
    });
    const wasmResult = wasmEngine.run();

    expect(wasmResult.steps.length).toBe(jsResult.steps.length);
    for (let i = 0; i < jsResult.steps.length; i++) {
      expect(wasmResult.steps[i].from).toBe(jsResult.steps[i].from);
      expect(wasmResult.steps[i].to).toBe(jsResult.steps[i].to);
    }
  });

  it('yields bit-identical steps on rectangular loom', async () => {
    const wasmFactory = await createWasmEvaluator();
    const rectConfig: DeepPartial<WeaveOptions> = {
      ...baseConfig,
      minPegGap: 2,
      loom: {
        shape: 'rectangle',
        widthMm: 200,
        heightMm: 150,
        pegsX: 10,
        pegsY: 8,
        pegDiameterMm: 1.5,
      },
    };

    const jsEngine = WeaveEngine.create(img, rectConfig);
    const jsResult = jsEngine.run();

    const wasmEngine = await WeaveEngine.createAsync(img, rectConfig, undefined, {
      evaluator: wasmFactory,
    });
    const wasmResult = wasmEngine.run();

    expect(wasmResult.steps.length).toBe(jsResult.steps.length);
    for (let i = 0; i < jsResult.steps.length; i++) {
      expect(wasmResult.steps[i].from).toBe(jsResult.steps[i].from);
      expect(wasmResult.steps[i].to).toBe(jsResult.steps[i].to);
      expect(wasmResult.steps[i].gain).toBeCloseTo(jsResult.steps[i].gain, 6);
    }
  });

  it('yields bit-identical steps on custom loom', async () => {
    const wasmFactory = await createWasmEvaluator();
    const customPegs = [
      { x: 30, y: 0 },
      { x: 100, y: 0 },
      { x: 130, y: 50 },
      { x: 110, y: 110 },
      { x: 20, y: 110 },
      { x: 0, y: 50 },
    ];
    const customConfig: DeepPartial<WeaveOptions> = {
      ...baseConfig,
      minPegGap: 1,
      loom: {
        shape: 'custom',
        pegs: customPegs,
        pegDiameterMm: 1,
      },
    };

    const jsEngine = WeaveEngine.create(img, customConfig);
    const jsResult = jsEngine.run();

    const wasmEngine = await WeaveEngine.createAsync(img, customConfig, undefined, {
      evaluator: wasmFactory,
    });
    const wasmResult = wasmEngine.run();

    expect(wasmResult.steps.length).toBe(jsResult.steps.length);
    for (let i = 0; i < jsResult.steps.length; i++) {
      expect(wasmResult.steps[i].from).toBe(jsResult.steps[i].from);
      expect(wasmResult.steps[i].to).toBe(jsResult.steps[i].to);
    }
  });
});
