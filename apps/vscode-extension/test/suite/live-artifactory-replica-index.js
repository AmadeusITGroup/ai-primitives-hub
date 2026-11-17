/* global require, __dirname, exports -- CommonJS globals used by the extension-host suite entrypoint. */
const path = require('node:path');
const Mocha = require('mocha');

/**
 *
 */
/** Runs the live extension-host consumer tests. */
function run() {
  const mocha = new Mocha({ ui: 'tdd', color: true });
  mocha.addFile(path.join(__dirname, 'live-artifactory-replica.test.js'));

  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} live replica consumer test(s) failed.`));
      } else {
        resolve();
      }
    });
  });
}

exports.run = run;
