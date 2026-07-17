#!/usr/bin/env node

const { run } = require('../dist/index.js');

run().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 70;
});
