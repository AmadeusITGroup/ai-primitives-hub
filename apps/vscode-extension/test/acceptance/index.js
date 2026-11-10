/* global require, module, process, __dirname -- @vscode/test-electron entry */
const fs = require('node:fs');
const path = require('node:path');
const Mocha = require('mocha');

/** Run the native acceptance suite for one phase and persist its outcomes. */
function run() {
  const mocha = new Mocha({ ui: 'tdd', timeout: 180000, color: true, bail: true });
  mocha.addFile(path.resolve(__dirname, 'native-scenarios.test.js'));
  return new Promise((resolve, reject) => {
    const outcomes = [];
    const runner = mocha.run((failures) => {
      fs.writeFileSync(path.join(process.env.APH_ACCEPT_ROOT, 'native-results.json'),
        JSON.stringify({ phase: process.env.APH_ACCEPT_PHASE, stats: runner.stats, outcomes }, null, 2));
      if (failures) {
        reject(new Error(`${failures} native acceptance test(s) failed`));
      } else {
        resolve();
      }
    });
    runner.on('pass', (t) => outcomes.push({ test: t.fullTitle(), status: 'passed' }));
    runner.on('fail', (t, e) => outcomes.push({ test: t.fullTitle(), status: 'failed', error: e.stack }));
  });
}
module.exports = { run };
