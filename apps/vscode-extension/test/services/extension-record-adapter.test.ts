/**
 * Extension record adapter: the extension, as the `vscode` host, installs,
 * updates, uninstalls and switches a repository bundle against a real temp
 * git root. Only `vscode.window`, the workspace lookup and `RegistryStorage` are stubbed.
 *
 * The user record suite installs a user-scope bundle into a temp `HOME`;
 * `XDG_CONFIG_HOME` is a per-test temp folder, so the real user record is never touched.
 *
 * The older-records suite checks that a write migrates old lockfiles and
 * profile installs first, and how a migrated `unknown` entry is handled.
 */
import * as assert from 'node:assert';
import {
  createHash,
} from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  pathToFileURL,
} from 'node:url';
import {
  resolveUserConfigPaths,
} from '@ai-primitives-hub/app';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  BundleScopeCommands,
} from '../../src/commands/bundle-scope-commands';
import type {
  BundleInstaller,
} from '../../src/services/bundle-installer';
import {
  ExtensionRecordAdapter,
  MIGRATION_LOG_PREFIX,
} from '../../src/services/extension-record-adapter';
import {
  HubManager,
} from '../../src/services/hub-manager';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  ScopeConflictResolver,
} from '../../src/services/scope-conflict-resolver';
import {
  HubStorage,
} from '../../src/storage/hub-storage';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  VsCodeAppStorage,
} from '../../src/storage/vscode-app-storage';
import type {
  Bundle,
  InstalledBundle,
  RegistrySource,
  RepositoryCommitMode,
} from '../../src/types/registry';
import {
  findUserRecordBundle,
  getInstalledBundleForScope,
} from '../../src/utils/bundle-scope-utils';
import {
  Logger,
} from '../../src/utils/logger';
import {
  createMockContext,
  initGitRoot,
  isOnDisk,
  LOCAL_RECORD_FILE,
  overrideEnv,
  RECORD_FILE,
  recordEntry,
  recordProfileInstall,
  setupUserRecordManager,
  snapshotTree,
  testBundle,
  writeOldEntry,
  writeOldLockfile,
} from '../helpers/install-record-test-helpers';

const BUNDLE_ID = 'record-bundle';
const OLD_LOCKFILE = 'prompt-registry.lock.json';
const HELLO = '.github/prompts/hello.prompt.md';
const STYLE = '.github/instructions/style.instructions.md';
const SOURCE = { id: 'acme-github', name: 'Acme', type: 'github', url: 'https://github.com/acme/tools', enabled: true, priority: 0 };

/** A bundle version: its bundle-relative files and manifest items. */
interface BundleVersion {
  version: string;
  files: Record<string, string>;
  items: { id: string; file: string; type: string }[];
}

/** 1.0.0 writes a prompt and an instruction. */
const V1: BundleVersion = {
  version: '1.0.0',
  files: { 'prompts/hello.prompt.md': '# Hello 1.0.0\n', 'instructions/style.instructions.md': 'Use strict TypeScript.\n' },
  items: [{ id: 'hello', file: 'prompts/hello.prompt.md', type: 'prompt' }, { id: 'style', file: 'instructions/style.instructions.md', type: 'instructions' }]
};

/** 1.1.0 changes the prompt and drops the instruction. */
const V2: BundleVersion = {
  version: '1.1.0',
  files: { 'prompts/hello.prompt.md': '# Hello 1.1.0\n' },
  items: [{ id: 'hello', file: 'prompts/hello.prompt.md', type: 'prompt' }]
};

const sha256 = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`;

const manifestOf = (bundle: BundleVersion, bundleId = BUNDLE_ID): string => {
  const prompts = bundle.items.map((item) => `  - id: ${item.id}\n    file: ${item.file}\n    type: ${item.type}\n`).join('');
  return `id: ${bundleId}\nversion: ${bundle.version}\nname: Record Bundle\ndescription: Test\nauthor: test\nprompts:\n${prompts}`;
};

const zipOf = (bundle: BundleVersion, bundleId = BUNDLE_ID): Buffer => {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile('deployment-manifest.yml', Buffer.from(manifestOf(bundle, bundleId)));
  for (const [file, content] of Object.entries(bundle.files)) {
    zip.addFile(file, Buffer.from(content));
  }
  return zip.toBuffer();
};

const writeBundleDir = (dir: string, bundle: BundleVersion, bundleId = BUNDLE_ID): void => {
  for (const [file, content] of Object.entries({ 'deployment-manifest.yml': manifestOf(bundle, bundleId), ...bundle.files })) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
};

const bundleOf = (version: string, sourceId = SOURCE.id): Bundle =>
  testBundle({ id: BUNDLE_ID, name: 'Record Bundle', version, description: 'Test', author: 'test', sourceId, license: 'MIT' });

suite('ExtensionRecordAdapter: repository installs through the extension', function () {
  this.timeout(20_000);

  let sandbox: sinon.SinonSandbox;
  let tempRoot: string;
  let root: string;
  let manager: RegistryManager;
  let installer: BundleInstaller;
  let showError: sinon.SinonStub;
  let showInfo: sinon.SinonStub;
  let showWarning: sinon.SinonStub;

  const abs = (relative: string): string => path.join(root, ...relative.split('/'));
  const read = (relative: string): string => fs.readFileSync(abs(relative), 'utf8');
  const readRecord = (file: string = RECORD_FILE): any => fs.existsSync(abs(file)) ? JSON.parse(read(file)) : null;
  const toolsOf = (file: string = RECORD_FILE, bundleId = BUNDLE_ID): Record<string, any> => readRecord(file)?.bundles[bundleId]?.tools ?? {};

  const install = (bundle: BundleVersion, options: { commitMode?: RepositoryCommitMode; sourceId?: string } = {}): Promise<InstalledBundle> =>
    installer.installFromBuffer(bundleOf(bundle.version, options.sourceId), zipOf(bundle), { scope: 'repository', commitMode: options.commitMode ?? 'commit' }, 'github');

  const listed = async (): Promise<InstalledBundle> => {
    const item = (await manager.listInstalledBundles('repository')).find((bundle) => bundle.bundleId === BUNDLE_ID);
    assert.ok(item, `${BUNDLE_ID} is listed`);
    return item;
  };

  const update = async (bundle: BundleVersion): Promise<void> => {
    await installer.update(await listed(), bundleOf(bundle.version), zipOf(bundle), 'github');
  };

  // Record another tool's entry in the committed record file, as that tool's own install would.
  const recordOtherTool = (tool: string, files: string[], bundleId = BUNDLE_ID): Promise<void> =>
    recordEntry(manager.getRecordAdapter(), root, { bundleId, tool, files, content: `# ${tool}\n`, keepExisting: true });

  setup(() => {
    sandbox = sinon.createSandbox();
    tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'extension-record-')));
    root = path.join(tempRoot, 'repo');
    fs.mkdirSync(root, { recursive: true });
    initGitRoot(root);

    (RegistryManager as any).instance = undefined;
    manager = RegistryManager.getInstance({
      ...createMockContext(sandbox),
      globalStorageUri: vscode.Uri.file(path.join(tempRoot, 'global'))
    });
    const storage = sandbox.createStubInstance(RegistryStorage);
    storage.getSources.resolves([SOURCE] as any);
    storage.getInstalledBundles.resolves([]);
    storage.getInstalledBundle.resolves(undefined);
    storage.getCachedSourceBundles.resolves([]);
    (manager as any).storage = storage;
    installer = manager.getBundleInstaller();

    const scopeSelectionUI = require('../../src/utils/scope-selection-ui');
    sandbox.stub(scopeSelectionUI, 'getWorkspaceRoot').returns(root);
    sandbox.stub(scopeSelectionUI, 'hasOpenWorkspace').returns(true);
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: vscode.Uri.file(root), name: 'repo', index: 0 }]);
    showError = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    showInfo = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    showWarning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
  });

  teardown(() => {
    sandbox.restore();
    (RegistryManager as any).instance = undefined;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('install records the vscode entry with the written files and the configured source', async () => {
    await install(V1);

    const record = readRecord();
    const { installedAt, ...entry } = record.bundles[BUNDLE_ID].tools.vscode;
    assert.deepStrictEqual(Object.keys(record.bundles[BUNDLE_ID].tools), ['vscode']);
    assert.ok(!Number.isNaN(Date.parse(installedAt)));
    assert.deepStrictEqual(entry, {
      version: '1.0.0',
      sourceId: SOURCE.id,
      sourceType: 'github',
      files: [
        { path: STYLE, checksum: sha256(V1.files['instructions/style.instructions.md']) },
        { path: HELLO, checksum: sha256(V1.files['prompts/hello.prompt.md']) }
      ]
    });
    assert.deepStrictEqual(record.sources[SOURCE.id], { type: 'github', url: SOURCE.url });
    assert.strictEqual(read(HELLO), V1.files['prompts/hello.prompt.md']);
  });

  test('install records the configured source with the fields the CLI records for its type', async () => {
    ((manager as any).storage.getSources as sinon.SinonStub).resolves([{
      ...SOURCE, config: { branch: 'main', collectionsPath: '', indexFile: 'index.json', authMode: 'bearer', credentialRef: 'ACME_TOKEN' }
    }]);

    await install(V1);

    assert.deepStrictEqual(readRecord().sources[SOURCE.id], { type: 'github', url: SOURCE.url, branch: 'main' });
  });

  const refusedInstalls: { name: string; arrange: () => void; sourceId?: string; expected: RegExp | { code: string }; errorShown: boolean }[] = [
    { name: 'an unconfigured source id', arrange: () => undefined, sourceId: 'not-configured', expected: /source not-configured is not configured/, errorShown: false },
    {
      name: 'a RECORD.MALFORMED record',
      arrange: () => fs.writeFileSync(abs(RECORD_FILE), '{ "version": '),
      expected: { code: 'RECORD.MALFORMED' },
      errorShown: true
    }
  ];

  refusedInstalls.forEach(({ name, arrange, sourceId, expected, errorShown }) => {
    test(`install with ${name} is refused before any file is written`, async () => {
      arrange();
      const before = snapshotTree(root);

      await assert.rejects(install(V1, { sourceId }), expected);

      assert.deepStrictEqual(snapshotTree(root), before);
      assert.ok(!fs.existsSync(path.join(tempRoot, 'global', 'bundles')), 'no bundle cache written');
      assert.strictEqual(showError.callCount, errorShown ? 1 : 0);
      if (errorShown) {
        assert.ok(String(showError.firstCall.args[0]).includes(RECORD_FILE), String(showError.firstCall.args[0]));
      }
    });
  });

  test('uninstall removes only the vscode entry; the kiro entry and its files stay byte-identical', async () => {
    await install(V1);
    await recordOtherTool('kiro', ['.kiro/steering/hello.md']);
    const kiroBefore = JSON.stringify(toolsOf().kiro);
    const kiroFile = read('.kiro/steering/hello.md');

    await manager.uninstallBundle(BUNDLE_ID, 'repository');

    assert.deepStrictEqual(Object.keys(toolsOf()), ['kiro']);
    assert.strictEqual(JSON.stringify(toolsOf().kiro), kiroBefore);
    assert.strictEqual(read('.kiro/steering/hello.md'), kiroFile);
    assert.ok(!fs.existsSync(abs(HELLO)) && !fs.existsSync(abs(STYLE)), 'vscode files deleted');
  });

  const modifiedFileCases: { action: string; run: () => Promise<void>; vscodeAfter: string[] | undefined }[] = [
    { action: 'uninstall', run: () => manager.uninstallBundle(BUNDLE_ID, 'repository'), vscodeAfter: undefined },
    { action: 'update', run: () => update(V2), vscodeAfter: [HELLO] },
    {
      action: 'update to another bundle id',
      run: async () => installer.update(await listed(), { ...bundleOf(V2.version), id: `${BUNDLE_ID}-next` }, zipOf(V2, `${BUNDLE_ID}-next`), 'github').then(() => undefined),
      vscodeAfter: undefined
    }
  ];

  modifiedFileCases.forEach(({ action, run, vscodeAfter }) => {
    test(`${action} keeps a locally modified file it would otherwise delete`, async () => {
      await install(V1);
      fs.writeFileSync(abs(STYLE), 'My own rules.\n');

      await run();

      assert.strictEqual(read(STYLE), 'My own rules.\n');
      assert.deepStrictEqual(toolsOf().vscode?.files.map((file: { path: string }) => file.path), vscodeAfter);
    });
  });

  test('update in place does not bring back a skill file the new version dropped', async () => {
    const skill = (version: string, files: Record<string, string>): BundleVersion => ({
      version, files, items: [{ id: 'demo', file: 'skills/demo/SKILL.md', type: 'skill' }]
    });
    const withScript = skill('1.0.0', { 'skills/demo/SKILL.md': '---\nname: demo\ndescription: Demo\n---\n', 'skills/demo/scripts/run.sh': 'echo 1\n' });
    await install(withScript);
    const script = (toolsOf().vscode?.files ?? []).map((file: { path: string }) => file.path).find((file: string) => file.endsWith('run.sh'));
    assert.ok(script !== undefined && fs.existsSync(abs(script)), 'the script is installed');

    await update(skill('1.1.0', { 'skills/demo/SKILL.md': '---\nname: demo\ndescription: Demo 1.1\n---\n' }));

    assert.ok(!fs.existsSync(abs(script)), 'the dropped script is not written again');
    assert.ok(!(toolsOf().vscode?.files ?? []).some((file: { path: string }) => file.path === script), 'nor recorded');
  });

  test('update in place moves a copilot-cli sibling to the new version and deletes its dropped file; a kiro sibling is reported out of date', async () => {
    await install(V1);
    await recordOtherTool('copilot-cli', [HELLO, STYLE]);
    await recordOtherTool('kiro', [HELLO]);
    const kiroBefore = toolsOf().kiro;

    await update(V2);

    const tools = toolsOf();
    assert.deepStrictEqual(Object.keys(tools).toSorted(), ['copilot-cli', 'kiro', 'vscode']);
    for (const tool of ['vscode', 'copilot-cli']) {
      assert.strictEqual(tools[tool].version, '1.1.0', tool);
      assert.deepStrictEqual(tools[tool].files, [{ path: HELLO, checksum: sha256(V2.files['prompts/hello.prompt.md']) }], tool);
    }
    assert.deepStrictEqual(tools.kiro, kiroBefore);
    assert.ok(!fs.existsSync(abs(STYLE)), 'the dropped file is deleted');
    assert.strictEqual(read(HELLO), V2.files['prompts/hello.prompt.md']);
    const message = String(showInfo.firstCall?.args[0]);
    assert.ok(showInfo.calledOnce && message.includes('kiro (1.0.0)') && message.includes('out of date'), message);
  });

  test('move to user installs the version the host tool has, not another tool\'s newer entry', async () => {
    await install(V1);
    await recordOtherTool('kiro', [HELLO]);
    const record = readRecord();
    Object.assign(record.bundles[BUNDLE_ID].tools.kiro, { version: '1.1.0', installedAt: '2099-01-01T00:00:00.000Z' });
    fs.writeFileSync(abs(RECORD_FILE), JSON.stringify(record));
    showWarning.resolves('Move');
    const installBundle = sandbox.stub(manager, 'installBundle').resolves(undefined);
    sandbox.stub(manager, 'uninstallBundle').resolves();
    const resolver = sandbox.createStubInstance(ScopeConflictResolver);
    resolver.migrateBundle.callsFake(async (bundleId, fromScope, toScope, uninstall, reinstall) => {
      await uninstall({} as InstalledBundle);
      await reinstall({} as InstalledBundle, toScope);
      return { success: true, bundleId, fromScope, toScope };
    });
    const repositoryScopeService = installer.createRepositoryScopeService();
    assert.ok(repositoryScopeService);

    await new BundleScopeCommands(manager, resolver, repositoryScopeService).moveToUser(BUNDLE_ID);

    assert.deepStrictEqual(installBundle.firstCall?.args[1], { scope: 'user', version: '1.0.0' });
  });

  test('commit-mode switch moves the entry unchanged to the local-only file and excludes only paths no committed entry lists', async () => {
    await install(V1);
    await recordOtherTool('copilot-cli', [HELLO]);
    fs.writeFileSync(abs(STYLE), 'My own rules.\n');
    const vscodeBefore = toolsOf().vscode;
    showWarning.resolves('Switch');
    const repositoryScopeService = installer.createRepositoryScopeService();
    assert.ok(repositoryScopeService);

    await new BundleScopeCommands(manager, sandbox.createStubInstance(ScopeConflictResolver), repositoryScopeService)
      .switchCommitMode(BUNDLE_ID, 'local-only');

    assert.deepStrictEqual(toolsOf(LOCAL_RECORD_FILE).vscode, vscodeBefore, 'moved unchanged, modified file checksum included');
    assert.deepStrictEqual(Object.keys(toolsOf()), ['copilot-cli']);
    const exclude = read('.git/info/exclude').split('\n');
    assert.ok(exclude.includes(STYLE), exclude.join('\n'));
    assert.ok(!exclude.includes(HELLO), exclude.join('\n'));
  });

  suite('one version per bundle and tool', () => {
    const COLL = 'acme-tools-coll';
    const OLD_ONLY = '.github/prompts/old.prompt.md';

    /**
     * A version of the versioned-id bundle: the shared prompt and one prompt of its own.
     * @param version
     * @param own
     */
    const versionOf = (version: string, own: 'old' | 'new'): BundleVersion => ({
      version,
      files: { 'prompts/hello.prompt.md': `# Hello ${version}\n`, [`prompts/${own}.prompt.md`]: `# ${own} ${version}\n` },
      items: [{ id: 'hello', file: 'prompts/hello.prompt.md', type: 'prompt' }, { id: own, file: `prompts/${own}.prompt.md`, type: 'prompt' }]
    });

    const installVersion = (bundle: BundleVersion, commitMode: RepositoryCommitMode = 'commit'): Promise<InstalledBundle> =>
      installer.installFromBuffer(
        { ...bundleOf(bundle.version), id: `${COLL}-${bundle.version}` },
        zipOf(bundle, `${COLL}-${bundle.version}`),
        { scope: 'repository', commitMode },
        'github'
      );

    /**
     * `<key> <tool> <version>` for every entry of a record file, sorted.
     * @param file
     */
    const entriesIn = (file: string): string[] => Object.entries(readRecord(file)?.bundles ?? {})
      .flatMap(([key, bundle]: [string, any]) => Object.entries(bundle.tools).map(([tool, entry]: [string, any]) => `${key} ${tool} ${entry.version}`))
      .toSorted();

    const listedVersions = async (): Promise<string[]> => (await manager.listInstalledBundles('repository'))
      .filter((item) => item.bundleId.startsWith(COLL))
      .map((item) => `${item.bundleId} ${item.version}`);

    [
      { name: 'upgrade', from: '1.0.0', to: '2.0.0' },
      { name: 'downgrade', from: '2.0.0', to: '1.0.0' }
    ].forEach(({ name, from, to }) => {
      test(`${name} by installing another version leaves one vscode entry, one listed item and no file only the old version wrote`, async () => {
        await installVersion(versionOf(from, 'old'));

        await installVersion(versionOf(to, 'new'));

        assert.deepStrictEqual(entriesIn(RECORD_FILE), [`${COLL}-${to} vscode ${to}`]);
        assert.deepStrictEqual(await listedVersions(), [`${COLL}-${to} ${to}`]);
        assert.ok(!fs.existsSync(abs(OLD_ONLY)), 'the old version\'s own file is deleted');
        assert.strictEqual(read(HELLO), `# Hello ${to}\n`);
      });
    });

    test('installing another version keeps a locally modified file only the old version wrote', async () => {
      await installVersion(versionOf('1.0.0', 'old'));
      fs.writeFileSync(abs(OLD_ONLY), 'My own prompt.\n');

      await installVersion(versionOf('2.0.0', 'new'));

      assert.strictEqual(read(OLD_ONLY), 'My own prompt.\n');
      assert.deepStrictEqual(entriesIn(RECORD_FILE), [`${COLL}-2.0.0 vscode 2.0.0`]);
    });

    test('update in place to the next versioned id leaves one vscode entry and deletes the old version\'s own file', async () => {
      await installVersion(versionOf('1.0.0', 'old'));
      const installed = (await manager.listInstalledBundles('repository')).find((item) => item.bundleId === `${COLL}-1.0.0`);
      assert.ok(installed);
      const next = versionOf('2.0.0', 'new');

      await installer.update(installed, { ...bundleOf(next.version), id: `${COLL}-2.0.0` }, zipOf(next, `${COLL}-2.0.0`), 'github');

      assert.deepStrictEqual(entriesIn(RECORD_FILE), [`${COLL}-2.0.0 vscode 2.0.0`]);
      assert.ok(!fs.existsSync(abs(OLD_ONLY)), 'the old version\'s own file is deleted');
      assert.ok(showError.notCalled, String(showError.firstCall?.args[0]));
    });

    test('installing another version retires the old prompt-registry entry of the old version and its unmodified file', async () => {
      await writeOldEntry(root, `${COLL}-1.0.0`, { files: { '.github/prompts/legacy.prompt.md': 'old content' } });

      await installVersion(versionOf('2.0.0', 'new'));

      assert.ok(!fs.existsSync(abs(OLD_LOCKFILE)), 'the emptied old file is removed');
      assert.ok(!fs.existsSync(abs('.github/prompts/legacy.prompt.md')), 'the old file is deleted');
      assert.deepStrictEqual(await listedVersions(), [`${COLL}-2.0.0 2.0.0`]);
    });

    test('commit-mode switch replaces an older version held under its own key in the target file', async () => {
      // A committed 1.0.0 entry next to a local-only 2.0.0 one, as after a merge of a teammate's record.
      await recordEntry(manager.getRecordAdapter(), root, { bundleId: `${COLL}-1.0.0`, files: [HELLO, OLD_ONLY] });
      const committedWithOldVersion = read(RECORD_FILE);
      await installVersion(versionOf('2.0.0', 'new'), 'local-only');
      fs.writeFileSync(abs(RECORD_FILE), committedWithOldVersion);
      fs.writeFileSync(abs(OLD_ONLY), `# ${COLL}-1.0.0\n`);
      showWarning.resolves('Switch');
      const repositoryScopeService = installer.createRepositoryScopeService();
      assert.ok(repositoryScopeService);

      await new BundleScopeCommands(manager, sandbox.createStubInstance(ScopeConflictResolver), repositoryScopeService)
        .switchCommitMode(`${COLL}-2.0.0`, 'commit');

      assert.deepStrictEqual(entriesIn(RECORD_FILE), [`${COLL}-2.0.0 vscode 2.0.0`]);
      assert.ok(!fs.existsSync(abs(LOCAL_RECORD_FILE)), 'the emptied local-only file is removed');
      assert.ok(!fs.existsSync(abs(OLD_ONLY)), 'the old version\'s own file is deleted');
      assert.strictEqual(read(HELLO), '# Hello 2.0.0\n');
      assert.deepStrictEqual(await listedVersions(), [`${COLL}-2.0.0 2.0.0`]);
    });
  });
});

suite('user record', function () {
  this.timeout(20_000);

  /** Home-relative files the vscode user layout writes for {@link V1}. */
  const USER_HELLO = '.copilot/prompts/hello.prompt.md';
  const USER_STYLE = '.copilot/instructions/style.instructions.md';
  const WSL_LOG = 'The shared user record is not used in WSL';

  let sandbox: sinon.SinonSandbox;
  let tempRoot: string;
  let home: string;
  let globalStorage: string;
  let localSource: RegistrySource;
  let manager: RegistryManager;
  let storage: RegistryStorage;
  let showError: sinon.SinonStub;
  let dispose: () => void;

  const userPath = (relative: string): string => path.join(home, ...relative.split('/'));
  const userRecordPath = (): string => storage.getPaths().userRecord;
  const readUserRecord = (): any => fs.existsSync(userRecordPath()) ? JSON.parse(fs.readFileSync(userRecordPath(), 'utf8')) : null;
  const listedUser = async (): Promise<InstalledBundle | undefined> =>
    (await manager.listInstalledBundles('user')).find((bundle) => bundle.bundleId === BUNDLE_ID);
  const installUser = (): Promise<InstalledBundle> => manager.installBundle(BUNDLE_ID, { scope: 'user' });
  /** The 1.0.0 bundle as the configured local source lists it. */
  const v1Bundle = (): Bundle => {
    const bundleDir = path.join(localSource.url, BUNDLE_ID);
    return {
      ...bundleOf(V1.version, localSource.id),
      manifestUrl: pathToFileURL(path.join(bundleDir, 'deployment-manifest.yml')).href, downloadUrl: pathToFileURL(bundleDir).href
    };
  };

  setup(async () => {
    sandbox = sinon.createSandbox();
    tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'extension-user-record-')));
    home = path.join(tempRoot, 'home');
    fs.mkdirSync(home, { recursive: true });

    // A configured local source holding the bundle at 1.0.0, in the source cache.
    const sourceDir = path.join(tempRoot, 'source');
    writeBundleDir(path.join(sourceDir, BUNDLE_ID), V1);
    localSource = { id: 'acme-local', name: 'Acme local', type: 'local', url: sourceDir, enabled: true, priority: 0 };

    ({ manager, storage, globalStorage, showError, dispose } = await setupUserRecordManager(sandbox, {
      tempRoot, env: { HOME: home, USERPROFILE: home }, source: localSource
    }));
    await storage.cacheSourceBundles(localSource.id, [v1Bundle()]);
  });

  teardown(() => {
    dispose();
  });

  test('the user record path is under XDG_CONFIG_HOME, not under globalStorageUri', () => {
    const userRecord = new VsCodeAppStorage({ ...createMockContext(sandbox), globalStorageUri: vscode.Uri.file(globalStorage) }).getPaths().userRecord;

    assert.strictEqual(userRecord, path.join(process.env.XDG_CONFIG_HOME ?? '', 'ai-primitives-hub', 'ai-primitives-hub.user.lock.json'));
    assert.ok(!userRecord.startsWith(globalStorage), userRecord);
  });

  test('a user-scope install records the vscode entry with home-relative paths in the user record, not in RegistryStorage', async () => {
    const recordInstallation = sandbox.spy(RegistryStorage.prototype, 'recordInstallation');

    await installUser();

    const record = readUserRecord();
    const { installedAt, ...entry } = record.bundles[BUNDLE_ID].tools.vscode;
    assert.deepStrictEqual(Object.keys(record.bundles[BUNDLE_ID].tools), ['vscode']);
    assert.ok(!Number.isNaN(Date.parse(installedAt)));
    assert.deepStrictEqual(entry, {
      version: '1.0.0',
      sourceId: localSource.id,
      sourceType: 'local',
      files: [
        { path: USER_STYLE, checksum: sha256(V1.files['instructions/style.instructions.md']) },
        { path: USER_HELLO, checksum: sha256(V1.files['prompts/hello.prompt.md']) }
      ]
    });
    assert.strictEqual(fs.readFileSync(userPath(USER_HELLO), 'utf8'), V1.files['prompts/hello.prompt.md']);
    assert.strictEqual(recordInstallation.callCount, 0, 'RegistryStorage.recordInstallation is not called');
    assert.deepStrictEqual(await storage.getInstalledBundles('user'), []);
  });

  test('a repeat user-scope install keeps a copy it wrote earlier as a regular file', async () => {
    await installUser();
    // A copy, as a transformed file or a failed symlink leaves it.
    const hello = userPath(USER_HELLO);
    fs.rmSync(hello);
    fs.writeFileSync(hello, V1.files['prompts/hello.prompt.md']);

    await manager.getBundleInstaller().installFromBuffer(v1Bundle(), zipOf(V1), { scope: 'user' }, 'local');

    assert.strictEqual(fs.readFileSync(hello, 'utf8'), V1.files['prompts/hello.prompt.md'], 'the copy is not deleted');
    const paths = readUserRecord().bundles[BUNDLE_ID].tools.vscode.files.map((file: { path: string }) => file.path);
    assert.ok(paths.includes(USER_HELLO), paths.join(', '));
  });

  test('an action on a bundle only copilot-cli holds in the user record is refused with RECORD.CLI_MANAGED; the record is unchanged', async () => {
    const adapter = new ExtensionRecordAdapter({
      sources: { listSources: () => Promise.resolve([localSource]) },
      hostTool: 'vscode',
      userRecordPath: userRecordPath(),
      env: { HOME: home }
    });
    const location = adapter.userLocation();
    for (const [bundleId, tool, file] of [['vscode-bundle', 'vscode', '.copilot/prompts/mine.prompt.md'], [BUNDLE_ID, 'copilot-cli', '.copilot/prompts/cli.prompt.md']]) {
      fs.mkdirSync(path.dirname(userPath(file)), { recursive: true });
      fs.writeFileSync(userPath(file), `# ${tool}\n`);
      await adapter.service.recordInstall({
        location, bundleId, version: '1.0.0', tool,
        source: { sourceId: localSource.id, type: 'local', url: localSource.url }, sourceType: 'local',
        writtenPaths: [userPath(file)], workspaceRoot: home, syncSiblings: false
      });
    }
    const before = fs.readFileSync(userRecordPath(), 'utf8');

    await assert.rejects(adapter.assertUserHostTool(BUNDLE_ID, 'uninstall'), (error: Error & { code?: string }) => {
      assert.strictEqual(error.code, 'RECORD.CLI_MANAGED');
      assert.ok(error.message.includes('copilot-cli') && error.message.includes('user target'), error.message);
      return true;
    });

    assert.strictEqual(fs.readFileSync(userRecordPath(), 'utf8'), before);
  });

  test('a user-scope install retires this profile\'s RegistryStorage entry; a shared path and a regular file only the old entry lists stay', async () => {
    // The profile's own 0.9.0 install: its bundle cache, a symlink into it and the RegistryStorage entry.
    const cacheDir = path.join(globalStorage, 'bundles', BUNDLE_ID);
    const oldVersion: BundleVersion = {
      version: '0.9.0',
      files: { 'prompts/hello.prompt.md': '# Hello 0.9.0\n', 'prompts/old.prompt.md': '# Old\n' },
      items: [{ id: 'hello', file: 'prompts/hello.prompt.md', type: 'prompt' }, { id: 'old', file: 'prompts/old.prompt.md', type: 'prompt' }]
    };
    writeBundleDir(cacheDir, oldVersion);
    const shared = userPath(USER_HELLO);
    const oldOnly = userPath('.copilot/prompts/old.prompt.md');
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.symlinkSync(path.join(cacheDir, 'prompts', 'hello.prompt.md'), shared, 'file');
    fs.writeFileSync(oldOnly, 'My own copy.\n');
    await storage.recordInstallation({
      bundleId: BUNDLE_ID, version: '0.9.0', installedAt: '2026-10-01T10:00:00.000Z', scope: 'user', installPath: cacheDir,
      manifest: {} as InstalledBundle['manifest'], sourceId: localSource.id, sourceType: 'local'
    });
    assert.strictEqual((await listedUser())?.version, '0.9.0');
    assert.strictEqual(readUserRecord(), null);

    // Through the installer, so only the install's own retirement can remove the stored entry.
    await manager.getBundleInstaller().installFromBuffer(v1Bundle(), zipOf(V1), { scope: 'user' }, 'local');

    assert.strictEqual(await storage.getInstalledBundle(BUNDLE_ID, 'user'), undefined, 'the RegistryStorage entry is retired');
    assert.strictEqual(fs.readFileSync(shared, 'utf8'), V1.files['prompts/hello.prompt.md'], 'the path both list stays');
    assert.ok(!fs.lstatSync(oldOnly).isSymbolicLink() && fs.readFileSync(oldOnly, 'utf8') === 'My own copy.\n', 'the regular file stays');
    const listed = await listedUser();
    assert.deepStrictEqual({ version: listed?.version, recordOrigin: listed?.recordOrigin }, { version: '1.0.0', recordOrigin: 'install-record' });

    await manager.uninstallBundle(BUNDLE_ID, 'user');

    assert.strictEqual(await listedUser(), undefined);
  });

  test('concurrent user-scope installs of different bundles all end up in the user record under vscode', async () => {
    const ids = ['concurrent-a', 'concurrent-b', 'concurrent-c'];
    const installer = manager.getBundleInstaller();

    await Promise.all(ids.map((id) => {
      const version: BundleVersion = {
        version: '1.0.0',
        files: { [`prompts/${id}.prompt.md`]: `# ${id}\n` },
        items: [{ id, file: `prompts/${id}.prompt.md`, type: 'prompt' }]
      };
      return installer.installFromBuffer({ ...v1Bundle(), id }, zipOf(version, id), { scope: 'user' }, 'local');
    }));

    const record = readUserRecord();
    assert.deepStrictEqual(Object.keys(record.bundles).toSorted(), ids);
    for (const id of ids) {
      assert.deepStrictEqual(Object.keys(record.bundles[id].tools), ['vscode'], id);
      assert.deepStrictEqual(record.bundles[id].tools.vscode.files.map((file: { path: string }) => file.path), [`.copilot/prompts/${id}.prompt.md`], id);
    }
  });

  test('a profile activated at user scope is recorded only in the user record; deactivating it uninstalls its bundles and files', async () => {
    const ids = ['profile-a', 'profile-b'];
    const files = ids.map((id) => userPath(`.copilot/prompts/${id}.prompt.md`));
    const bundles = ids.map((id, index): Bundle => {
      const dir = path.join(localSource.url, id);
      writeBundleDir(dir, { version: '1.0.0', files: { [`prompts/${id}.prompt.md`]: `# ${id}\n` }, items: [{ id, file: `prompts/${id}.prompt.md`, type: 'prompt' }] }, id);
      return { ...v1Bundle(), id, name: `Team bundle ${index}`, manifestUrl: pathToFileURL(path.join(dir, 'deployment-manifest.yml')).href, downloadUrl: pathToFileURL(dir).href };
    });
    await storage.cacheSourceBundles(localSource.id, [v1Bundle(), ...bundles]);
    await storage.addProfile({
      id: 'team', name: 'Team', description: '', icon: '', active: false, createdAt: '', updatedAt: '',
      bundles: ids.map((id) => ({ id, version: '1.0.0', sourceId: localSource.id, required: true }))
    });
    const recordInstallation = sandbox.spy(RegistryStorage.prototype, 'recordInstallation');

    await manager.activateProfile('team');

    assert.strictEqual(recordInstallation.callCount, 0, 'RegistryStorage.recordInstallation is not called');
    assert.deepStrictEqual(await storage.getInstalledBundles('user'), []);
    assert.deepStrictEqual(ids.map((id) => Object.keys(readUserRecord()?.bundles[id]?.tools ?? {})), [['vscode'], ['vscode']]);
    assert.ok(files.every((file) => fs.existsSync(file)), 'both bundles are installed');

    await manager.deactivateProfile('team');

    assert.deepStrictEqual(ids.filter((id) => readUserRecord()?.bundles[id] !== undefined), [], 'both are gone from the user record');
    assert.deepStrictEqual(files.filter((file) => isOnDisk(file)), [], 'their files are removed');
  });

  test('activating a local profile with an old CLI user lockfile present migrates it before the first user record write', async () => {
    await writeOldLockfile(resolveUserConfigPaths(process.env).userLockfile, { 'old-cli': { version: '1.0.0' } });
    await storage.addProfile({
      id: 'team', name: 'Team', description: '', icon: '', active: false, createdAt: '', updatedAt: '',
      bundles: [{ id: BUNDLE_ID, version: '1.0.0', sourceId: localSource.id, required: true }]
    });
    const adapter = manager.getRecordAdapter();
    const migrate = sandbox.spy(adapter, 'migrateBeforeWrite');
    const recordInstall = sandbox.spy(adapter.service, 'recordInstall');

    await manager.activateProfile('team');

    assert.ok(recordInstall.called, 'the profile bundle was recorded');
    assert.ok(migrate.calledBefore(recordInstall), 'the user level is migrated before the first user record write');
    const record = readUserRecord();
    assert.ok(record.importedUserLockfileAt, 'the import marker is set');
    assert.deepStrictEqual(Object.keys(record.bundles['old-cli'].tools), ['unknown']);
    assert.deepStrictEqual(Object.keys(record.bundles[BUNDLE_ID].tools), ['vscode']);
  });

  test('the scope commands lookup gives a lone unknown user bundle as RegistryManager lists and uninstalls it', async () => {
    await writeOldLockfile(resolveUserConfigPaths(process.env).userLockfile, { 'old-cli': { version: '1.0.0' } });
    await manager.migrateBeforeWrite('user');

    const listed = (await manager.listInstalledBundles('user')).find((bundle) => bundle.bundleId === 'old-cli');
    const viaManagerReader = await getInstalledBundleForScope(storage, 'old-cli', 'user', undefined, manager.userRecordReader());
    const viaOwnAdapter = await getInstalledBundleForScope(storage, 'old-cli', 'user');

    assert.ok(listed, 'RegistryManager lists it');
    assert.deepStrictEqual(viaManagerReader, listed);
    assert.deepStrictEqual(viaOwnAdapter, listed);

    await manager.uninstallBundle('old-cli', 'user');

    assert.strictEqual(readUserRecord().bundles['old-cli'], undefined, 'RegistryManager finds it to uninstall');
  });

  test('a hub profile activated at user scope is recorded in the user record; activating another hub profile uninstalls its bundle and files', async () => {
    const hubStorage = new HubStorage(path.join(tempRoot, 'hubs'));
    const hubManager = new HubManager(hubStorage, {} as any, process.cwd(), undefined, manager);
    manager.setHubManager(hubManager);
    const hubProfile = (id: string, bundleIds: string[]) => ({
      id, name: id, description: '', icon: '', active: false, createdAt: '', updatedAt: '',
      bundles: bundleIds.map((bundleId) => ({ id: bundleId, version: '1.0.0', source: localSource.id, required: true }))
    });
    await hubStorage.saveHub('acme-hub', {
      version: '1.0.0', metadata: { name: 'Acme hub', description: '', maintainer: 'test', updatedAt: '' }, sources: [],
      profiles: [hubProfile('hub-team', [BUNDLE_ID]), hubProfile('hub-empty', [])]
    }, { type: 'local', location: path.join(tempRoot, 'hub') });
    await hubStorage.setActiveHubId('acme-hub');

    await hubManager.activateProfile('acme-hub', 'hub-team', { installBundles: true });

    assert.deepStrictEqual(await storage.getInstalledBundles('user'), []);
    assert.deepStrictEqual(Object.keys(readUserRecord()?.bundles[BUNDLE_ID]?.tools ?? {}), ['vscode']);
    assert.ok(fs.existsSync(userPath(USER_HELLO)), 'the bundle is installed');

    await hubManager.activateProfile('acme-hub', 'hub-empty', { installBundles: true });

    assert.strictEqual(readUserRecord()?.bundles[BUNDLE_ID], undefined, 'the bundle is gone from the user record');
    assert.ok(!isOnDisk(userPath(USER_HELLO)) && !isOnDisk(userPath(USER_STYLE)), 'its files are removed');
  });

  test('a user-scope install from a local-skills source records the skill folder files in the user record; uninstall removes them', async () => {
    const skillsSource: RegistrySource = { id: 'acme-skills', name: 'Acme skills', type: 'local-skills', url: path.join(tempRoot, 'skills'), enabled: true, priority: 0 };
    await storage.addSource(skillsSource);
    // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    zip.addFile('skills/review/SKILL.md', Buffer.from('---\nname: review\n---\n# Review\n'));
    zip.addFile('skills/review/checklist.md', Buffer.from('- tests\n'));
    const recordInstallation = sandbox.spy(RegistryStorage.prototype, 'recordInstallation');

    const installed = await manager.getBundleInstaller().installFromBuffer(
      { ...v1Bundle(), id: 'review-skill', sourceId: skillsSource.id }, zip.toBuffer(), { scope: 'user' }, 'local-skills');

    assert.strictEqual(installed.recordOrigin, 'install-record');
    assert.deepStrictEqual(readUserRecord().bundles['review-skill'].tools.vscode.files.map((file: { path: string }) => file.path).toSorted(),
      ['.copilot/skills/review/SKILL.md', '.copilot/skills/review/checklist.md']);
    assert.strictEqual(recordInstallation.callCount, 0, 'RegistryStorage.recordInstallation is not called');

    await manager.uninstallBundle('review-skill', 'user');

    assert.strictEqual(readUserRecord()?.bundles['review-skill'], undefined);
    assert.ok(!isOnDisk(userPath('.copilot/skills/review/SKILL.md')) && !isOnDisk(userPath('.copilot/skills/review/checklist.md')), 'the skill files are removed');
  });

  test('a user-scope skill install writes over a skill folder a copilot-cli user entry lists without the overwrite prompt; its files and both entries stay', async () => {
    const skillsSource: RegistrySource = { id: 'acme-skills', name: 'Acme skills', type: 'local-skills', url: path.join(tempRoot, 'skills'), enabled: true, priority: 0 };
    await storage.addSource(skillsSource);
    const skill = { 'SKILL.md': '---\nname: review\n---\n# Review\n', 'checklist.md': '- tests\n' };
    // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    // The CLI's copilot-cli entry for the same skill files, in the shared `~/.copilot/skills`.
    const cliFiles = Object.entries(skill).map(([name, content]) => {
      zip.addFile(`skills/review/${name}`, Buffer.from(content));
      const file = userPath(`.copilot/skills/review/${name}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return file;
    });
    const adapter = new ExtensionRecordAdapter({
      sources: { listSources: () => Promise.resolve([skillsSource]) },
      hostTool: 'vscode',
      userRecordPath: userRecordPath(),
      env: { HOME: home }
    });
    await adapter.service.recordInstall({
      location: adapter.userLocation(), bundleId: 'review-skill', version: '1.0.0', tool: 'copilot-cli',
      source: { sourceId: skillsSource.id, type: 'local-skills', url: skillsSource.url }, sourceType: 'local-skills',
      writtenPaths: cliFiles, workspaceRoot: home, syncSiblings: false
    });
    const showWarning = vscode.window.showWarningMessage as sinon.SinonStub;

    await manager.getBundleInstaller().installFromBuffer(
      { ...v1Bundle(), id: 'review-skill', sourceId: skillsSource.id }, zip.toBuffer(), { scope: 'user' }, 'local-skills');

    assert.ok(!showWarning.getCalls().some((call) => String(call.args[0]).includes('already exists')), 'no overwrite prompt');
    assert.deepStrictEqual(cliFiles.filter((file) => !fs.existsSync(file)), [], 'the copilot-cli entry\'s files stay');
    assert.deepStrictEqual(Object.keys(readUserRecord().bundles['review-skill'].tools).toSorted(), ['copilot-cli', 'vscode']);
  });

  test('a user-scope uninstall after ~/.copilot is re-pointed outside home is refused with RECORD.PATH_OUTSIDE_ROOT; the outside file stays', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    await installUser();
    const outside = path.join(tempRoot, 'outside-copilot');
    fs.cpSync(userPath('.copilot'), outside, { recursive: true });
    fs.rmSync(userPath('.copilot'), { recursive: true });
    fs.symlinkSync(outside, userPath('.copilot'), 'dir');

    await assert.rejects(manager.uninstallBundle(BUNDLE_ID, 'user'), { code: 'RECORD.PATH_OUTSIDE_ROOT' });

    assert.strictEqual(fs.readFileSync(path.join(outside, 'prompts', 'hello.prompt.md'), 'utf8'), V1.files['prompts/hello.prompt.md']);
  });

  test('a user-scope install with a malformed user record shows one error naming the file and writes nothing to the user folders', async () => {
    const malformed = '{ "version": "3.0.0", ';
    fs.mkdirSync(path.dirname(userRecordPath()), { recursive: true });
    fs.writeFileSync(userRecordPath(), malformed);

    await assert.rejects(installUser(), { code: 'RECORD.MALFORMED' });

    assert.deepStrictEqual(snapshotTree(home), new Map(), 'nothing written under home');
    assert.strictEqual(fs.readFileSync(userRecordPath(), 'utf8'), malformed);
    assert.strictEqual(showError.callCount, 1);
    assert.ok(String(showError.firstCall.args[0]).includes(userRecordPath()), String(showError.firstCall.args[0]));
  });

  test('in WSL a user-scope install is recorded in RegistryStorage, the user record is never created, and that is logged once', async () => {
    sandbox.stub(vscode.env, 'remoteName').value('wsl');
    const info = sandbox.stub(Logger.getInstance(), 'info');

    await installUser();
    await manager.listInstalledBundles('user');

    assert.strictEqual((await storage.getInstalledBundle(BUNDLE_ID, 'user'))?.version, '1.0.0');
    assert.ok(!fs.existsSync(userRecordPath()), 'no user record');
    assert.strictEqual(info.getCalls().filter((call) => String(call.args[0]).includes(WSL_LOG)).length, 1);
  });

  suite('one version per bundle and tool', () => {
    const COLL = 'acme-tools-coll';
    const idOf = (version: string): string => `${COLL}-${version}`;
    const ownFile = (own: string): string => userPath(`.copilot/prompts/${own}.prompt.md`);

    /**
     * A version of the versioned-id bundle: the shared prompt and one prompt of its own.
     * @param version - Bundle version.
     * @param own - Name of the prompt only this version writes.
     */
    const versionOf = (version: string, own: string): BundleVersion => ({
      version,
      files: { 'prompts/hello.prompt.md': `# Hello ${version}\n`, [`prompts/${own}.prompt.md`]: `# ${own} ${version}\n` },
      items: [{ id: 'hello', file: 'prompts/hello.prompt.md', type: 'prompt' }, { id: own, file: `prompts/${own}.prompt.md`, type: 'prompt' }]
    });

    const bundleAt = (version: string): Bundle => ({ ...v1Bundle(), id: idOf(version), version });

    const installVersion = (version: BundleVersion): Promise<InstalledBundle> =>
      manager.getBundleInstaller().installFromBuffer(bundleAt(version.version), zipOf(version, idOf(version.version)), { scope: 'user' }, 'local');

    /** `<key> <tool> <version>` for every entry of the user record, sorted. */
    const userEntries = (): string[] => Object.entries(readUserRecord()?.bundles ?? {})
      .flatMap(([key, bundle]: [string, any]) => Object.entries(bundle.tools).map(([tool, entry]: [string, any]) => `${key} ${tool} ${entry.version}`))
      .toSorted();

    const listedVersions = async (): Promise<string[]> => (await manager.listInstalledBundles('user'))
      .filter((item) => item.bundleId.startsWith(COLL))
      .map((item) => `${item.bundleId} ${item.version}`);

    const cacheOf = (version: string): string => path.join(globalStorage, 'bundles', idOf(version));

    /**
     * Record a profile's own install of a version in RegistryStorage, with its bundle cache and links into it.
     * @param version - Bundle version, writing `old.prompt.md` of its own.
     * @param profileId - Profile the install belongs to.
     */
    const storeProfileInstall = async (version: string, profileId?: string): Promise<void> => {
      const bundle = versionOf(version, 'old');
      writeBundleDir(cacheOf(version), bundle, idOf(version));
      for (const file of Object.keys(bundle.files)) {
        fs.mkdirSync(path.dirname(userPath(`.copilot/${file}`)), { recursive: true });
        fs.symlinkSync(path.join(cacheOf(version), file), userPath(`.copilot/${file}`), 'file');
      }
      await storage.recordInstallation({
        bundleId: idOf(version), version, installedAt: '2026-10-01T10:00:00.000Z', scope: 'user', installPath: cacheOf(version),
        manifest: {} as InstalledBundle['manifest'], sourceId: localSource.id, sourceType: 'local', profileId
      });
    };

    test('install 1.0.0, upgrade to 2.0.0 and downgrade back: one vscode entry, one listed item, no file or cache only the old version had', async () => {
      for (const [step, own, gone] of [['1.0.0', 'old', undefined], ['2.0.0', 'new', 'old'], ['1.0.0', 'old', 'new']] as const) {
        const previous = gone === undefined ? undefined : (step === '2.0.0' ? '1.0.0' : '2.0.0');

        await installVersion(versionOf(step, own));

        assert.deepStrictEqual(userEntries(), [`${idOf(step)} vscode ${step}`], step);
        assert.deepStrictEqual(await listedVersions(), [`${idOf(step)} ${step}`], step);
        assert.strictEqual(fs.readFileSync(userPath(USER_HELLO), 'utf8'), `# Hello ${step}\n`, step);
        if (gone !== undefined && previous !== undefined) {
          assert.ok(!isOnDisk(ownFile(gone)), `${step}: the old version's own file is deleted`);
          assert.ok(!fs.existsSync(cacheOf(previous)), `${step}: the old version's bundle cache is removed`);
        }
      }
      assert.ok(showError.notCalled, String(showError.firstCall?.args[0]));
    });

    test('installing another version keeps a file the user replaced that only the old version wrote', async () => {
      await installVersion(versionOf('1.0.0', 'old'));
      // The user replaces the link into the bundle cache with a file of their own.
      fs.rmSync(ownFile('old'));
      fs.writeFileSync(ownFile('old'), 'My own prompt.\n');

      await installVersion(versionOf('2.0.0', 'new'));

      assert.strictEqual(fs.readFileSync(ownFile('old'), 'utf8'), 'My own prompt.\n');
      assert.deepStrictEqual(userEntries(), [`${idOf('2.0.0')} vscode 2.0.0`]);
    });

    test('update in place to the next versioned id leaves one vscode entry, deletes the old version\'s own file and shows no error', async () => {
      await installVersion(versionOf('1.0.0', 'old'));
      const installed = (await manager.listInstalledBundles('user')).find((item) => item.bundleId === idOf('1.0.0'));
      assert.ok(installed);
      const next = versionOf('2.0.0', 'new');

      await manager.getBundleInstaller().update(installed, bundleAt('2.0.0'), zipOf(next, idOf('2.0.0')), 'local');

      assert.deepStrictEqual(userEntries(), [`${idOf('2.0.0')} vscode 2.0.0`]);
      assert.ok(!isOnDisk(ownFile('old')), 'the old version\'s own file is deleted');
      assert.ok(!fs.existsSync(cacheOf('1.0.0')), 'the old version\'s bundle cache is removed');
      assert.ok(showError.notCalled, String(showError.firstCall?.args[0]));
    });

    test('an older RegistryStorage item next to a newer user record entry lists as one item, the record\'s', async () => {
      await storeProfileInstall('1.0.0');
      const adapter = manager.getRecordAdapter();
      fs.writeFileSync(ownFile('new'), '# new 2.0.0\n');
      await adapter.service.recordInstall({
        location: adapter.userLocation(), bundleId: idOf('2.0.0'), version: '2.0.0', tool: adapter.hostTool,
        source: { sourceId: localSource.id, type: 'local', url: localSource.url }, sourceType: 'local',
        writtenPaths: [ownFile('new')], workspaceRoot: home, syncSiblings: false
      });

      assert.deepStrictEqual(await listedVersions(), [`${idOf('2.0.0')} 2.0.0`]);
      assert.strictEqual((await findUserRecordBundle({ adapter, storage }, idOf('1.0.0'), { version: '1.0.0' }))?.bundleId, idOf('2.0.0'));
    });

    test('a user record holding two versions of the bundle for vscode lists the latest installed', async () => {
      await installVersion(versionOf('2.0.0', 'new'));
      // An older key next to it, as after a hand edit or a copy from another machine.
      const record = readUserRecord();
      record.bundles[idOf('1.0.0')] = { tools: { vscode: { ...record.bundles[idOf('2.0.0')].tools.vscode, version: '1.0.0', installedAt: '2026-01-01T00:00:00.000Z' } } };
      fs.writeFileSync(userRecordPath(), JSON.stringify(record, null, 2));

      assert.deepStrictEqual(await listedVersions(), [`${idOf('2.0.0')} 2.0.0`]);
      assert.strictEqual((await findUserRecordBundle({ adapter: manager.getRecordAdapter(), storage }, idOf('1.0.0')))?.bundleId, idOf('2.0.0'));
    });

    test('installing another version retires this profile\'s RegistryStorage item of the old version and its own file', async () => {
      await storeProfileInstall('1.0.0');

      await installVersion(versionOf('2.0.0', 'new'));

      assert.strictEqual(await storage.getInstalledBundle(idOf('1.0.0'), 'user'), undefined, 'the RegistryStorage item is retired');
      assert.ok(!isOnDisk(ownFile('old')), 'the old version\'s own file is removed');
      assert.strictEqual(fs.readFileSync(userPath(USER_HELLO), 'utf8'), '# Hello 2.0.0\n', 'the path both write stays');
      assert.deepStrictEqual(await listedVersions(), [`${idOf('2.0.0')} 2.0.0`]);
    });

    test('deactivating a profile uninstalls a later version of its bundle from the user record', async () => {
      const v1 = versionOf('1.0.0', 'old');
      const dir = path.join(localSource.url, idOf('1.0.0'));
      writeBundleDir(dir, v1, idOf('1.0.0'));
      await storage.cacheSourceBundles(localSource.id, [{
        ...bundleAt('1.0.0'), manifestUrl: pathToFileURL(path.join(dir, 'deployment-manifest.yml')).href, downloadUrl: pathToFileURL(dir).href
      }]);
      await storage.addProfile({
        id: 'team', name: 'Team', description: '', icon: '', active: false, createdAt: '', updatedAt: '',
        bundles: [{ id: idOf('1.0.0'), version: '1.0.0', sourceId: localSource.id, required: true }]
      });
      await manager.activateProfile('team');
      await installVersion(versionOf('2.0.0', 'new'));
      assert.deepStrictEqual(userEntries(), [`${idOf('2.0.0')} vscode 2.0.0`]);

      await manager.deactivateProfile('team');

      assert.deepStrictEqual(userEntries(), []);
      assert.ok(!isOnDisk(ownFile('new')) && !isOnDisk(userPath(USER_HELLO)), 'its files are removed');
    });
  });
});

suite('older records', function () {
  this.timeout(20_000);

  const OTHER_ID = 'other-bundle';
  /** File the old `prompt-registry.lock.json` entry lists, root-relative. */
  const OLD_FILE = '.github/prompts/old.prompt.md';
  /** Home-relative file this profile's 0.9.0 install synced. */
  const USER_HELLO = '.copilot/prompts/hello.prompt.md';
  /** The other bundle: one prompt of its own. */
  const OTHER: BundleVersion = {
    version: '1.0.0',
    files: { 'prompts/other.prompt.md': '# Other\n' },
    items: [{ id: 'other', file: 'prompts/other.prompt.md', type: 'prompt' }]
  };
  /** This profile's RegistryStorage install of the bundle. */
  const V0: BundleVersion = {
    version: '0.9.0',
    files: { 'prompts/hello.prompt.md': '# Hello 0.9.0\n' },
    items: [{ id: 'hello', file: 'prompts/hello.prompt.md', type: 'prompt' }]
  };

  let sandbox: sinon.SinonSandbox;
  let tempRoot: string;
  let root: string;
  let home: string;
  let globalStorage: string;
  let localSource: RegistrySource;
  let manager: RegistryManager;
  let storage: RegistryStorage;
  let shown: Map<string, unknown>;
  let showInfo: sinon.SinonStub;
  let showWarning: sinon.SinonStub;
  let restoreEnv: () => void;

  /** `globalState` over {@link shown}, so two adapters can share it. */
  const globalState = (): Pick<vscode.Memento, 'get' | 'update'> => ({
    get: <T>(key: string): T | undefined => shown.get(key) as T | undefined,
    update: (key: string, value: unknown) => {
      shown.set(key, value);
      return Promise.resolve();
    }
  });
  const abs = (relative: string): string => path.join(root, ...relative.split('/'));
  const userPath = (relative: string): string => path.join(home, ...relative.split('/'));
  const readRecord = (): any => fs.existsSync(abs(RECORD_FILE)) ? JSON.parse(fs.readFileSync(abs(RECORD_FILE), 'utf8')) : null;
  const readUserRecord = (): any => {
    const file = storage.getPaths().userRecord;
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  };
  const messages = (): string[] => [...showInfo.getCalls(), ...showWarning.getCalls()].map((call) => String(call.args[0]));

  const sourceBundle = (bundleId: string): Bundle => {
    const dir = path.join(localSource.url, bundleId);
    return {
      id: bundleId, name: bundleId, version: V1.version, description: 'Test', author: 'test', sourceId: localSource.id,
      environments: [], tags: [], lastUpdated: '', size: '', dependencies: [], license: 'MIT',
      manifestUrl: pathToFileURL(path.join(dir, 'deployment-manifest.yml')).href, downloadUrl: pathToFileURL(dir).href
    };
  };

  const writeOldRepositoryFile = async (bundleId: string): Promise<void> => {
    fs.mkdirSync(path.dirname(abs(OLD_FILE)), { recursive: true });
    fs.writeFileSync(abs(OLD_FILE), 'old content');
    await writeOldLockfile(abs(OLD_LOCKFILE), { [bundleId]: { version: '0.9.0', files: [OLD_FILE] } }, { id: localSource.id, type: 'local', url: localSource.url });
  };

  // This profile's 0.9.0 user install, before the shared user record.
  const installForProfile = (cached = V0): Promise<void> => recordProfileInstall(storage, path.join(globalStorage, 'bundles', BUNDLE_ID), {
    bundleId: BUNDLE_ID, version: V0.version, sourceId: localSource.id,
    cache: { 'deployment-manifest.yml': manifestOf(cached), ...cached.files }, syncedFile: 'prompts/hello.prompt.md', userFile: userPath(USER_HELLO)
  });

  setup(async () => {
    sandbox = sinon.createSandbox();
    tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'extension-old-records-')));
    root = path.join(tempRoot, 'repo');
    fs.mkdirSync(root, { recursive: true });
    initGitRoot(root);
    home = path.join(tempRoot, 'home');
    fs.mkdirSync(home, { recursive: true });
    restoreEnv = overrideEnv({ HOME: home, USERPROFILE: home });
    globalStorage = path.join(tempRoot, 'User', 'globalStorage', 'acme.extension');

    // A configured local source holding both bundles at 1.0.0, in the source cache.
    const sourceDir = path.join(tempRoot, 'source');
    writeBundleDir(path.join(sourceDir, BUNDLE_ID), V1);
    writeBundleDir(path.join(sourceDir, OTHER_ID), OTHER, OTHER_ID);
    localSource = { id: 'acme-local', name: 'Acme local', type: 'local', url: sourceDir, enabled: true, priority: 0 };

    shown = new Map();
    (RegistryManager as any).instance = undefined;
    manager = RegistryManager.getInstance({
      ...createMockContext(sandbox),
      globalStorageUri: vscode.Uri.file(globalStorage),
      globalState: { ...globalState(), keys: () => [...shown.keys()], setKeysForSync: () => undefined }
    });
    storage = manager.getStorage();
    await storage.initialize();
    await storage.addSource(localSource);
    await storage.cacheSourceBundles(localSource.id, [sourceBundle(BUNDLE_ID), sourceBundle(OTHER_ID)]);

    const scopeSelectionUI = require('../../src/utils/scope-selection-ui');
    sandbox.stub(scopeSelectionUI, 'getWorkspaceRoot').returns(root);
    sandbox.stub(scopeSelectionUI, 'hasOpenWorkspace').returns(true);
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: vscode.Uri.file(root), name: 'repo', index: 0 }]);
    sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    showInfo = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    showWarning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
  });

  teardown(() => {
    sandbox.restore();
    restoreEnv();
    (RegistryManager as any).instance = undefined;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('a repository install migrates prompt-registry.lock.json and notifies once; the same report through another adapter is only logged', async () => {
    await writeOldRepositoryFile('old-bundle');
    const migrate = sandbox.spy(manager.getRecordAdapter(), 'migrateBeforeWrite');
    const info = sandbox.spy(Logger.getInstance(), 'info');

    await manager.installBundle(BUNDLE_ID, { scope: 'repository', commitMode: 'commit' });

    const record = readRecord();
    assert.ok(!fs.existsSync(abs(OLD_LOCKFILE)), 'the old file is renamed');
    assert.deepStrictEqual(record.bundles['old-bundle'].tools, {
      unknown: {
        version: '0.9.0', sourceId: localSource.id, sourceType: 'local', installedAt: '2026-10-01T10:00:00.000Z',
        needsReinstall: true, files: [{ path: OLD_FILE, checksum: sha256('old content') }]
      }
    });
    assert.deepStrictEqual(Object.keys(record.bundles[BUNDLE_ID].tools), ['vscode']);
    const notices = (): unknown[][] => showInfo.getCalls().filter((call) => String(call.args[0]).startsWith('Migrated the')).map((call) => call.args);
    assert.deepStrictEqual(notices(), [['Migrated the repository install record: 1 bundle needs reinstalling.', 'Show details']]);

    const report = await migrate.firstCall.returnValue;
    assert.ok(report, 'the install ran a migration');
    new ExtensionRecordAdapter({ sources: { listSources: () => Promise.resolve([]) }, memento: globalState() })
      .showMigrationReport(report, abs(RECORD_FILE));

    assert.strictEqual(notices().length, 1, 'one notification per record path and migratedAt');
    assert.strictEqual(info.getCalls().filter((call) => String(call.args[0]).startsWith(MIGRATION_LOG_PREFIX)).length, 2, 'two log entries');
  });

  const profileCases: { name: string; wsl?: boolean; otherToolFirst?: boolean; removeFailsOnce?: boolean; toolsAfter?: string[] }[] = [
    { name: 'outside WSL a user write migrates this profile\'s RegistryStorage user entry under vscode with its file and removes it from RegistryStorage', toolsAfter: ['vscode'] },
    { name: 'in WSL a user write leaves this profile\'s RegistryStorage user entry as it is', wsl: true },
    {
      name: 'a user record holding the bundle only for kiro keeps that entry, adds the profile\'s vscode entry beside it and removes it from RegistryStorage',
      otherToolFirst: true,
      toolsAfter: ['kiro', 'vscode']
    },
    {
      name: 'a RegistryStorage removal that fails is shown in one warning, the action continues, and the next user write removes it',
      removeFailsOnce: true,
      toolsAfter: ['vscode']
    }
  ];
  profileCases.forEach(({ name, wsl = false, otherToolFirst = false, removeFailsOnce = false, toolsAfter }) => {
    test(name, async () => {
      if (wsl) {
        sandbox.stub(vscode.env, 'remoteName').value('wsl');
      }
      await installForProfile();
      const adapter = manager.getRecordAdapter();
      if (otherToolFirst) {
        const kiroFile = userPath('.kiro/steering/hello.md');
        fs.mkdirSync(path.dirname(kiroFile), { recursive: true });
        fs.writeFileSync(kiroFile, '# Hello for kiro\n');
        await adapter.service.recordInstall({
          location: adapter.userLocation(), bundleId: BUNDLE_ID, version: V1.version, tool: 'kiro',
          source: { sourceId: localSource.id, type: 'local', url: localSource.url }, sourceType: 'local', writtenPaths: [kiroFile]
        });
      }
      if (removeFailsOnce) {
        sandbox.stub(storage, 'removeInstallation').callThrough().onFirstCall().rejects(new Error('storage is busy'));
      }

      await manager.installBundle(OTHER_ID, { scope: 'user' });

      const stored = await storage.getInstalledBundle(BUNDLE_ID, 'user');
      assert.strictEqual(fs.readFileSync(userPath(USER_HELLO), 'utf8'), V0.files['prompts/hello.prompt.md'], 'the synced file stays');
      if (wsl) {
        assert.strictEqual(stored?.version, V0.version);
        assert.strictEqual(readUserRecord(), null, 'no user record in WSL');
        return;
      }
      const record = readUserRecord();
      assert.deepStrictEqual(Object.keys(record.bundles[BUNDLE_ID].tools), toolsAfter);
      assert.deepStrictEqual(Object.keys(record.bundles[OTHER_ID].tools), ['vscode'], 'the action ran');
      const { installedAt: _installedAt, ...entry } = record.bundles[BUNDLE_ID].tools.vscode;
      assert.deepStrictEqual(entry, {
        version: V0.version, sourceId: localSource.id, sourceType: 'local',
        files: [{ path: USER_HELLO, checksum: sha256(V0.files['prompts/hello.prompt.md']) }]
      });
      if (removeFailsOnce) {
        const warnings = showWarning.getCalls().map((call) => String(call.args[0]));
        assert.deepStrictEqual(warnings.filter((warning) => warning.includes('could not remove the old profile entries')), [
          `Migrated the user install record, but could not remove the old profile entries of ${BUNDLE_ID}. They are removed on the next change.`
        ]);
        assert.strictEqual(stored?.version, V0.version, 'still in RegistryStorage after the failed removal');
        const saved = fs.readFileSync(storage.getPaths().userRecord, 'utf8');

        await adapter.migrateBeforeWrite('user', home);

        assert.strictEqual(fs.readFileSync(storage.getPaths().userRecord, 'utf8'), saved, 'the saved record is unchanged');
        assert.strictEqual(await storage.getInstalledBundle(BUNDLE_ID, 'user'), undefined, 'removed on the next user write');
        return;
      }
      assert.strictEqual(stored, undefined, 'removed from RegistryStorage');
    });
  });

  test('a cached profile manifest with an invalid prompt type or a source outside the bundle cache does not stop the migration; those items are skipped', async () => {
    const outsideTarget = userPath('.copilot/prompts/outside.prompt.md');
    await installForProfile({
      ...V0,
      items: [
        ...V0.items,
        { id: 'bad-type', file: 'prompts/hello.prompt.md', type: 'not-a-kind' },
        { id: 'outside', file: '../outside.prompt.md', type: 'prompt' }
      ]
    });
    // A file next to the bundle cache, and a link to it where the outside item would sync.
    const outsideSource = path.join(globalStorage, 'bundles', 'outside.prompt.md');
    fs.writeFileSync(outsideSource, '# Outside\n');
    fs.symlinkSync(outsideSource, outsideTarget, 'file');

    await manager.installBundle(OTHER_ID, { scope: 'user' });

    const record = readUserRecord();
    assert.deepStrictEqual(Object.keys(record.bundles[OTHER_ID].tools), ['vscode'], 'the action ran');
    assert.deepStrictEqual(record.bundles[BUNDLE_ID].tools.vscode.files.map((file: { path: string }) => file.path), [USER_HELLO]);
    assert.strictEqual(await storage.getInstalledBundle(BUNDLE_ID, 'user'), undefined, 'removed from RegistryStorage');
    assert.ok(isOnDisk(outsideTarget), 'the skipped item\'s file stays');
  });

  const loneUnknownCases: { action: string; run: () => Promise<void>; toolsAfter: string[]; message?: RegExp }[] = [
    { action: 'update installs it for vscode', run: () => manager.updateBundle(BUNDLE_ID), toolsAfter: ['vscode'] },
    {
      action: 'uninstall removes the entry',
      run: () => manager.uninstallBundle(BUNDLE_ID, 'repository'),
      toolsAfter: [],
      message: /Its tool was unknown, so its files were kept: \.github\/prompts\/old\.prompt\.md/
    },
    {
      action: 'move to user scope is refused with the reinstall hint',
      run: async () => {
        const repositoryScopeService = manager.getBundleInstaller().createRepositoryScopeService();
        assert.ok(repositoryScopeService);
        await new BundleScopeCommands(manager, sandbox.createStubInstance(ScopeConflictResolver), repositoryScopeService).moveToUser(BUNDLE_ID);
      },
      toolsAfter: ['unknown'],
      message: new RegExp(`${BUNDLE_ID} was migrated and its tool is unknown; reinstall it first`)
    }
  ];
  loneUnknownCases.forEach(({ action, run, toolsAfter, message }) => {
    test(`a bundle only an old prompt-registry file holds: ${action} and keeps the old file`, async () => {
      await writeOldRepositoryFile(BUNDLE_ID);

      await run();

      assert.deepStrictEqual(Object.keys(readRecord()?.bundles[BUNDLE_ID]?.tools ?? {}), toolsAfter);
      assert.strictEqual(fs.readFileSync(abs(OLD_FILE), 'utf8'), 'old content');
      if (message !== undefined) {
        assert.ok(messages().some((shownMessage) => message.test(shownMessage)), messages().join('\n'));
      }
    });
  });
});
