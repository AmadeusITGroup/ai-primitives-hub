/* global require, module -- CommonJS acceptance oracle */
/**
 * Independent acceptance oracle for target switching (09-ACCEPTANCE-TEST-PLAN).
 * Holds the expected installations and derives lockfile records, files on disk
 * and per-harness views without calling production code.
 */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// [repository prompt dir, user prompt dir] relative to workspace / HOME.
const LAYOUT = {
  vscode: ['.github/prompts', '.copilot/prompts'],
  'vscode-insiders': ['.github/prompts', '.copilot/prompts'],
  'copilot-cli': ['.github/prompts', '.copilot/prompts'],
  kiro: ['.kiro/steering', '.kiro/steering'],
  'kiro-cli': ['.kiro/steering', '.kiro/steering'],
  windsurf: ['.windsurf/rules', '.codeium/windsurf/rules'],
  'claude-code': ['.claude/commands', '.claude/commands'],
  cursor: ['.cursor/rules', '.cursor/rules'],
  opencode: ['.opencode/commands', '.opencode/commands'],
  devin: ['.devin/rules', '.devin/rules'],
  'devin-cli': ['.devin/rules', '.devin/rules']
};
const HARNESSES = Object.keys(LAYOUT);
const SCHEMA_URL = 'https://raw.githubusercontent.com/AmadeusITGroup/ai-primitives-hub/main/packages/core/src/public/schemas/lockfile.schema.json';
const COLLECTIONS = { alpha: ['1.0.0', '2.0.0'], beta: ['1.0.0'] };
const SOURCE_ID = 'acceptance-local';

const bytes = (collection, version) => `# ${collection} ${version}\n`;
const sha = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const fileName = (collection) => `${collection}.prompt.md`;

/**
 * Write one extracted collection directory per collection/version.
 * @param {string} dir Parent directory.
 * @returns {Record<string, string>} `<collection>@<version>` -> directory.
 */
function writeCollections(dir) {
  const out = {};
  for (const [collection, versions] of Object.entries(COLLECTIONS)) {
    for (const version of versions) {
      const d = path.join(dir, `${collection}-${version}`);
      fs.mkdirSync(path.join(d, 'prompts'), { recursive: true });
      fs.writeFileSync(path.join(d, 'deployment-manifest.yml'),
        `id: ${collection}\nname: ${collection}\nversion: ${version}\nitems:\n  - path: prompts/${fileName(collection)}\n    kind: prompt\n`);
      fs.writeFileSync(path.join(d, 'prompts', fileName(collection)), bytes(collection, version));
      out[`${collection}@${version}`] = d;
    }
  }
  return out;
}

class TargetModel {
  /**
   * @param {string} home Synthetic HOME.
   * @param {string} workspace Workspace root (canonical).
   * @param {string} dataHome XDG data home.
   */
  constructor(home, workspace, dataHome) {
    this.home = fs.realpathSync(home);
    this.workspace = fs.realpathSync(workspace);
    this.dataHome = dataHome;
    /** @type {{harness: string, scope: string, collection: string, version: string}[]} */
    this.rows = [];
  }

  key(r) {
    return `${r.harness}|${r.scope}|${r.collection}`;
  }

  install(harness, scope, collection, version) {
    assert.ok(LAYOUT[harness], `unknown harness ${harness}`);
    assert.ok(!this.rows.some((r) => this.key(r) === `${harness}|${scope}|${collection}`), 'model: already installed');
    this.rows.push({ harness, scope, collection, version });
  }

  update(harness, scope, collection, version) {
    const row = this.rows.find((r) => this.key(r) === `${harness}|${scope}|${collection}`);
    assert.ok(row, 'model: update of missing row');
    row.version = version;
  }

  uninstall(harness, scope, collection) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => this.key(r) !== `${harness}|${scope}|${collection}`);
    assert.equal(this.rows.length, before - 1, 'model: uninstall of missing row');
  }

  forHarness(harness) {
    return this.rows.filter((r) => r.harness === harness);
  }

  /** Absolute destination of a row's single file. */
  destination(r) {
    const [repoDir, userDir] = LAYOUT[r.harness];
    return r.scope === 'repository'
      ? path.join(this.workspace, repoDir, fileName(r.collection))
      : path.join(this.home, userDir, fileName(r.collection));
  }

  repoLockfile() {
    return path.join(this.workspace, 'prompt-registry.lock.json');
  }

  userLockfile() {
    return path.join(this.dataHome, 'ai-primitives-hub', 'ai-primitives-hub.lock.json');
  }
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * Flatten a v3 records-only lockfile; asserts the persisted contract.
 * @param {string} file Lockfile path.
 * @returns {{harness: string, scope: string, collection: string, version: string, installationId: string, files: object[]}[]}
 */
function readRecords(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  const doc = readJson(file);
  assert.equal(doc.version, '3.0.0', `${file}: version`);
  assert.equal(doc.$schema, SCHEMA_URL, `${file}: $schema`);
  assert.deepEqual(Object.keys(doc).filter((k) => !['$schema', 'version', 'generatedAt', 'generatedBy', 'sources', 'bundles'].includes(k)), [],
    `${file}: records-only lockfile must not carry other sections`);
  assert.deepEqual(Object.keys(doc).toSorted(), ['$schema', 'bundles', 'generatedAt', 'generatedBy', 'sources', 'version'],
    `${file}: records-only top-level shape`);
  const rows = [];
  for (const bundle of Object.values(doc.bundles)) {
    assert.ok(doc.sources?.[bundle.sourceId], `${file}: source ${bundle.sourceId} recorded for re-acquisition`);
    for (const [harness, tool] of Object.entries(bundle.tools)) {
      for (const inst of Object.values(tool.instances)) {
        assert.equal(typeof inst.installationId, 'string');
        rows.push({
          harness, scope: inst.scope, root: inst.root, collection: bundle.manifestId, version: inst.version,
          installationId: inst.installationId, files: inst.files, sourceId: bundle.sourceId
        });
      }
    }
  }
  return rows;
}

const sortRows = (rows) => [...rows].sort((a, b) => `${a.harness}|${a.scope}|${a.collection}`.localeCompare(`${b.harness}|${b.scope}|${b.collection}`));
const strip = (rows) => sortRows(rows).map(({ harness, scope, collection, version }) => ({ harness, scope, collection, version }));

/**
 * Lockfiles must hold exactly the model's rows, each in its own authority.
 * @param {TargetModel} model
 */
function assertLockfiles(model) {
  const repo = readRecords(model.repoLockfile());
  const user = readRecords(model.userLockfile());
  assert.ok(repo.every((r) => r.scope === 'repository'), 'repository lockfile holds only repository rows');
  if (fs.existsSync(model.repoLockfile())) {
    const text = fs.readFileSync(model.repoLockfile(), 'utf8');
    assert.ok(!text.includes(model.workspace) && !text.includes(model.home), 'committed lockfile has no machine-specific absolute paths');
  }
  assert.ok(user.every((r) => r.scope === 'user'), 'user lockfile holds only user rows');
  assert.deepEqual(strip([...repo, ...user]), strip(model.rows), 'lockfile records == model');
  for (const r of [...repo, ...user]) {
    // Repository paths are workspace-relative; user paths are relative to the instance root under HOME.
    const base = r.scope === 'repository' ? model.workspace : r.root;
    if (r.scope === 'user') {
      assert.ok(r.root === model.home || r.root.startsWith(model.home + path.sep), `${r.collection}: user root at or under HOME`);
    }
    assert.equal(r.files.length, 1, `${r.collection}: one recorded file`);
    assert.ok(!path.isAbsolute(r.files[0].path), `${r.collection}: recorded path is relative`);
    assert.equal(path.resolve(base, r.files[0].path), model.destination(r), `${r.collection}: recorded path`);
    assert.equal(r.files[0].checksum, sha(bytes(r.collection, r.version)), `${r.collection}: recorded checksum`);
  }
  const ids = [...repo, ...user].map((r) => r.installationId);
  assert.equal(new Set(ids).size, ids.length, 'installation IDs are unique');
  return [...repo, ...user];
}

/**
 * Every harness prompt directory contains exactly the model's files.
 * Shared directories (e.g. `.github/prompts`) hold the union of all harnesses using them.
 * @param {TargetModel} model
 */
function assertDisk(model) {
  const expected = new Map();
  for (const r of model.rows) {
    expected.set(model.destination(r), bytes(r.collection, r.version));
  }
  const dirs = new Set();
  for (const [repoDir, userDir] of Object.values(LAYOUT)) {
    dirs.add(path.join(model.workspace, repoDir));
    dirs.add(path.join(model.home, userDir));
  }
  const actual = new Map();
  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        actual.set(path.join(dir, name), fs.readFileSync(path.join(dir, name), 'utf8'));
      }
    }
  }
  assert.deepEqual(Object.fromEntries([...actual].sort()), Object.fromEntries([...expected].sort()), 'files on disk == model');
}

/**
 * CLI `installed -o json` for the selected harness.
 * @param {object[]} rows CLI data.
 * @param {TargetModel} model
 * @param {string} harness
 */
function assertCliInstalled(rows, model, harness) {
  assert.ok(Array.isArray(rows), 'installed returns an array');
  const got = rows.map((r) => ({ harness: r.instance.type, scope: r.instance.scope, collection: r.manifestId, version: r.version }));
  assert.deepEqual(strip(got), strip(model.forHarness(harness)), `CLI installed for ${harness}`);
}

/**
 * Marketplace payload and Explorer nodes for the selected harness.
 * @param {{bundles: object[]}} marketplace Last `bundlesLoaded` message.
 * @param {{collection: string, scope: string, version: string}[]} explorer Installed Bundles nodes.
 * @param {TargetModel} model
 * @param {string} harness
 */
function assertExtensionViews(marketplace, explorer, model, harness) {
  const expected = strip(model.forHarness(harness));
  const cards = marketplace.bundles.flatMap((b) => (b.installations ?? []).map((i) => ({
    harness: i.targetType, scope: i.scope, collection: b.manifestId ?? b.id, version: i.version
  })));
  assert.deepEqual(strip(cards), expected, `Marketplace installations for ${harness}`);
  for (const b of marketplace.bundles) {
    assert.equal(b.installed, (b.installations ?? []).length > 0, `${b.id}: installed flag matches installations`);
  }
  assert.equal(cards.length, expected.length, 'Installed counter counts installations');
  assert.deepEqual(strip(explorer.map((n) => ({ harness, ...n }))), expected, `Explorer installed for ${harness}`);
}

/**
 * Snapshot of all lockfile bytes and harness directories, for "no change" checks.
 * @param {TargetModel} model
 */
function snapshot(model) {
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
  const files = {};
  for (const [repoDir, userDir] of Object.values(LAYOUT)) {
    for (const dir of [path.join(model.workspace, repoDir), path.join(model.home, userDir)]) {
      if (fs.existsSync(dir)) {
        for (const name of fs.readdirSync(dir)) {
          files[path.join(dir, name)] = read(path.join(dir, name));
        }
      }
    }
  }
  const bundlesOnly = (f) => {
    const t = read(f);
    return t === null ? null : JSON.stringify(JSON.parse(t).bundles);
  };
  return { repo: bundlesOnly(model.repoLockfile()), user: bundlesOnly(model.userLockfile()), files };
}

module.exports = {
  LAYOUT, HARNESSES, SCHEMA_URL, COLLECTIONS, SOURCE_ID, bytes, sha, fileName,
  writeCollections, TargetModel, readRecords, assertLockfiles, assertDisk,
  assertCliInstalled, assertExtensionViews, snapshot
};
