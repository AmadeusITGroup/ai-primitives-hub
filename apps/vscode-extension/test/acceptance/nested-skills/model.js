/* global require, module, process, __dirname -- CommonJS acceptance oracle */
/**
 * Nested skill layout acceptance (issue #701): builds real bundles from the
 * `test/fixtures/nested-skills` source repository and holds the expected
 * installed skill trees, independent of production code.
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const REPO_ROOT = path.resolve(EXT_ROOT, '..', '..');
const CLI_JS = path.join(REPO_ROOT, 'packages', 'cli', 'bin', 'ai-primitives-hub.js');
const FIXTURE = path.join(EXT_ROOT, 'test', 'fixtures', 'nested-skills');

/** Skill leaf folders each collection must install. */
const COLLECTIONS = {
  'nested-automated': ['automated-test_test-generation', 'automated-test_generation-checks', 'flat-control'],
  'nested-manual': ['manual-test_test-generation', 'manual-test_generation-checks']
};
const SKILL_FILES = ['SKILL.md', 'references/CHECKLIST.md', 'scripts/helper.sh'];

/**
 * Every file expected below a skills root once the given collections are installed.
 * @param {string[]} collections
 * @returns {string[]} Sorted `/`-separated paths relative to the skills root.
 */
function expectedTree(collections) {
  return collections.flatMap((c) => COLLECTIONS[c].flatMap((leaf) => SKILL_FILES.map((f) => `${leaf}/${f}`))).sort();
}

/**
 * List every file below a directory.
 * @param {string} root
 * @returns {string[]} Sorted `/`-separated relative paths; empty when missing.
 */
function listTree(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else {
        out.push(path.relative(root, abs).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Which fixture skill each installed SKILL.md actually is (its `Marker:` line).
 * @param {string} root Skills root.
 * @returns {Record<string, string>} Relative SKILL.md path -> marker.
 */
function skillMarkers(root) {
  return Object.fromEntries(listTree(root).filter((f) => f.endsWith('SKILL.md'))
    .map((f) => [f, /^Marker: (.*)$/m.exec(fs.readFileSync(path.join(root, f), 'utf8'))?.[1] ?? '?']));
}

/**
 * Assert a skills root holds exactly the expected skills, each with its own content.
 * @param {string} root Skills root (e.g. `~/.copilot/skills`).
 * @param {string[]} collections Installed collections.
 * @param {string} label
 */
function assertSkills(root, collections, label) {
  assert.deepEqual(listTree(root), expectedTree(collections), `${label}: installed tree under ${root}`);
  for (const c of collections) {
    for (const leaf of COLLECTIONS[c]) {
      assert.match(fs.readFileSync(path.join(root, leaf, 'SKILL.md'), 'utf8'), new RegExp(`^Marker: ${leaf}$`, 'm'), `${label}: ${leaf}/SKILL.md content`);
    }
  }
}

/**
 * Build the fixture's collections with the real `bundle build` command and
 * extract each bundle into `<dir>/collections/<id>/` (a `local` source).
 * @param {string} dir Owned temp dir.
 * @returns {{ collections: string, zips: Record<string, string> }}
 */
function buildBundles(dir) {
  const src = path.join(dir, 'fixture-src');
  fs.cpSync(FIXTURE, src, { recursive: true });
  const git = (...args) => cp.execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: src, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  git('remote', 'add', 'origin', 'https://github.com/acme/nested-skills-fixture.git');
  const AdmZip = require('adm-zip');
  const collections = path.join(dir, 'collections');
  const zips = {};
  for (const id of Object.keys(COLLECTIONS)) {
    const out = cp.spawnSync(process.execPath, [CLI_JS, 'bundle', 'build', '--collection-file', `collections/${id}.collection.yml`,
      '--version', '1.0.0', '--out-dir', path.join(dir, 'dist'), '--repo-slug', 'acme-nested-skills-fixture', '-o', 'json'], { cwd: src, encoding: 'utf8' });
    const parsed = JSON.parse(out.stdout);
    assert.ok(['ok', 'warning'].includes(parsed.status), `bundle build ${id}: ${out.stdout}${out.stderr}`);
    zips[id] = parsed.data.zipAsset;
    new AdmZip(parsed.data.zipAsset).extractAllTo(path.join(collections, id), true);
  }
  return { collections, zips };
}

module.exports = { COLLECTIONS, CLI_JS, EXT_ROOT, expectedTree, listTree, skillMarkers, assertSkills, buildBundles };
