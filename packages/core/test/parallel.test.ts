import { describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import {
  WeaveEngine,
  createSharedBuffers,
  createSharedControl,
  ParallelEvaluator,
  type RasterImage,
  type WeaveOptions,
  type EvaluatorSetup,
} from '../src/index.js';

function makeSyntheticImage(size = 64): RasterImage {
  const data = new Uint8ClampedArray(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.35;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const d = Math.hypot(x - cx, y - cy);
      const val = d < r ? 40 : 230;
      data[idx] = val;
      data[idx + 1] = val;
      data[idx + 2] = val;
      data[idx + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

describe('ParallelEvaluator', () => {
  it('falls back seamlessly to local evaluation when workerCount = 1', () => {
    const img = makeSyntheticImage(64);
    const options: Partial<WeaveOptions> = {
      maxLines: 10,
      resolutionPx: 64,
      loom: { shape: 'circle', diameterMm: 200, pegCount: 40, startAngleDeg: 0, pegDiameterMm: 2 },
    };

    const engineSeq = WeaveEngine.create(img, options);
    const resSeq = engineSeq.run();

    // With workerCount = 1
    const sharedCtrl = createSharedControl(1);
    const enginePar = WeaveEngine.create(img, options, undefined, {
      evaluator: (setup: EvaluatorSetup) => {
        const { buffers } = createSharedBuffers(setup, false);
        return new ParallelEvaluator({
          workerCount: 1,
          setup,
          buffers,
          sharedControl: sharedCtrl,
        });
      },
    });
    const resPar = enginePar.run();

    expect(resPar.steps.length).toBe(resSeq.steps.length);
    for (let i = 0; i < resSeq.steps.length; i++) {
      expect(resPar.steps[i].from).toBe(resSeq.steps[i].from);
      expect(resPar.steps[i].to).toBe(resSeq.steps[i].to);
      expect(resPar.steps[i].fromSide).toBe(resSeq.steps[i].fromSide);
      expect(resPar.steps[i].toSide).toBe(resSeq.steps[i].toSide);
      expect(resPar.steps[i].gain).toBeCloseTo(resSeq.steps[i].gain, 8);
    }
  });

  it('produces bit-identical steps to sequential execution with 2 worker threads', async () => {
    const img = makeSyntheticImage(64);
    const options: Partial<WeaveOptions> = {
      maxLines: 20,
      resolutionPx: 64,
      loom: { shape: 'circle', diameterMm: 200, pegCount: 50, startAngleDeg: 0, pegDiameterMm: 2 },
    };

    const engineSeq = WeaveEngine.create(img, options);
    const resSeq = engineSeq.run();

    const workerCount = 2; // 1 coordinator + 1 helper worker
    const sharedCtrl = createSharedControl(workerCount);
    let workerHandle: Worker | null = null;

    const enginePar = await WeaveEngine.createAsync(img, options, undefined, {
      evaluator: (setup: EvaluatorSetup) => {
        const { buffers, descriptor: buffersDesc } = createSharedBuffers(setup, false);

        workerHandle = new Worker(new URL('./worker-helper.mjs', import.meta.url));
        workerHandle.postMessage({
          type: 'start',
          workerIndex: 1,
          workerCount,
          controlDesc: sharedCtrl.descriptor,
          setup,
          buffersDesc,
        });

        const parEval = new ParallelEvaluator({
          workerCount,
          setup,
          buffers,
          sharedControl: sharedCtrl,
          onDispose: () => {
            if (workerHandle) {
              workerHandle.terminate();
              workerHandle = null;
            }
          },
        });
        parEval.waitUntilReady();
        return parEval;
      },
    });

    const resPar = enginePar.run();
    enginePar.dispose();

    expect(resPar.steps.length).toBe(resSeq.steps.length);
    for (let i = 0; i < resSeq.steps.length; i++) {
      expect(resPar.steps[i].from).toBe(resSeq.steps[i].from);
      expect(resPar.steps[i].to).toBe(resSeq.steps[i].to);
      expect(resPar.steps[i].fromSide).toBe(resSeq.steps[i].fromSide);
      expect(resPar.steps[i].toSide).toBe(resSeq.steps[i].toSide);
      expect(resPar.steps[i].gain).toBeCloseTo(resSeq.steps[i].gain, 8);
    }
  });

  it('produces bit-identical steps to sequential execution with 4 worker threads', async () => {
    const img = makeSyntheticImage(64);
    const options: Partial<WeaveOptions> = {
      maxLines: 25,
      resolutionPx: 64,
      loom: { shape: 'circle', diameterMm: 200, pegCount: 60, startAngleDeg: 0, pegDiameterMm: 2 },
    };

    const engineSeq = WeaveEngine.create(img, options);
    const resSeq = engineSeq.run();

    const workerCount = 4; // 1 coordinator + 3 helper workers
    const sharedCtrl = createSharedControl(workerCount);
    const workers: Worker[] = [];

    const enginePar = await WeaveEngine.createAsync(img, options, undefined, {
      evaluator: (setup: EvaluatorSetup) => {
        const { buffers, descriptor: buffersDesc } = createSharedBuffers(setup, false);

        for (let w = 1; w < workerCount; w++) {
          const worker = new Worker(new URL('./worker-helper.mjs', import.meta.url));
          worker.postMessage({
            type: 'start',
            workerIndex: w,
            workerCount,
            controlDesc: sharedCtrl.descriptor,
            setup,
            buffersDesc,
          });
          workers.push(worker);
        }

        const parEval = new ParallelEvaluator({
          workerCount,
          setup,
          buffers,
          sharedControl: sharedCtrl,
          onDispose: () => {
            workers.forEach((w) => w.terminate());
            workers.length = 0;
          },
        });
        parEval.waitUntilReady();
        return parEval;
      },
    });

    const resPar = enginePar.run();
    enginePar.dispose();

    expect(resPar.steps.length).toBe(resSeq.steps.length);
    for (let i = 0; i < resSeq.steps.length; i++) {
      expect(resPar.steps[i].from).toBe(resSeq.steps[i].from);
      expect(resPar.steps[i].to).toBe(resSeq.steps[i].to);
      expect(resPar.steps[i].fromSide).toBe(resSeq.steps[i].fromSide);
      expect(resPar.steps[i].toSide).toBe(resSeq.steps[i].toSide);
      expect(resPar.steps[i].gain).toBeCloseTo(resSeq.steps[i].gain, 8);
    }
  });

  it('produces bit-identical steps with fidelity options (angularDiversity, highlightProtection, centerDamp)', async () => {
    const img = makeSyntheticImage(64);
    const options: Partial<WeaveOptions> = {
      maxLines: 20,
      resolutionPx: 64,
      highlightProtection: 2.5,
      angularDiversity: 0.35,
      centerDampRadiusMm: 20,
      loom: { shape: 'circle', diameterMm: 200, pegCount: 40, startAngleDeg: 0, pegDiameterMm: 2 },
    };

    const engineSeq = WeaveEngine.create(img, options);
    const resSeq = engineSeq.run();

    const workerCount = 2;
    const sharedCtrl = createSharedControl(workerCount);
    let workerHandle: Worker | null = null;

    const enginePar = await WeaveEngine.createAsync(img, options, undefined, {
      evaluator: (setup: EvaluatorSetup) => {
        const { buffers, descriptor: buffersDesc } = createSharedBuffers(setup, false);

        workerHandle = new Worker(new URL('./worker-helper.mjs', import.meta.url));
        workerHandle.postMessage({
          type: 'start',
          workerIndex: 1,
          workerCount,
          controlDesc: sharedCtrl.descriptor,
          setup,
          buffersDesc,
        });

        const parEval = new ParallelEvaluator({
          workerCount,
          setup,
          buffers,
          sharedControl: sharedCtrl,
          onDispose: () => {
            if (workerHandle) {
              workerHandle.terminate();
              workerHandle = null;
            }
          },
        });
        parEval.waitUntilReady();
        return parEval;
      },
    });

    const resPar = enginePar.run();
    enginePar.dispose();

    expect(resPar.steps.length).toBe(resSeq.steps.length);
    for (let i = 0; i < resSeq.steps.length; i++) {
      expect(resPar.steps[i].from).toBe(resSeq.steps[i].from);
      expect(resPar.steps[i].to).toBe(resSeq.steps[i].to);
      expect(resPar.steps[i].fromSide).toBe(resSeq.steps[i].fromSide);
      expect(resPar.steps[i].toSide).toBe(resSeq.steps[i].toSide);
      expect(resPar.steps[i].gain).toBeCloseTo(resSeq.steps[i].gain, 8);
    }
  });
});
