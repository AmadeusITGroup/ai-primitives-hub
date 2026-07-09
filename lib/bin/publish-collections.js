#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');

let yauzl;
try {
  yauzl = require('yauzl');
} catch (err) {
  console.debug('yauzl dependency not found or failed to load; zip listing unavailable.', err?.message || err);
  yauzl = null;
}

const { listCollectionFiles, readCollection } = require('../dist');

class PublishError extends Error {
  constructor(message, code, context = {}) {
    super(message);
    this.name = 'PublishError';
    this.code = code;
    this.context = context;
  }
}

function parseArgs(argv) {
  const out = {
    changedPaths: [],
    changedPathsFile: undefined,
    dryRun: false,
    repoSlug: undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--changed-path' && argv[i + 1]) {
      out.changedPaths.push(argv[i + 1]);
      i++;
    } else if (a === '--changed-paths-file' && argv[i + 1]) {
      out.changedPathsFile = argv[i + 1];
      i++;
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--repo-slug' && argv[i + 1]) {
      out.repoSlug = argv[i + 1];
      i++;
    }
  }

  return out;
}

function execCommand(cmd, args, cwd, env, spawnSync = childProcess.spawnSync) {
  const res = spawnSync(cmd, args, { cwd, env: env || process.env, encoding: 'utf8' });
  if (res.status !== 0) {
    const err = res.stderr || res.stdout || `${cmd} ${args.join(' ')}`;
    throw new Error(err.trim());
  }
  return res.stdout;
}

function normalizePaths(paths) {
  const normalized = (paths || [])
    .map((p) => String(p).replace(/\\/g, '/').replace(/^\//, '').trim())
    .filter(Boolean);
  return [...new Set(normalized)];
}

function commitExists(cwd, ref, spawnSync = childProcess.spawnSync) {
  const res = spawnSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return res.status === 0;
}

function computeChangedPathsFromGitDiff({ repoRoot, base, head, env, spawnSync = childProcess.spawnSync }) {
  if (!head) return { paths: [], isInitialCommit: false };

  const isEmptyOrZeroBase = !base || base.trim() === '' || base === '0000000000000000000000000000000000000000';
  if (isEmptyOrZeroBase) {
    const fallbackBase = `${head}~1`;
    if (!commitExists(repoRoot, fallbackBase, spawnSync)) {
      console.log('Initial commit detected (base SHA is empty/zeros and no previous commit exists)');
      return { paths: [], isInitialCommit: true };
    }
    base = fallbackBase;
  }

  if (!commitExists(repoRoot, base, spawnSync)) {
    const fallbackBase = `${head}~1`;
    if (!commitExists(repoRoot, fallbackBase, spawnSync)) {
      console.log('Initial commit detected (base commit does not exist and no previous commit)');
      return { paths: [], isInitialCommit: true };
    }
    console.log(`Base commit ${base} not found (force-push?), falling back to ${fallbackBase}`);
    base = fallbackBase;
  }

  const out = execCommand('git', ['diff', '--name-only', base, head], repoRoot, env, spawnSync);
  const paths = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return { paths: normalizePaths(paths), isInitialCommit: false };
}

function readChangedPaths({ repoRoot, args, env, spawnSync }) {
  let paths = [...args.changedPaths];
  let isInitialCommit = false;

  if (args.changedPathsFile) {
    const content = fs.readFileSync(path.join(repoRoot, args.changedPathsFile), 'utf8');
    content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .forEach((p) => paths.push(p));
  }

  if (paths.length === 0) {
    const base = env.GITHUB_BASE_SHA;
    const head = env.GITHUB_HEAD_SHA;
    const result = computeChangedPathsFromGitDiff({ repoRoot, base, head, env, spawnSync });
    paths = result.paths;
    isInitialCommit = result.isInitialCommit;
  }

  return { paths: normalizePaths(paths), isInitialCommit };
}

function detectAffected({ repoRoot, changedPaths, spawnSync = childProcess.spawnSync }) {
  if (changedPaths.length === 0) return [];
  const script = path.join(__dirname, 'detect-affected-collections.js');
  const args = [];
  changedPaths.forEach((p) => args.push('--changed-path', p));
  const out = execCommand('node', [script, ...args], repoRoot, undefined, spawnSync);
  const parsed = JSON.parse(out);
  return parsed.affected || [];
}

function getAllCollectionFiles(repoRoot) {
  const collectionFiles = listCollectionFiles(repoRoot);
  return collectionFiles.map((file) => {
    const collection = readCollection(repoRoot, file);
    return { id: collection.id, file };
  });
}

function computeVersion({ repoRoot, collectionFile, spawnSync = childProcess.spawnSync }) {
  const script = path.join(__dirname, 'compute-collection-version.js');
  const out = execCommand('node', [script, '--collection-file', collectionFile], repoRoot, undefined, spawnSync);
  return JSON.parse(out);
}

function buildBundle({ repoRoot, repoSlug, collectionFile, version, spawnSync = childProcess.spawnSync }) {
  const script = path.join(__dirname, 'build-collection-bundle.js');
  const out = execCommand(
    'node',
    [script, '--collection-file', collectionFile, '--version', version, '--repo-slug', repoSlug, '--out-dir', 'dist'],
    repoRoot,
    undefined,
    spawnSync
  );
  return JSON.parse(out);
}

function ghReleaseExists({ repoRoot, tag, spawnSync = childProcess.spawnSync }) {
  const res = spawnSync('gh', ['release', 'view', tag], { cwd: repoRoot, stdio: 'ignore' });
  return res.status === 0;
}

function publishRelease({ repoRoot, tag, manifestAsset, zipAsset, readmeAsset, spawnSync = childProcess.spawnSync }) {
  const absManifest = path.isAbsolute(manifestAsset) ? manifestAsset : path.join(repoRoot, manifestAsset);
  const absZip = path.isAbsolute(zipAsset) ? zipAsset : path.join(repoRoot, zipAsset);
  let absReadme;
  
  if (readmeAsset) {
    absReadme = path.isAbsolute(readmeAsset) ? readmeAsset : path.join(repoRoot, readmeAsset);
    if (!fs.existsSync(absReadme)) {
      throw new PublishError(`Missing readme asset: ${absReadme}`, 'MISSING_ASSET', { asset: 'readme', path: absReadme });
    }
  }

  if (!fs.existsSync(absManifest)) {
    throw new PublishError(`Missing manifest asset: ${absManifest}`, 'MISSING_ASSET', {
      asset: 'manifest',
      path: absManifest,
    });
  }
  if (!fs.existsSync(absZip)) {
    throw new PublishError(`Missing zip asset: ${absZip}`, 'MISSING_ASSET', { asset: 'zip', path: absZip });
  }

  if (ghReleaseExists({ repoRoot, tag, spawnSync })) {
    throw new PublishError(`Release already exists: ${tag}`, 'RELEASE_EXISTS', { tag });
  }

  const args = ['release', 'create', tag, '--title', tag, '--notes', '', absZip, absManifest];

  execCommand('gh', absReadme ? [...args, absReadme] : args, repoRoot, undefined, spawnSync);
}

function sha256File(absPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absPath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function listZipEntries(absZip) {
  if (!yauzl) {
    return Promise.resolve({ entries: [], note: 'Zip listing unavailable (missing yauzl dependency).' });
  }

  return new Promise((resolve, reject) => {
    yauzl.open(absZip, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      const entries = [];

      const finish = (maybeErr) => {
        try {
          zipfile.close();
        } catch {
          // ignore
        }
        if (maybeErr) reject(maybeErr);
        else resolve({ entries });
      };

      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        entries.push(entry.fileName);
        zipfile.readEntry();
      });
      zipfile.on('end', () => finish());
      zipfile.on('error', finish);
    });
  });
}

async function getFileInfo(absPath) {
  const st = fs.statSync(absPath);
  const sha = await sha256File(absPath);
  return { size: st.size, sha256: sha };
}

async function formatAssetSummary(label, absPath, repoRoot) {
  if (!fs.existsSync(absPath)) {
    return `  ${label}: MISSING (${path.relative(repoRoot, absPath)})`;
  }
  const info = await getFileInfo(absPath);
  return `  ${label}: ${path.relative(repoRoot, absPath)} (${info.size} bytes, sha256 ${info.sha256})`;
}

async function formatZipEntries(absZip) {
  const lines = [];
  try {
    const { entries, note } = await listZipEntries(absZip);
    if (note) {
      lines.push(`  zip_entries: ${note}`);
    } else {
      lines.push('  zip_entries:');
      entries.forEach((e) => lines.push(`    - ${e}`));
    }
  } catch (e) {
    lines.push(`  zip_entries: ERROR (${e.message})`);
  }
  return lines;
}

async function logDryRunSummary({ logger, collectionId, tag, nextVersion, manifestAsset, zipAsset, readmeAsset, repoRoot }) {
  const absManifest = path.isAbsolute(manifestAsset) ? manifestAsset : path.join(repoRoot, manifestAsset);
  const absZip = path.isAbsolute(zipAsset) ? zipAsset : path.join(repoRoot, zipAsset);
  const absReadme = readmeAsset ? (path.isAbsolute(readmeAsset) ? readmeAsset : path.join(repoRoot, readmeAsset)) : undefined;

  logger.log(`DRY RUN: ${collectionId}`);
  logger.log(`  release_tag: ${tag}`);
  logger.log(`  version: ${nextVersion}`);

  logger.log(await formatAssetSummary('manifest', absManifest, repoRoot));
  logger.log(await formatAssetSummary('zip', absZip, repoRoot));
  if (absReadme) {
    logger.log(await formatAssetSummary('readme', absReadme, repoRoot));
  }

  if (fs.existsSync(absZip)) {
    const zipLines = await formatZipEntries(absZip);
    zipLines.forEach((line) => logger.log(line));
  }
}

async function processAffectedCollection({ repoRoot, repoSlug, args, logger, affectedCollection, spawnSync }) {
  const versionInfo = computeVersion({ repoRoot, collectionFile: affectedCollection.file, spawnSync });
  const bundle = buildBundle({
    repoRoot,
    repoSlug,
    collectionFile: affectedCollection.file,
    version: versionInfo.nextVersion,
    spawnSync,
  });

  if (!bundle.readmeAsset) {
    if (process.env.GITHUB_ACTIONS) {
      logger.log(`::warning file=${affectedCollection.file}::Collection '${affectedCollection.id}' has no readme. Consider adding a readme to help users understand this collection.`);
    } else {
      logger.log(`⚠️  Collection '${affectedCollection.id}' has no readme. Consider adding a readme to help users understand this collection.`);
    }
  }

  if (args.dryRun) {
    await logDryRunSummary({
      logger,
      collectionId: affectedCollection.id,
      tag: versionInfo.tag,
      nextVersion: versionInfo.nextVersion,
      manifestAsset: bundle.manifestAsset,
      zipAsset: bundle.zipAsset,
      readmeAsset: bundle.readmeAsset,
      repoRoot,
    });
    return;
  }

  logger.log(`Collection ${affectedCollection.id}: tag ${versionInfo.tag}`);

  publishRelease({
    repoRoot,
    tag: versionInfo.tag,
    manifestAsset: bundle.manifestAsset,
    zipAsset: bundle.zipAsset,
    readmeAsset: bundle.readmeAsset,
    spawnSync,
  });
}

async function main(opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const argv = opts.argv || process.argv.slice(2);
  const env = opts.env || process.env;
  const logger = opts.logger || console;
  const spawnSync = opts.spawnSync || childProcess.spawnSync;

  const args = parseArgs(argv);

  const repoSlug = args.repoSlug || (env.GITHUB_REPOSITORY || '').replace(/\//g, '-') || path.basename(repoRoot);

  const { paths: changedPaths, isInitialCommit } = readChangedPaths({ repoRoot, args, env, spawnSync });

  let affected;
  if (isInitialCommit) {
    logger.log('Initial commit mode: publishing all collections');
    affected = getAllCollectionFiles(repoRoot);
  } else {
    affected = detectAffected({ repoRoot, changedPaths, spawnSync });
  }

  if (affected.length === 0) {
    logger.log('No affected collections; skipping publish.');
    return;
  }

  try {
    execCommand('git', ['fetch', '--tags', '--force'], repoRoot, undefined, spawnSync);
  } catch (e) {
    console.error(`Warning: git fetch --tags failed - ${e?.message || e}`);
  }

  for (const a of affected) {
    await processAffectedCollection({ repoRoot, repoSlug, args, logger, affectedCollection: a, spawnSync });
  }
}

module.exports = {
  main,
  parseArgs,
  commitExists,
  computeChangedPathsFromGitDiff,
  readChangedPaths,
  getAllCollectionFiles,
  listZipEntries,
  logDryRunSummary,
  PublishError,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  });
}
