/**
 * Cross-delivery test: CLI writes, extension lists (BR5.3, NFR2 — CLI → extension direction).
 *
 * Runs the real `ai-primitives-hub` CLI `target add` and `install` command
 * implementations (the built `@ai-primitives-hub/cli` package, loaded from
 * `packages/cli/dist`) against a real temp git folder, installing one local
 * fixture bundle (one prompt, one instruction) for `vscode` and `kiro` at
 * repository scope. The extension's `RegistryManager.listInstalledBundles`
 * then reads the same folder and must show the bundle with the recorded
 * version and repository scope. No network.
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
  LockfileManager,
} from '../../src/services/lockfile-manager';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
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

interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CliModules {
  runCommand: (argv: string[], options: Record<string, unknown>) => Promise<CliRunResult>;
  commandClasses: unknown[];
}

/**
 * Load the built CLI command implementations from `packages/cli/dist`.
 * The extension has no package dependency on the CLI, so the test resolves
 * the monorepo package by walking up from this file.
 */
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
  return { runCommand: framework.runCommand, commandClasses: [targetAdd.TargetAddCommand, install.InstallCommand] };
};

suite('Cross-delivery: CLI install record listed by the extension', function () {
  this.timeout(60_000);

  let sandbox: sinon.SinonSandbox;
  let tempRoot: string;
  let root: string;
  let bundleDir: string;
  let cli: CliModules;

  const runCli = async (argv: string[]): Promise<CliRunResult> => {
    const home = path.join(tempRoot, 'home');
    const result = await cli.runCommand(argv, {
      commandClasses: cli.commandClasses,
      context: {
        cwd: root,
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

  suiteSetup(() => {
    cli = loadCli();
  });

  setup(async () => {
    sandbox = sinon.createSandbox();
    tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'install-record-cross-')));
    root = path.join(tempRoot, 'repo');
    bundleDir = path.join(tempRoot, 'bundle');
    fs.mkdirSync(root, { recursive: true });
    initGitRoot(root);
    for (const [relative, content] of Object.entries(BUNDLE_FILES)) {
      fs.mkdirSync(path.dirname(path.join(bundleDir, relative)), { recursive: true });
      fs.writeFileSync(path.join(bundleDir, relative), content);
    }

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
    LockfileManager.resetInstance();
  });

  teardown(() => {
    sandbox.restore();
    LockfileManager.resetInstance();
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
