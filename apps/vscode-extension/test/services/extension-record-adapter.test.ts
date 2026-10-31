/**
 * Extension record adapter: the extension, as the `vscode` host, installs,
 * updates, uninstalls and switches a repository bundle against a real temp
 * git root. Only `vscode.window`, the workspace lookup and `RegistryStorage` are stubbed.
 *
 * The user record suite installs a user-scope bundle into a temp `HOME`;
 * `XDG_CONFIG_HOME` is a per-test temp folder, so the real user record is never touched.
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
} from '../../src/services/extension-record-adapter';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  ScopeConflictResolver,
} from '../../src/services/scope-conflict-resolver';
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
  Logger,
} from '../../src/utils/logger';
import {
  createMockContext,
  initGitRoot,
  LOCAL_RECORD_FILE,
  overrideEnv,
  RECORD_FILE,
  recordEntry,
  snapshotTree,
  writeOldEntry,
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

/**
 * Write a bundle version's folder: its manifest and files.
 * @param dir - Bundle folder.
 * @param bundle - Bundle version.
 */
const writeBundleDir = (dir: string, bundle: BundleVersion): void => {
  for (const [file, content] of Object.entries({ 'deployment-manifest.yml': manifestOf(bundle), ...bundle.files })) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
};

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

  const bundleOf = (version: string, sourceId = SOURCE.id): Bundle => ({
    id: BUNDLE_ID, name: 'Record Bundle', version, description: 'Test', author: 'test', sourceId,
    environments: [], tags: [], lastUpdated: '', size: '', dependencies: [], license: 'MIT', manifestUrl: '', downloadUrl: ''
  });

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

  test('install retires the bundle\'s old prompt-registry entry and its unmodified old file', async () => {
    await writeOldEntry(root, BUNDLE_ID, { files: { '.github/prompts/old.prompt.md': 'old content' } });

    await install(V1);

    assert.ok(!fs.existsSync(abs(OLD_LOCKFILE)), 'the emptied old file is removed');
    assert.ok(!fs.existsSync(abs('.github/prompts/old.prompt.md')), 'the old file is deleted');
    assert.deepStrictEqual(Object.keys(toolsOf()), ['vscode']);
  });

  test('uninstall of an old-file-only bundle keeps a path a record entry lists and a modified file', async () => {
    const shared = '.github/prompts/shared.prompt.md';
    const modified = '.github/prompts/modified.prompt.md';
    const plain = '.github/prompts/plain.prompt.md';
    await writeOldEntry(root, 'old-bundle', { files: {
      [shared]: 'shared',
      [modified]: { content: 'edited by the user', recorded: 'as installed' },
      [plain]: 'plain'
    } });
    await recordOtherTool('vscode', [shared], 'other-bundle');

    await manager.uninstallBundle('old-bundle', 'repository');

    assert.ok(!fs.existsSync(abs(OLD_LOCKFILE)), 'the emptied old file is removed');
    assert.ok(!fs.existsSync(abs(plain)), 'the unmodified file is deleted');
    assert.strictEqual(read(shared), 'shared');
    assert.strictEqual(read(modified), 'edited by the user');
    assert.deepStrictEqual(Object.keys(toolsOf(RECORD_FILE, 'other-bundle')), ['vscode']);
  });

  test('uninstall of a recorded bundle also retires an old prompt-registry entry for it', async () => {
    await install(V1);
    await writeOldEntry(root, BUNDLE_ID, { files: { '.github/prompts/old.prompt.md': 'old content' } });

    await manager.uninstallBundle(BUNDLE_ID, 'repository');

    assert.deepStrictEqual(toolsOf(), {});
    assert.ok(!fs.existsSync(abs(OLD_LOCKFILE)), 'the emptied old file is removed');
    assert.ok(!fs.existsSync(abs('.github/prompts/old.prompt.md')), 'the old file is deleted');
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

suite('user record (U4)', function () {
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
  let restoreEnv: () => void;

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
      id: BUNDLE_ID, name: 'Record Bundle', version: V1.version, description: 'Test', author: 'test', sourceId: localSource.id,
      environments: [], tags: [], lastUpdated: '', size: '', dependencies: [], license: 'MIT',
      manifestUrl: pathToFileURL(path.join(bundleDir, 'deployment-manifest.yml')).href, downloadUrl: pathToFileURL(bundleDir).href
    };
  };

  setup(async () => {
    sandbox = sinon.createSandbox();
    tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'extension-user-record-')));
    home = path.join(tempRoot, 'home');
    fs.mkdirSync(home, { recursive: true });
    restoreEnv = overrideEnv({ HOME: home, USERPROFILE: home });
    // `User/globalStorage/<id>`, so the user MCP config derived from it stays in the temp folder.
    globalStorage = path.join(tempRoot, 'User', 'globalStorage', 'acme.extension');

    // A configured local source holding the bundle at 1.0.0, in the source cache.
    const sourceDir = path.join(tempRoot, 'source');
    writeBundleDir(path.join(sourceDir, BUNDLE_ID), V1);
    localSource = { id: 'acme-local', name: 'Acme local', type: 'local', url: sourceDir, enabled: true, priority: 0 };

    (RegistryManager as any).instance = undefined;
    manager = RegistryManager.getInstance({ ...createMockContext(sandbox), globalStorageUri: vscode.Uri.file(globalStorage) });
    storage = manager.getStorage();
    await storage.initialize();
    await storage.addSource(localSource);
    await storage.cacheSourceBundles(localSource.id, [v1Bundle()]);

    showError = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
  });

  teardown(() => {
    sandbox.restore();
    restoreEnv();
    (RegistryManager as any).instance = undefined;
    fs.rmSync(tempRoot, { recursive: true, force: true });
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

    // Through the installer, so only the install's own retirement can remove the
    // RegistryStorage entry (not `installBundle`'s old-version cleanup).
    await manager.getBundleInstaller().installFromBuffer(v1Bundle(), zipOf(V1), { scope: 'user' }, 'local');

    assert.strictEqual(await storage.getInstalledBundle(BUNDLE_ID, 'user'), undefined, 'the RegistryStorage entry is retired');
    assert.strictEqual(fs.readFileSync(shared, 'utf8'), V1.files['prompts/hello.prompt.md'], 'the path both list stays');
    assert.ok(!fs.lstatSync(oldOnly).isSymbolicLink() && fs.readFileSync(oldOnly, 'utf8') === 'My own copy.\n', 'the regular file stays');
    const listed = await listedUser();
    assert.deepStrictEqual({ version: listed?.version, recordOrigin: listed?.recordOrigin }, { version: '1.0.0', recordOrigin: 'install-record' });

    await manager.uninstallBundle(BUNDLE_ID, 'user');

    assert.strictEqual(await listedUser(), undefined);
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
});
