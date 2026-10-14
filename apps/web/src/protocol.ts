import type { WeaveOptions, WeaveResult } from '@weaver-art/core';

/** Messages from the UI thread to the weaving worker. */
export type ToWorker =
  | {
      type: 'start';
      image: { width: number; height: number; data: ArrayBuffer };
      options: WeaveOptions;
      accel?: 'js' | 'wasm' | 'parallel';
      threads?: number;
    }
  | { type: 'stop' };

/** Messages from the weaving worker to the UI thread. */
export type FromWorker =
  | { type: 'target'; size: number; rgba: ArrayBuffer }
  | {
      type: 'progress';
      size: number;
      rgba: ArrayBuffer;
      lines: number;
      lengthMm: number;
      elapsedMs: number;
      currentThread?: string;
      currentLayer?: number;
    }
  | { type: 'done'; size: number; rgba: ArrayBuffer; result: WeaveResult }
  | { type: 'error'; message: string };
