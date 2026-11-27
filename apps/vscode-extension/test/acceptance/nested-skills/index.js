/* global require, module, __dirname -- @vscode/test-electron entry */
const path = require('node:path');
const Mocha = require('mocha');

/** Run the native nested skill suite for one phase. */
function run() {
  const mocha = new Mocha({ ui: 'tdd', timeout: 180000, color: true });
  mocha.addFile(path.resolve(__dirname, 'native.test.js'));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} native nested-skill test(s) failed`)) : resolve()));
  });
}
module.exports = { run };
