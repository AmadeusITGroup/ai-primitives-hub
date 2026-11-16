/* global require, module, process -- CommonJS acceptance scenarios */
/**
 * CLI side of the nested skill layout acceptance (issue #701): one sandbox per
 * target, real CLI bin per step, installed trees checked against the oracle.
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { COLLECTIONS, CLI_JS, assertSkills, listTree, skillMarkers } = require('./model');

const TARGETS = [
  { type: 'vscode', scope: 'user', skills: (sb) => path.join(sb.home, '.copilot', 'skills') },
  { type: 'copilot-cli', scope: 'user', skills: (sb) => path.join(sb.home, '.copilot', 'skills') },
  { type: 'vscode', scope: 'repository', skills: (sb) => path.join(sb.ws, '.github', 'skills') }
];

function sandbox(root) {
  const home = path.join(root, 'home');
  const ws = path.join(root, 'workspace');
  for (const d of [home, path.join(ws, '.git'), path.join(root, 'tmp')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const env = {
    PATH: process.env.PATH, LANG: process.env.LANG, HOME: home, USERPROFILE: home, TMPDIR: path.join(root, 'tmp'), NO_COLOR: '1', CI: '1',
    XDG_CONFIG_HOME: path.join(root, 'xdg/config'), XDG_DATA_HOME: path.join(root, 'xdg/data'),
    XDG_STATE_HOME: path.join(root, 'xdg/state'), XDG_CACHE_HOME: path.join(root, 'xdg/cache')
  };
  for (const k of Object.keys(env)) {
    if (env[k] === undefined) {
      delete env[k];
    }
  }
  return { home, ws, env };
}

function cli(sb, args) {
  const out = cp.spawnSync(process.execPath, [CLI_JS, ...args, '-o', 'json'], { env: sb.env, cwd: sb.ws, encoding: 'utf8', timeout: 60000 });
  let parsed = null;
  try {
    parsed = JSON.parse(out.stdout);
  } catch { /* raw output kept in the assertion message */ }
  assert.ok(out.status === 0 && ['ok', 'warning'].includes(parsed?.status), `${args.join(' ')}: ${out.stdout}${out.stderr}`.slice(0, 900));
  return parsed.data;
}

/**
 * Install both fixture collections, then uninstall them, on each target.
 * @param {string} campaign Owned temp dir.
 * @param {string} collectionsDir Extracted bundle directories.
 * @returns {object[]} One result per scenario, with the observed tree.
 */
function runCliScenarios(campaign, collectionsDir) {
  const results = [];
  for (const t of TARGETS) {
    const id = `cli:${t.type}:${t.scope}`;
    const sb = sandbox(fs.mkdtempSync(path.join(campaign, `cli-${t.type}-${t.scope}-`)));
    const root = t.skills(sb);
    const observed = {};
    const failures = [];
    const check = (fn) => {
      try {
        fn();
      } catch (error) {
        failures.push(String(error.message ?? error));
      }
    };
    try {
      cli(sb, ['target', 'add', 't', '--type', t.type, '--scope', t.scope, ...(t.scope === 'repository' ? ['--workspace-root', sb.ws] : [])]);
      const installed = [];
      for (const c of Object.keys(COLLECTIONS)) {
        cli(sb, ['install', '--from', path.join(collectionsDir, c), '--target', 't']);
        installed.push(c);
        observed[`after install ${c}`] = skillMarkers(root);
      }
      check(() => assertSkills(root, installed, `${id} install`));
      for (const c of Object.keys(COLLECTIONS)) {
        cli(sb, ['uninstall', '--bundle', c, '--target', 't']);
        observed[`after uninstall ${c}`] = skillMarkers(root);
      }
      check(() => assert.deepEqual(listTree(root), [], `${id}: uninstall leaves no skill files`));
    } catch (error) {
      failures.push(String(error.message ?? error));
    }
    results.push({ id, pass: failures.length === 0, root, observed, ...(failures.length === 0 ? {} : { error: failures.join('\n---\n') }) });
  }
  return results;
}

module.exports = { runCliScenarios };
