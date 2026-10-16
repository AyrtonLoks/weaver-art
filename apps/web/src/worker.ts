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

/**
 * Worker stub temporário (motor JS legado expurgado na Task 0.1).
 * A nova orquestração em Rust/Wasm + WebGL2 será conectada nas próximas tasks.
 */
async function start(msg: Extract<ToWorker, { type: 'start' }>): Promise<void> {
  const image = { width: msg.image.width, height: msg.image.height, data: new Uint8ClampedArray(msg.image.data) };
  const e = new WeaveEngine(image, msg.options);
  engine = e;

  const target = e.targetToRGBA().buffer as ArrayBuffer;
  post({ type: 'target', size: e.size, rgba: target }, [target]);

  e.run();
  const rgba = e.toRGBA().buffer as ArrayBuffer;
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
