import {
  WeaveEngine,
  createSharedBuffers,
  createSharedControl,
  ParallelEvaluator,
  type EvaluatorSetup,
} from '@weaver-art/core';
import { instantiateWasmKernel } from '@weaver-art/wasm';
import type { FromWorker, ToWorker } from './protocol';

interface WorkerScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<ToWorker>) => void) | null;
}
const ctx = self as unknown as WorkerScope;

let engine: WeaveEngine | null = null;

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  ctx.postMessage(msg, transfer);
}

function snapshot(e: WeaveEngine): ArrayBuffer {
  return e.toRGBA().buffer as ArrayBuffer;
}

/** Yield to the event loop so `stop` messages can be received between chunks. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function start(msg: Extract<ToWorker, { type: 'start' }>): Promise<void> {
  const image = { width: msg.image.width, height: msg.image.height, data: new Uint8ClampedArray(msg.image.data) };
  const accel = msg.accel ?? 'js';
  const helperWorkers: Worker[] = [];

  let e: WeaveEngine;
  if (accel === 'wasm') {
    e = await WeaveEngine.createAsync(image, msg.options, undefined, {
      evaluator: async (setup: EvaluatorSetup) => {
        return instantiateWasmKernel(setup);
      },
    });
  } else if (accel === 'parallel' && typeof SharedArrayBuffer !== 'undefined') {
    const threadCount = Math.max(1, msg.threads ?? (navigator.hardwareConcurrency || 4));
    const sharedCtrl = createSharedControl(threadCount);
    e = await WeaveEngine.createAsync(image, msg.options, undefined, {
      evaluator: (setup: EvaluatorSetup) => {
        const { buffers, descriptor: buffersDesc } = createSharedBuffers(setup, Boolean(msg.options.halftoneMixing));
        for (let w = 1; w < threadCount; w++) {
          const worker = new Worker(new URL('./helper-worker.ts', import.meta.url), { type: 'module' });
          worker.postMessage({
            type: 'start',
            workerIndex: w,
            workerCount: threadCount,
            controlDesc: sharedCtrl.descriptor,
            setup,
            buffersDesc,
          });
          helperWorkers.push(worker);
        }
        const parEval = new ParallelEvaluator({
          workerCount: threadCount,
          setup,
          buffers,
          sharedControl: sharedCtrl,
          onDispose: () => {
            helperWorkers.forEach((w) => w.terminate());
            helperWorkers.length = 0;
          },
        });
        parEval.waitUntilReady();
        return parEval;
      },
    });
  } else {
    e = new WeaveEngine(image, msg.options);
  }
  engine = e;
  const t0 = performance.now();
  const target = e.targetToRGBA().buffer as ArrayBuffer;
  post({ type: 'target', size: e.size, rgba: target }, [target]);

  let lastPost = 0;
  while (!e.done) {
    e.runChunk(10);
    const now = performance.now();
    if (now - lastPost > 120 || e.done) {
      lastPost = now;
      const rgba = snapshot(e);
      const thread = e.options.threads[e.currentThreadIndex];
      post(
        {
          type: 'progress',
          size: e.size,
          rgba,
          lines: e.steps.length,
          lengthMm: e.totalLengthMm,
          elapsedMs: now - t0,
          currentThread: thread?.name,
          currentLayer: e.currentLayerIndex + 1,
        },
        [rgba],
      );
    }
    await tick();
  }
  if (msg.options.refinePasses && msg.options.refinePasses > 0 && e.stopReason !== 'aborted') {
    e.refine(msg.options.refinePasses);
  }
  const rgba = snapshot(e);
  post({ type: 'done', size: e.size, rgba, result: e.result() }, [rgba]);
  e.dispose();
  engine = null;
}

ctx.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'start') {
    engine?.abort();
    start(msg).catch((err: unknown) => {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    });
  } else if (msg.type === 'stop') {
    engine?.abort();
  }
};
