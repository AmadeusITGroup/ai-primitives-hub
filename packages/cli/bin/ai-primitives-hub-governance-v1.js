#!/usr/bin/env node

const { runGovernanceCliV1 } = require('../dist/governance-v1.js');

runGovernanceCliV1(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error) => {
  process.stderr.write(`Governance validation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});