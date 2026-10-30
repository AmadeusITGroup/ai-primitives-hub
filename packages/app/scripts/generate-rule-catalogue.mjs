#!/usr/bin/env node
/**
 * Regenerate docs/author-guide/rule-catalogue.md from the rule registry.
 * Usage: pnpm -C packages/app run generate:rule-catalogue [-- --check]
 * Requires a prior `pnpm -C packages/app run build`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { generateRuleCatalogue, RULE_CATALOGUE_PATH } = require('../dist/governance/generate-catalogue.js');
const { NodeFileSystem } = require('@ai-primitives-hub/infra');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const check = process.argv.includes('--check');
const ok = await generateRuleCatalogue(new NodeFileSystem(), repoRoot, { check });
if (check && !ok) {
  process.stderr.write(`${RULE_CATALOGUE_PATH} is out of date. Run: pnpm -C packages/app run generate:rule-catalogue\n`);
  process.exit(1);
}
process.stdout.write(`${check ? 'Checked' : 'Wrote'} ${RULE_CATALOGUE_PATH}\n`);
