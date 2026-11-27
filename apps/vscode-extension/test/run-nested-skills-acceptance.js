/* global require, process, console, __dirname -- acceptance launcher */
/**
 * Nested skill layout acceptance (issue #701): builds bundles from
 * `test/fixtures/nested-skills`, runs the CLI scenarios, then one fresh real
 * VS Code extension host per native phase. Local fixtures only; an installed
 * VS Code binary is required (no download).
 * Env: APH_NESTED_MODE=all|cli|vscode,
 * APH_NESTED_PHASES=user:local,repository:local,user:local-awesome-copilot,repository:local-awesome-copilot,
 * APH_NESTED_KEEP=1 (keep the campaign directory even when green), VSCODE_EXECUTABLE_PATH.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildBundles, EXT_ROOT } = require('./acceptance/nested-skills/model');
const { runCliScenarios } = require('./acceptance/nested-skills/cli-scenarios');

const INDEX = path.join(__dirname, 'acceptance', 'nested-skills', 'index.js');
const DEFAULT_PHASES = 'user:local,repository:local,user:local-awesome-copilot,repository:local-awesome-copilot';

function findCode(env) {
  const candidates = env.VSCODE_EXECUTABLE_PATH ? [env.VSCODE_EXECUTABLE_PATH] : ['/usr/share/code/code', '/usr/share/code-insiders/code-insiders'];
  return candidates.find((c) => {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return fs.statSync(c).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

/**
 * Run one phase in a fresh, isolated extension host (own HOME, XDG, user data).
 * @param {string} campaign
 * @param {string} phase `<scope>:<source type>`.
 * @param {string} exe VS Code executable.
 * @param {{ collections: string, fixtureSrc: string }} built
 */
async function runNative(campaign, phase, exe, built) {
  const root = fs.mkdtempSync(path.join(campaign, `native-${phase.replace(':', '-')}-`));
  const home = path.join(root, 'home');
  const ws = path.join(root, 'workspace');
  for (const d of [home, path.join(ws, '.git'), path.join(root, 'tmp'), path.join(root, 'vscode-user-data', 'User'), path.join(root, 'vscode-extensions')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'vscode-user-data', 'User', 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false, 'workbench.enableExperiments': false, 'git.autofetch': false,
    'json.schemaDownload.enable': false, 'security.workspace.trust.enabled': false
  }, null, 2));
  const xdg = (n) => path.join(root, 'xdg', n);
  const env = {
    PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, LANG: process.env.LANG,
    HOME: home, USERPROFILE: home, TMPDIR: path.join(root, 'tmp'),
    XDG_CONFIG_HOME: xdg('config'), XDG_DATA_HOME: xdg('data'), XDG_STATE_HOME: xdg('state'), XDG_CACHE_HOME: xdg('cache'),
    APH_NESTED_ROOT: root, APH_NESTED_PHASE: phase,
    APH_NESTED_SOURCE_DIR: phase.endsWith(':local') ? built.collections : built.fixtureSrc
  };
  for (const k of Object.keys(env)) {
    if (env[k] === undefined) {
      delete env[k];
    }
  }
  const saved = { ...process.env };
  const observedFile = path.join(root, 'native-observed.json');
  try {
    for (const k of Object.keys(process.env)) {
      delete process.env[k];
    }
    Object.assign(process.env, env);
    await require('@vscode/test-electron').runTests({
      vscodeExecutablePath: exe, extensionDevelopmentPath: EXT_ROOT, extensionTestsPath: INDEX,
      launchArgs: [ws, '--user-data-dir', path.join(root, 'vscode-user-data'), '--extensions-dir', path.join(root, 'vscode-extensions'),
        '--disable-extensions', '--disable-gpu', '--disable-updates', '--disable-telemetry', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust']
    });
    return { id: `vscode:${phase}`, root, pass: true };
  } catch (error) {
    const details = fs.existsSync(observedFile) ? JSON.parse(fs.readFileSync(observedFile, 'utf8')) : {};
    return { id: `vscode:${phase}`, root, pass: false, error: [String(error.message ?? error), ...(details.failures ?? []), ...(details.errors ?? [])].join('\n---\n') };
  } finally {
    for (const k of Object.keys(process.env)) {
      delete process.env[k];
    }
    Object.assign(process.env, saved);
  }
}

async function main() {
  const mode = process.env.APH_NESTED_MODE ?? 'all';
  const phases = (process.env.APH_NESTED_PHASES ?? DEFAULT_PHASES).split(',');
  const campaign = fs.mkdtempSync(path.join(os.tmpdir(), 'aph-nested-skills-'));
  const built = buildBundles(campaign);
  built.fixtureSrc = path.join(campaign, 'fixture-src');
  const report = { campaign, cli: [], native: [] };
  if (mode !== 'vscode') {
    report.cli = runCliScenarios(campaign, built.collections);
  }
  if (mode !== 'cli') {
    const exe = findCode(process.env);
    if (exe === null || (process.platform === 'linux' && !process.env.DISPLAY)) {
      report.native.push({ id: 'vscode', pass: false, error: 'blocked: no VS Code executable or DISPLAY; downloads are never performed' });
    } else {
      for (const phase of phases) {
        report.native.push(await runNative(campaign, phase, exe, built));
      }
    }
  }
  const all = [...report.cli, ...report.native];
  fs.writeFileSync(path.join(campaign, 'report.json'), JSON.stringify(report, null, 2));
  for (const r of all) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.id}${r.pass ? '' : `\n  ${String(r.error).split('\n').slice(0, 6).join('\n  ')}`}`);
  }
  console.log(`report: ${path.join(campaign, 'report.json')}`);
  const failed = all.filter((r) => !r.pass);
  if (failed.length === 0 && process.env.APH_NESTED_KEEP !== '1') {
    fs.rmSync(campaign, { recursive: true, force: true });
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
