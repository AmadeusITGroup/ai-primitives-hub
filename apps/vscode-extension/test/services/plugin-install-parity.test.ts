/**
 * Agent Plugin install parity between the extension and the CLI at
 * repository scope.
 *
 * The same bundle, built by the real CLI, is installed by the built CLI
 * binary into one git workspace and by the extension's BundleInstaller into
 * another. Files, lockfile entry and git exclude section must be identical,
 * and each delivery must uninstall what the other installed.
 */
import * as assert from 'node:assert';
import {
  createHash,
} from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  BundleInstaller,
} from '../../src/services/bundle-installer';
import {
  LockfileManager,
} from '../../src/services/lockfile-manager';
import type {
  Bundle,
  RepositoryCommitMode,
} from '../../src/types/registry';
import {
  runBuiltCliOk,
} from '../helpers/cli-runner';
import {
  runGit,
} from '../helpers/git-test-helpers';
import {
  buildPluginBundleWithCli,
  CliBuiltPluginBundle,
  DEMO_PLUGIN_ID,
} from '../helpers/plugin-bundle-fixtures';

const LOCKFILES = new Set(['prompt-registry.lock.json', 'prompt-registry.local.lock.json']);
const EXCLUDE_HEADER = '# Prompt Registry (local)';
const POSIX = process.platform !== 'win32';

interface FileFact {
  relativePath: string;
  sha256: string;
  executable?: boolean;
}

/**
 * Every file of a workspace outside `.git/` and the lockfiles.
 * @param root - Workspace root.
 */
const workspaceFiles = (root: string): FileFact[] => {
  const facts: FileFact[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relativePath = path.relative(root, full).split(path.sep).join('/');
      if (relativePath === '.git') {
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
      } else if (!LOCKFILES.has(relativePath)) {
        const fact: FileFact = { relativePath, sha256: createHash('sha256').update(fs.readFileSync(full)).digest('hex') };
        if (POSIX) {
          // eslint-disable-next-line no-bitwise -- owner execute bit
          fact.executable = (fs.statSync(full).mode & 0o100) !== 0;
        }
        facts.push(fact);
      }
    }
  };
  walk(root);
  return facts.toSorted((a, b) => a.relativePath.localeCompare(b.relativePath));
};

/**
 * Lines of the managed section of `.git/info/exclude`, sorted.
 * @param root - Workspace root.
 */
const excludeSection = (root: string): string[] => {
  const file = path.join(root, '.git', 'info', 'exclude');
  if (!fs.existsSync(file)) {
    return [];
  }
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const start = lines.indexOf(EXCLUDE_HEADER);
  if (start === -1) {
    return [];
  }
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('#')) {
      break;
    }
    if (line.trim().length > 0) {
      section.push(line.trim());
    }
  }
  return section.toSorted();
};

/**
 * The bundle entry of the mode's lockfile, without the fields that differ by nature.
 * @param root - Workspace root.
 * @param mode - Commit mode.
 */
const comparableEntry = (root: string, mode: RepositoryCommitMode): string => {
  const file = path.join(root, mode === 'commit' ? 'prompt-registry.lock.json' : 'prompt-registry.local.lock.json');
  const lockfile = JSON.parse(fs.readFileSync(file, 'utf8')) as { bundles: Record<string, Record<string, unknown>> };
  const entry = { ...lockfile.bundles[DEMO_PLUGIN_ID] };
  delete entry.installedAt;
  delete entry.checksum;
  return JSON.stringify(entry);
};

const assertUninstalled = (root: string, who: string): void => {
  assert.deepStrictEqual(workspaceFiles(root), [], `${who}: no bundle file remains`);
  assert.ok(!fs.existsSync(path.join(root, '.github', 'plugins', DEMO_PLUGIN_ID)), `${who}: no plugin directory remains`);
  for (const lockfile of LOCKFILES) {
    assert.ok(!fs.existsSync(path.join(root, lockfile)), `${who}: ${lockfile} is removed`);
  }
  assert.deepStrictEqual(excludeSection(root), [], `${who}: no excluded path remains`);
};

const createContext = (globalStorage: string): vscode.ExtensionContext => ({
  globalStorageUri: { fsPath: globalStorage },
  storageUri: { fsPath: path.join(globalStorage, '..', 'workspace-storage') },
  extensionPath: __dirname,
  extension: { packageJSON: { publisher: 'test-publisher', name: 'test-extension', version: '1.0.0' } },
  globalState: {
    get: () => ({}),
    update: () => Promise.resolve(),
    keys: () => [],
    setKeysForSync: () => undefined
  }
}) as unknown as vscode.ExtensionContext;

suite('Agent Plugin install parity with the CLI (repository scope)', function () {
  this.timeout(120_000);
  const built = new Map<'plugin' | 'mixed', CliBuiltPluginBundle>();
  let buildRoot: string;
  let sandbox: sinon.SinonSandbox;
  let root: string;

  suiteSetup(async () => {
    buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-parity-build-'));
    for (const kind of ['plugin', 'mixed'] as const) {
      const workDir = path.join(buildRoot, kind);
      fs.mkdirSync(workDir);
      built.set(kind, await buildPluginBundleWithCli(workDir, kind));
    }
  });

  suiteTeardown(() => {
    fs.rmSync(buildRoot, { recursive: true, force: true });
  });

  setup(() => {
    sandbox = sinon.createSandbox();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-parity-'));
  });

  teardown(() => {
    sandbox.restore();
    LockfileManager.resetInstance();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * Install with both deliveries, compare, then cross-uninstall.
   * @param kind - Bundle content.
   * @param mode - Commit mode.
   */
  const checkParity = async (kind: 'plugin' | 'mixed', mode: RepositoryCommitMode): Promise<void> => {
    const fixture = built.get(kind);
    assert.ok(fixture);
    const cliWorkspace = path.join(root, 'A');
    const extensionWorkspace = path.join(root, 'B');
    const home = path.join(root, 'home');
    const cliConfigA = path.join(root, 'cli-config-A');
    const cliConfigB = path.join(root, 'cli-config-B');
    for (const dir of [home, cliConfigA, cliConfigB]) {
      fs.mkdirSync(dir);
    }
    runGit(root, ['init', '-q', 'A']);
    runGit(root, ['init', '-q', 'B']);

    // CLI install into A.
    await runBuiltCliOk(['target', 'add', 'parity', '--type', 'vscode', '--scope', 'repository', '--workspace-root', cliWorkspace], { cwd: cliConfigA, home });
    await runBuiltCliOk(['install', '--from', fixture.unpackedDir, '--target', 'parity', '--commit-mode', mode], { cwd: cliConfigA, home });

    // Extension install into B.
    const folders = sandbox.stub(vscode.workspace, 'workspaceFolders').value([
      { uri: vscode.Uri.file(extensionWorkspace), name: 'B', index: 0 }
    ]);
    LockfileManager.resetInstance();
    const installer = new BundleInstaller(createContext(path.join(root, 'extension', 'global')), 'vscode');
    const bundle: Bundle = {
      id: DEMO_PLUGIN_ID,
      name: 'demo-plugin',
      version: '1.0.0',
      description: 'Demo plugin bundle',
      author: 'Test',
      sourceId: `local-${path.basename(fixture.unpackedDir)}`,
      environments: ['vscode'],
      tags: [],
      lastUpdated: '2026-01-01T00:00:00Z',
      size: '1KB',
      dependencies: [],
      license: 'MIT',
      downloadUrl: '',
      manifestUrl: ''
    };
    await installer.installFromBuffer(bundle, fs.readFileSync(fixture.zipPath), { scope: 'repository', commitMode: mode }, 'local');

    assert.deepStrictEqual(workspaceFiles(extensionWorkspace), workspaceFiles(cliWorkspace), 'installed files');
    assert.strictEqual(comparableEntry(extensionWorkspace, mode), comparableEntry(cliWorkspace, mode), 'lockfile bundle entry');
    assert.deepStrictEqual(excludeSection(extensionWorkspace), excludeSection(cliWorkspace), 'git exclude section');

    // The extension uninstalls what the CLI installed in A.
    folders.value([{ uri: vscode.Uri.file(cliWorkspace), name: 'A', index: 0 }]);
    LockfileManager.resetInstance();
    const records = await LockfileManager.getInstance(cliWorkspace).getInstalledBundles();
    const record = records.find((r) => r.bundleId === DEMO_PLUGIN_ID);
    assert.ok(record, 'the extension reads the CLI install');
    assert.strictEqual(record.filesMissing, false, 'the CLI install shows no missing file');
    await installer.uninstall(record);
    assertUninstalled(cliWorkspace, 'extension uninstall of the CLI install');

    // The CLI uninstalls what the extension installed in B.
    await runBuiltCliOk(['target', 'add', 'parity', '--type', 'vscode', '--scope', 'repository', '--workspace-root', extensionWorkspace], { cwd: cliConfigB, home });
    await runBuiltCliOk(['uninstall', '--bundle', DEMO_PLUGIN_ID, '--target', 'parity'], { cwd: cliConfigB, home });
    assertUninstalled(extensionWorkspace, 'CLI uninstall of the extension install');
  };

  for (const kind of ['plugin', 'mixed'] as const) {
    for (const mode of ['commit', 'local-only'] as const) {
      test(`${kind} bundle, ${mode}: same files, entry and exclusions; each delivery uninstalls the other's install`, () => checkParity(kind, mode));
    }
  }
});
