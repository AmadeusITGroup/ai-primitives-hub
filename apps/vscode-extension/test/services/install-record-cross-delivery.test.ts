/**
 * Cross-delivery tests in both directions: the built CLI installs a local
 * bundle and the extension lists it; the extension installs it and the CLI
 * lists and uninstalls it. Real temp git folders, no network.
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import type {
  Bundle,
} from '../../src/types/registry';
import {
  createMockContext,
  initGitRoot,
  RECORD_FILE,
} from '../helpers/install-record-test-helpers';

const BUNDLE_ID = 'cross-delivery-bundle';

const BUNDLE_FILES: Record<string, string> = {
  'deployment-manifest.yml': `id: ${BUNDLE_ID}
version: 1.4.2
name: Cross Delivery Bundle
prompts:
  - id: hello
    file: prompts/hello.prompt.md
    type: prompt
  - id: style
    name: Style Rules
    file: instructions/style.instructions.md
    type: instructions
`,
  'prompts/hello.prompt.md': '# Hello Prompt\n',
  'instructions/style.instructions.md': '---\napplyTo: "**/*.ts"\n---\nUse strict TypeScript.\n'
};

/** Files the vscode writer installs for {@link BUNDLE_FILES}, root-relative. */
const INSTALLED_FILES = ['.github/prompts/hello.prompt.md', '.github/instructions/style.instructions.md'];

interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CliModules {
  runCommand: (argv: string[], options: Record<string, unknown>) => Promise<CliRunResult>;
  commandClasses: unknown[];
}

/** Load the built CLI from `packages/cli/dist`; the extension has no package dependency on it. */
const loadCli = (): CliModules => {
  let dir = __dirname;
  while (!fs.existsSync(path.join(dir, 'packages', 'cli', 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error('packages/cli not found above the test; build the monorepo packages first');
    }
    dir = parent;
  }
  const dist = path.join(dir, 'packages', 'cli', 'dist');
  const framework = require(path.join(dist, 'framework', 'index.js'));
  const install = require(path.join(dist, 'commands', 'install.js'));
  const targetAdd = require(path.join(dist, 'commands', 'target-add.js'));
  const status = require(path.join(dist, 'commands', 'status.js'));
  const uninstall = require(path.join(dist, 'commands', 'uninstall.js'));
  return {
    runCommand: framework.runCommand,
    commandClasses: [targetAdd.TargetAddCommand, install.InstallCommand, status.StatusCommand, uninstall.UninstallCommand]
  };
};

/**
 * A runner for the CLI in one folder, with an isolated home.
 * @param cli - Loaded CLI.
 * @param cwd - Working folder.
 * @param home - Home folder for the CLI's user config.
 */
const cliIn = (cli: CliModules, cwd: string, home: string) => async (argv: string[]): Promise<CliRunResult> => {
  const result = await cli.runCommand(argv, {
    commandClasses: cli.commandClasses,
    context: {
      cwd,
      fs: new NodeFileSystem(),
      env: {
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, 'xdg-config'),
        XDG_CACHE_HOME: path.join(home, 'xdg-cache')
      }
    }
  });
  assert.strictEqual(result.exitCode, 0, `ai-primitives-hub ${argv.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
};

/**
 * Create a temp root with a git repository and the fixture bundle folder.
 * @returns The realpath'd temp root, the repository root and the bundle folder.
 */
const createFixture = (): { tempRoot: string; root: string; bundleDir: string } => {
  const tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'install-record-cross-')));
  const root = path.join(tempRoot, 'repo');
  const bundleDir = path.join(tempRoot, 'bundle');
  fs.mkdirSync(root, { recursive: true });
  initGitRoot(root);
  for (const [relative, content] of Object.entries(BUNDLE_FILES)) {
    fs.mkdirSync(path.dirname(path.join(bundleDir, relative)), { recursive: true });
    fs.writeFileSync(path.join(bundleDir, relative), content);
  }
  return { tempRoot, root, bundleDir };
};

suite('Cross-delivery: CLI install record listed by the extension', function () {
  this.timeout(60_000);

  let sandbox: sinon.SinonSandbox;
  let tempRoot: string;
  let root: string;
  let bundleDir: string;
  let cli: CliModules;

  suiteSetup(() => {
    cli = loadCli();
  });

  setup(async () => {
    sandbox = sinon.createSandbox();
    ({ tempRoot, root, bundleDir } = createFixture());
    const runCli = cliIn(cli, root, path.join(tempRoot, 'home'));

    // The CLI writes the record: one bundle, installed for vscode, then kiro.
    for (const [name, type] of [['repo-vscode', 'vscode'], ['repo-kiro', 'kiro']]) {
      await runCli(['target', 'add', name, '--type', type, '--scope', 'repository', '--workspace-root', root, '-o', 'json']);
    }
    for (const target of ['repo-vscode', 'repo-kiro']) {
      const result = await runCli(['install', BUNDLE_ID, '--from', bundleDir, '--target', target, '-o', 'json']);
      assert.strictEqual(JSON.parse(result.stdout).data.lockfile, path.join(root, RECORD_FILE));
    }

    (RegistryManager as any).instance = undefined;
    const manager = RegistryManager.getInstance(createMockContext(sandbox));
    const storage = sandbox.createStubInstance(RegistryStorage);
    storage.getInstalledBundles.resolves([]);
    storage.getSources.resolves([]);
    (manager as any).storage = storage;
    const scopeSelectionUI = require('../../src/utils/scope-selection-ui');
    sandbox.stub(scopeSelectionUI, 'getWorkspaceRoot').returns(root);
    sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
  });

  teardown(() => {
    sandbox.restore();
    (RegistryManager as any).instance = undefined;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('the extension lists the bundle the CLI installed for vscode and kiro, with its version and scope', async () => {
    const items = await RegistryManager.getInstance().listInstalledBundles('repository');

    assert.deepStrictEqual(items.map(({ bundleId, version, scope, recordOrigin }) => ({ bundleId, version, scope, recordOrigin })), [
      { bundleId: BUNDLE_ID, version: '1.4.2', scope: 'repository', recordOrigin: 'install-record' }
    ]);
  });
});

suite('Cross-delivery: extension install record read and removed by the CLI', function () {
  this.timeout(60_000);

  let sandbox: sinon.SinonSandbox;
  let tempRoot: string;
  let root: string;
  let bundleDir: string;
  let cli: CliModules;

  /**
   * Record bytes with the fields that differ per writer and per run replaced.
   * @param file - Record file.
   */
  const normalisedRecord = (file: string): string =>
    fs.readFileSync(file, 'utf8').replaceAll(/"(generatedBy|generatedAt|installedAt)": "[^"]*"/g, '"$1": "<normalised>"');

  /** Zip the fixture bundle folder, as a source adapter hands it to the installer. */
  const bundleZip = (): Buffer => {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    for (const [relative, content] of Object.entries(BUNDLE_FILES)) {
      zip.addFile(relative, Buffer.from(content));
    }
    return zip.toBuffer();
  };

  suiteSetup(() => {
    cli = loadCli();
  });

  setup(async () => {
    sandbox = sinon.createSandbox();
    ({ tempRoot, root, bundleDir } = createFixture());

    (RegistryManager as any).instance = undefined;
    const manager = RegistryManager.getInstance({
      ...createMockContext(sandbox),
      globalStorageUri: vscode.Uri.file(path.join(tempRoot, 'global'))
    });
    const storage = sandbox.createStubInstance(RegistryStorage);
    storage.getInstalledBundles.resolves([]);
    // The configured source matching the CLI's `--from <bundleDir>` source.
    storage.getSources.resolves([
      { id: `local-${path.basename(bundleDir)}`, name: 'Local bundle', type: 'local', url: bundleDir, enabled: true, priority: 0 }
    ] as any);
    (manager as any).storage = storage;
    const scopeSelectionUI = require('../../src/utils/scope-selection-ui');
    sandbox.stub(scopeSelectionUI, 'getWorkspaceRoot').returns(root);
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: vscode.Uri.file(root), name: 'repo', index: 0 }]);
    sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
    sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);

    // The extension writes the record: one bundle, installed for vscode.
    const bundle = {
      id: BUNDLE_ID, name: 'Cross Delivery Bundle', version: '1.4.2', description: '', author: '', sourceId: `local-${path.basename(bundleDir)}`,
      environments: [], tags: [], lastUpdated: '', size: '', dependencies: [], license: '', manifestUrl: '', downloadUrl: ''
    } as Bundle;
    await manager.getBundleInstaller().installFromBuffer(bundle, bundleZip(), { scope: 'repository', commitMode: 'commit' }, 'local');
  });

  teardown(() => {
    sandbox.restore();
    (RegistryManager as any).instance = undefined;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('the CLI lists the bundle the extension installed for vscode and uninstalls it with its files; the record matches the CLI\'s', async () => {
    // The same install by the CLI, from the same source, in another repository.
    const cliRoot = path.join(tempRoot, 'cli-repo');
    fs.mkdirSync(cliRoot, { recursive: true });
    initGitRoot(cliRoot);
    const home = path.join(tempRoot, 'home');
    const runCliRef = cliIn(cli, cliRoot, home);
    await runCliRef(['target', 'add', 'cli-vscode', '--type', 'vscode', '--scope', 'repository', '--workspace-root', cliRoot, '-o', 'json']);
    await runCliRef(['install', BUNDLE_ID, '--from', bundleDir, '--target', 'cli-vscode', '-o', 'json']);
    assert.strictEqual(normalisedRecord(path.join(root, RECORD_FILE)), normalisedRecord(path.join(cliRoot, RECORD_FILE)));

    const runCli = cliIn(cli, root, home);
    await runCli(['target', 'add', 'repo-vscode', '--type', 'vscode', '--scope', 'repository', '--workspace-root', root, '-o', 'json']);
    const status = JSON.parse((await runCli(['status', '-o', 'json'])).stdout).data;
    assert.deepStrictEqual(status.entries.map(({ bundleId, tool, version }: Record<string, string>) => ({ bundleId, tool, version })), [
      { bundleId: BUNDLE_ID, tool: 'vscode', version: '1.4.2' }
    ]);
    for (const file of INSTALLED_FILES) {
      assert.ok(fs.existsSync(path.join(root, ...file.split('/'))), `${file} installed`);
    }

    await runCli(['uninstall', '--bundle', BUNDLE_ID, '--target', 'repo-vscode', '-o', 'json']);

    assert.ok(!fs.existsSync(path.join(root, RECORD_FILE)), 'the emptied record is removed');
    for (const file of INSTALLED_FILES) {
      assert.ok(!fs.existsSync(path.join(root, ...file.split('/'))), `${file} removed`);
    }
  });
});
