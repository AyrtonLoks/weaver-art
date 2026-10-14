import { runHelperLoop } from '@weaver-art/core';

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg.type === 'start') {
    runHelperLoop(msg.workerIndex, msg.workerCount, msg.controlDesc, msg.setup, msg.buffersDesc);
  }
};
