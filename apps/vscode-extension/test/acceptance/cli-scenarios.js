/* global require, module, process, __dirname -- CommonJS acceptance scenarios */
/**
 * CLI acceptance scenarios (09-ACCEPTANCE-TEST-PLAN): real CLI bin per step,
 * every step checked against the independent model on all observation points.
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  TargetModel, writeCollections, assertLockfiles, assertDisk, assertCliInstalled, snapshot, sha, bytes, readRecords
} = require('./target-model');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const CLI_JS = path.join(REPO_ROOT, 'packages', 'cli', 'bin', 'ai-primitives-hub.js');
const ENV_ALLOW = ['PATH', 'SystemRoot', 'LANG'];

/**
 * Sandbox: HOME, XDG roots, workspace (git), collection fixtures.
 * @param {string} root Owned temp dir.
 * @param {{xdg?: boolean, gate?: boolean}} options `xdg:false` leaves XDG variables unset (S14).
 */
function sandbox(root, options = {}) {
  const home = path.join(root, 'home');
  const ws = path.join(root, 'workspace');
  for (const d of [home, path.join(ws, '.git'), path.join(root, 'tmp')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const env = {};
  for (const k of ENV_ALLOW) {
    if (process.env[k] !== undefined) {
      env[k] = process.env[k];
    }
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, TMPDIR: path.join(root, 'tmp'), NO_COLOR: '1', CI: '1' });
  if (options.xdg !== false) {
    Object.assign(env, {
      XDG_CONFIG_HOME: path.join(root, 'xdg/config'), XDG_DATA_HOME: path.join(root, 'xdg/data'),
      XDG_STATE_HOME: path.join(root, 'xdg/state'), XDG_CACHE_HOME: path.join(root, 'xdg/cache')
    });
  }
  const configHome = env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  const dataHome = env.XDG_DATA_HOME ?? path.join(home, '.local', 'share');
  const stateHome = env.XDG_STATE_HOME ?? path.join(home, '.local', 'state');
  if (options.gate !== false) {
    fs.mkdirSync(path.join(configHome, 'ai-primitives-hub'), { recursive: true });
    fs.writeFileSync(path.join(configHome, 'ai-primitives-hub', 'config.yml'), 'experimental:\n  targetManagement: true\n');
  }
  const collections = writeCollections(path.join(root, 'collections'));
  return { env, ws, home, dataHome, stateHome, collections, model: new TargetModel(home, ws, dataHome) };
}

/**
 * Run one CLI step; returns the parsed envelope and raw output.
 * @param {object} sb Sandbox.
 * @param {string[]} args CLI arguments (without `-o json`).
 * @param {object[]} log Step log.
 */
function cli(sb, args, log) {
  const out = cp.spawnSync(process.execPath, [CLI_JS, ...args, '-o', 'json'], {
    env: sb.env, cwd: sb.ws, encoding: 'utf8', timeout: 60000, maxBuffer: 10 * 1024 * 1024
  });
  let parsed = null;
  try {
    parsed = JSON.parse(out.stdout);
  } catch { /* raw output retained */ }
  const step = { args, status: out.status, stdout: out.stdout, stderr: out.stderr, parsed };
  log.push(step);
  return step;
}

function ok(step) {
  assert.ok(step.status === 0 && step.parsed?.status === 'ok', `${step.args.join(' ')} failed: ${step.stderr || step.stdout}`.slice(0, 900));
  return step.parsed.data;
}

function fails(step, pattern) {
  assert.notEqual(step.status, 0, `${step.args.join(' ')} unexpectedly succeeded`);
  assert.match(`${step.stderr}${step.stdout}`, pattern);
}

/** Assert every observation point against the model for the selected harness. */
function check(sb, harness, log) {
  assertLockfiles(sb.model);
  assertDisk(sb.model);
  assertCliInstalled(ok(cli(sb, ['installed'], log)), sb.model, harness);
  const current = ok(cli(sb, ['target', 'current'], log));
  assert.equal(current.type, harness, 'target current');
}

const idOf = (sb, harness, scope, collection) => {
  const rows = [...readRecords(sb.model.repoLockfile()), ...readRecords(sb.model.userLockfile())];
  const row = rows.find((r) => r.harness === harness && r.scope === scope && r.collection === collection);
  assert.ok(row, `no recorded installation ${harness}/${scope}/${collection}`);
  return row.installationId;
};

/** S5-S9: per-harness lifecycle with switching back and forth. */
function lifecycle(sb, harnesses, log) {
  const c = sb.collections;
  for (const h of harnesses) {
    const before = snapshot(sb.model);
    ok(cli(sb, ['target', 'use', h], log));
    assert.deepEqual(snapshot(sb.model), before, `S5: switching to ${h} changes no file or record`);
    check(sb, h, log);
    ok(cli(sb, ['install', '--from', c['alpha@1.0.0'], '--scope', 'repository'], log));
    sb.model.install(h, 'repository', 'alpha', '1.0.0');
    check(sb, h, log);
    ok(cli(sb, ['install', '--from', c['alpha@2.0.0'], '--scope', 'user'], log));
    sb.model.install(h, 'user', 'alpha', '2.0.0');
    check(sb, h, log);
    ok(cli(sb, ['install', '--from', c['beta@1.0.0'], '--scope', 'repository'], log));
    sb.model.install(h, 'repository', 'beta', '1.0.0');
    check(sb, h, log);
    const userAlpha = readRecords(sb.model.userLockfile()).find((r) => r.harness === h && r.collection === 'alpha');
    ok(cli(sb, ['update', '--from', c['alpha@2.0.0'], '--installation-id', idOf(sb, h, 'repository', 'alpha')], log));
    sb.model.update(h, 'repository', 'alpha', '2.0.0');
    check(sb, h, log);
    assert.deepEqual(readRecords(sb.model.userLockfile()).find((r) => r.harness === h && r.collection === 'alpha'), userAlpha,
      'S7: updating the repository row leaves the user row unchanged');
    ok(cli(sb, ['uninstall', 'beta', '--scope', 'repository'], log));
    sb.model.uninstall(h, 'repository', 'beta');
    check(sb, h, log);
  }
  for (const h of [...harnesses].reverse()) {
    ok(cli(sb, ['target', 'use', h], log));
    check(sb, h, log);
  }
  for (const h of harnesses) {
    ok(cli(sb, ['target', 'use', h], log));
    ok(cli(sb, ['uninstall', '--installation-id', idOf(sb, h, 'user', 'alpha')], log));
    sb.model.uninstall(h, 'user', 'alpha');
    check(sb, h, log);
    ok(cli(sb, ['uninstall', 'alpha', '--scope', 'repository'], log));
    sb.model.uninstall(h, 'repository', 'alpha');
    check(sb, h, log);
  }
}

/** S10: harnesses sharing `.github` keep separate ownership. */
function sharedRoot(sb, log) {
  ok(cli(sb, ['target', 'use', 'vscode'], log));
  ok(cli(sb, ['install', '--from', sb.collections['alpha@1.0.0'], '--scope', 'repository'], log));
  sb.model.install('vscode', 'repository', 'alpha', '1.0.0');
  check(sb, 'vscode', log);
  ok(cli(sb, ['target', 'use', 'copilot-cli'], log));
  check(sb, 'copilot-cli', log);
  const before = snapshot(sb.model);
  fails(cli(sb, ['install', '--from', sb.collections['alpha@2.0.0'], '--scope', 'repository'], log), /conflict|owned|unmanaged/i);
  assert.deepEqual(snapshot(sb.model), before, 'S10: conflicting install changes nothing');
  check(sb, 'copilot-cli', log);
}

/** Mutations require an explicit scope; selection records the harness only. */
function scopeRequired(sb, log) {
  ok(cli(sb, ['target', 'use', 'kiro'], log));
  const before = snapshot(sb.model);
  fails(cli(sb, ['install', '--from', sb.collections['alpha@1.0.0']], log), /--scope/);
  assert.deepEqual(snapshot(sb.model), before);
  const selection = JSON.parse(fs.readFileSync(path.join(sb.stateHome, 'ai-primitives-hub', 'target-selection.json'), 'utf8'));
  assert.deepEqual(selection.workspaces[fs.realpathSync(sb.ws)], { type: 'kiro' }, 'selection persists the harness only');
}

/** S12: gate off keeps legacy commands and writes no new state. */
function gateOff(sb, log) {
  fails(cli(sb, ['target', 'current'], log), /experimental|targetManagement/i);
  assert.equal(fs.existsSync(path.join(sb.stateHome, 'ai-primitives-hub', 'target-selection.json')), false);
  ok(cli(sb, ['target', 'list'], log));
}

/** S2-S4: guided v2 migration. */
function migration(sb, log) {
  const legacyFile = (dir, name) => path.join(sb.ws, dir, name);
  for (const [collection, version, dir] of [['alpha', '1.0.0', '.github/prompts'], ['beta', '1.0.0', '.github/prompts']]) {
    fs.mkdirSync(path.join(sb.ws, dir), { recursive: true });
    fs.writeFileSync(legacyFile(dir, `${collection}.prompt.md`), bytes(collection, version));
  }
  fs.appendFileSync(legacyFile('.github/prompts', 'beta.prompt.md'), 'local edit\n');
  const hex = (text) => sha(text).slice('sha256:'.length);
  const v2 = {
    $schema: 'https://github.com/AmadeusITGroup/prompt-registry/schemas/lockfile.schema.json',
    version: '2.0.0', generatedAt: '2026-01-01T00:00:00.000Z', generatedBy: 'prompt-registry@0.0.1',
    bundles: Object.fromEntries(['alpha', 'beta'].map((collection) => [collection, {
      version: '1.0.0', sourceId: 'acceptance-local', sourceType: 'local', installedAt: '2026-01-01T00:00:00.000Z',
      files: [{ path: `.github/prompts/${collection}.prompt.md`, checksum: hex(bytes(collection, '1.0.0')) }]
    }])),
    sources: { 'acceptance-local': { type: 'local', url: path.join(sb.ws, '..', 'collections') } }
  };
  const lockPath = sb.model.repoLockfile();
  const original = `${JSON.stringify(v2, null, 2)}\n`;
  fs.writeFileSync(lockPath, original);
  const beforeDry = snapshot(sb.model);
  ok(cli(sb, ['target', 'use', 'vscode'], log));
  fails(cli(sb, ['install', '--from', sb.collections['alpha@2.0.0'], '--scope', 'repository'], log), /legacy|migrat/i);
  const plan = ok(cli(sb, ['lockfile', 'migrate', '--dry-run'], log));
  assert.equal(fs.readFileSync(lockPath, 'utf8'), original, 'dry run writes nothing');
  assert.deepEqual(snapshot(sb.model).files, beforeDry.files);
  assert.ok(JSON.stringify(plan).includes('copilot-cli') && JSON.stringify(plan).includes('vscode-insiders'), 'ambiguous `.github` lists candidates');
  fails(cli(sb, ['lockfile', 'migrate'], log), /--harness|ambiguous/i);
  const result = ok(cli(sb, ['lockfile', 'migrate', '--harness', 'vscode'], log));
  sb.model.install('vscode', 'repository', 'alpha', '1.0.0');
  const modified = JSON.stringify(result);
  assert.match(modified, /beta/, 'modified file reported');
  assert.ok(fs.readFileSync(legacyFile('.github/prompts', 'beta.prompt.md'), 'utf8').includes('local edit'), 'modified file kept');
  const backup = result.backup;
  assert.equal(fs.readFileSync(backup, 'utf8'), original, 'v2 bytes recoverable');
  assert.match(JSON.stringify(result), /commit/i, 'commit guidance for the committed lockfile');
  // beta stays on disk unmanaged: exclude it from the managed-file comparison.
  const betaPath = legacyFile('.github/prompts', 'beta.prompt.md');
  const betaBytes = fs.readFileSync(betaPath, 'utf8');
  fs.rmSync(betaPath);
  check(sb, 'vscode', log);
  fs.writeFileSync(betaPath, betaBytes);
}

/** S14: XDG variables unset resolve under HOME; no mode variable involved. */
function defaultLocations(sb, log) {
  ok(cli(sb, ['target', 'use', 'devin'], log));
  ok(cli(sb, ['install', '--from', sb.collections['alpha@1.0.0'], '--scope', 'user'], log));
  sb.model.install('devin', 'user', 'alpha', '1.0.0');
  check(sb, 'devin', log);
  assert.ok(fs.existsSync(path.join(sb.home, '.local', 'share', 'ai-primitives-hub', 'ai-primitives-hub.lock.json')));
  assert.ok(fs.existsSync(path.join(sb.home, '.local', 'state', 'ai-primitives-hub', 'target-selection.json')));
}

const SCENARIOS = [
  { id: 'S1-scope-required', run: scopeRequired },
  { id: 'S5-S9-lifecycle', run: (sb, log) => lifecycle(sb, ['vscode', 'kiro', 'devin'], log) },
  // Harnesses sharing a root (.github: vscode, vscode-insiders, copilot-cli) never share a lifecycle run; S10 covers that conflict.
  { id: 'S5-S9-lifecycle-b', run: (sb, log) => lifecycle(sb, ['vscode-insiders', 'kiro-cli', 'windsurf', 'claude-code'], log) },
  { id: 'S5-S9-lifecycle-c', run: (sb, log) => lifecycle(sb, ['copilot-cli', 'cursor', 'opencode', 'devin-cli'], log) },
  { id: 'S10-shared-root', run: sharedRoot },
  { id: 'S2-S4-migration', run: migration },
  { id: 'S12-gate-off', run: gateOff, options: { gate: false } },
  { id: 'S14-default-locations', run: defaultLocations, options: { xdg: false } }
];

/**
 * Run every CLI scenario in its own sandbox under `parent`.
 * @param {string} parent Campaign directory.
 * @returns {{id: string, pass: boolean, error?: string, root: string, steps: object[]}[]}
 */
function runCliScenarios(parent) {
  return SCENARIOS.map((s) => {
    const root = fs.mkdtempSync(path.join(parent, `${s.id}-`));
    const log = [];
    try {
      s.run(sandbox(root, s.options), log);
      return { id: s.id, pass: true, root, steps: log };
    } catch (error) {
      return { id: s.id, pass: false, error: String(error.stack ?? error), root, steps: log };
    }
  });
}

module.exports = { runCliScenarios, sandbox, cli, CLI_JS };
