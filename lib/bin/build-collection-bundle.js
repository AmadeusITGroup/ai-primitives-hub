#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const archiver = require('archiver');

const {
  createReleaseManifestPlan,
  createLegacyReleaseManifestPlan,
  generateBundleId,
  isMissingSourceLicenseError,
  LEGACY_RELEASE_WARNING,
  serializeReleaseManifest,
} = require('../dist');

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

async function createZip({ zipPath, manifest, entries }) {
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

    archive.append(manifest, {
      name: 'deployment-manifest.yml',
      date: fixedDate,
    });

    entries
      .slice()
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      .forEach((entry) => {
        archive.append(entry.bytes, { name: entry.path, date: fixedDate });
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
  let releasePlan;
  try {
    releasePlan = createReleaseManifestPlan({
      repoRoot,
      collectionFile: args.collectionFile,
      version: args.version,
    });
  } catch (error) {
    if (!isMissingSourceLicenseError(error)) throw error;
    releasePlan = createLegacyReleaseManifestPlan({
      repoRoot,
      collectionFile: args.collectionFile,
      version: args.version,
    });
    console.error(`warning: ${LEGACY_RELEASE_WARNING}`);
  }
  const collectionId = releasePlan.manifest.id;
  if (typeof collectionId !== 'string' || collectionId.length === 0) throw new Error('collection.id is required');

  const bundleId = generateBundleId(repoSlug, collectionId, args.version);
  const collectionOutDir = path.join(outDir, collectionId);
  await fs.promises.mkdir(collectionOutDir, { recursive: true });

  const standaloneManifestPath = path.join(collectionOutDir, 'deployment-manifest.yml');
  const manifest = serializeReleaseManifest(releasePlan.manifest);
  await fs.promises.writeFile(standaloneManifestPath, manifest);

  const zipPath = path.join(collectionOutDir, `${collectionId}.bundle.zip`);
  await createZip({ zipPath, manifest, entries: releasePlan.entries });

  process.stdout.write(
    JSON.stringify(
      {
        collectionId,
        version: args.version,
        outDir: collectionOutDir.replace(/\\/g, '/'),
        manifestAsset: standaloneManifestPath.replace(/\\/g, '/'),
        zipAsset: zipPath.replace(/\\/g, '/'),
        readmeAsset: releasePlan.readmeSourcePath ? releasePlan.readmeSourcePath.replace(/\\/g, '/') : undefined,
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
