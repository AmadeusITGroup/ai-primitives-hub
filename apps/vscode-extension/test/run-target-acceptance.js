/* global require, module, process, console, __dirname -- acceptance launcher */
/**
 * Target acceptance campaign (09-ACCEPTANCE-TEST-PLAN): CLI scenarios, then one
 * fresh real VS Code extension host per native phase. Local fixtures only; an
 * installed VS Code binary is required (no download).
 * Env: APH_ACCEPT_MODE=all|cli|vscode, APH_ACCEPT_PHASES=lifecycle,migration,lockfile-error,local-only,mcp,storage,
 * APH_ACCEPT_KEEP=1, VSCODE_EXECUTABLE_PATH.
 */
const { Buffer } = require('node:buffer');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCliScenarios, CLI_JS } = require('./acceptance/cli-scenarios');
const { writeCollections, bytes, sha } = require('./acceptance/target-model');

const EXT_ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(EXT_ROOT, 'test', 'acceptance', 'index.js');

/**
 * Find an already-installed VS Code executable without downloading one.
 * @param {NodeJS.ProcessEnv} env
 */
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
 * Seed a native phase sandbox; returns the host environment and workspace.
 * @param {string} root
 * @param {string} phase
 */
function seed(root, phase) {
  const home = path.join(root, 'home');
  const ws = path.join(root, 'workspace');
  for (const d of [home, path.join(ws, '.git'), path.join(root, 'tmp'), path.join(root, 'vscode-user-data', 'User'), path.join(root, 'vscode-extensions')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const xdg = (n) => path.join(root, 'xdg', n);
  fs.mkdirSync(path.join(xdg('config'), 'ai-primitives-hub'), { recursive: true });
  fs.writeFileSync(path.join(xdg('config'), 'ai-primitives-hub', 'config.yml'), 'experimental:\n  targetManagement: true\n');
  const all = writeCollections(path.join(root, 'all'));
  fs.mkdirSync(path.join(root, 'collections'), { recursive: true });
  fs.mkdirSync(path.join(root, 'staged'), { recursive: true });
  for (const [key, dir] of Object.entries(all)) {
    const target = key === 'alpha@2.0.0' ? path.join(root, 'staged', path.basename(dir)) : path.join(root, 'collections', path.basename(dir));
    fs.cpSync(dir, target, { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'vscode-user-data', 'User', 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false, 'workbench.enableExperiments': false, 'git.autofetch': false,
    'json.schemaDownload.enable': false, 'security.workspace.trust.enabled': false
  }, null, 2));
  const extra = {};
  if (phase === 'migration') {
    fs.mkdirSync(path.join(ws, '.github', 'prompts'), { recursive: true });
    for (const c of ['alpha', 'beta']) {
      fs.writeFileSync(path.join(ws, '.github', 'prompts', `${c}.prompt.md`), bytes(c, '1.0.0'));
    }
    fs.appendFileSync(path.join(ws, '.github', 'prompts', 'beta.prompt.md'), 'local edit\n');
    fs.writeFileSync(path.join(ws, 'prompt-registry.lock.json'), `${JSON.stringify({
      $schema: 'https://github.com/AmadeusITGroup/prompt-registry/schemas/lockfile.schema.json',
      version: '2.0.0', generatedAt: '2026-01-01T00:00:00.000Z', generatedBy: 'prompt-registry@0.0.1',
      bundles: Object.fromEntries(['alpha', 'beta'].map((c) => [c, {
        version: '1.0.0', sourceId: 'acceptance-local', sourceType: 'local', installedAt: '2026-01-01T00:00:00.000Z',
        files: [{ path: `.github/prompts/${c}.prompt.md`, checksum: sha(bytes(c, '1.0.0')).slice(7) }]
      }])),
      sources: { 'acceptance-local': { type: 'local', url: path.join(root, 'collections') } }
    }, null, 2)}\n`);
  }
  if (phase === 'storage') {
    const sharedHub = path.join(xdg('config'), 'ai-primitives-hub', 'hubs');
    fs.mkdirSync(sharedHub, { recursive: true });
    const hubYaml = [
      'version: 1.0.0',
      'metadata:',
      '  name: Shared XDG Hub',
      '  description: Existing shared hub for migration-conflict acceptance',
      '  maintainer: acceptance',
      '  updatedAt: 2026-11-09T00:00:00.000Z',
      'sources: []',
      'profiles: []',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(sharedHub, 'shared-hub.yml'), hubYaml);
    fs.writeFileSync(path.join(sharedHub, 'shared-hub.meta.json'), JSON.stringify({
      reference: { type: 'local', location: sharedHub, autoSync: false },
      lastModified: '2026-11-09T00:00:00.000Z',
      size: Buffer.byteLength(hubYaml)
    }));
    fs.writeFileSync(path.join(xdg('config'), 'ai-primitives-hub', 'active-hub.json'), JSON.stringify({ hubId: 'shared-hub' }));
    const legacy = path.join(root, 'vscode-user-data', 'User', 'globalStorage', 'amadeusitgroup.prompt-registry');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'config.json'), `${JSON.stringify({
      version: '1.0.0', profiles: [], settings: {},
      sources: [{ id: 'legacy-source', name: 'Legacy Source', type: 'local', url: path.join(root, 'collections'), enabled: true, priority: 1 }]
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(legacy, 'activeHubId.json'), JSON.stringify({ hubId: 'legacy-hub' }));
    extra.APH_ACCEPT_LEGACY_STORAGE = legacy;
  }
  const env = {
    PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, LANG: process.env.LANG,
    HOME: home, USERPROFILE: home, TMPDIR: path.join(root, 'tmp'),
    XDG_CONFIG_HOME: xdg('config'), XDG_DATA_HOME: xdg('data'), XDG_STATE_HOME: xdg('state'), XDG_CACHE_HOME: xdg('cache'),
    APH_ACCEPT_ROOT: root, APH_ACCEPT_PHASE: phase, APH_ACCEPT_NODE: process.execPath, APH_ACCEPT_CLI: CLI_JS, ...extra
  };
  for (const k of Object.keys(env)) {
    if (env[k] === undefined) {
      delete env[k];
    }
  }
  return { env, ws };
}

async function runNative(parent, phase, exe) {
  const root = fs.mkdtempSync(path.join(parent, `native-${phase}-`));
  const { env, ws } = seed(root, phase);
  const saved = { ...process.env };
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
    return { phase, root, pass: true };
  } catch (error) {
    return { phase, root, pass: false, error: String(error.message ?? error) };
  } finally {
    for (const k of Object.keys(process.env)) {
      delete process.env[k];
    }
    Object.assign(process.env, saved);
  }
}

async function main() {
  const mode = process.env.APH_ACCEPT_MODE ?? 'all';
  const phases = (process.env.APH_ACCEPT_PHASES ?? 'lifecycle,migration,lockfile-error,local-only,mcp,storage').split(',');
  const campaign = fs.mkdtempSync(path.join(os.tmpdir(), 'aph-accept-'));
  const report = { campaign, cli: [], native: [] };
  if (mode !== 'vscode') {
    report.cli = runCliScenarios(campaign);
  }
  if (mode !== 'cli') {
    const exe = findCode(process.env);
    if (exe === null || (process.platform === 'linux' && !process.env.DISPLAY)) {
      report.native.push({ pass: false, error: 'blocked: no VS Code executable or DISPLAY; downloads are never performed' });
    } else {
      for (const phase of phases) {
        report.native.push(await runNative(campaign, phase, exe));
      }
    }
  }
  const failed = [...report.cli, ...report.native].filter((r) => !r.pass);
  fs.writeFileSync(path.join(campaign, 'report.json'), JSON.stringify(report, null, 2));
  for (const r of [...report.cli, ...report.native]) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.id ?? `native:${r.phase}`}${r.pass ? '' : `\n  ${String(r.error).split('\n')[0]}`}`);
  }
  console.log(`report: ${path.join(campaign, 'report.json')}`);
  if (failed.length === 0 && process.env.APH_ACCEPT_KEEP !== '1') {
    fs.rmSync(campaign, { recursive: true, force: true });
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}

module.exports = { seed, findCode };
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
