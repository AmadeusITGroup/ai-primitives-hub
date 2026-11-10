/**
 * RuntimeTargetCommands UI tests — real registered handlers + real
 * controller/session/store under synthetic roots; only the vscode boundary
 * (pickers, dialogs, notifications, status, events) is stubbed.
 */
import * as assert from 'node:assert';
import {
  execFileSync,
} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createRuntimeTargetSession,
} from '@ai-primitives-hub/app';
import {
  instanceKey,
} from '@ai-primitives-hub/core';
import {
  BuiltInOnlyLayoutConfigLoader,
  loadExtractedDirectory,
  NodeRuntimeProjectionFileSystem,
  ScopedRuntimeTargetStore,
  XdgAppStorage,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';
import {
  createRuntimeTargetSessionFactory,
  registerRuntimeTargetCommands,
} from '../../src/commands/runtime-target-commands';
import {
  CONFIGURE_COMMAND_ID,
  registerRuntimeTargetFeature,
} from '../../src/commands/runtime-target-feature';
import {
  RuntimeTargetController,
} from '../../src/services/runtime-target-controller';

const envOf = (root: string): Record<string, string> => ({
  HOME: path.join(root, 'home'),
  USERPROFILE: path.join(root, 'home'),
  XDG_CONFIG_HOME: path.join(root, 'xdg/config'),
  XDG_DATA_HOME: path.join(root, 'xdg/data'),
  XDG_CACHE_HOME: path.join(root, 'xdg/cache'),
  XDG_STATE_HOME: path.join(root, 'xdg/state'),
  TMPDIR: path.join(root, 'tmp')
});

const sessionFor = (root: string) => (ws?: string) => {
  const env = envOf(root);
  const storage = new XdgAppStorage(env);
  return createRuntimeTargetSession({
    storage,
    store: new ScopedRuntimeTargetStore({ storage, workspaceRoot: ws }),
    fs: new NodeRuntimeProjectionFileSystem(),
    env,
    ...(ws === undefined ? {} : { workspaceRoot: ws }),
    layoutLoader: new BuiltInOnlyLayoutConfigLoader()
  });
};

function bundle(dir: string, version: string): void {
  fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'deployment-manifest.yml'),
    `id: demo\nversion: ${version}\nname: Demo\nitems:\n  - path: prompts/a.prompt.md\n    kind: prompt\n`);
  fs.writeFileSync(path.join(dir, 'prompts', 'a.prompt.md'), `# A ${version}\n`);
}

interface Stubs {
  handlers: Map<string, () => Promise<unknown>>;
  executed: unknown[][];
  status: { text: string; tooltip: unknown; shown: boolean };
  bars: { text: string; tooltip: unknown; shown: boolean; command?: string; disposeCalls: number }[];
  errors: string[];
  infos: string[];
  warnings: string[];
  docs: string[];
  quickPickResults: unknown[];
  openDialogResult: unknown;
  inputResult: unknown;
  confirmResult: unknown;
  folderListeners: ((e: { removed: { uri: { fsPath: string } }[] }) => void)[];
  focusListeners: ((e: { focused: boolean }) => void)[];
}

function installStubs(s: Stubs): () => void {
  const v = vscode as unknown as Record<string, unknown>;
  const window = v.window as Record<string, unknown>;
  const commands = v.commands as Record<string, unknown>;
  const workspace = v.workspace as Record<string, unknown>;
  const orig = {
    registerCommand: commands.registerCommand,
    executeCommand: commands.executeCommand,
    createStatusBarItem: window.createStatusBarItem,
    showQuickPick: window.showQuickPick,
    showOpenDialog: window.showOpenDialog,
    showInputBox: window.showInputBox,
    showWarningMessage: window.showWarningMessage,
    showInformationMessage: window.showInformationMessage,
    showErrorMessage: window.showErrorMessage,
    openTextDocument: workspace.openTextDocument,
    showTextDocument: window.showTextDocument,
    onDidChangeWorkspaceFolders: workspace.onDidChangeWorkspaceFolders,
    onDidChangeWindowState: window.onDidChangeWindowState,
    workspaceFolders: workspace.workspaceFolders
  };
  commands.registerCommand = (id: string, fn: unknown) => {
    s.handlers.set(id, fn as () => Promise<unknown>);
    return { dispose: () => s.handlers.delete(id) };
  };
  commands.executeCommand = (...args: unknown[]) => {
    s.executed.push(args);
    return Promise.resolve();
  };
  window.createStatusBarItem = () => {
    const bar = {
      text: '', tooltip: undefined as unknown, command: '', shown: false,
      disposeCalls: 0,
      show() {
        this.shown = true;
      },
      hide() {
        this.shown = false;
      },
      dispose() {
        this.shown = false;
        this.disposeCalls += 1;
      }
    };
    s.status = bar;
    s.bars.push(bar);
    return bar;
  };
  window.onDidChangeWindowState = (fn: (e: { focused: boolean }) => void) => {
    s.focusListeners.push(fn);
    return { dispose: () => {
      s.focusListeners = s.focusListeners.filter((f) => f !== fn);
    } };
  };
  window.showQuickPick = (items: unknown[]) => {
    const requested = s.quickPickResults.shift();
    if (requested === undefined) {
      return Promise.resolve(undefined);
    }
    const selected = items.find((item) => {
      if (typeof requested === 'string') {
        return item === requested
          || (typeof item === 'object' && item !== null && (item as Record<string, unknown>).label === requested);
      }
      if (typeof item !== 'object' || item === null || typeof requested !== 'object' || requested === null) {
        return false;
      }
      const candidate = item as Record<string, unknown>;
      const choice = requested as Record<string, unknown>;
      if (choice.root !== undefined) {
        return candidate.root === choice.root;
      }
      if (choice.manifestId !== undefined) {
        return candidate.manifestId === choice.manifestId && candidate.sourceId === choice.sourceId;
      }
      return candidate.label === choice.label;
    });
    assert.notStrictEqual(selected, undefined, `choice is not offered: ${JSON.stringify(requested)}`);
    return Promise.resolve(selected);
  };
  window.showOpenDialog = () => Promise.resolve(s.openDialogResult);
  window.showInputBox = () => Promise.resolve(s.inputResult);
  window.showWarningMessage = (...args: unknown[]) => {
    s.warnings.push(String(args[0]));
    return Promise.resolve(s.confirmResult);
  };
  window.showInformationMessage = (...args: unknown[]) => {
    s.infos.push(String(args[0]));
    return Promise.resolve();
  };
  window.showErrorMessage = (...args: unknown[]) => {
    s.errors.push(String(args[0]));
    return Promise.resolve();
  };
  workspace.openTextDocument = (o: { content: string }) => {
    s.docs.push(o.content);
    return Promise.resolve({ getText: () => o.content });
  };
  window.showTextDocument = () => Promise.resolve();
  workspace.onDidChangeWorkspaceFolders = (fn: (e: { removed: { uri: { fsPath: string } }[] }) => void) => {
    s.folderListeners.push(fn);
    return { dispose: () => {
      s.folderListeners = s.folderListeners.filter((f) => f !== fn);
    } };
  };
  return () => {
    Object.assign(window, {
      createStatusBarItem: orig.createStatusBarItem,
      showQuickPick: orig.showQuickPick,
      showOpenDialog: orig.showOpenDialog,
      showInputBox: orig.showInputBox,
      showWarningMessage: orig.showWarningMessage,
      showInformationMessage: orig.showInformationMessage,
      showErrorMessage: orig.showErrorMessage,
      showTextDocument: orig.showTextDocument,
      onDidChangeWindowState: orig.onDidChangeWindowState
    });
    Object.assign(commands, {
      registerCommand: orig.registerCommand,
      executeCommand: orig.executeCommand
    });
    Object.assign(workspace, {
      openTextDocument: orig.openTextDocument,
      onDidChangeWorkspaceFolders: orig.onDidChangeWorkspaceFolders,
      workspaceFolders: orig.workspaceFolders
    });
  };
}

const makeStubs = (): Stubs => ({
  handlers: new Map(),
  executed: [],
  bars: [],
  status: { text: '', tooltip: undefined, shown: false },
  errors: [], infos: [], warnings: [], docs: [],
  quickPickResults: [],
  openDialogResult: undefined,
  inputResult: undefined,
  confirmResult: 'Apply Preview',
  folderListeners: [], focusListeners: []
});

const ctx = (): vscode.ExtensionContext => ({ subscriptions: [] as unknown[] } as unknown as vscode.ExtensionContext);

const lockfilePath = (root: string): string =>
  path.join(root, 'xdg', 'data', 'ai-primitives-hub', 'ai-primitives-hub.lock.json');

function lockBytes(root: string): string {
  const read = (file: string): string => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      return '<absent>';
    }
  };
  return [lockfilePath(root), path.join(root, 'xdg', 'state', 'ai-primitives-hub', 'target-selection.json')].map((file) => read(file)).join('\n');
}

function nativeCli(root: string, ws: string, args: string[]): any {
  const bin = path.resolve(__dirname, '../../../../../packages/cli/bin/ai-primitives-hub.js');
  const preload = `require(${JSON.stringify(require.resolve('nock'))}).disableNetConnect();require(${JSON.stringify(bin)});`;
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(path.join(root, 'xdg', 'config', 'ai-primitives-hub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'xdg', 'config', 'ai-primitives-hub', 'config.yml'), 'experimental:\n  targetManagement: true\n');
  fs.writeFileSync(path.join(ws, '.git'), 'gitdir: /dev/null\n');
  fs.writeFileSync(path.join(ws, 'ai-primitives-hub-layouts.yml'), 'layouts: {}\n');
  const env = envOf(root);
  return JSON.parse(execFileSync(process.execPath, ['-e', preload, bin, ...args, '-o', 'json'], {
    cwd: ws,
    env: { ...env, TMP: env.TMPDIR, TEMP: env.TMPDIR, PATH: process.env.PATH, LOG_LEVEL: 'ERROR' },
    encoding: 'utf8', timeout: 15_000
  })).data;
}

async function select(s: Stubs, ws: string, type = 'vscode', scope = 'user'): Promise<void> {
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'ai-primitives-hub-layouts.yml'), 'layouts: {}\n');
  const workspace = vscode.workspace as unknown as Record<string, unknown>;
  const folders = (workspace.workspaceFolders ?? []) as { uri: { fsPath: string } }[];
  if (!folders.some((folder) => folder.uri.fsPath === ws)) {
    workspace.workspaceFolders = [...folders, { name: path.basename(ws), uri: { fsPath: ws }, index: folders.length }];
  }
  const after = (workspace.workspaceFolders ?? []) as unknown[];
  if (after.length > 1) {
    s.quickPickResults.push({ root: ws });
  }
  s.quickPickResults.push(type);
  void scope;
  await s.handlers.get('promptregistry.runtimeTargetSelect')!();
  assert.deepStrictEqual(s.errors, []);
}

suite('RuntimeTargetCommands UI', () => {
  test('single workspace selector asks for harness only and persists no scope', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cmd-'));
    const s = makeStubs();
    const restore = installStubs(s);
    const ws = path.join(root, 'workspace');
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, 'ai-primitives-hub-layouts.yml'), 'layouts: {}\n');
    (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [{ name: 'Workspace', uri: { fsPath: ws } }];
    try {
      const factory = createRuntimeTargetSessionFactory(envOf(root));
      const c = registerRuntimeTargetCommands(ctx(), { env: envOf(root), sessionFactory: factory });
      s.quickPickResults.push('devin');
      await s.handlers.get('promptregistry.runtimeTargetSelect')!();
      assert.deepStrictEqual(s.errors, []);
      assert.strictEqual(s.status.text, 'Target: devin');
      assert.strictEqual(s.quickPickResults.length, 0);
      const selection = await factory(ws).getSelectedTarget();
      assert.deepStrictEqual(selection, { type: 'devin', selection: 'workspace' });
      const doc = JSON.parse(fs.readFileSync(path.join(root, 'xdg/state/ai-primitives-hub/target-selection.json'), 'utf8'));
      assert.deepStrictEqual(doc.workspaces[fs.realpathSync(ws)], { type: 'devin' });
      c.dispose();
    } finally {
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('installed preview lists repository and user receipts from physical scoped authorities', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cmd-'));
    const s = makeStubs();
    const restore = installStubs(s);
    const ws = path.join(root, 'workspace');
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, 'ai-primitives-hub-layouts.yml'), 'layouts: {}\n');
    (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [{ name: 'Workspace', uri: { fsPath: ws } }];
    try {
      const factory = createRuntimeTargetSessionFactory(envOf(root));
      await factory(ws).selectTarget({ type: 'devin' });
      for (const [scope, version] of [['repository', '1.0.0'], ['user', '2.0.0']] as const) {
        const dir = path.join(root, scope);
        bundle(dir, version);
        const session = factory(ws).forScope(scope);
        const op = { kind: 'install' as const, payload: { ...await loadExtractedDirectory(dir), sourceId: 'src' } };
        await session.apply(op, (await session.plan(op)).hash);
      }
      const c = registerRuntimeTargetCommands(ctx(), { env: envOf(root), sessionFactory: factory });
      await c.installed();
      const rows = JSON.parse(s.docs.at(-1)!);
      assert.strictEqual(rows.length, 2);
      assert.deepStrictEqual(rows.map((r: { instance: { scope: string } }) => r.instance.scope).toSorted(), ['repository', 'user']);
      c.dispose();
    } finally {
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('gate on registers exactly 11 command IDs + status; dispose clears them', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cmd-'));
    const s = makeStubs();
    const restore = installStubs(s);
    try {
      const c = registerRuntimeTargetCommands(ctx(), { env: envOf(root) });
      assert.ok(c);
      assert.strictEqual(s.handlers.size, 12);
      const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
      assert.deepStrictEqual([...s.handlers.keys()].toSorted(), manifest.contributes.commands
        .map((cmd: { command: string }) => cmd.command)
        .filter((id: string) => id.startsWith('promptregistry.runtimeTarget') || id === 'promptregistry.migrateLockfile').toSorted());
      assert.ok(s.status.shown);
      c.dispose();
      c.dispose(); // idempotent
      assert.strictEqual(s.handlers.size, 0);
      assert.strictEqual(s.status.shown, false);
      assert.strictEqual(s.folderListeners.length, 0);
      assert.strictEqual(s.focusListeners.length, 0);
    } finally {
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('cancelled context pick: no selection, no state change, no error', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cmd-'));
    const s = makeStubs();
    const restore = installStubs(s);
    try {
      const c = registerRuntimeTargetCommands(ctx(), { env: envOf(root) });
      s.quickPickResults.push(undefined); // context pick cancelled
      const before = lockBytes(root);
      await s.handlers.get('promptregistry.runtimeTargetSelect')!();
      assert.strictEqual(lockBytes(root), before);
      assert.strictEqual(s.errors.length, 0);
      c.dispose();
    } finally {
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('cancelled type pick after context: no selection written', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cmd-'));
    const s = makeStubs();
    const restore = installStubs(s);
    try {
      const c = registerRuntimeTargetCommands(ctx(), { env: envOf(root) });
      s.quickPickResults.push(undefined); // type pick cancelled (context is implicit single-folder)
      const before = lockBytes(root);
      await s.handlers.get('promptregistry.runtimeTargetSelect')!();
      assert.strictEqual(lockBytes(root), before);
      assert.strictEqual(s.errors.length, 0);
      c.dispose();
    } finally {
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('select B workspace then install via confirm: real files + receipts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cmd-'));
    const s = makeStubs();
    const restore = installStubs(s);
    const wsB = path.join(root, 'wsB');
    fs.mkdirSync(path.join(wsB, '.git'), { recursive: true });
    const v = vscode as unknown as Record<string, unknown>;
    (v.workspace as Record<string, unknown>).workspaceFolders = [
      { name: 'A', uri: { fsPath: path.join(root, 'wsA') } },
      { name: 'B', uri: { fsPath: wsB } }
    ];
    try {
      const c = registerRuntimeTargetCommands(ctx(), { env: envOf(root) });
      s.quickPickResults.push({ root: wsB }, 'vscode');
      await s.handlers.get('promptregistry.runtimeTargetSelect')!();
      const d = path.join(root, 'b1');
      bundle(d, '1.0.0');
      // ensureContext already set (B retained)
      s.openDialogResult = [{ fsPath: d }];
      s.inputResult = 'demo-local';
      s.quickPickResults.push('user');
      await s.handlers.get('promptregistry.runtimeTargetInstall')!();
      const lf = JSON.parse(fs.readFileSync(lockfilePath(root), 'utf8'));
      const tools = Object.values(lf.bundles)[0] as { tools: Record<string, unknown> };
      assert.ok(tools.tools.vscode !== undefined);
      // user-scope receipt lives in the user authority, not wsB's repo doc
      assert.ok(!fs.existsSync(path.join(wsB, 'prompt-registry.lock.json'))
        || Object.keys(JSON.parse(fs.readFileSync(path.join(wsB, 'prompt-registry.lock.json'), 'utf8')).bundles ?? {}).length === 0);
      assert.ok(fs.existsSync(path.join(envOf(root).HOME, '.copilot', 'prompts', 'a.prompt.md')));
      assert.strictEqual(s.errors.length, 0);
      c.dispose();
    } finally {
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('unmanaged destination conflict: warning only, nothing applied', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cmd-'));
    const s = makeStubs();
    const restore = installStubs(s);
    try {
      const env = envOf(root);
      // seed an unmanaged file at the vscode prompt destination
      fs.mkdirSync(path.join(env.HOME, '.copilot', 'prompts'), { recursive: true });
      fs.writeFileSync(path.join(env.HOME, 'ai-primitives-hub-layouts.yml'), 'layouts: {}\n');
      fs.writeFileSync(path.join(env.HOME, '.copilot', 'prompts', 'a.prompt.md'), 'unmanaged\n');
      const c = registerRuntimeTargetCommands(ctx(), { env });
      s.quickPickResults.push('vscode');
      await s.handlers.get('promptregistry.runtimeTargetSelect')!();
      const d = path.join(root, 'b1');
      bundle(d, '1.0.0');
      const before = lockBytes(root);
      s.openDialogResult = [{ fsPath: d }];
      s.inputResult = 'demo-local';
      s.quickPickResults.push('user');
      await s.handlers.get('promptregistry.runtimeTargetInstall')!();
      assert.ok(s.warnings.some((w) => w.includes('conflict')));
      assert.strictEqual(fs.readFileSync(path.join(env.HOME, '.copilot', 'prompts', 'a.prompt.md'), 'utf8'), 'unmanaged\n');
      assert.strictEqual(lockBytes(root), before);
      c.dispose();
    } finally {
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('workspace folder removed during Apply Preview modal: apply cancelled', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cmd-'));
    const s = makeStubs();
    const restore = installStubs(s);
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    const v = vscode as unknown as Record<string, unknown>;
    (v.workspace as Record<string, unknown>).workspaceFolders = [{ name: 'ws', uri: { fsPath: ws } }];
    try {
      const env = envOf(root);
      const c = registerRuntimeTargetCommands(ctx(), { env });
      s.quickPickResults.push('vscode');
      await s.handlers.get('promptregistry.runtimeTargetSelect')!();
      const d = path.join(root, 'b1');
      bundle(d, '1.0.0');
      s.openDialogResult = [{ fsPath: d }];
      s.inputResult = 'demo-local';
      // during the modal, the folder is removed before confirm resolves
      (v.window as Record<string, unknown>).showWarningMessage = (...args: unknown[]) => {
        s.warnings.push(String(args[0]));
        for (const fn of s.folderListeners) {
          fn({ removed: [{ uri: { fsPath: ws } }] });
        }
        return Promise.resolve('Apply Preview');
      };
      s.quickPickResults.push('user');
      await s.handlers.get('promptregistry.runtimeTargetInstall')!();
      assert.ok(s.errors.some((e) => e.includes('Context changed')));
      assert.strictEqual(fs.existsSync(path.join(env.HOME, '.copilot', 'prompts', 'a.prompt.md')), false);
      c.dispose();
    } finally {
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  for (const phase of ['scope', 'directory', 'source', 'import-confirm', 'apply-confirm'] as const) {
    test(`cancel ${phase}: existing lockfile and target files remain unchanged`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cancel-'));
      const s = makeStubs();
      const restore = installStubs(s);
      const ui = registerRuntimeTargetCommands(ctx(), { env: envOf(root) });
      try {
        const ws = path.join(root, 'ws');
        fs.mkdirSync(ws);
        await select(s, ws);
        const before = lockBytes(root);
        const dir = path.join(root, 'bundle');
        bundle(dir, '1.0.0');
        s.openDialogResult = [{ fsPath: dir }];
        s.inputResult = 'src';
        if (phase === 'scope') {
          s.quickPickResults.push(undefined); // cancel at (former) scope phase = type pick now
          await s.handlers.get('promptregistry.runtimeTargetSelect')!();
        } else {
          if (phase === 'directory') {
            s.openDialogResult = undefined;
          }
          if (phase === 'source') {
            s.inputResult = undefined;
          }
          if (phase === 'import-confirm' || phase === 'apply-confirm') {
            s.confirmResult = undefined;
          }
          const command = phase === 'import-confirm' ? 'ImportInstalled' : 'Install';
          await s.handlers.get(`promptregistry.runtimeTarget${command}`)!();
        }
        assert.strictEqual(lockBytes(root), before);
        assert.strictEqual(fs.existsSync(path.join(envOf(root).HOME, '.copilot')), false);
        assert.deepStrictEqual(s.errors, []);
      } finally {
        ui.dispose();
        restore();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test('disposing during confirmation cancels the captured apply', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-dispose-'));
    const s = makeStubs();
    const restore = installStubs(s);
    const ui = registerRuntimeTargetCommands(ctx(), { env: envOf(root) });
    try {
      const ws = path.join(root, 'ws');
      fs.mkdirSync(ws);
      await select(s, ws);
      const dir = path.join(root, 'bundle');
      bundle(dir, '1.0.0');
      const before = lockBytes(root);
      s.openDialogResult = [{ fsPath: dir }];
      s.inputResult = 'src';
      (vscode.window as unknown as Record<string, unknown>).showWarningMessage = () => {
        ui.dispose();
        return Promise.resolve('Apply Preview');
      };
      s.quickPickResults.push('user');
      await s.handlers.get('promptregistry.runtimeTargetInstall')!();
      assert.strictEqual(lockBytes(root), before);
      assert.strictEqual(fs.existsSync(path.join(envOf(root).HOME, '.copilot')), false);
      assert.ok(s.errors.some((e) => e.includes('Context changed')));
    } finally {
      ui.dispose();
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('public handlers retain VSCode v1 while projecting, updating and uninstalling Kiro', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-lifecycle-'));
    const s = makeStubs();
    const restore = installStubs(s);
    const ui = registerRuntimeTargetCommands(ctx(), { env: envOf(root) });
    try {
      const a = path.join(root, 'a');
      const b = path.join(root, 'b');
      fs.mkdirSync(a);
      fs.mkdirSync(b);
      const controller = new RuntimeTargetController({ sessionFactory: sessionFor(root) });
      const dir1 = path.join(root, 'v1');
      const dir2 = path.join(root, 'v2');
      bundle(dir1, '1.0.0');
      bundle(dir2, '2.0.0');
      await select(s, a);
      assert.ok(String(s.status.tooltip).includes(a));
      assert.ok(String(s.status.tooltip).includes('workspace'));
      s.openDialogResult = [{ fsPath: dir1 }];
      s.inputResult = 'src';
      s.quickPickResults.push('user');
      await s.handlers.get('promptregistry.runtimeTargetInstall')!();
      const [installedV1] = await controller.listInstallations(a, 'user');
      assert.strictEqual(installedV1.version, '1.0.0');
      const source = instanceKey(installedV1.instance);
      await select(s, b, 'kiro', 'repository');
      s.quickPickResults.push({ label: source }, 'user');
      await s.handlers.get('promptregistry.runtimeTargetProject')!();
      assert.strictEqual((await controller.listInstallations(b, 'user'))[0].version, '1.0.0');
      s.openDialogResult = [{ fsPath: dir2 }];
      s.quickPickResults.push('demo@1.0.0');
      await s.handlers.get('promptregistry.runtimeTargetUpdate')!();
      assert.strictEqual((await controller.listInstallations(b, 'user'))[0].version, '2.0.0');
      assert.strictEqual((await controller.listInstallations(a, 'user'))[0].version, '1.0.0');
      s.quickPickResults.push('demo@2.0.0');
      await s.handlers.get('promptregistry.runtimeTargetUninstall')!();
      assert.deepStrictEqual(await controller.listInstallations(b), []);
      await select(s, a);
      await s.handlers.get('promptregistry.runtimeTargetVerify')!();
      const verification = JSON.parse(s.docs.at(-1)!);
      assert.ok(verification.length > 0 && verification.every((v: { status: string }) => v.status === 'healthy'));
      assert.strictEqual(fs.readFileSync(path.join(envOf(root).HOME, '.copilot/prompts/a.prompt.md'), 'utf8'), '# A 1.0.0\n');
      assert.deepStrictEqual(s.errors, []);
    } finally {
      ui.dispose();
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('native CLI and controller observe each other; CLI change during modal rejects stale apply', async function (this: { timeout(ms: number): void }) {
    this.timeout(30_000);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-native-'));
    const s = makeStubs();
    const restore = installStubs(s);
    const ui = registerRuntimeTargetCommands(ctx(), { env: envOf(root) });
    try {
      const ws = path.join(root, 'ws');
      const controller = new RuntimeTargetController({ sessionFactory: sessionFor(root) });
      nativeCli(root, ws, ['target', 'use', 'vscode']);
      assert.strictEqual((await controller.getActiveTarget(ws))!.instance.type, 'vscode');
      const dir = path.join(root, 'bundle');
      bundle(dir, '1.0.0');
      nativeCli(root, ws, ['install', '--from', dir, '--source-id', 'src', '--scope', 'user']);
      assert.strictEqual((await controller.listInstallations(ws, 'user'))[0].version, '1.0.0');
      await controller.selectTarget({ type: 'kiro' }, ws);
      const active = nativeCli(root, ws, ['target', 'current']);
      assert.deepStrictEqual(active, { type: 'kiro', selection: 'workspace' });
      await select(s, ws, 'kiro', 'repository');
      s.openDialogResult = [{ fsPath: dir }];
      s.inputResult = 'src';
      (vscode.window as unknown as Record<string, unknown>).showWarningMessage = () => {
        nativeCli(root, ws, ['target', 'use', 'devin']);
        return Promise.resolve('Apply Preview');
      };
      s.quickPickResults.push('user');
      await s.handlers.get('promptregistry.runtimeTargetInstall')!();
      assert.ok(s.errors.some((e) => e.includes('PLAN.STALE')), s.errors.join('\n'));
      assert.strictEqual(fs.existsSync(path.join(ws, '.kiro', 'prompts', 'a.prompt.md')), false);
      const beforeRefresh = lockBytes(root);
      await s.handlers.get('promptregistry.runtimeTargetRefresh')!();
      assert.strictEqual(s.status.text, 'Target: devin');
      assert.strictEqual(lockBytes(root), beforeRefresh);
    } finally {
      ui.dispose();
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

suite('RuntimeTargetFeature opt-in', () => {
  const configurationEvent = {
    affectsConfiguration: (key: string) => key === 'promptregistry.experimental.runtimeTargetManagement'
  };

  const configure = (initial: boolean | undefined) => {
    const ws = vscode.workspace as unknown as Record<string, unknown>;
    const originalGet = ws.getConfiguration;
    const originalListen = ws.onDidChangeConfiguration;
    const listeners = new Set<(event: typeof configurationEvent) => void>();
    let value = initial;
    ws.getConfiguration = () => ({
      get: <T>(k: string, d: T) => (k === 'experimental.runtimeTargetManagement' ? (value === undefined ? d : value) : d) as T,
      inspect: <T>(k: string) => (k === 'experimental.runtimeTargetManagement' && value !== undefined ? { globalValue: value as T } : undefined)
    });
    ws.onDidChangeConfiguration = (listener: (event: typeof configurationEvent) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    };
    return {
      listeners,
      change: (next: boolean | undefined) => {
        value = next;
        for (const listener of listeners) {
          listener(configurationEvent);
        }
      },
      restore: () => {
        ws.getConfiguration = originalGet;
        ws.onDidChangeConfiguration = originalListen;
      }
    };
  };

  const withSetting = (value: boolean | undefined): (() => void) => {
    const settings = configure(value);
    return () => settings.restore();
  };

  test('feature dispose clears the live registry binding', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cmd-'));
    const s = makeStubs();
    const restore = installStubs(s);
    const undo = withSetting(true);
    const bindings: unknown[] = [];
    try {
      const feature = registerRuntimeTargetFeature(ctx(), {
        env: envOf(root),
        registryManager: {
          setRuntimeTargetManagement: (binding) => bindings.push(binding),
          refreshRuntimeInstallations: () => undefined
        }
      });
      assert.ok(bindings.at(-1));
      feature.dispose();
      assert.strictEqual(bindings.at(-1), undefined);
    } finally {
      undo();
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('default off clears stale context, shows nothing and opens the exact setting without storage writes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-feat-'));
    const s = makeStubs();
    const restore = installStubs(s);
    const undo = withSetting(undefined);
    let feature: vscode.Disposable | undefined;
    try {
      const env = { ...envOf(root) };
      feature = registerRuntimeTargetFeature(ctx(), { env });
      assert.strictEqual(s.handlers.size, 1); // only configure
      assert.ok(s.handlers.has(CONFIGURE_COMMAND_ID));
      assert.deepStrictEqual(s.bars.filter((bar) => bar.shown).map((bar) => bar.text), []);
      assert.ok(s.executed.some((args) => args[0] === 'setContext'
        && args[1] === 'promptregistry.targetManagementEnabled' && args[2] === false));
      await s.handlers.get(CONFIGURE_COMMAND_ID)!();
      assert.ok(s.executed.some((args) => args[0] === 'workbench.action.openSettings'
        && args[1] === '@id:promptregistry.experimental.runtimeTargetManagement'));
      assert.strictEqual(fs.existsSync(path.join(env.XDG_DATA_HOME, 'ai-primitives-hub')), false);
      assert.strictEqual(fs.existsSync(path.join(env.HOME, '.copilot')), false);
    } finally {
      feature?.dispose();
      undo();
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('setting enables real target selection and install without mutating the environment', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-feat-'));
    const s = makeStubs();
    const restore = installStubs(s);
    const undo = withSetting(true);
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    const v = vscode as unknown as Record<string, unknown>;
    (v.workspace as Record<string, unknown>).workspaceFolders = [{ name: 'ws', uri: { fsPath: ws } }];
    let feature: vscode.Disposable | undefined;
    try {
      const env = { ...envOf(root) };
      feature = registerRuntimeTargetFeature(ctx(), { env });
      assert.strictEqual(s.handlers.size, 13); // 12 + configure
      assert.deepStrictEqual(s.bars.filter((bar) => bar.shown).map((bar) => bar.text), ['Target: none']);
      s.quickPickResults.push('vscode');
      await s.handlers.get('promptregistry.runtimeTargetSelect')!();
      const d = path.join(root, 'b1');
      bundle(d, '1.0.0');
      s.openDialogResult = [{ fsPath: d }];
      s.inputResult = 'demo-local';
      s.quickPickResults.push('user');
      await s.handlers.get('promptregistry.runtimeTargetInstall')!();
      assert.ok(fs.existsSync(path.join(envOf(root).HOME, '.copilot', 'prompts', 'a.prompt.md')));
      assert.strictEqual(s.bars.filter((bar) => bar.shown).length, 1);
    } finally {
      feature?.dispose();
      undo();
      restore();
      (v.workspace as Record<string, unknown>).workspaceFolders = undefined;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('toggle and dispose preserve state, release UI resources and ignore queued configuration events', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-feat-'));
    const s = makeStubs();
    const restore = installStubs(s);
    const settings = configure(true);
    const context = ctx();
    let feature: vscode.Disposable | undefined;
    try {
      const env = { ...envOf(root) };
      feature = registerRuntimeTargetFeature(context, { env });
      const ws = path.join(root, 'ws');
      fs.mkdirSync(ws);
      await select(s, ws);
      const before = lockBytes(root);
      assert.strictEqual(s.handlers.size, 13);
      assert.strictEqual(settings.listeners.size, 1);
      settings.change(false);
      assert.strictEqual(s.handlers.size, 1, 'only configure remains after off');
      assert.deepStrictEqual(s.bars.filter((bar) => bar.shown).map((bar) => bar.text), []);
      assert.strictEqual(s.folderListeners.length, 0);
      assert.strictEqual(s.focusListeners.length, 0);
      settings.change(true);
      assert.strictEqual(s.handlers.size, 13);
      assert.deepStrictEqual(s.bars.filter((bar) => bar.shown).map((bar) => bar.text), ['Target: none']);
      assert.strictEqual(context.subscriptions.length, 1);
      assert.strictEqual(lockBytes(root), before);
      assert.strictEqual(fs.existsSync(path.join(env.HOME, '.copilot')), false);
      const queued = [...settings.listeners][0];
      feature.dispose();
      feature.dispose();
      queued(configurationEvent);
      assert.strictEqual(s.handlers.size, 0);
      assert.strictEqual(settings.listeners.size, 0);
      assert.strictEqual(s.folderListeners.length, 0);
      assert.strictEqual(s.focusListeners.length, 0);
      assert.ok(s.bars.every((bar) => !bar.shown && bar.disposeCalls === 1));
      assert.strictEqual(lockBytes(root), before);
    } finally {
      feature?.dispose();
      settings.restore();
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('disabling the setting during confirmation cancels the captured apply even with the environment flag', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-feat-'));
    const s = makeStubs();
    const restore = installStubs(s);
    const settings = configure(true);
    let feature: vscode.Disposable | undefined;
    try {
      feature = registerRuntimeTargetFeature(ctx(), { env: envOf(root) });
      const ws = path.join(root, 'ws');
      fs.mkdirSync(ws);
      await select(s, ws);
      const before = lockBytes(root);
      const dir = path.join(root, 'bundle');
      bundle(dir, '1.0.0');
      s.openDialogResult = [{ fsPath: dir }];
      s.inputResult = 'src';
      (vscode.window as unknown as Record<string, unknown>).showWarningMessage = () => {
        settings.change(false);
        return Promise.resolve('Apply Preview');
      };
      s.quickPickResults.push('user');
      await s.handlers.get('promptregistry.runtimeTargetInstall')!();
      assert.ok(s.docs.length > 0, 'an applicable preview must precede cancellation');
      assert.ok(s.errors.some((error) => error.includes('Context changed')), s.errors.join('\n'));
      assert.strictEqual(lockBytes(root), before);
      assert.strictEqual(fs.existsSync(path.join(envOf(root).HOME, '.copilot')), false);
      assert.strictEqual(s.handlers.size, 1);
      assert.deepStrictEqual(s.bars.filter((bar) => bar.shown).map((bar) => bar.text), []);
    } finally {
      feature?.dispose();
      settings.restore();
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('setting false keeps the feature off', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-feat-'));
    const s = makeStubs();
    const restore = installStubs(s);
    const undo = withSetting(false);
    let feature: vscode.Disposable | undefined;
    try {
      feature = registerRuntimeTargetFeature(ctx(), { env: envOf(root) });
      assert.strictEqual(s.handlers.size, 1);
      assert.deepStrictEqual(s.bars.filter((bar) => bar.shown).map((bar) => bar.text), []);
    } finally {
      feature?.dispose();
      undo();
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('an unconfigured setting keeps the feature off', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-feat-'));
    const s = makeStubs();
    const restore = installStubs(s);
    const undo = withSetting(undefined);
    let feature: vscode.Disposable | undefined;
    try {
      feature = registerRuntimeTargetFeature(ctx(), { env: envOf(root) });
      assert.strictEqual(s.handlers.size, 1);
      assert.deepStrictEqual(s.bars.filter((bar) => bar.shown).map((bar) => bar.text), []);
      assert.strictEqual(fs.existsSync(path.join(envOf(root).XDG_DATA_HOME, 'ai-primitives-hub')), false);
    } finally {
      feature?.dispose();
      undo();
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('contribution: setting + configure command + 11 enablement keys in package.json', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
    assert.strictEqual(manifest.contributes.configuration.properties['promptregistry.experimental.runtimeTargetManagement'].default, false);
    assert.strictEqual(manifest.contributes.configuration.properties['promptregistry.experimental.runtimeTargetManagement'].scope, 'application');
    assert.deepStrictEqual(manifest.contributes.configuration.properties['promptregistry.experimental.runtimeTargetManagement'].tags, ['experimental']);
    assert.ok(manifest.contributes.commands.some((c: { command: string }) => c.command === CONFIGURE_COMMAND_ID));
    const rt = manifest.contributes.commands.filter((c: { command: string }) => c.command.startsWith('promptregistry.runtimeTarget'));
    assert.strictEqual(rt.length, 11);
    assert.ok(rt.every((c: { enablement?: string }) => c.enablement === 'promptregistry.targetManagementEnabled'));
  });
});
