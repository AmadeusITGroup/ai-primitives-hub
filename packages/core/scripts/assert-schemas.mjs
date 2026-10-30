#!/usr/bin/env node
/**
 * Fail the build when a schema in src/public/schemas is missing from the published dist output.
 * tsc only copies JSON files that are imported, so an unreferenced schema would silently not ship.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src/public/schemas');
const output = path.join(root, 'dist/public/schemas');

const missing = fs.readdirSync(source)
  .filter((file) => file.endsWith('.schema.json'))
  .filter((file) => !fs.existsSync(path.join(output, file)));

if (missing.length > 0) {
  process.stderr.write(`Schemas missing from dist/public/schemas: ${missing.join(', ')}\n`);
  process.exit(1);
}
