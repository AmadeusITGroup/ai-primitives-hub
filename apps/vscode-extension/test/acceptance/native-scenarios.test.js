/* global require, process, setTimeout, suite, test, suiteSetup -- Mocha suite inside the real extension host */
/**
 * Native acceptance scenarios (09-ACCEPTANCE-TEST-PLAN), run in a real VS Code
 * extension host. Only user-input APIs are scripted; the extension observes
 * through its test-mode API and the oracle checks lockfiles, disk and views.
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const pkg = require('../../package.json');
const {
  TargetModel, SCHEMA_URL, assertLockfiles, assertDisk, assertExtensionViews, assertCliInstalled, readRecords, snapshot
} = require('./target-model');

const ROOT = process.env.APH_ACCEPT_ROOT;
const PHASE = process.env.APH_ACCEPT_PHASE;
const HOME = process.env.HOME;
const DATA_HOME = process.env.XDG_DATA_HOME;
const STATE_HOME = process.env.XDG_STATE_HOME;
const COLLECTIONS = path.join(ROOT, 'collections');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = () => vscode.workspace.workspaceFolders[0].uri.fsPath;

let api;
const prompts = [];
const errors = [];
const infos = [];

/**
 * Script user input. Each entry: { kind, match: RegExp, answer }.
 * Unscripted prompts fail the test (they are recorded and asserted empty).
 */
const script = [];
function answer(kind, text) {
  prompts.push({ kind, text });
  const i = script.findIndex((s) => s.kind === kind && s.match.test(text));
  if (i === -1) {
    throw new Error(`unscripted ${kind}: ${text}`);
  }
  const value = script.splice(i, 1)[0].answer;
  // Warning answers may be callbacks run at the moment the prompt appears.
  return kind === 'warning' && typeof value === 'function' ? value() : value;
}

function installInputBoundary() {
  const w = vscode.window;
  w.showQuickPick = async (items, options = {}) => {
    const list = await items;
    const choose = answer('quickPick', `${options.placeHolder ?? ''} ${options.title ?? ''}`);
    const hit = list.filter((item) => choose(item));
    assert.equal(hit.length, 1, `QuickPick "${options.placeHolder}": expected one matching item among ${JSON.stringify(list).slice(0, 400)}`);
    return hit[0];
  };
  w.createQuickPick = () => {
    const accept = new vscode.EventEmitter();
    const hide = new vscode.EventEmitter();
    const change = new vscode.EventEmitter();
    const qp = {
      items: [], selectedItems: [], title: '', placeholder: '', ignoreFocusOut: false,
      onDidAccept: accept.event, onDidHide: hide.event, onDidChangeSelection: change.event,
      show: () => {
        const choose = answer('scopePicker', `${qp.title} ${qp.placeholder}`);
        prompts.push({ kind: 'scopeItems', items: qp.items.map((i) => ({ label: i.label, description: i.description, scope: i._scope, commitMode: i._commitMode })) });
        const hit = qp.items.filter((item) => choose(item));
        assert.equal(hit.length, 1, 'scope picker: expected one matching item');
        qp.selectedItems = hit;
        setTimeout(() => accept.fire(), 0);
      },
      hide: () => {
        hide.fire();
      },
      dispose: () => {}
    };
    return qp;
  };
  w.showInputBox = async (options = {}) => answer('input', options.prompt ?? options.title ?? '');
  w.showOpenDialog = async (options = {}) => answer('dialog', options.title ?? options.openLabel ?? '');
  w.showWarningMessage = async (message, ...rest) => {
    const items = rest.filter((r) => typeof r === 'string' || r?.title !== undefined).map((r) => r.title ?? r);
    if (items.length === 0) {
      prompts.push({ kind: 'warning', text: message });
      return undefined;
    }
    return answer('warning', `${message} [${items.join('|')}]`);
  };
  w.showErrorMessage = async (message) => {
    errors.push(String(message));
    return undefined;
  };
  w.showInformationMessage = async (message, ...rest) => {
    infos.push(String(message));
    void rest;
    return undefined;
  };
}

/**
 * Poll the observation API until the predicate holds (views refresh asynchronously).
 * @param {() => Promise<unknown>} check
 * @param {string} label
 * @param {number} timeout
 */
async function eventually(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`${label}: ${last?.message ?? last}`);
    }
    await sleep(100);
  }
}

function cli(args) {
  const env = {
    PATH: process.env.PATH, HOME, USERPROFILE: HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: DATA_HOME,
    XDG_STATE_HOME: STATE_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME, TMPDIR: process.env.TMPDIR
  };
  const out = cp.spawnSync(process.env.APH_ACCEPT_NODE, [process.env.APH_ACCEPT_CLI, ...args, '-o', 'json'], {
    env,
    cwd: ws(), encoding: 'utf8', timeout: 60000
  });
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.status, 'ok', `CLI ${args.join(' ')}: ${out.stderr}`);
  return parsed.data;
}

async function checkAll(model, harness) {
  assertLockfiles(model);
  assertDisk(model);
  assertCliInstalled(cli(['installed']), model, harness);
  await eventually(async () => {
    assertExtensionViews(await api.marketplaceSnapshot(), await api.explorerInstalled(), model, harness);
  }, `views for ${harness}`);
}

async function select(harness) {
  const before = snapshot(modelRef);
  script.push({ kind: 'quickPick', match: /Target type/, answer: (item) => (item.label ?? item) === harness });
  await vscode.commands.executeCommand('promptregistry.runtimeTargetSelect');
  assert.deepEqual(script, [], 'select asked only for the harness');
  assert.deepEqual(snapshot(modelRef), before, 'switching changes no file or record');
  const selection = JSON.parse(fs.readFileSync(path.join(STATE_HOME, 'ai-primitives-hub', 'target-selection.json'), 'utf8'));
  assert.deepEqual(selection.workspaces[fs.realpathSync(ws())], { type: harness });
}

const bundleId = (collection) => collection;

async function marketplace(message, scope) {
  script.push({ kind: 'warning', match: /Apply|Preview/, answer: 'Apply Preview' });
  await api.postMarketplaceMessage({
    ...message,
    ...(scope === undefined
      ? {}
      : {
        scope,
        ...(scope === 'repository' ? { commitMode: 'commit' } : {})
      })
  });
  assert.deepEqual(errors, [], `Marketplace ${message.type}: ${errors.join(' | ')}`);
  assert.deepEqual(script, [], 'all scripted prompts consumed');
}

const idOf = (model, harness, scope, collection) => [...readRecords(model.repoLockfile()), ...readRecords(model.userLockfile())]
  .find((r) => r.harness === harness && r.scope === scope && r.collection === collection).installationId;

let modelRef;
const getModel = () => modelRef;
const getApi = () => api;

suite(`target acceptance (${PHASE})`, () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`);
    const exports = await ext.activate();
    api = exports?.testApi;
    assert.ok(api, 'extension exposes testApi in Test mode');
    installInputBoundary();
    modelRef = new TargetModel(HOME, ws(), DATA_HOME);
    // Open the real views: snapshots are the messages actually delivered to the webview.
    await vscode.commands.executeCommand('workbench.view.extension.promptRegistry');
  });

  if (PHASE === 'lifecycle') {
    test('S1 enable: harness-only selector, no experimental reminders', async () => {
      await vscode.workspace.getConfiguration('promptregistry').update('experimental.runtimeTargetManagement', true, vscode.ConfigurationTarget.Global);
      await eventually(async () => assert.ok((await vscode.commands.getCommands(true)).includes('promptregistry.runtimeTargetSelect')), 'commands registered');
      script.push(
        { kind: 'quickPick', match: /Select source type/, answer: (item) => item.value === 'local' },
        { kind: 'input', match: /source name/, answer: 'Acceptance' },
        { kind: 'dialog', match: /./, answer: [vscode.Uri.file(COLLECTIONS)] },
        { kind: 'input', match: /priority/i, answer: '1' }
      );
      // Command ids keep their historical casing (ADR-0004).
      await vscode.commands.executeCommand('promptRegistry.addSource');
      await eventually(async () => {
        const ids = (await api.marketplaceSnapshot()).bundles.map((b) => b.id);
        assert.ok(ids.includes('alpha') && ids.includes('beta'), `catalog: ${ids}`);
      }, 'local source synced');
      await select('vscode');
      assert.ok(!infos.concat(prompts.map((p) => p.text ?? '')).some((t) => /poc|experimental/i.test(t)), 'no experimental reminders after enabling');
      assert.ok(!/poc|experimental/i.test(api.statusText()), `status: ${api.statusText()}`);
      await checkAll(modelRef, 'vscode');
    });

    for (const harness of ['vscode', 'kiro', 'devin']) {
      const selectedHarness = harness;
      test(`S5-S8 ${selectedHarness}: switch, install both scopes, update one row, uninstall scoped`, async () => {
        const m = getModel();
        const extensionApi = getApi();
        await select(selectedHarness);
        await checkAll(m, selectedHarness);
        await marketplace({ type: 'install', bundleId: bundleId('alpha') }, 'repository');
        m.install(selectedHarness, 'repository', 'alpha', '1.0.0');
        await checkAll(m, selectedHarness);
        const alphaCard = (await extensionApi.marketplaceSnapshot()).bundles.find((b) => b.id === 'alpha');
        assert.deepEqual(alphaCard.installations.map((i) => i.scope), ['repository'], 'repository row is scoped');
        await marketplace({ type: 'install', bundleId: bundleId('alpha') }, 'user');
        m.install(selectedHarness, 'user', 'alpha', '1.0.0');
        await marketplace({ type: 'install', bundleId: bundleId('beta') }, 'repository');
        m.install(selectedHarness, 'repository', 'beta', '1.0.0');
        await checkAll(m, selectedHarness);
        await marketplace({ type: 'uninstall', bundleId: 'beta', installationId: idOf(m, selectedHarness, 'repository', 'beta') });
        m.uninstall(selectedHarness, 'repository', 'beta');
        await checkAll(m, selectedHarness);
      });
    }

    test('S7 update one scope row to a new version', async () => {
      const m = modelRef;
      const d = path.join(COLLECTIONS, 'alpha-2.0.0');
      fs.cpSync(path.join(ROOT, 'staged', 'alpha-2.0.0'), d, { recursive: true });
      await api.syncAllSources();
      await select('kiro');
      const user = readRecords(m.userLockfile()).find((r) => r.harness === 'kiro' && r.collection === 'alpha');
      const repositoryInstallationId = idOf(m, 'kiro', 'repository', 'alpha');
      const userInstallationId = idOf(m, 'kiro', 'user', 'alpha');
      script.push({ kind: 'warning', match: /Apply plan/, answer: 'Apply Preview' });
      await vscode.commands.executeCommand('promptRegistry.updateBundle', {
        data: { bundleId: 'alpha', scope: 'repository', installationId: repositoryInstallationId }
      });
      m.update('kiro', 'repository', 'alpha', '2.0.0');
      await checkAll(m, 'kiro');
      assert.deepEqual(readRecords(m.userLockfile()).find((r) => r.harness === 'kiro' && r.collection === 'alpha'), user, 'user row unchanged');

      const repository = readRecords(m.repoLockfile()).find((r) => r.harness === 'kiro' && r.collection === 'alpha');
      script.push({ kind: 'warning', match: /Apply plan/, answer: 'Apply Preview' });
      await vscode.commands.executeCommand('promptRegistry.updateBundle', {
        data: { bundleId: 'alpha', scope: 'user', installationId: userInstallationId }
      });
      m.update('kiro', 'user', 'alpha', '2.0.0');
      await checkAll(m, 'kiro');
      assert.deepEqual(readRecords(m.repoLockfile()).find((r) => r.harness === 'kiro' && r.collection === 'alpha'), repository, 'repository row unchanged');

      script.push(
        { kind: 'warning', match: /Are you sure/, answer: 'Uninstall' },
        { kind: 'warning', match: /Apply plan/, answer: 'Apply Preview' }
      );
      await vscode.commands.executeCommand('promptRegistry.uninstallBundle', {
        data: { bundleId: 'alpha', scope: 'user', installationId: userInstallationId }
      });
      m.uninstall('kiro', 'user', 'alpha');
      await checkAll(m, 'kiro');
      assert.deepEqual(script, [], 'tree uninstall prompts were answered');
    });

    test('S9 switching back and forth always shows the selected harness', async () => {
      for (const h of ['devin', 'vscode', 'kiro', 'copilot-cli', 'vscode']) {
        await select(h);
        await checkAll(modelRef, h);
      }
    });

    test('S11 CLI changes are observed without reload; CLI switch during confirmation rejects the apply', async () => {
      const m = modelRef;
      cli(['install', '--from', path.join(COLLECTIONS, 'beta-1.0.0'), '--scope', 'user']);
      m.install('vscode', 'user', 'beta', '1.0.0');
      await checkAll(m, 'vscode');
      const before = snapshot(m);
      script.push({ kind: 'scopePicker', match: /Select Scope|Choose where/, answer: (item) => item._scope === 'repository' && item._commitMode !== 'local-only' }, {
        kind: 'warning', match: /Apply|Preview/, answer: () => {
          cli(['target', 'use', 'devin']);
          return 'Apply Preview';
        }
      });
      await api.postMarketplaceMessage({ type: 'install', bundleId: 'beta' });
      assert.ok(errors.splice(0).some((e) => /changed|stale|preview again/i.test(e)), 'stale apply rejected');
      assert.deepEqual(snapshot(m), before, 'nothing applied');
      await checkAll(m, 'devin');
    });

    test('S8 final: uninstall everything, harness by harness', async () => {
      const m = modelRef;
      for (const h of new Set(m.rows.map((r) => r.harness))) {
        await select(h);
        for (const r of m.forHarness(h)) {
          await marketplace({ type: 'uninstall', bundleId: r.collection, installationId: idOf(m, h, r.scope, r.collection) });
          m.uninstall(h, r.scope, r.collection);
          await checkAll(m, h);
        }
      }
      assert.deepEqual(m.rows, []);
    });
  }

  if (PHASE === 'migration') {
    test('S2-S4 legacy lockfile: proposed on activation, insisted on, migrated, inspected', async () => {
      const m = modelRef;
      const lock = m.repoLockfile();
      const original = fs.readFileSync(lock, 'utf8');
      script.push({ kind: 'warning', match: /legacy lockfile.*\[Migrate Now\|Preview\|Later\]/i, answer: 'Later' });
      await vscode.workspace.getConfiguration('promptregistry').update('experimental.runtimeTargetManagement', true, vscode.ConfigurationTarget.Global);
      await eventually(async () => assert.deepEqual(script, []), 'migration proposed on enable');
      await select('vscode');
      script.push({ kind: 'warning', match: /legacy lockfile/i, answer: 'Later' });
      await api.postMarketplaceMessage({ type: 'install', bundleId: 'alpha' });
      assert.equal(fs.readFileSync(lock, 'utf8'), original, 'mutation blocked while unmigrated');
      errors.splice(0);
      script.push({ kind: 'quickPick', match: /harness/i, answer: (item) => (item.label ?? item) === 'vscode' }, { kind: 'warning', match: /migrat|apply/i, answer: 'Migrate' });
      await vscode.commands.executeCommand('promptregistry.migrateLockfile');
      assert.deepEqual(script, []);
      assert.ok(infos.some((t) => /commit/i.test(t)), 'commit guidance shown');
      assert.ok(prompts.concat(infos.map((t) => ({ text: t }))).some((p) => /beta/.test(p.text ?? JSON.stringify(p))), 'modified file reported');
      m.install('vscode', 'repository', 'alpha', '1.0.0');
      const beta = path.join(ws(), '.github/prompts/beta.prompt.md');
      const betaBytes = fs.readFileSync(beta, 'utf8');
      fs.rmSync(beta);
      await checkAll(m, 'vscode');
      fs.writeFileSync(beta, betaBytes);
    });
  }

  if (PHASE === 'lockfile-error') {
    test('unsupported lockfile keeps the catalog visible and disables mutations', async () => {
      await vscode.workspace.getConfiguration('promptregistry').update(
        'experimental.runtimeTargetManagement', true, vscode.ConfigurationTarget.Global
      );
      await eventually(async () => {
        assert.ok((await vscode.commands.getCommands(true)).includes('promptregistry.runtimeTargetSelect'));
      }, 'target commands registered');
      script.push(
        { kind: 'quickPick', match: /Select source type/, answer: (item) => item.value === 'local' },
        { kind: 'input', match: /source name/i, answer: 'Local Acceptance' },
        { kind: 'dialog', match: /Select local registry directory/, answer: [vscode.Uri.file(COLLECTIONS)] },
        { kind: 'input', match: /priority/i, answer: '1' }
      );
      await vscode.commands.executeCommand('promptRegistry.addSource');
      await eventually(async () => {
        const view = await api.marketplaceSnapshot();
        assert.ok(view.bundles.some((bundle) => bundle.id === 'alpha'), 'local catalog loaded');
        assert.deepEqual(script, [], 'source inputs consumed');
      }, 'local catalog sync');
      await select('vscode');

      const authority = path.join(DATA_HOME, 'ai-primitives-hub', 'ai-primitives-hub.lock.json');
      fs.mkdirSync(path.dirname(authority), { recursive: true });
      const unsupported = {
        $schema: SCHEMA_URL, version: '9.9.9', generatedAt: '2026-11-09T00:00:00.000Z',
        generatedBy: 'acceptance fixture', sources: {}, bundles: {}
      };
      const before = `${JSON.stringify(unsupported, null, 2)}\n`;
      fs.writeFileSync(authority, before);
      await api.postMarketplaceMessage({ type: 'refresh' });
      const view = await eventually(async () => {
        const latest = await api.marketplaceSnapshot();
        assert.ok(latest.inventoryWarning, 'unreadable installed state is visible');
        return latest;
      }, 'installed-state warning delivered');
      assert.ok(view.bundles.some((bundle) => bundle.id === 'alpha'), 'catalog remains visible');
      assert.ok(view.bundles.every((bundle) => bundle.inventoryUnavailable === true), 'mutating controls are disabled');
      const explorer = await api.explorerInstalled();
      assert.ok(explorer.some((row) => 'error' in row && /lockfile/i.test(row.error)), 'Explorer explains that installed state is unavailable');
      assert.equal(fs.readFileSync(authority, 'utf8'), before, 'unsupported lockfile is not rewritten or deleted');
    });
  }

  if (PHASE === 'storage') {
    test('S13 legacy global storage: migration insisted on, XDG used afterwards, legacy untouched', async () => {
      const legacy = process.env.APH_ACCEPT_LEGACY_STORAGE;
      const before = fs.readFileSync(path.join(legacy, 'config.json'), 'utf8');
      script.push({ kind: 'warning', match: /legacy (storage|location)|migrat/i, answer: 'Migrate Now' });
      await api.runStartupChecks();
      assert.deepEqual(script, []);
      const sources = await api.listSources();
      assert.ok(sources.some((s) => s.name === 'Legacy Source'), 'migrated source visible');
      assert.ok(fs.existsSync(path.join(process.env.XDG_CONFIG_HOME, 'ai-primitives-hub')), 'XDG config populated');
      assert.ok(infos.some((message) => /legacy-hub.*shared-hub.*kept shared XDG selection/i.test(message)),
        'active-hub conflict names both selections and the one retained');
      assert.deepEqual(JSON.parse(fs.readFileSync(
        path.join(process.env.XDG_CONFIG_HOME, 'ai-primitives-hub', 'active-hub.json'), 'utf8'
      )), { hubId: 'shared-hub' });
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(legacy, 'activeHubId.json'), 'utf8')), { hubId: 'legacy-hub' });
      assert.equal(fs.readFileSync(path.join(legacy, 'config.json'), 'utf8'), before, 'legacy root untouched');
      assert.ok(!Object.keys(process.env).some((k) => /STORAGE_MODE/.test(k)), 'no storage-mode variable');
    });
  }

  if (PHASE === 'local-only') {
    test('repository Local Only writes the local lock and git-excludes only its outputs', async () => {
      await vscode.workspace.getConfiguration('promptregistry').update(
        'experimental.runtimeTargetManagement', true, vscode.ConfigurationTarget.Global
      );
      await eventually(async () => {
        assert.ok((await vscode.commands.getCommands(true)).includes('promptregistry.runtimeTargetSelect'));
      }, 'target commands registered');
      script.push(
        { kind: 'quickPick', match: /Select source type/, answer: (item) => item.value === 'local' },
        { kind: 'input', match: /source name/i, answer: 'Local Only Acceptance' },
        { kind: 'dialog', match: /Select local registry directory/, answer: [vscode.Uri.file(COLLECTIONS)] },
        { kind: 'input', match: /priority/i, answer: '1' }
      );
      await vscode.commands.executeCommand('promptRegistry.addSource');
      await eventually(async () => {
        assert.ok((await api.marketplaceSnapshot()).bundles.some((bundle) => bundle.id === 'alpha'));
      }, 'local source synced');
      await select('vscode');

      script.push({ kind: 'warning', match: /Apply|Preview/, answer: 'Apply Preview' });
      await api.postMarketplaceMessage({
        type: 'install', bundleId: 'alpha', scope: 'repository', version: '1.0.0', commitMode: 'local-only'
      });
      const localLockPath = path.join(ws(), 'prompt-registry.local.lock.json');
      const trackedLockPath = path.join(ws(), 'prompt-registry.lock.json');
      const outputPath = path.join(ws(), '.github', 'prompts', 'alpha.prompt.md');
      const excludePath = path.join(ws(), '.git', 'info', 'exclude');
      const lock = JSON.parse(fs.readFileSync(localLockPath, 'utf8'));
      assert.equal(Object.values(lock.bundles).length, 1);
      assert.equal(fs.existsSync(trackedLockPath), false);
      assert.equal(fs.readFileSync(outputPath, 'utf8'), '# alpha 1.0.0\n');
      let excluded = fs.readFileSync(excludePath, 'utf8');
      assert.match(excluded, /prompt-registry\.local\.lock\.json/);
      assert.match(excluded, /\.github\/prompts\/alpha\.prompt\.md/);

      const rows = await eventually(async () => {
        const current = await api.explorerInstalled();
        assert.equal(current.length, 1);
        return current;
      }, 'local-only installation visible');
      const installationId = rows[0].installationId;
      assert.ok(installationId);
      script.push({ kind: 'warning', match: /Apply|Preview/, answer: 'Apply Preview' });
      await api.postMarketplaceMessage({ type: 'uninstall', bundleId: 'alpha', installationId });
      await eventually(async () => assert.deepEqual(await api.explorerInstalled(), []), 'local-only installation removed');
      assert.equal(fs.existsSync(outputPath), false);
      excluded = fs.readFileSync(excludePath, 'utf8');
      assert.doesNotMatch(excluded, /\.github\/prompts\/alpha\.prompt\.md/);
    });
  }

  if (PHASE === 'mcp') {
    test('target-managed MCP install writes and removes the selected workspace configuration', async () => {
      await vscode.workspace.getConfiguration('promptregistry').update(
        'experimental.runtimeTargetManagement', true, vscode.ConfigurationTarget.Global
      );
      await eventually(async () => {
        assert.ok((await vscode.commands.getCommands(true)).includes('promptregistry.runtimeTargetSelect'));
      }, 'target commands registered');

      const collectionDir = path.join(COLLECTIONS, 'mcp-1.0.0');
      fs.mkdirSync(path.join(collectionDir, 'prompts'), { recursive: true });
      fs.mkdirSync(path.join(collectionDir, 'mcp'), { recursive: true });
      fs.writeFileSync(path.join(collectionDir, 'deployment-manifest.yml'), [
        'id: mcp-demo',
        'version: 1.0.0',
        'name: MCP Demo',
        'repository: https://github.com/acceptance/mcp-demo',
        'prompts:',
        '  - id: welcome',
        '    file: prompts/welcome.prompt.md',
        '    type: prompt',
        'mcpServers:',
        '  demo:',
        '    command: node',
        '    args:',
        '      - "${bundlePath}/mcp/server.js"'
      ].join('\n'));
      fs.writeFileSync(path.join(collectionDir, 'prompts', 'welcome.prompt.md'), '# MCP Demo\n');
      fs.writeFileSync(path.join(collectionDir, 'mcp', 'server.js'), 'export default 1;\n');

      script.push(
        { kind: 'quickPick', match: /Select source type/, answer: (item) => item.value === 'local' },
        { kind: 'input', match: /source name/i, answer: 'MCP Acceptance' },
        { kind: 'dialog', match: /Select local registry directory/, answer: [vscode.Uri.file(COLLECTIONS)] },
        { kind: 'input', match: /priority/i, answer: '1' }
      );
      await vscode.commands.executeCommand('promptRegistry.addSource');
      await eventually(async () => {
        assert.ok((await api.marketplaceSnapshot()).bundles.some((bundle) => bundle.id === 'mcp-demo'));
      }, 'MCP collection synced');
      const mcpTarget = vscode.env.appName.includes('Insiders') ? 'vscode-insiders' : 'vscode';
      await select(mcpTarget);

      script.push({ kind: 'warning', match: /Apply plan/, answer: 'Apply Preview' });
      await api.postMarketplaceMessage({
        type: 'install', bundleId: 'mcp-demo', scope: 'repository', version: '1.0.0', commitMode: 'commit'
      });
      const configPath = path.join(ws(), '.vscode', 'mcp.json');
      const trackingPath = path.join(ws(), '.vscode', 'prompt-registry-mcp-tracking.json');
      const excludePath = path.join(ws(), '.git', 'info', 'exclude');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.equal(Object.keys(config.servers).length, 1);
      const server = Object.values(config.servers)[0];
      assert.equal(server.command, 'node');
      assert.ok(server.args[0].endsWith('/mcp/server.js'));
      assert.ok(fs.existsSync(server.args[0]), 'MCP server support stays available in the retained payload');
      assert.equal(fs.existsSync(path.join(ws(), 'mcp', 'server.js')), false, 'MCP support files are not projected into the harness root');
      assert.equal(Object.keys(JSON.parse(fs.readFileSync(trackingPath, 'utf8')).managedServers).length, 1);

      const row = (await api.explorerInstalled()).find((item) => item.collection === 'mcp-demo');
      assert.ok(row && 'installationId' in row);
      script.push({ kind: 'warning', match: /Apply plan/, answer: 'Apply Preview' });
      await api.postMarketplaceMessage({ type: 'uninstall', bundleId: 'mcp-demo', installationId: row.installationId });
      const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.deepEqual(after.servers, {});
      assert.deepEqual(JSON.parse(fs.readFileSync(trackingPath, 'utf8')).managedServers, {});
      assert.deepEqual(script, [], 'all MCP lifecycle prompts were answered');

      script.push({ kind: 'warning', match: /Apply plan/, answer: 'Apply Preview' });
      await api.postMarketplaceMessage({
        type: 'install', bundleId: 'mcp-demo', scope: 'repository', version: '1.0.0', commitMode: 'local-only'
      });
      const localOnlyRow = (await api.explorerInstalled()).find((item) => item.collection === 'mcp-demo');
      assert.ok(localOnlyRow && 'installationId' in localOnlyRow);
      const localOnlyExclude = fs.readFileSync(excludePath, 'utf8');
      assert.match(localOnlyExclude, /\.vscode\/mcp\.json/);
      assert.match(localOnlyExclude, /\.vscode\/prompt-registry-mcp-tracking\.json/);

      script.push({ kind: 'warning', match: /Apply plan/, answer: 'Apply Preview' });
      await api.postMarketplaceMessage({
        type: 'uninstall', bundleId: 'mcp-demo', installationId: localOnlyRow.installationId
      });
      const finalExclude = fs.readFileSync(excludePath, 'utf8');
      assert.doesNotMatch(finalExclude, /\.vscode\/mcp\.json/);
      assert.doesNotMatch(finalExclude, /\.vscode\/prompt-registry-mcp-tracking\.json/);
      assert.deepEqual(script, [], 'MCP Local Only install/uninstall prompts were answered');
    });
  }
});
