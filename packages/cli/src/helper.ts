import { parentPort } from 'node:worker_threads';
import { runHelperLoop } from '@weaver-art/core';

if (!parentPort) {
  throw new Error('Helper thread must be run within a Worker context');
}

parentPort.on('message', (msg) => {
  if (msg.type === 'start') {
    runHelperLoop(msg.workerIndex, msg.workerCount, msg.controlDesc, msg.setup, msg.buffersDesc);
  }
});
