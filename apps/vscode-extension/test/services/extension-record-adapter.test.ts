/**
 * Extension record adapter contract (U3; BR11.4–BR11.6, BR12.1, NFR4.12,
 * NFR4.13, NFR4.15, NFR5.2).
 *
 * The extension runs as the `vscode` host and installs, updates, uninstalls
 * and switches a repository bundle through `BundleInstaller`,
 * `RegistryManager` and `BundleScopeCommands` against a real temp git root.
 * Other tools' entries are written through the adapter's own
 * `InstallRecordService`; old `prompt-registry` files through app's
 * `json-lockfile-store`. Only `vscode.window`, the workspace lookup and
 * `RegistryStorage` (the configured sources) are stubbed.
 *
 * Covered elsewhere: refusing actions on an entry only `kiro` holds
 * (`cli-managed-guard.test.ts`).
 */
import * as assert from 'node:assert';
import {
  createHash,
} from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  emptyLockfile,
  type LockfileFs,
  upsertBundleEntry,
  upsertSource,
  writeLockfile,
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
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  ScopeConflictResolver,
} from '../../src/services/scope-conflict-resolver';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import type {
  Bundle,
  InstalledBundle,
  RepositoryCommitMode,
} from '../../src/types/registry';
import {
  createMockContext,
  initGitRoot,
  LOCAL_RECORD_FILE,
  RECORD_FILE,
  snapshotTree,
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

/**
 * Record checksum of a text.
 * @param text - File content.
 */
const sha256 = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`;

/**
 * Zip a bundle version with its deployment manifest.
 * @param bundle - Bundle version.
 */
const zipOf = (bundle: BundleVersion): Buffer => {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  const prompts = bundle.items.map((item) => `  - id: ${item.id}\n    file: ${item.file}\n    type: ${item.type}\n`).join('');
  zip.addFile('deployment-manifest.yml', Buffer.from(
    `id: ${BUNDLE_ID}\nversion: ${bundle.version}\nname: Record Bundle\ndescription: Test\nauthor: test\nprompts:\n${prompts}`
  ));
  for (const [file, content] of Object.entries(bundle.files)) {
    zip.addFile(file, Buffer.from(content));
  }
  return zip.toBuffer();
};

/** `LockfileFs` over Node's filesystem, for writing old-file fixtures. */
const nodeLockfileFs: LockfileFs = {
  readFile: (file) => fs.promises.readFile(file, 'utf8'),
  writeFile: (file, contents) => fs.promises.writeFile(file, contents),
  exists: (file) => Promise.resolve(fs.existsSync(file)),
  mkdir: async (dir, options) => {
    await fs.promises.mkdir(dir, options);
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

  /**
   * Record another tool's entry in the committed record file, as that tool's own install would.
   * @param tool - Tool key.
   * @param files - Root-relative files; created when missing.
   * @param bundleId - Bundle id.
   */
  const recordOtherTool = async (tool: string, files: string[], bundleId = BUNDLE_ID): Promise<void> => {
    for (const file of files.filter((candidate) => !fs.existsSync(abs(candidate)))) {
      fs.mkdirSync(path.dirname(abs(file)), { recursive: true });
      fs.writeFileSync(abs(file), `# ${tool}\n`);
    }
    const adapter = manager.getRecordAdapter();
    const [committed] = await adapter.locations(root);
    await adapter.service.recordInstall({
      location: committed, bundleId, version: '1.0.0', tool,
      source: { sourceId: SOURCE.id, type: 'github', url: SOURCE.url }, sourceType: 'github',
      writtenPaths: files.map((file) => abs(file)), syncSiblings: false
    });
  };

  /**
   * Write an old `prompt-registry.lock.json` entry listing files with their bare checksums.
   * @param bundleId - Bundle id.
   * @param files - Root-relative path → content written now; `recorded` overrides the checksummed content.
   */
  const writeOldEntry = async (bundleId: string, files: Record<string, { content: string; recorded?: string }>): Promise<void> => {
    for (const [file, { content }] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(abs(file)), { recursive: true });
      fs.writeFileSync(abs(file), content);
    }
    const lock = upsertSource(upsertBundleEntry(emptyLockfile('ai-primitives-hub-extension@0.9.0'), bundleId, {
      version: '0.9.0', sourceId: SOURCE.id, sourceType: 'github', installedAt: '2026-10-01T10:00:00.000Z',
      files: Object.entries(files).map(([file, { content, recorded }]) => ({ path: file, checksum: sha256(recorded ?? content).slice('sha256:'.length) }))
    }), SOURCE.id, { type: 'github', url: SOURCE.url });
    await writeLockfile(abs(OLD_LOCKFILE), lock, nodeLockfileFs);
  };

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
    { action: 'update', run: () => update(V2), vscodeAfter: [HELLO] }
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
    await writeOldEntry(BUNDLE_ID, { '.github/prompts/old.prompt.md': { content: 'old content' } });

    await install(V1);

    assert.ok(!fs.existsSync(abs(OLD_LOCKFILE)), 'the emptied old file is removed');
    assert.ok(!fs.existsSync(abs('.github/prompts/old.prompt.md')), 'the old file is deleted');
    assert.deepStrictEqual(Object.keys(toolsOf()), ['vscode']);
  });

  test('uninstall of an old-file-only bundle keeps a path a record entry lists and a modified file', async () => {
    const shared = '.github/prompts/shared.prompt.md';
    const modified = '.github/prompts/modified.prompt.md';
    const plain = '.github/prompts/plain.prompt.md';
    await writeOldEntry('old-bundle', {
      [shared]: { content: 'shared' },
      [modified]: { content: 'edited by the user', recorded: 'as installed' },
      [plain]: { content: 'plain' }
    });
    await recordOtherTool('vscode', [shared], 'other-bundle');

    await manager.uninstallBundle('old-bundle', 'repository');

    assert.ok(!fs.existsSync(abs(OLD_LOCKFILE)), 'the emptied old file is removed');
    assert.ok(!fs.existsSync(abs(plain)), 'the unmodified file is deleted');
    assert.strictEqual(read(shared), 'shared');
    assert.strictEqual(read(modified), 'edited by the user');
    assert.deepStrictEqual(Object.keys(toolsOf(RECORD_FILE, 'other-bundle')), ['vscode']);
  });
});
