import process from 'node:process';
import {
  setTimeout,
} from 'node:timers';
import {
  parentPort,
} from 'node:worker_threads';

let count = 0;
parentPort.on('message', ({ document }) => {
  count++;
  if (document.id !== 'wait') {
    parentPort.postMessage({ findings: [{ ruleId: 'TEST', vulnerableContent: String(count) }] });
    if (document.id === 'exit') {
      setTimeout(() => process.exit(0), 10);
    }
    if (document.id === 'error') {
      setTimeout(() => {
        throw new Error('synthetic idle failure');
      }, 10);
    }
  }
});
