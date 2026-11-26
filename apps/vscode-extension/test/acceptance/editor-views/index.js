/* global require, module, __dirname */
const path = require('node:path');
const Mocha = require('mocha');

function run() {
  const mocha = new Mocha({ ui: 'tdd', timeout: 60000, color: true });
  mocha.addFile(path.join(__dirname, 'native.test.js'));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => failures ? reject(new Error(`${failures} editor view test(s) failed`)) : resolve());
  });
}

module.exports = { run };
