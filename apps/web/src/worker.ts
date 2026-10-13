import { WeaveEngine } from '@weaver-art/core';
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
  const e = new WeaveEngine(image, msg.options);
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
      post(
        { type: 'progress', size: e.size, rgba, lines: e.steps.length, lengthMm: e.totalLengthMm, elapsedMs: now - t0 },
        [rgba],
      );
    }
    await tick();
  }
  const rgba = snapshot(e);
  post({ type: 'done', size: e.size, rgba, result: e.result() }, [rgba]);
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
