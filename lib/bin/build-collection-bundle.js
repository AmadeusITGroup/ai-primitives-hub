#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const archiver = require('archiver');

const { readCollection, resolveCollectionItemPaths, generateBundleId } = require('../dist');
const { resolveCollectionReadmePath } = require('../dist/collections');

function parseArgs(argv) {
  const out = {
    collectionFile: undefined,
    version: undefined,
    outDir: undefined,
    repoSlug: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--collection-file' && argv[i + 1]) {
      out.collectionFile = argv[i + 1];
      i++;
    } else if (a === '--version' && argv[i + 1]) {
      out.version = argv[i + 1];
      i++;
    } else if (a === '--out-dir' && argv[i + 1]) {
      out.outDir = argv[i + 1];
      i++;
    } else if (a === '--repo-slug' && argv[i + 1]) {
      out.repoSlug = argv[i + 1];
      i++;
    }
  }
  return out;
}

function normalizeRepoRel(p) {
  return String(p).replace(/\\/g, '/').replace(/^\//, '');
}

function runNodeScript(scriptPath, args, cwd) {
  const res = spawnSync('node', [scriptPath, ...args], { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(res.stderr || res.stdout || `Command failed: node ${scriptPath}`);
  }
  return res;
}

async function createZip({ repoRoot, zipPath, manifestPath, itemPaths }) {
  await fs.promises.mkdir(path.dirname(zipPath), { recursive: true });

  const output = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  // Fixed date for reproducible builds.
  const fixedDate = new Date('1980-01-01T00:00:00.000Z');

  return new Promise((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);

    archive.pipe(output);

    archive.file(manifestPath, {
      name: 'deployment-manifest.yml',
      date: fixedDate,
    });

    itemPaths
      .map(normalizeRepoRel)
      .sort()
      .forEach((rel) => {
        const abs = path.join(repoRoot, rel);
        archive.file(abs, { name: rel, date: fixedDate });
      });

    archive.finalize();
  });
}

async function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv.slice(2));
  if (!args.collectionFile) throw new Error('Missing --collection-file');
  if (!args.version) throw new Error('Missing --version');

  const repoSlug = args.repoSlug || (process.env.GITHUB_REPOSITORY || '').replace(/\//g, '-');
  if (!repoSlug) throw new Error('Missing --repo-slug (or set GITHUB_REPOSITORY)');

  const outDir = args.outDir || path.join('dist');
  const collection = readCollection(repoRoot, args.collectionFile);
  const collectionId = collection.id;
  if (!collectionId) throw new Error('collection.id is required');

  const bundleId = generateBundleId(repoSlug, collectionId, args.version);
  const collectionOutDir = path.join(outDir, collectionId);
  await fs.promises.mkdir(collectionOutDir, { recursive: true });

  const standaloneManifestPath = path.join(collectionOutDir, 'deployment-manifest.yml');
  const generateManifestScript = path.join(__dirname, 'generate-manifest.js');
  runNodeScript(
    generateManifestScript,
    [args.version, '--collection-file', args.collectionFile, '--out', standaloneManifestPath],
    repoRoot
  );

  const itemPaths = resolveCollectionItemPaths(repoRoot, collection);
  const readmePath = resolveCollectionReadmePath(collection);
  const zipPath = path.join(collectionOutDir, `${collectionId}.bundle.zip`);
  await createZip({ repoRoot, zipPath, manifestPath: standaloneManifestPath, itemPaths });

  process.stdout.write(
    JSON.stringify(
      {
        collectionId,
        version: args.version,
        outDir: collectionOutDir.replace(/\\/g, '/'),
        manifestAsset: standaloneManifestPath.replace(/\\/g, '/'),
        zipAsset: zipPath.replace(/\\/g, '/'),
        readmeAsset: readmePath ? readmePath.replace(/\\/g, '/') : undefined,
        bundleId,
      },
      null,
      2
    ) + '\n'
  );
}

main().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
