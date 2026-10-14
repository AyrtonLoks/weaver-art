import { parentPort } from 'node:worker_threads';
import { runHelperLoop } from '../dist/index.js';

if (!parentPort) {
  throw new Error('worker-helper.mjs must be run in a worker thread');
}

parentPort.on('message', (msg) => {
  if (msg.type === 'start') {
    runHelperLoop(msg.workerIndex, msg.workerCount, msg.controlDesc, msg.setup, msg.buffersDesc);
  }
});
