import {
  parentPort,
} from 'node:worker_threads';

let count = 0;
parentPort.on('message', ({ document }) => {
  count++;
  if (document.id !== 'wait') {
    parentPort.postMessage({ findings: [{ ruleId: 'TEST', vulnerableContent: String(count) }] });
  }
});
