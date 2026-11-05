/**
 * BundleInstaller Repository Scope Unit Tests
 *
 * Install, reinstall, update and uninstall at repository scope through the
 * real services: the workspace files, the lockfile, the MCP configuration
 * and the bundle cache are observed on disk.
 *
 * Requirements covered:
 * - 1.1-1.8: Repository-Level Installation as Default
 * - 8.3-8.4: Update Detection Across Scopes
 */
import * as assert from 'node:assert';
import {
  createHash,
} from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  BundleInstaller,
} from '../../src/services/bundle-installer';
import {
  LocalModificationWarningService,
} from '../../src/services/local-modification-warning-service';
import {
  LockfileManager,
} from '../../src/services/lockfile-manager';
import {
  Bundle,
  InstallOptions,
} from '../../src/types/registry';
import {
  DEMO_PLUGIN_ID,
  PluginBundleKind,
  PluginBundleZipOptions,
  writePluginBundleZip,
} from '../helpers/plugin-bundle-fixtures';

const POSIX = process.platform !== 'win32';

/**
 * Every file below a directory with its sha256, sorted; `[]` when absent.
 * @param dir - Directory.
 */
const treeOf = (dir: string): string[] => {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const facts: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        facts.push(`${path.relative(dir, full).split(path.sep).join('/')} ${createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
      }
    }
  };
  walk(dir);
  return facts.toSorted();
};

suite('BundleInstaller - Repository Scope', () => {
  let sandbox: sinon.SinonSandbox;
  let root: string;
  let workspaceRoot: string;
  let globalStorage: string;
  let context: vscode.ExtensionContext;
  let workspaceFolders: sinon.SinonStub;

  const bundleOf = (version = '1.0.0', overrides: Partial<Bundle> = {}): Bundle => ({
    id: DEMO_PLUGIN_ID,
    name: 'Demo Plugin',
    version,
    description: 'Demo plugin bundle',
    author: 'Test',
    sourceId: 'local-demo',
    environments: ['vscode'],
    tags: [],
    lastUpdated: '2026-01-01T00:00:00Z',
    size: '1KB',
    dependencies: [],
    license: 'MIT',
    downloadUrl: 'https://example.com/demo-plugin.zip',
    manifestUrl: 'https://example.com/deployment-manifest.yml',
    ...overrides
  });

  const zipOf = (kind: PluginBundleKind, opts: PluginBundleZipOptions = {}): Buffer => writePluginBundleZip(root, kind, opts).bytes;

  const repository = (overrides: Partial<InstallOptions> = {}): InstallOptions => ({ scope: 'repository', commitMode: 'commit', ...overrides });

  const bundlesDir = (): string => path.join(globalStorage, 'bundles');

  const cacheSiblings = (): string[] => (fs.existsSync(bundlesDir())
    ? fs.readdirSync(bundlesDir()).filter((name) => name.startsWith(`${DEMO_PLUGIN_ID}.`))
    : []);

  const readLockfile = (): { bundles: Record<string, { version: string; files: { path: string }[] }>; sources: Record<string, { type: string; url: string }> } | undefined => {
    const file = path.join(workspaceRoot, 'prompt-registry.lock.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
  };

  /** Act as a Kiro host: BundleInstaller target and the MCP host detection. */
  const kiroInstaller = (): BundleInstaller => {
    sandbox.stub(vscode.env, 'appName').value('Kiro');
    sandbox.stub(vscode.env, 'uriScheme').value('kiro');
    return new BundleInstaller(context, 'kiro');
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-installer-repo-'));
    workspaceRoot = path.join(root, 'workspace');
    globalStorage = path.join(root, 'global');
    fs.mkdirSync(workspaceRoot);
    context = {
      globalStorageUri: { fsPath: globalStorage },
      storageUri: { fsPath: path.join(root, 'workspace-storage') },
      extensionPath: __dirname,
      extension: { packageJSON: { publisher: 'test-publisher', name: 'test-extension', version: '1.0.0' } },
      globalState: {
        get: sandbox.stub().returns({}),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      }
    } as unknown as vscode.ExtensionContext;
    workspaceFolders = sandbox.stub(vscode.workspace, 'workspaceFolders').value([
      { uri: vscode.Uri.file(workspaceRoot), name: 'workspace', index: 0 }
    ]);
    LockfileManager.resetInstance();
  });

  teardown(() => {
    sandbox.restore();
    LockfileManager.resetInstance();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('installs a spec-compliant plugin into .github/plugins/<name>/ and uninstalls it completely', async () => {
    const installer = new BundleInstaller(context, 'vscode');

    const installed = await installer.installFromBuffer(bundleOf(), zipOf('plugin'), repository(), 'local');

    const pluginDir = path.join(workspaceRoot, '.github', 'plugins', DEMO_PLUGIN_ID);
    assert.deepStrictEqual(treeOf(pluginDir).map((fact) => fact.split(' ')[0]), [
      'mcp.json', 'plugin.json', 'scripts/run.sh', 'skills/helper/SKILL.md'
    ]);
    if (POSIX) {
      // eslint-disable-next-line no-bitwise -- owner execute bit
      assert.ok((fs.statSync(path.join(pluginDir, 'scripts', 'run.sh')).mode & 0o100) !== 0, 'run.sh is executable');
    }

    await installer.uninstall(installed);

    assert.deepStrictEqual(treeOf(workspaceRoot), [], 'no file remains in the workspace');
    assert.ok(!fs.existsSync(pluginDir), 'no plugin directory remains');
    assert.strictEqual(readLockfile(), undefined, 'the lockfile is removed');
  });

  test('installs a skills-source bundle at repository scope through the shared install', async () => {
    const zip = new AdmZip();
    zip.addFile('deployment-manifest.yml', Buffer.from(`id: ${DEMO_PLUGIN_ID}\nversion: 1.0.0\nname: Demo\nprompts:\n  - id: my-skill\n    file: skills/my-skill/SKILL.md\n    type: skill\n`));
    zip.addFile('skills/my-skill/SKILL.md', Buffer.from('---\nname: my-skill\ndescription: Mine\n---\n'));
    const installer = new BundleInstaller(context, 'vscode');

    await installer.installFromBuffer(bundleOf(), zip.toBuffer(), repository(), 'skills');

    assert.ok(fs.existsSync(path.join(workspaceRoot, '.github', 'skills', 'my-skill', 'SKILL.md')));
    assert.deepStrictEqual(readLockfile()?.bundles[DEMO_PLUGIN_ID].files.map((f) => f.path), ['skills/my-skill/SKILL.md']);
  });

  test('a Kiro host rejects a plugin bundle and leaves no file, MCP configuration or cache', async () => {
    const installer = kiroInstaller();

    await assert.rejects(
      installer.installFromBuffer(bundleOf(), zipOf('plugin', { withMcpServers: true }), repository(), 'local'),
      (error: Error & { code?: string; unsupported?: unknown[] }) => {
        assert.strictEqual(error.code, 'BUNDLE.UNSUPPORTED_CONTENT');
        assert.ok(error.message.startsWith('Cannot install "Demo Plugin" on kiro (repository scope): '), error.message);
        assert.ok(Array.isArray(error.unsupported));
        return true;
      }
    );

    assert.deepStrictEqual(fs.readdirSync(workspaceRoot), [], 'no file, MCP configuration or lockfile in the workspace');
    assert.ok(!fs.existsSync(path.join(bundlesDir(), DEMO_PLUGIN_ID)), 'no bundle cache');
    assert.deepStrictEqual(cacheSiblings(), [], 'no staging directory');
  });

  test('a rejected reinstall keeps the installed version, its entry and its cache', async () => {
    const installer = kiroInstaller();
    await installer.installFromBuffer(bundleOf(), zipOf('prompt'), repository(), 'local');
    const cacheBefore = treeOf(path.join(bundlesDir(), DEMO_PLUGIN_ID));
    const lockfileBefore = readLockfile();
    const workspaceBefore = treeOf(workspaceRoot);

    await assert.rejects(
      installer.installFromBuffer(bundleOf('2.0.0'), zipOf('mixed', { version: '2.0.0' }), repository({ force: true }), 'local'),
      { code: 'BUNDLE.UNSUPPORTED_CONTENT' }
    );

    assert.deepStrictEqual(treeOf(path.join(bundlesDir(), DEMO_PLUGIN_ID)), cacheBefore, 'the cache of the installed version is unchanged');
    assert.deepStrictEqual(readLockfile(), lockfileBefore, 'the lockfile is unchanged');
    assert.deepStrictEqual(treeOf(workspaceRoot), workspaceBefore, 'the installed files are unchanged');
    assert.deepStrictEqual(cacheSiblings(), []);
  });

  test('a rejected repository update keeps the installed version, its entry, its MCP servers and its cache', async () => {
    const installer = kiroInstaller();
    const installed = await installer.installFromBuffer(bundleOf(), zipOf('prompt', { withMcpServers: true }), repository(), 'local');
    const mcpConfig = path.join(workspaceRoot, '.kiro', 'settings', 'mcp.json');
    assert.ok(fs.existsSync(mcpConfig), 'the MCP server of v1 is configured');
    const workspaceBefore = treeOf(workspaceRoot);
    const cacheBefore = treeOf(path.join(bundlesDir(), DEMO_PLUGIN_ID));
    const lockfileBefore = readLockfile();

    await assert.rejects(
      installer.update(installed, bundleOf('2.0.0'), zipOf('mixed', { version: '2.0.0', withMcpServers: true }), 'local'),
      { code: 'BUNDLE.UNSUPPORTED_CONTENT' }
    );

    assert.deepStrictEqual(treeOf(workspaceRoot), workspaceBefore, 'v1 files and MCP configuration are unchanged');
    assert.deepStrictEqual(readLockfile(), lockfileBefore, 'the v1 entry is unchanged');
    assert.deepStrictEqual(treeOf(path.join(bundlesDir(), DEMO_PLUGIN_ID)), cacheBefore, 'the v1 cache is unchanged');
    assert.deepStrictEqual(cacheSiblings(), []);
  });

  test('a successful reinstall replaces the cache and leaves no staging or old directory', async () => {
    const installer = new BundleInstaller(context, 'vscode');
    await installer.installFromBuffer(bundleOf(), zipOf('prompt'), repository(), 'local');
    const cacheBefore = treeOf(path.join(bundlesDir(), DEMO_PLUGIN_ID));

    await installer.installFromBuffer(bundleOf('2.0.0'), zipOf('mixed', { version: '2.0.0' }), repository({ force: true }), 'local');

    const cacheAfter = treeOf(path.join(bundlesDir(), DEMO_PLUGIN_ID));
    assert.notDeepStrictEqual(cacheAfter, cacheBefore);
    assert.ok(cacheAfter.some((fact) => fact.startsWith('plugins/demo-plugin/plugin.json ')), 'the cache holds v2');
    assert.deepStrictEqual(cacheSiblings(), [], 'no .staging-* or .old-* directory');
    assert.strictEqual(readLockfile()?.bundles[DEMO_PLUGIN_ID].version, '2.0.0');
  });

  test('records a non-empty source URL when the bundle has no download or manifest URL', async () => {
    const installer = new BundleInstaller(context, 'vscode');

    await installer.installFromBuffer(bundleOf('1.0.0', { downloadUrl: '', manifestUrl: '' }), zipOf('prompt'), repository(), 'local');

    assert.deepStrictEqual(readLockfile()?.sources['local-demo'], { type: 'local', url: 'local:local-demo' });
  });

  test('a lockfile write failure fails the install and rolls back its files', async () => {
    sandbox.stub(LockfileManager.prototype, 'writeBundleEntry').rejects(new Error('disk full'));
    const installer = new BundleInstaller(context, 'vscode');

    await assert.rejects(installer.installFromBuffer(bundleOf(), zipOf('mixed'), repository(), 'local'), /disk full/);

    assert.deepStrictEqual(treeOf(workspaceRoot), [], 'no bundle file remains in the workspace');
  });

  test('a Kiro install then update reports no local modification', async () => {
    const installer = kiroInstaller();
    const warnings = new LocalModificationWarningService(LockfileManager.getInstance(workspaceRoot));
    const installed = await installer.installFromBuffer(bundleOf(), zipOf('prompt'), repository(), 'local');

    assert.deepStrictEqual(await warnings.checkForModifications(DEMO_PLUGIN_ID), []);

    await installer.update(installed, bundleOf('1.1.0'), zipOf('prompt', { version: '1.1.0' }), 'local');

    assert.deepStrictEqual(await warnings.checkForModifications(DEMO_PLUGIN_ID), []);
    assert.strictEqual(readLockfile()?.bundles[DEMO_PLUGIN_ID].version, '1.1.0');
  });

  test('throws when repository scope is requested without an open workspace', async () => {
    workspaceFolders.value(undefined);
    const installer = new BundleInstaller(context, 'vscode');

    await assert.rejects(
      installer.installFromBuffer(bundleOf(), zipOf('prompt'), repository(), 'local'),
      /Repository scope requires an open workspace/
    );
  });

  suite('MCP server names', () => {
    const mcpBundle = (): Bundle => bundleOf('1.0.0', {
      id: 'mirror-org-mirror-sample-mcp-1.0.0',
      repository: 'https://github.com/mirror-org/mirror'
    });

    const bundleZip = (repositoryLine: string): Buffer => {
      const zip = new AdmZip();
      zip.addFile('deployment-manifest.yml', Buffer.from(`
id: sample-mcp
version: 1.0.0
name: Sample MCP
description: Test
author: test
${repositoryLine}
prompts: []
mcpServers:
  gateway:
    type: http
    url: https://example.invalid/mcp
`));
      return zip.toBuffer();
    };

    const writtenServerNames = (): string[] => {
      const config = JSON.parse(fs.readFileSync(path.join(workspaceRoot, '.vscode', 'mcp.json'), 'utf8')) as { servers: Record<string, unknown> };
      return Object.keys(config.servers);
    };

    test('names servers after the repository in the deployment manifest, not the source they came from', async () => {
      const installer = new BundleInstaller(context, 'vscode');

      await installer.installFromBuffer(
        mcpBundle(), bundleZip('repository: https://github.com/acme-org/sample-collections'), repository(), 'github'
      );

      assert.deepStrictEqual(writtenServerNames(), ['ai-primitives-hub:acme-org:sample-collections:sample-mcp:gateway']);
    });

    test('uses the source repository when the deployment manifest has none', async () => {
      const installer = new BundleInstaller(context, 'vscode');

      await installer.installFromBuffer(mcpBundle(), bundleZip("repository: ''"), repository(), 'github');

      assert.deepStrictEqual(writtenServerNames(), ['ai-primitives-hub:mirror-org:mirror:sample-mcp:gateway']);
    });
  });
});
