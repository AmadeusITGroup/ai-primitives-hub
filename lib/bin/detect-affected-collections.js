#!/usr/bin/env node
const path = require('path');

const { listCollectionFiles, readCollection, resolveCollectionItemPaths, resolveCollectionReadmePath} = require('../dist');

function parseArgs(argv) {
  const out = { changedPaths: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--changed-path' && argv[i + 1]) {
      out.changedPaths.push(argv[i + 1]);
      i++;
    }
  }
  return out;
}

function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\//, '').trim();
}

const repoRoot = process.cwd();
const args = parseArgs(process.argv.slice(2));

const changedPaths = args.changedPaths.map(normalizePath).filter(Boolean);
const changedSet = new Set(changedPaths);

const collectionFiles = listCollectionFiles(repoRoot);
const affected = [];

for (const file of collectionFiles) {
  const collection = readCollection(repoRoot, file);
  const itemPaths = resolveCollectionItemPaths(repoRoot, collection);
  const itemPathsSet = new Set(itemPaths.map(normalizePath));
  const readmePath = resolveCollectionReadmePath(collection);

  // Check if collection file itself changed
  const normalizedFile = normalizePath(file);
  if (changedSet.has(normalizedFile)) {
    affected.push({ id: collection.id, file });
    continue;
  }

  // Check if any item path changed
  if (changedPaths.some(cp => itemPathsSet.has(cp))) {
    affected.push({ id: collection.id, file });
    continue;
  }

  // Check if readme changed
  if (readmePath) {
    const normalizedReadme = normalizePath(readmePath);
    if (changedSet.has(normalizedReadme)) {
      affected.push({ id: collection.id, file });
    }
  }
}

process.stdout.write(JSON.stringify({ affected }, null, 2) + '\n');
