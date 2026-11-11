/** Contract tests for the repository install record store and service on a real temp git folder. */
import {
  execFileSync,
} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type InstallRecord,
  RECORD_MAX_BYTES,
  type RecordFs,
  type RecordLocation,
  RegistryError,
  type RegistrySource,
  type SourceRecord,
  type Target,
} from '@ai-primitives-hub/core';
import {
  NodeRecordFs,
  RecordSchemaValidator,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  assertUserFolderInsideHome,
  findModifiedFiles,
  InstallRecordService,
  isLocalSourceInsideRoot,
  LOCAL_SOURCE_OUTSIDE_REASON,
  mapToolToTarget,
  type MigratedEntry,
  migrateRecords,
  type MigrationInput,
  orderConfiguredSources,
  PROFILE_STORE_NAME,
  type RecordHubInput,
  recordHubsOf,
  type RecordInstallInput,
  RecordStore,
  resolveRecordSource,
  resolveUserHome,
  selectRecord,
  type SelectRecordOptions,
  toRecordHub,
  toRecordSource,
  writerGroupFor,
} from '../../src/records';
import {
  emptyLockfile,
  findLockfile,
  type LockfileFs,
  type LockfileSourceEntry,
  upsertBundleEntry,
  writeLockfile,
} from '../../src/stores/json-lockfile-store';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const POSIX_ONLY = process.platform === 'win32';
const BUNDLE = 'acme-tools';

/** `NodeRecordFs` whose `rename` always fails, to simulate a failed atomic write. */
class FailingRenameFs extends NodeRecordFs {
  public override rename(): Promise<void> {
    return Promise.reject(new Error('EXDEV: rename failed'));
  }
}

/** `NodeRecordFs` whose `unlink` always fails, to simulate a record file that cannot be removed. */
class FailingUnlinkFs extends NodeRecordFs {
  public override unlink(): Promise<void> {
    return Promise.reject(new Error('EBUSY: unlink failed'));
  }
}

/** `NodeRecordFs` whose second rename onto a record file fails, to interrupt a two-file save. */
class SecondRecordSaveFailsFs extends NodeRecordFs {
  private recordRenames = 0;

  public override rename(from: string, to: string): Promise<void> {
    if (to.endsWith('.lock.json')) {
      this.recordRenames += 1;
      if (this.recordRenames === 2) {
        return Promise.reject(new Error('ENOSPC: second save failed'));
      }
    }
    return super.rename(from, to);
  }
}

/** `NodeRecordFs` that cannot delete an old `prompt-registry.*` file, to interrupt a migration after its saves. */
class FailingOldUnlinkFs extends NodeRecordFs {
  public override unlink(file: string): Promise<void> {
    return path.basename(file).startsWith('prompt-registry.') ? Promise.reject(new Error('EPERM: unlink failed')) : super.unlink(file);
  }
}

describe('repository install record', () => {
  let base: string;
  let root: string;
  let store: RecordStore;
  let service: InstallRecordService;
  let committed: RecordLocation;
  let localOnly: RecordLocation;

  const build = async (recordFs: RecordFs = new NodeRecordFs()): Promise<void> => {
    store = new RecordStore({ fs: recordFs, validator: new RecordSchemaValidator(), generatedBy: 'ai-primitives-hub-cli@0.3.0', now: () => NOW });
    service = new InstallRecordService({ store, fs: recordFs, now: () => NOW });
    [committed, localOnly] = await store.resolveRepository({ start: path.join(root, 'nested') });
  };

  /**
   * Write files under the root and return their absolute paths.
   * @param relativePaths - Root-relative paths.
   */
  const write = (...relativePaths: string[]): string[] => relativePaths.map((relative) => {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `content of ${relative}\n`);
    return absolute;
  });

  const install = (tool: string, files: string[], overrides: Partial<RecordInstallInput> = {}): ReturnType<InstallRecordService['recordInstall']> =>
    service.recordInstall({
      location: committed,
      bundleId: BUNDLE,
      version: '1.0.0',
      tool,
      source: { sourceId: 'acme-github', type: 'github', url: 'https://github.com/acme/tools' },
      sourceType: 'github',
      writtenPaths: write(...files),
      ...overrides
    });

  const read = (location: RecordLocation): InstallRecord => JSON.parse(fs.readFileSync(location.path, 'utf8')) as InstallRecord;
  const toolsIn = (location: RecordLocation): string[] => Object.keys(read(location).bundles[BUNDLE]?.tools ?? {}).toSorted();
  const filesOf = (location: RecordLocation, tool: string): string[] => read(location).bundles[BUNDLE].tools[tool].files.map((file) => file.path);
  const excludeText = (): string => fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8');

  const expectCode = async (promise: Promise<unknown>, code: string): Promise<void> => {
    await expect(promise).rejects.toBeInstanceOf(RegistryError);
    await expect(promise).rejects.toMatchObject({ code });
  };

  /**
   * Write a valid 3.0.0 record with one vscode entry and optional unknown fields.
   * @param location - Record file.
   * @param files - Recorded paths of the entry.
   * @param extra - Unknown fields to add.
   * @param extra.top - At the top level.
   * @param extra.entry - In the entry.
   */
  const writeRecord = (location: RecordLocation, files: string[], extra: { top?: object; entry?: object } = {}): void => {
    fs.writeFileSync(location.path, JSON.stringify({
      $schema: 'https://github.com/AmadeusITGroup/ai-primitives-hub/schemas/lockfile.schema.json',
      version: '3.0.0',
      level: 'repository',
      generatedAt: '2026-10-24T10:00:00.000Z',
      generatedBy: 'ai-primitives-hub-cli@0.3.0',
      bundles: {
        [BUNDLE]: {
          tools: {
            vscode: {
              version: '1.0.0', sourceId: 'acme-github', sourceType: 'github', installedAt: '2026-10-24T10:00:00.000Z',
              files: files.map((file) => ({ path: file, checksum: `sha256:${'0'.repeat(64)}` })),
              ...extra.entry
            }
          }
        }
      },
      sources: { 'acme-github': { type: 'github', url: 'https://github.com/acme/tools' } },
      ...extra.top
    }));
  };

  beforeEach(async () => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'install-record-')));
    root = path.join(base, 'repo');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await build();
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('keeps both entries when one bundle is installed for vscode, then kiro', async () => {
    await install('vscode', ['.github/prompts/a.prompt.md']);
    await install('kiro', ['.kiro/steering/a.md']);

    expect(committed.root).toBe(root);
    expect(toolsIn(committed)).toEqual(['kiro', 'vscode']);
    expect(filesOf(committed, 'vscode')).toEqual(['.github/prompts/a.prompt.md']);
    expect(filesOf(committed, 'kiro')).toEqual(['.kiro/steering/a.md']);
  });

  it.each([
    ['committed', (): RecordLocation => committed],
    ['local-only', (): RecordLocation => localOnly]
  ])('reinstall deletes a superseded file but keeps one another entry in the %s file lists', async (_label, otherFile) => {
    await install('kiro', ['docs/shared.md'], { location: otherFile() });
    await install('vscode', ['docs/shared.md', 'docs/old.md']);

    const change = await install('vscode', ['docs/new.md'], { syncSiblings: false });
    const removal = await service.deleteSuperseded(change);

    expect(change).toMatchObject({ deletedFiles: ['docs/old.md'], keptSharedFiles: ['docs/shared.md'] });
    expect(removal).toEqual({ deleted: ['docs/old.md'], warnings: [] });
    expect(fs.existsSync(path.join(root, 'docs', 'old.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'docs', 'shared.md'))).toBe(true);
    expect(filesOf(committed, 'vscode')).toEqual(['docs/new.md']);
  });

  it('moves the entry to the other file when the commit mode changes, leaving it in one file', async () => {
    await install('vscode', ['.github/prompts/a.prompt.md']);

    await install('vscode', ['.github/prompts/a.prompt.md'], { location: localOnly });

    expect(fs.existsSync(committed.path)).toBe(false);
    expect(toolsIn(localOnly)).toEqual(['vscode']);
  });

  it('uninstall removes only that tool\'s entry and returns its files', async () => {
    await install('vscode', ['.github/prompts/a.prompt.md']);
    await install('kiro', ['.kiro/steering/a.md']);

    const change = await service.recordUninstall({ location: committed, bundleId: BUNDLE, tool: 'kiro' });

    expect(change.deletedFiles).toEqual(['.kiro/steering/a.md']);
    expect(toolsIn(committed)).toEqual(['vscode']);
  });

  it('uninstallEntry deletes the entry\'s files but keeps a shared, an edited, a missing and a caller-kept one', async () => {
    await install('kiro', ['docs/shared.md']);
    await install('vscode', ['docs/shared.md', 'docs/edited.md', 'docs/gone.md', 'docs/held.md', 'docs/plain.md'], { location: localOnly });
    fs.writeFileSync(path.join(root, 'docs', 'edited.md'), 'my own edits\n');
    fs.rmSync(path.join(root, 'docs', 'gone.md'));

    const result = await service.uninstallEntry({ location: localOnly, bundleId: BUNDLE, tool: 'vscode', keep: new Set(['docs/held.md']) });

    expect(result).toMatchObject({
      deleted: ['docs/plain.md'],
      kept: ['docs/shared.md', 'docs/edited.md', 'docs/gone.md', 'docs/held.md'],
      modified: ['docs/edited.md']
    });
    expect(fs.existsSync(path.join(root, 'docs', 'plain.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'docs', 'edited.md'))).toBe(true);
    expect(fs.existsSync(localOnly.path)).toBe(false);
    expect(toolsIn(committed)).toEqual(['kiro']);
  });

  it('keeps both entries when two installs at one root are recorded at the same time', async () => {
    await Promise.all([
      install('vscode', ['.github/prompts/a.prompt.md']),
      install('vscode', ['.github/prompts/b.prompt.md'], { bundleId: 'other-tools' }),
      install('kiro', ['.kiro/steering/a.md'])
    ]);

    expect(Object.keys(read(committed).bundles).toSorted()).toEqual([BUNDLE, 'other-tools']);
    expect(toolsIn(committed)).toEqual(['kiro', 'vscode']);
  });

  it('uninstalling the last local-only entry deletes the file and its info/exclude line', async () => {
    await install('vscode', ['.github/prompts/a.prompt.md'], { location: localOnly });

    await service.recordUninstall({ location: committed, bundleId: BUNDLE, tool: 'vscode' });

    expect(fs.existsSync(localOnly.path)).toBe(false);
    expect(excludeText()).not.toContain('ai-primitives-hub.local.lock.json');
  });

  it('saves the last entry\'s record empty when it cannot be removed, so it lists no deleted file', async () => {
    await install('vscode', ['.github/prompts/a.prompt.md']);
    await build(new FailingUnlinkFs());

    const change = await service.recordUninstall({ location: committed, bundleId: BUNDLE, tool: 'vscode' });

    expect(change.deletedFiles).toEqual(['.github/prompts/a.prompt.md']);
    expect(change.warnings.join('\n')).toContain('Could not remove the empty record');
    expect(read(committed).bundles).toEqual({});
  });

  it('adds the local-only file to info/exclude before writing it', async () => {
    let excludedFirst: boolean | undefined;
    class WatchingFs extends NodeRecordFs {
      public override async rename(from: string, to: string): Promise<void> {
        if (to === localOnly.path) {
          excludedFirst = excludeText().includes('ai-primitives-hub.local.lock.json');
        }
        await super.rename(from, to);
      }
    }
    await build(new WatchingFs());

    await install('vscode', ['.github/prompts/a.prompt.md'], { location: localOnly });

    expect(excludedFirst).toBe(true);
  });

  it('adds the local-only file to info/exclude once', async () => {
    await install('vscode', ['.github/prompts/a.prompt.md'], { location: localOnly });
    await install('kiro', ['.kiro/steering/a.md'], { location: localOnly });

    const lines = excludeText().split('\n');
    expect(lines.filter((line) => line === 'ai-primitives-hub.local.lock.json')).toHaveLength(1);
    expect(lines).toContain('# Prompt Registry (local)');
  });

  it('adds the local-only file to the common info/exclude of a worktree', async () => {
    const common = path.join(base, 'main.git');
    const worktreeGitDir = path.join(common, 'worktrees', 'repo');
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
    fs.rmSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git'), `gitdir: ${worktreeGitDir}\n`);

    const change = await install('vscode', ['.github/prompts/a.prompt.md'], { location: localOnly });

    expect(change.warnings).toEqual([]);
    expect(fs.readFileSync(path.join(common, 'info', 'exclude'), 'utf8')).toContain('ai-primitives-hub.local.lock.json');
  });

  it('never overwrites a malformed record and refuses the write', async () => {
    fs.writeFileSync(committed.path, '{ "version": "3.0.0", ');

    await expectCode(install('vscode', ['.github/prompts/a.prompt.md']), 'RECORD.MALFORMED');
    await expectCode(store.save(committed, (await store.load(localOnly)).record), 'RECORD.MALFORMED');

    expect(fs.readFileSync(committed.path, 'utf8')).toBe('{ "version": "3.0.0", ');
    expect(fs.existsSync(localOnly.path)).toBe(false);
  });

  it('leaves the previous record intact with RECORD.WRITE_FAILED when the rename fails', async () => {
    await install('vscode', ['.github/prompts/a.prompt.md']);
    const before = fs.readFileSync(committed.path, 'utf8');
    await build(new FailingRenameFs());

    await expectCode(install('kiro', ['.kiro/steering/a.md']), 'RECORD.WRITE_FAILED');

    expect(fs.readFileSync(committed.path, 'utf8')).toBe(before);
    expect(fs.readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it.each([
    ['larger than 10 MB', (file: string): void => fs.writeFileSync(file, ' '.repeat(RECORD_MAX_BYTES + 1))],
    ['a folder', (file: string): void => fs.mkdirSync(file)],
    ...(POSIX_ONLY ? [] : [['a FIFO', (file: string): void => execFileSync('mkfifo', [file])] as const])
  ])('refuses a record file that is %s', async (_label, create) => {
    create(committed.path);

    await expectCode(store.load(committed), 'RECORD.MALFORMED');
  });

  it.skipIf(POSIX_ONLY)('refuses a recorded path whose folder is a symlink leaving the root', async () => {
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, '.github'), 'dir');
    writeRecord(committed, ['.github/prompts/a.prompt.md']);

    await expectCode(store.load(committed), 'RECORD.PATH_OUTSIDE_ROOT');
  });

  it.skipIf(POSIX_ONLY)('removes a superseded symlink without following it', async () => {
    const target = path.join(base, 'outside.md');
    fs.writeFileSync(target, 'keep me');
    fs.mkdirSync(path.join(root, 'docs'));
    fs.symlinkSync(target, path.join(root, 'docs', 'link.md'), 'file');

    const removal = await service.deleteSuperseded({ deletedFiles: ['docs/link.md'], location: committed });

    expect(removal.deleted).toEqual(['docs/link.md']);
    expect(fs.existsSync(path.join(root, 'docs', 'link.md'))).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('keep me');
  });

  it('keeps unknown fields of a loaded record when it is saved again', async () => {
    writeRecord(committed, ['.github/prompts/a.prompt.md'], { top: { futureTop: { kept: true } }, entry: { futureEntry: 1 } });

    await install('kiro', ['.kiro/steering/a.md']);

    const record = read(committed) as InstallRecord & { futureTop?: unknown };
    expect(record.futureTop).toEqual({ kept: true });
    expect(record.bundles[BUNDLE].tools.vscode).toMatchObject({ futureEntry: 1 });
  });

  it.each([
    ['https://user:pass@github.com/acme/tools', 'https://github.com/acme/tools'],
    ['https://github.com/acme/tools?token=abc&ref=main', 'https://github.com/acme/tools?ref=main'],
    ['https://host.example/repo?auth=Bearer%20x&Authorization=y&credential=z&ref=main', 'https://host.example/repo?ref=main'],
    ['deploy@host.example:acme/tools.git', 'host.example:acme/tools.git'],
    ['git@github.com:acme/tools.git', 'git@github.com:acme/tools.git'],
    [String.raw`C:\Users\a@b\x`, String.raw`C:\Users\a@b\x`]
  ])('records source %s as %s', async (url, expected) => {
    await install('vscode', ['.github/prompts/a.prompt.md'], {
      source: { sourceId: 'acme-github', type: 'github', url, token: 'ghp_secret' }
    });

    expect(read(committed).sources['acme-github']).toEqual({ type: 'github', url: expected });
  });

  it('leaves merged MCP config files out of the record', async () => {
    await install('vscode', ['.vscode/mcp.json', '.github/prompts/a.prompt.md']);

    expect(filesOf(committed, 'vscode')).toEqual(['.github/prompts/a.prompt.md']);
  });

  it('writes byte-identical output whatever the key and file order of the record', async () => {
    const reversed = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        return value.map((item) => reversed(item)).toReversed();
      }
      if (typeof value !== 'object' || value === null) {
        return value;
      }
      return Object.fromEntries(Object.entries(value).toReversed().map(([key, item]) => [key, reversed(item)]));
    };
    await install('vscode', ['.github/prompts/a.prompt.md', '.github/prompts/b.prompt.md']);
    await install('kiro', ['.kiro/steering/a.md']);
    const canonical = fs.readFileSync(committed.path, 'utf8');

    const loaded = await store.load(committed);
    await store.save(committed, reversed(loaded.record) as InstallRecord);

    expect(fs.readFileSync(committed.path, 'utf8')).toBe(canonical);
  });

  describe('hub reference', () => {
    const HUB: RecordHubInput = { id: 'acme-hub', name: 'Acme Hub', type: 'github', location: 'acme/hub', ref: 'main' };
    const hubSource = { sourceId: 'acme-github', type: 'github', url: 'https://github.com/acme/tools', hubId: HUB.id };
    const installFromHub = (tool: string, files: string[], overrides: Partial<RecordInstallInput> = {}): ReturnType<typeof install> =>
      install(tool, files, { source: hubSource, hub: HUB, ...overrides });
    const configured = (hubId: string): RegistrySource => ({
      id: 'acme-github', name: 'Acme', type: 'github', url: 'https://github.com/acme/tools', enabled: true, priority: 0, hubId
    });

    it('refuses the same source through a second hub with RECORD.HUB_CONFLICT and changes nothing', async () => {
      await installFromHub('vscode', ['.github/prompts/a.prompt.md']);
      const before = fs.readFileSync(committed.path, 'utf8');
      const other: RecordHubInput = { ...HUB, id: 'other-hub', location: 'other/hub' };

      await expectCode(installFromHub('kiro', ['.kiro/steering/a.md'], { source: { ...hubSource, hubId: other.id }, hub: other }), 'RECORD.HUB_CONFLICT');

      expect(fs.readFileSync(committed.path, 'utf8')).toBe(before);
    });

    it('records the same source with no hub next to a hub install, keeping its hub', async () => {
      await installFromHub('vscode', ['.github/prompts/a.prompt.md']);
      const { hubId: _hubId, ...withoutHub } = hubSource;

      await install('kiro', ['.kiro/steering/a.md'], { source: withoutHub });

      expect(toolsIn(committed)).toEqual(['kiro', 'vscode']);
    });

    it('records the source hubId and the hub import reference', async () => {
      await install('vscode', ['.github/prompts/a.prompt.md'], { source: toRecordSource(configured(HUB.id), 'acme-github', HUB), hub: HUB });

      const record = read(committed);
      expect(record.sources['acme-github']).toEqual({ type: 'github', url: 'https://github.com/acme/tools', hubId: 'acme-hub' });
      expect(record.hubs).toEqual({ 'acme-hub': { name: 'Acme Hub', type: 'github', location: 'acme/hub', ref: 'main' } });
      expect(await service.listEntries([committed])).toMatchObject([{ bundleId: BUNDLE, tool: 'vscode', hubId: 'acme-hub' }]);
    });

    it('never records a credential or an unknown hub field', async () => {
      const hub = {
        ...HUB, type: 'artifactory', location: 'https://user:pass@art.example/hub?token=SECRET&x=1',
        authMode: 'bearer', credentialRef: 'ART_TOKEN', token: 'SECRET', configFile: 'hubs/hub-config.yml'
      } as RecordHubInput;

      await installFromHub('vscode', ['.github/prompts/a.prompt.md'], { hub });

      const text = fs.readFileSync(committed.path, 'utf8');
      expect(read(committed).hubs).toEqual({
        'acme-hub': { name: 'Acme Hub', type: 'artifactory', location: 'https://art.example/hub?x=1', ref: 'main', configFile: 'hubs/hub-config.yml' }
      });
      expect(text).not.toMatch(/SECRET|pass|ART_TOKEN|bearer/);
    });

    it.each([
      ['the built-in local hub', { ...HUB, id: 'default-local' }],
      ['a local-path hub', { ...HUB, type: 'local', location: path.join(os.tmpdir(), 'hub') }],
      ['a GitHub hub given as a local path', { ...HUB, location: '/home/me/hub' }],
      ['a file URL hub', { ...HUB, type: 'url', location: 'file:///home/me/hub-config.yml' }]
    ] as [string, RecordHubInput][])('does not record %s', async (_label, hub) => {
      expect(toRecordHub(hub.id, hub.name, hub)).toBeUndefined();
      expect(toRecordSource(configured(hub.id), 'acme-github', hub).hubId).toBeUndefined();

      await install('vscode', ['.github/prompts/a.prompt.md'], { source: { ...hubSource, hubId: hub.id }, hub });

      const record = read(committed);
      expect(record.sources['acme-github'].hubId).toBeUndefined();
      expect(record.hubs).toBeUndefined();
    });

    it('records the hubs of configured hubs that are shareable only', () => {
      const hubs = recordHubsOf([
        { id: 'acme-hub', name: 'Acme Hub', reference: { type: 'github', location: 'acme/hub', ref: 'main' } },
        { id: 'default-local', name: 'Local', reference: { type: 'local', location: '/tmp/local' } },
        { id: 'mine', name: 'Mine', reference: { type: 'local', location: 'C:\\hubs\\mine' } },
        { id: 'web', name: '', reference: { type: 'url', location: 'https://hubs.example/hub-config.yml' } }
      ]);

      expect([...hubs.keys()]).toEqual(['acme-hub', 'web']);
      expect(hubs.get('web')?.name).toBe('web');
    });

    it('drops the hubs entry with the last source that names it', async () => {
      await installFromHub('vscode', ['.github/prompts/a.prompt.md']);
      await install('vscode', ['.github/prompts/b.prompt.md'], { bundleId: 'other-bundle', source: { sourceId: 'plain', type: 'github', url: 'https://github.com/acme/plain' } });
      expect(Object.keys(read(committed).hubs ?? {})).toEqual(['acme-hub']);

      await service.recordUninstall({ location: committed, bundleId: BUNDLE, tool: 'vscode' });

      const record = read(committed);
      expect(Object.keys(record.sources)).toEqual(['plain']);
      expect(record.hubs).toBeUndefined();
    });

    it('drops hubs carried over by migration that no source names', async () => {
      writeRecord(committed, ['.github/prompts/old.prompt.md'], { top: { hubs: { 'old-hub': { name: 'Old', url: 'https://hubs.example/old.yml' } } } });

      await install('kiro', ['.kiro/steering/a.md']);

      expect(read(committed).hubs).toBeUndefined();
    });

    it('keeps the recorded hub when the same source is installed again without one', async () => {
      await installFromHub('vscode', ['.github/prompts/a.prompt.md']);

      await install('kiro', ['.kiro/steering/a.md'], { source: hubSource });

      expect(read(committed).hubs).toEqual({ 'acme-hub': { name: 'Acme Hub', type: 'github', location: 'acme/hub', ref: 'main' } });
    });

    it('drops a hubId no hub entry backs and keeps one that has an entry', async () => {
      await installFromHub('vscode', ['.github/prompts/a.prompt.md']);

      await install('vscode', ['.github/prompts/b.prompt.md'], { bundleId: 'other-bundle', source: { ...hubSource, sourceId: 'other', hubId: 'unknown-hub' } });

      const { sources } = read(committed);
      expect([sources['acme-github'].hubId, sources.other.hubId]).toEqual(['acme-hub', undefined]);
    });

    it('moves the hub with an entry to the other repository file', async () => {
      await installFromHub('vscode', ['.github/prompts/a.prompt.md']);

      await service.moveEntry({ location: committed, bundleId: BUNDLE, tool: 'vscode' });

      expect(read(localOnly).sources['acme-github'].hubId).toBe('acme-hub');
      expect(read(localOnly).hubs).toEqual({ 'acme-hub': { name: 'Acme Hub', type: 'github', location: 'acme/hub', ref: 'main' } });
      expect(fs.existsSync(committed.path)).toBe(false);
    });

    it('keeps the hubId when a source id is remapped', async () => {
      await installFromHub('vscode', ['.github/prompts/a.prompt.md']);

      await service.remapSource({ root, from: 'acme-github', to: 'acme-renamed', descriptor: { type: 'github', url: 'https://github.com/acme/tools' } });

      const record = read(committed);
      expect(record.sources).toEqual({ 'acme-renamed': { type: 'github', url: 'https://github.com/acme/tools', hubId: 'acme-hub' } });
      expect(Object.keys(record.hubs ?? {})).toEqual(['acme-hub']);
    });

    it('replays from the configured source of the recorded hub before one of the same id from another hub', async () => {
      const other: RegistrySource = { ...configured('other-hub'), url: 'https://github.com/other/tools' };
      const sameHub: RegistrySource = { ...configured(HUB.id), url: 'https://github.com/acme/moved' };
      const decision = await resolveRecordSource('acme-github', { type: 'github', url: 'https://github.com/acme/tools', hubId: HUB.id },
        new Map([['acme-github', other]]), root, new NodeRecordFs(), { candidates: [other, sameHub], hubs: new Map([[HUB.id, HUB]]) });

      expect(decision).toEqual({
        use: { sourceId: 'acme-github', type: 'github', url: 'https://github.com/acme/moved', hubId: HUB.id }, configured: true, hub: HUB
      });
    });
  });

  describe('one version per bundle and tool', () => {
    const COLL = 'acme-tools-coll';
    const entries = (location: RecordLocation): string[] => Object.entries(read(location).bundles)
      .flatMap(([key, bundle]) => Object.entries(bundle.tools).map(([tool, entry]) => `${key} ${tool} ${entry.version}`))
      .toSorted();
    const installVersion = (tool: string, version: string, files: string[], overrides: Partial<RecordInstallInput> = {}): ReturnType<typeof install> =>
      install(tool, files, { bundleId: `${COLL}-${version}`, version, ...overrides });

    it.each([
      ['upgrade', '1.0.0', '2.0.0'],
      ['downgrade', '2.0.0', '1.0.0']
    ])('%s keeps only the installed version and deletes files only the old one listed', async (_label, from, to) => {
      await installVersion('vscode', from, ['docs/shared.md', 'docs/old.md']);

      const change = await installVersion('vscode', to, ['docs/shared.md', 'docs/new.md']);
      const removal = await service.deleteSuperseded(change);

      expect(entries(committed)).toEqual([`${COLL}-${to} vscode ${to}`]);
      expect(change).toMatchObject({ deletedFiles: ['docs/old.md'], keptSharedFiles: [] });
      expect(removal.deleted).toEqual(['docs/old.md']);
      expect(fs.existsSync(path.join(root, 'docs', 'shared.md'))).toBe(true);
    });

    it('leaves another tool\'s entry of the old version untouched', async () => {
      await installVersion('kiro', '1.0.0', ['docs/shared.md']);
      await installVersion('vscode', '1.0.0', ['docs/shared.md']);

      const change = await installVersion('vscode', '2.0.0', ['docs/new.md'], { syncSiblings: false });

      expect(entries(committed)).toEqual([`${COLL}-1.0.0 kiro 1.0.0`, `${COLL}-2.0.0 vscode 2.0.0`]);
      expect(change).toMatchObject({ deletedFiles: [], keptSharedFiles: ['docs/shared.md'] });
    });

    it.each([
      ['committed', (): RecordLocation => committed],
      ['local-only', (): RecordLocation => localOnly]
    ])('moves a synced sibling of the old version\'s key in the %s file to the installed key', async (_label, siblingFile) => {
      await installVersion('vscode-insiders', '1.0.0', ['.github/prompts/a.prompt.md', '.github/agents/own.agent.md'], { location: siblingFile() });
      await installVersion('vscode', '1.0.0', ['.github/prompts/a.prompt.md']);

      const change = await installVersion('vscode', '2.0.0', ['.github/prompts/a.prompt.md']);

      expect(change.siblings).toEqual([{ tool: 'vscode-insiders', version: '2.0.0', location: siblingFile(), synced: true }]);
      expect(entries(siblingFile()).filter((row) => row.includes('vscode-insiders'))).toEqual([`${COLL}-2.0.0 vscode-insiders 2.0.0`]);
      expect(read(siblingFile()).bundles[`${COLL}-2.0.0`].tools['vscode-insiders'].files.map((file) => file.path))
        .toEqual(['.github/agents/own.agent.md', '.github/prompts/a.prompt.md']);
    });

    it('reports a sibling of the old version\'s key it does not sync and leaves it there', async () => {
      await installVersion('vscode-insiders', '1.0.0', ['.github/prompts/a.prompt.md']);
      await installVersion('vscode', '1.0.0', ['.github/prompts/a.prompt.md']);

      const change = await installVersion('vscode', '2.0.0', ['.github/prompts/a.prompt.md'], { syncSiblings: (tool) => tool !== 'vscode-insiders' });

      expect(change.siblings).toEqual([{ tool: 'vscode-insiders', version: '1.0.0', location: committed, synced: false }]);
      expect(entries(committed)).toEqual([`${COLL}-1.0.0 vscode-insiders 1.0.0`, `${COLL}-2.0.0 vscode 2.0.0`]);
    });

    it('removes the old version from the committed file when the new one is installed local-only', async () => {
      await installVersion('vscode', '1.0.0', ['docs/a.md']);

      await installVersion('vscode', '2.0.0', ['docs/a.md'], { location: localOnly });

      expect(fs.existsSync(committed.path)).toBe(false);
      expect(entries(localOnly)).toEqual([`${COLL}-2.0.0 vscode 2.0.0`]);
    });

    it('keeps a different bundle whose id starts the same', async () => {
      await install('vscode', ['docs/extra.md'], { bundleId: `${COLL}-extra-1.0.0` });
      await installVersion('vscode', '1.0.0', ['docs/a.md']);

      await installVersion('vscode', '2.0.0', ['docs/a.md']);

      expect(entries(committed)).toEqual([`${COLL}-2.0.0 vscode 2.0.0`, `${COLL}-extra-1.0.0 vscode 1.0.0`]);
    });

    it('replaces a non-versioned id in place', async () => {
      await install('vscode', ['docs/a.md']);

      await install('vscode', ['docs/a.md'], { version: '2.0.0' });

      expect(entries(committed)).toEqual([`${BUNDLE} vscode 2.0.0`]);
    });

    it('moveEntry replaces the tool\'s older version in the target file and returns the files only that version listed', async () => {
      await installVersion('kiro', '1.0.0', ['.kiro/steering/a.md'], { syncSiblings: false });
      await installVersion('vscode', '1.0.0', ['docs/shared.md', 'docs/old.md']);
      const committedWithOldVersion = fs.readFileSync(committed.path, 'utf8');
      await installVersion('vscode', '2.0.0', ['docs/shared.md', 'docs/new.md'], { location: localOnly });
      fs.writeFileSync(committed.path, committedWithOldVersion);

      const moved = await service.moveEntry({ location: localOnly, bundleId: `${COLL}-2.0.0`, tool: 'vscode' });

      expect(entries(committed)).toEqual([`${COLL}-1.0.0 kiro 1.0.0`, `${COLL}-2.0.0 vscode 2.0.0`]);
      expect(fs.existsSync(localOnly.path)).toBe(false);
      expect(moved).toMatchObject({ to: committed, deletedFiles: ['docs/old.md'], keptSharedFiles: [] });
    });
  });

  describe('record selection, target mapping and source gate', () => {
    const recordFs = new NodeRecordFs();
    let userLockfile: string;
    let cwd: string;

    const select = (given?: SelectRecordOptions['given']): ReturnType<typeof selectRecord> => selectRecord({
      store,
      fs: recordFs,
      cwd,
      given,
      findOldLockfile: (start) => findLockfile(start, { exists: (file) => Promise.resolve(fs.existsSync(file)) }, userLockfile),
      userLockfile
    });

    const target = (name: string, type: Target['type'], scope: Target['scope'], rootPath?: string): Target =>
      ({ name, type, scope, ...(rootPath === undefined ? {} : { rootPath, commitMode: 'commit' }) });

    const absolute = (...relativePaths: string[]): string[] => relativePaths.map((relative) => path.join(root, relative));

    beforeEach(() => {
      userLockfile = path.join(base, 'config', 'ai-primitives-hub.lock.json');
      fs.mkdirSync(path.dirname(userLockfile), { recursive: true });
      fs.writeFileSync(userLockfile, '{}');
      cwd = path.join(root, 'nested');
      fs.mkdirSync(cwd, { recursive: true });
    });

    it.each([
      ['--lockfile names a repository record', (): SelectRecordOptions['given'] => ({ lockfile: committed.path }),
        { level: 'repository', reason: 'lockfile-flag', files: (): string[] => [committed.path] }],
      ['--lockfile names the user lockfile', (): SelectRecordOptions['given'] => ({ lockfile: userLockfile, scope: 'repository' }),
        { level: 'user', reason: 'lockfile-flag', files: (): string[] => [] }],
      ['--scope repository', (): SelectRecordOptions['given'] => ({ scope: 'repository', target: target('k', 'kiro', 'user') }),
        { level: 'repository', reason: 'explicit-scope', files: (): string[] => [committed.path, localOnly.path] }],
      ['--scope user', (): SelectRecordOptions['given'] => ({ scope: 'user' }),
        { level: 'user', reason: 'explicit-scope', files: (): string[] => [] }],
      ['a repository target', (): SelectRecordOptions['given'] => ({ target: target('k', 'kiro', 'repository', cwd) }),
        { level: 'repository', reason: 'target-scope', files: (): string[] => [committed.path, localOnly.path] }],
      ['a workspace target', (): SelectRecordOptions['given'] => ({ target: target('k', 'kiro', 'workspace', cwd) }),
        { level: 'user', reason: 'target-scope', files: (): string[] => [] }]
    ])('a given level from %s picks that level', async (_label, given, expected) => {
      const selection = await select(given());

      expect({ level: selection.level, reason: selection.reason, inferred: selection.inferred, files: selection.locations.map((location) => location.path) })
        .toEqual({ level: expected.level, reason: expected.reason, inferred: false, files: expected.files() });
    });

    it('--lockfile also checks the other record file, which an install of the selected one loads', async () => {
      fs.writeFileSync(localOnly.path, '{ "version": "3.0.0", ');

      await expectCode(select({ lockfile: committed.path }), 'RECORD.MALFORMED');
    });

    it.each([
      ['a new record file is at the git root', (): void => {
        writeRecord(committed, ['.github/prompts/a.prompt.md']);
      }, { level: 'repository', reason: 'repository-record-found', old: (): string | undefined => undefined }],
      ['only an old prompt-registry file is found', (): void => {
        fs.writeFileSync(path.join(root, 'prompt-registry.lock.json'), '{}');
      }, { level: 'repository', reason: 'repository-record-found', old: (): string | undefined => path.join(root, 'prompt-registry.lock.json') }],
      ['only an old prompt-registry file below the git root is found', (): void => {
        fs.writeFileSync(path.join(cwd, 'prompt-registry.lock.json'), '{}');
      }, { level: 'user', reason: 'user-fallback', old: (): string | undefined => userLockfile }],
      ['neither is there', (): void => undefined,
        { level: 'user', reason: 'user-fallback', old: (): string | undefined => userLockfile }]
    ])('with no level, %s selects the %s level', async (_label, arrange, expected) => {
      arrange();

      const selection = await select();

      expect({ level: selection.level, reason: selection.reason, inferred: selection.inferred, old: selection.oldLockfile })
        .toEqual({ level: expected.level, reason: expected.reason, inferred: true, old: expected.old() });
    });

    it('stops with RECORD.MALFORMED before returning a selection with a malformed record', async () => {
      fs.writeFileSync(localOnly.path, '{ "version": "3.0.0", ');

      await expectCode(select({ scope: 'repository' }), 'RECORD.MALFORMED');
    });

    it.each([
      ['an explicit target of the tool\'s type', 'kiro', 'kiro-main', { target: 'kiro-main' }],
      ['an explicit target of another type', 'vscode', 'kiro-main', { skip: '--target kiro-main is a kiro target, not vscode' }],
      ['the single matching target', 'kiro', undefined, { target: 'kiro-main' }],
      ['several matching targets', 'vscode', undefined, { target: 'vscode-a', note: 'several vscode targets match; using vscode-a' }],
      ['no target of the type', 'claude-code', undefined, { skip: 'no claude-code target configured; add one with `target add`' }],
      ['a target on another git root only', 'copilot-cli', undefined, { skip: 'no copilot-cli target configured; add one with `target add`' }]
    ])('maps a repository tool with %s', async (_label, tool, explicitName, expected) => {
      const otherRepo = path.join(base, 'other');
      fs.mkdirSync(path.join(otherRepo, '.git'), { recursive: true });
      const targets = [
        target('vscode-b', 'vscode', 'repository', cwd),
        target('vscode-a', 'vscode', 'repository', root),
        target('kiro-main', 'kiro', 'repository', root),
        target('kiro-user', 'kiro', 'user'),
        target('copilot-other', 'copilot-cli', 'repository', otherRepo)
      ];

      const mapping = await mapToolToTarget({
        fs: recordFs, tool, level: 'repository', gitRoot: root, targets, cwd,
        explicit: targets.find((candidate) => candidate.name === explicitName)
      });

      expect('skip' in mapping ? { skip: mapping.skip } : { target: mapping.target.name, ...(mapping.note === undefined ? {} : { note: mapping.note }) })
        .toEqual(expected);
    });

    describe('resolveRecordSource', () => {
      const configured = new Map<string, RegistrySource>([['acme-github', {
        id: 'acme-github', name: 'Acme', type: 'github', url: 'https://github.com/acme/configured', enabled: true, priority: 0,
        config: { branch: 'main', credentialRef: 'ACME_TOKEN' }
      }], ['art-configured', {
        id: 'art-configured', name: 'Art', type: 'artifactory', url: 'https://art.example/configured', enabled: true, priority: 0,
        config: { indexFile: 'index-v1.json', credentialRef: 'ART_TOKEN' }
      }]]);

      beforeEach(() => {
        fs.mkdirSync(path.join(root, 'sources', 'local'), { recursive: true });
        fs.mkdirSync(path.join(base, 'outside'), { recursive: true });
      });

      it.each([
        ['a configured source wins over a different record URL', 'acme-github',
          (): SourceRecord => ({ type: 'github', url: 'https://evil.example/acme', credentialRef: 'EVIL_TOKEN' }),
          (): object => ({ use: { sourceId: 'acme-github', type: 'github', url: 'https://github.com/acme/configured', branch: 'main' }, configured: true })],
        ['a configured Artifactory source without authMode is used as anonymous, also for a record written without it', 'art-configured',
          (): SourceRecord => ({ type: 'artifactory', url: 'https://art.example/configured', indexFile: 'index-v1.json' }),
          (): object => ({ use: {
            sourceId: 'art-configured', type: 'artifactory', url: 'https://art.example/configured',
            indexFile: 'index-v1.json', authMode: 'anonymous', credentialRef: 'ART_TOKEN'
          }, configured: true })],
        ['an unconfigured source loses its credentialRef and authMode', 'art',
          (): SourceRecord => ({ type: 'artifactory', url: 'https://art.example/repo', indexFile: 'index.json', authMode: 'bearer', credentialRef: 'GITHUB_TOKEN' }),
          (): object => ({ use: { sourceId: 'art', type: 'artifactory', url: 'https://art.example/repo', indexFile: 'index.json' } })],
        ['a relative local source inside the root is used by its real path', 'mine',
          (): SourceRecord => ({ type: 'local', url: 'sources/local' }),
          (): object => ({ use: { sourceId: 'mine', type: 'local', url: path.join(root, 'sources', 'local') } })],
        ['a local source leaving the root through .. is skipped', 'mine',
          (): SourceRecord => ({ type: 'local', url: '../outside' }),
          (): object => ({ skip: LOCAL_SOURCE_OUTSIDE_REASON })],
        ['an absolute local source outside the root is skipped', 'mine',
          (): SourceRecord => ({ type: 'local-skills', url: path.join(base, 'outside') }),
          (): object => ({ skip: LOCAL_SOURCE_OUTSIDE_REASON })]
      ])('%s', async (_label, sourceId, fromRecord, expected) => {
        const decision = await resolveRecordSource(sourceId, fromRecord(), configured, root, recordFs);

        expect(decision).toEqual(expected());
      });

      it.skipIf(POSIX_ONLY)('skips a local source that leaves the root through a symlink', async () => {
        fs.symlinkSync(path.join(base, 'outside'), path.join(root, 'sources', 'link'), 'dir');

        const decision = await resolveRecordSource('mine', { type: 'local', url: 'sources/link' }, configured, root, recordFs);

        expect(decision).toEqual({ skip: LOCAL_SOURCE_OUTSIDE_REASON });
      });
    });

    describe('toRecordSource', () => {
      const configuredSource = (type: RegistrySource['type'], config: RegistrySource['config']): RegistrySource => ({
        id: 'src', name: 'Source', type, url: 'https://example.test/source', enabled: true, priority: 0, token: 'SECRET_TOKEN', config
      });

      it.each([
        ['Artifactory without authMode records anonymous', configuredSource('artifactory', { indexFile: 'index-v1.json' }),
          { type: 'artifactory', url: 'https://example.test/source', indexFile: 'index-v1.json', authMode: 'anonymous' }],
        ['Artifactory bearer keeps its credentialRef and drops branch', configuredSource('artifactory', { authMode: 'bearer', credentialRef: 'ART_TOKEN', branch: 'main' }),
          { type: 'artifactory', url: 'https://example.test/source', authMode: 'bearer', credentialRef: 'ART_TOKEN' }],
        ['GitHub keeps branch and collectionsPath and drops Artifactory fields', configuredSource('github', { branch: 'main', collectionsPath: 'collections', authMode: 'bearer', credentialRef: 'X' }),
          { type: 'github', url: 'https://example.test/source', branch: 'main', collectionsPath: 'collections' }],
        ['an empty collectionsPath is not recorded', configuredSource('awesome-copilot', { collectionsPath: '' }),
          { type: 'awesome-copilot', url: 'https://example.test/source' }]
      ] as [string, RegistrySource, Record<string, string>][])('%s', (_label, configured, expected) => {
        const recorded = toRecordSource(configured);

        expect({ ...recorded }).toEqual(expected);
        expect(Object.getPrototypeOf(recorded)).toBeNull();
      });

      it('sets the record key when one is given', () => {
        expect({ ...toRecordSource(configuredSource('github', {}), 'acme') }).toEqual({ sourceId: 'acme', type: 'github', url: 'https://example.test/source' });
      });
    });

    it.each([
      ['active hub, then detached sources; other hubs left out', {}, ['shared@hub-a', 'only-a@hub-a', 'detached@default-local']],
      ['other hubs last when included', { includeOtherHubs: true }, ['shared@hub-a', 'only-a@hub-a', 'detached@default-local', 'only-b@hub-b']]
    ])('orderConfiguredSources: %s, first id wins', (_label, options, expected) => {
      const source = (id: string, hubId: string): RegistrySource => ({ id, name: id, type: 'github', url: `https://github.com/acme/${id}`, enabled: true, priority: 0, hubId });
      const sources = [source('shared', 'hub-b'), source('only-b', 'hub-b'), source('detached', 'default-local'), source('shared', 'hub-a'), source('only-a', 'hub-a')];

      expect(orderConfiguredSources(sources, 'hub-a', options).map((ordered) => `${ordered.id}@${ordered.hubId}`)).toEqual(expected);
    });

    it('lists one row per bundle and tool over both files, sorted, with their record path', async () => {
      await install('vscode', ['.github/prompts/a.prompt.md']);
      await install('kiro', ['.kiro/steering/a.md'], { location: localOnly });

      const rows = await service.listEntries([committed, localOnly]);

      expect(rows).toEqual([
        { bundleId: BUNDLE, tool: 'kiro', level: 'repository', version: '1.0.0', record: localOnly.path, needsReinstall: false },
        { bundleId: BUNDLE, tool: 'vscode', level: 'repository', version: '1.0.0', record: committed.path, needsReinstall: false }
      ]);
    });

    it('re-recording vscode at a new version moves copilot-cli\'s version and shared list and keeps its own files', async () => {
      await install('copilot-cli', ['.github/prompts/a.prompt.md', '.github/agents/own.agent.md']);
      await install('vscode', ['.github/prompts/a.prompt.md']);
      write('.github/prompts/b.prompt.md');
      fs.writeFileSync(path.join(root, '.github', 'prompts', 'a.prompt.md'), 'version 2\n');

      const change = await service.recordInstall({
        location: committed, bundleId: BUNDLE, version: '2.0.0', tool: 'vscode',
        source: { sourceId: 'acme-github', type: 'github', url: 'https://github.com/acme/tools' }, sourceType: 'github',
        writtenPaths: absolute('.github/prompts/a.prompt.md', '.github/prompts/b.prompt.md')
      });

      const tools = read(committed).bundles[BUNDLE].tools;
      expect(change.siblings).toEqual([{ tool: 'copilot-cli', version: '2.0.0', location: committed, synced: true }]);
      expect(tools['copilot-cli'].version).toBe('2.0.0');
      expect(tools['copilot-cli'].files).toEqual([
        { path: '.github/agents/own.agent.md', checksum: expect.stringMatching(/^sha256:/) as string },
        tools.vscode.files[0]
      ]);
    });

    it.each([
      ['is deleted when nothing else lists it', false, { deletedFiles: ['.github/prompts/old.prompt.md'], keptSharedFiles: [] }],
      ['is kept when an entry in the other repository file lists it', true, { deletedFiles: [], keptSharedFiles: ['.github/prompts/old.prompt.md'] }]
    ])('a shared path the new version drops %s', async (_label, listedElsewhere, expected) => {
      await install('copilot-cli', ['.github/prompts/a.prompt.md', '.github/prompts/old.prompt.md']);
      await install('vscode', ['.github/prompts/a.prompt.md', '.github/prompts/old.prompt.md']);
      if (listedElsewhere) {
        await install('kiro', ['.github/prompts/old.prompt.md'], { bundleId: 'other-bundle', location: localOnly });
      }

      const change = await install('vscode', ['.github/prompts/a.prompt.md'], { version: '2.0.0' });
      await service.deleteSuperseded(change);

      expect(filesOf(committed, 'copilot-cli')).toEqual(['.github/prompts/a.prompt.md']);
      expect({ deletedFiles: change.deletedFiles, keptSharedFiles: change.keptSharedFiles }).toEqual(expected);
      expect(fs.existsSync(path.join(root, '.github', 'prompts', 'old.prompt.md'))).toBe(listedElsewhere);
    });

    it('re-records an entry held in the local-only file in that file', async () => {
      await install('vscode', ['.github/prompts/a.prompt.md'], { location: localOnly });

      const holding = await service.holdingLocation([committed, localOnly], BUNDLE, 'vscode');
      await install('vscode', ['.github/prompts/a.prompt.md'], { location: holding, version: '2.0.0' });

      expect(holding).toEqual(localOnly);
      expect(fs.existsSync(committed.path)).toBe(false);
      expect(read(localOnly).bundles[BUNDLE].tools.vscode.version).toBe('2.0.0');
    });
  });

  describe('commit-mode move, source remap and extension helpers', () => {
    const recordFs = new NodeRecordFs();
    const LOCAL_NAME = 'ai-primitives-hub.local.lock.json';
    const move = (location: RecordLocation, tool = 'vscode'): ReturnType<InstallRecordService['moveEntry']> =>
      service.moveEntry({ location, bundleId: BUNDLE, tool });

    it('moveEntry moves an entry with a user-modified file unchanged to the local-only file and back, with its source', async () => {
      await install('vscode', ['.github/prompts/a.prompt.md']);
      fs.writeFileSync(path.join(root, '.github', 'prompts', 'a.prompt.md'), 'edited by the user\n');
      const recorded = read(committed);

      const there = await move(committed);
      const moved = read(localOnly);
      const back = await move(localOnly);

      expect(there).toEqual({ from: committed, to: localOnly, deletedFiles: [], keptSharedFiles: [], warnings: [] });
      expect(moved.bundles[BUNDLE].tools.vscode).toEqual(recorded.bundles[BUNDLE].tools.vscode);
      expect(moved.sources).toEqual(recorded.sources);
      expect(back).toEqual({ from: localOnly, to: committed, deletedFiles: [], keptSharedFiles: [], warnings: [] });
      expect(read(committed).bundles[BUNDLE].tools.vscode).toEqual(recorded.bundles[BUNDLE].tools.vscode);
      expect(fs.existsSync(localOnly.path)).toBe(false);
      expect(excludeText()).not.toContain(LOCAL_NAME);
    });

    it('moveEntry interrupted after the first save leaves the entry in both files; the committed copy wins and the next move leaves one', async () => {
      await install('vscode', ['.github/prompts/a.prompt.md']);
      await install('kiro', ['.kiro/steering/a.md']);
      await build(new SecondRecordSaveFailsFs());

      await expectCode(move(committed), 'RECORD.WRITE_FAILED');
      const both = [toolsIn(committed), toolsIn(localOnly)];
      const holding = await service.holdingLocation([committed, localOnly], BUNDLE, 'vscode');
      const listedWhileInBoth = (await service.listEntries([localOnly, committed])).map((row) => `${row.tool}@${path.basename(row.record)}`);
      await build();
      await move(committed);

      expect(both).toEqual([['kiro', 'vscode'], ['vscode']]);
      expect(holding).toEqual(committed);
      expect(listedWhileInBoth).toEqual(['kiro@ai-primitives-hub.lock.json', 'vscode@ai-primitives-hub.lock.json']);
      expect([toolsIn(committed), toolsIn(localOnly)]).toEqual([['kiro'], ['vscode']]);
      expect((await service.listEntries([committed, localOnly])).map((row) => `${row.tool}@${path.basename(row.record)}`))
        .toEqual(['kiro@ai-primitives-hub.lock.json', `vscode@${LOCAL_NAME}`]);
    });

    it('remapSource rewrites sources and every sourceId and sourceType in both files, sanitized, and is a no-op the second time', async () => {
      await install('vscode', ['.github/prompts/a.prompt.md']);
      await install('kiro', ['.kiro/steering/a.md'], { location: localOnly });
      const input = {
        root, from: 'acme-github', to: 'acme-moved',
        descriptor: { type: 'skills', url: 'https://user:pass@github.com/acme/moved', branch: 'main', token: 'ghp_secret' }
      };

      const first = await service.remapSource(input);
      const bytes = [fs.readFileSync(committed.path, 'utf8'), fs.readFileSync(localOnly.path, 'utf8')];
      const second = await service.remapSource(input);

      expect(first).toEqual({ changed: [committed, localOnly], warnings: [] });
      for (const [location, tool] of [[committed, 'vscode'], [localOnly, 'kiro']] as const) {
        expect(read(location).sources).toEqual({ 'acme-moved': { type: 'skills', url: 'https://github.com/acme/moved', branch: 'main' } });
        expect(read(location).bundles[BUNDLE].tools[tool].sourceId).toBe('acme-moved');
        expect(read(location).bundles[BUNDLE].tools[tool].sourceType).toBe('skills');
      }
      expect(second).toEqual({ changed: [], warnings: [] });
      expect([fs.readFileSync(committed.path, 'utf8'), fs.readFileSync(localOnly.path, 'utf8')]).toEqual(bytes);
    });

    it('remapSource changes neither file when the local-only file is malformed', async () => {
      await install('vscode', ['.github/prompts/a.prompt.md']);
      const before = fs.readFileSync(committed.path, 'utf8');
      fs.writeFileSync(localOnly.path, '{ "version": "3.0.0", ');

      await expectCode(service.remapSource({ root, from: 'acme-github', to: 'acme-moved', descriptor: { type: 'github', url: 'https://github.com/acme/moved' } }), 'RECORD.MALFORMED');

      expect(fs.readFileSync(committed.path, 'utf8')).toBe(before);
      expect(fs.readFileSync(localOnly.path, 'utf8')).toBe('{ "version": "3.0.0", ');
    });

    it.each([
      ['unchanged', 'prefixed', (): void => undefined, []],
      ['unchanged, recorded with a bare-hex checksum (old file)', 'bare', (): void => undefined, []],
      ['edited', 'prefixed', (file: string): void => fs.writeFileSync(file, 'edited by the user\n'), ['docs/a.md']],
      ['missing', 'prefixed', (file: string): void => fs.rmSync(file), ['docs/a.md']],
      ['recorded without a checksum', 'none', (): void => undefined, ['docs/a.md']]
    ] as const)('findModifiedFiles reports a file that is %s', async (_label, checksumForm, change, expected) => {
      const [absolute] = write('docs/a.md');
      const hashed = await recordFs.hashFile(absolute);
      const checksum = checksumForm === 'bare' ? hashed.replace(/^sha256:/, '') : hashed;
      change(absolute);

      const modified = await findModifiedFiles(recordFs, root, [{ path: 'docs/a.md', ...(checksumForm === 'none' ? {} : { checksum }) }]);

      expect(modified).toEqual(expected);
    });

    it.skipIf(POSIX_ONLY).each([
      ['a symlink to a file with the recorded content', (file: string, linked: string): void => fs.renameSync(file, linked), []],
      ['a symlink to a file with other content', (file: string, linked: string): void => {
        fs.writeFileSync(linked, 'edited by the user\n');
        fs.rmSync(file);
      }, ['docs/a.md']],
      ['a dangling symlink', (file: string): void => fs.rmSync(file), ['docs/a.md']],
      ['a symlink to a folder', (file: string, linked: string): void => {
        fs.mkdirSync(linked);
        fs.rmSync(file);
      }, ['docs/a.md']]
    ] as const)('findModifiedFiles compares %s by the content it resolves to', async (_label, change, expected) => {
      const [absolute] = write('docs/a.md');
      const checksum = await recordFs.hashFile(absolute);
      // The extension's user-scope files are links into its bundle cache.
      const linked = path.join(root, 'cache', 'a.md');
      fs.mkdirSync(path.dirname(linked), { recursive: true });
      change(absolute, linked);
      fs.symlinkSync(linked, absolute, 'file');

      const modified = await findModifiedFiles(recordFs, root, [{ path: 'docs/a.md', checksum }]);

      expect(modified).toEqual(expected);
    });

    it.each([
      ['vscode', ['prompts/', 'agents/', 'skills/'], ['copilot-cli', 'vscode', 'vscode-insiders']],
      ['vscode', ['prompts/', 'chat-modes/'], ['vscode', 'vscode-insiders']],
      ['kiro', ['prompts', 'instructions/', 'skills/'], ['kiro', 'kiro-cli']],
      ['windsurf', ['prompts/', 'agents/'], ['windsurf']]
    ])('writerGroupFor(%s, %j) is %j', (hostTool, kinds, expected) => {
      expect(writerGroupFor(hostTool, kinds)).toEqual(expected);
    });

    describe('isLocalSourceInsideRoot', () => {
      beforeEach(() => {
        fs.mkdirSync(path.join(root, 'sources', 'local'), { recursive: true });
        fs.mkdirSync(path.join(base, 'outside'), { recursive: true });
      });

      it.each([
        ['a relative folder inside the root', (): string => 'sources/local', true],
        ['a folder leaving the root through ..', (): string => '../outside', false],
        ['an absolute folder outside the root', (): string => path.join(base, 'outside'), false]
      ])('%s', async (_label, localPath, expected) => {
        expect(await isLocalSourceInsideRoot(recordFs, root, localPath())).toBe(expected);
      });

      it.skipIf(POSIX_ONLY)('a symlink inside the root pointing outside it', async () => {
        fs.symlinkSync(path.join(base, 'outside'), path.join(root, 'sources', 'link'), 'dir');

        expect(await isLocalSourceInsideRoot(recordFs, root, 'sources/link')).toBe(false);
      });
    });
  });

  describe('shared user record', () => {
    const recordFs = new NodeRecordFs();
    let home: string;
    let userRecord: string;
    let userLockfile: string;
    let user: RecordLocation;

    beforeEach(() => {
      home = path.join(base, 'home');
      fs.mkdirSync(home, { recursive: true });
      userRecord = path.join(home, '.config', 'ai-primitives-hub', 'ai-primitives-hub.user.lock.json');
      userLockfile = path.join(home, '.config', 'ai-primitives-hub', 'ai-primitives-hub.lock.json');
      user = store.resolveUser({ home, path: userRecord });
    });

    const installAtUser = (files: string[]): ReturnType<InstallRecordService['recordInstall']> => service.recordInstall({
      location: user,
      bundleId: BUNDLE,
      version: '1.0.0',
      tool: 'vscode',
      source: { sourceId: 'acme-github', type: 'github', url: 'https://github.com/acme/tools' },
      sourceType: 'github',
      writtenPaths: files.map((relative) => {
        const absolute = path.join(home, relative);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, `content of ${relative}\n`);
        return absolute;
      })
    });

    it('loads a missing user record as empty and creates its folder on the first save, with home-relative paths', async () => {
      const loaded = await store.load(user);

      await installAtUser(['.copilot/prompts/a.prompt.md']);

      const written = JSON.parse(fs.readFileSync(userRecord, 'utf8')) as InstallRecord;
      expect({ exists: loaded.exists, root: user.root, level: written.level, files: written.bundles[BUNDLE].tools.vscode.files.map((file) => file.path) })
        .toEqual({ exists: false, root: home, level: 'user', files: ['.copilot/prompts/a.prompt.md'] });
    });

    it('refuses a 2.0.0 file under the user record name with RECORD.LEGACY_UNMIGRATED', async () => {
      fs.mkdirSync(path.dirname(userRecord), { recursive: true });
      fs.writeFileSync(userRecord, JSON.stringify({ version: '2.0.0', bundles: {} }));

      await expectCode(store.load(user), 'RECORD.LEGACY_UNMIGRATED');
    });

    it.skipIf(POSIX_ONLY)('refuses to load a user record once a recorded folder is re-pointed outside home', async () => {
      await installAtUser(['.copilot/prompts/a.prompt.md']);
      const outside = path.join(base, 'outside-copilot');
      fs.mkdirSync(path.join(outside, 'prompts'), { recursive: true });
      fs.writeFileSync(path.join(outside, 'prompts', 'a.prompt.md'), 'outside\n');
      fs.rmSync(path.join(home, '.copilot'), { recursive: true });
      fs.symlinkSync(outside, path.join(home, '.copilot'), 'dir');

      await expectCode(store.load(user), 'RECORD.PATH_OUTSIDE_ROOT');
      expect(fs.readFileSync(path.join(outside, 'prompts', 'a.prompt.md'), 'utf8')).toBe('outside\n');
    });

    it.each([
      ['HOME when it is set', { HOME: '/h/home', USERPROFILE: '/h/profile' }, (): string => path.resolve('/h/home')],
      ['USERPROFILE when HOME is empty', { HOME: '', USERPROFILE: '/h/profile' }, (): string => path.resolve('/h/profile')],
      ['os.homedir() when both are unset', {}, (): string => path.resolve(os.homedir())]
    ])('resolveUserHome uses %s', (_label, env, expected) => {
      expect(resolveUserHome(env)).toBe(expected());
    });

    it.each([
      ['a folder under home that does not exist yet', (): string => path.join(home, '.copilot', 'prompts'), undefined],
      ['an absolute folder outside home', (): string => path.join(base, 'elsewhere'), 'RECORD.PATH_OUTSIDE_ROOT']
    ])('assertUserFolderInsideHome with %s', async (_label, folder, code) => {
      const check = assertUserFolderInsideHome(recordFs, home, folder());

      await (code === undefined ? expect(check).resolves.toBeUndefined() : expectCode(check, code));
    });

    it.skipIf(POSIX_ONLY)('assertUserFolderInsideHome refuses a tool folder symlinked outside home', async () => {
      fs.mkdirSync(path.join(base, 'outside-kiro'), { recursive: true });
      fs.symlinkSync(path.join(base, 'outside-kiro'), path.join(home, '.kiro'), 'dir');

      await expectCode(assertUserFolderInsideHome(recordFs, home, path.join(home, '.kiro', 'steering')), 'RECORD.PATH_OUTSIDE_ROOT');
    });

    describe('selectRecord at user level', () => {
      let cwd: string;

      const select = (given?: SelectRecordOptions['given']): ReturnType<typeof selectRecord> => selectRecord({
        store,
        fs: recordFs,
        cwd,
        given,
        findOldLockfile: (start) => findLockfile(start, { exists: (file) => Promise.resolve(fs.existsSync(file)) }, userLockfile),
        userLockfile,
        userRecord,
        home
      });

      beforeEach(() => {
        cwd = path.join(base, 'not-a-repo');
        fs.mkdirSync(cwd, { recursive: true });
        fs.mkdirSync(path.dirname(userLockfile), { recursive: true });
        fs.writeFileSync(userLockfile, '{}');
      });

      it.each([
        ['--scope user', (): SelectRecordOptions['given'] => ({ scope: 'user' }), 'explicit-scope', false],
        ['a user-scope target', (): SelectRecordOptions['given'] => ({ target: { scope: 'user' } }), 'target-scope', false],
        ['no level outside a repository', (): SelectRecordOptions['given'] => undefined, 'user-fallback', true],
        ['--lockfile naming the user record', (): SelectRecordOptions['given'] => ({ lockfile: userRecord }), 'lockfile-flag', false]
      ])('%s selects the shared user record with the old user lockfile as old store', async (_label, given, reason, inferred) => {
        const selection = await select(given());
        const seen = { level: selection.level, root: selection.root, files: selection.locations.map((location) => location.path) };

        expect({ ...seen, old: selection.oldLockfile, reason: selection.reason, inferred: selection.inferred })
          .toEqual({ level: 'user', root: home, files: [userRecord], old: userLockfile, reason, inferred });
      });

      it.each([
        ['--lockfile naming the old user lockfile', (): SelectRecordOptions['given'] => ({ lockfile: userLockfile })],
        ['a workspace-scope target', (): SelectRecordOptions['given'] => ({ target: { scope: 'workspace', rootPath: cwd } })]
      ])('%s keeps the old user lockfile only', async (_label, given) => {
        const selection = await select(given());

        expect({ level: selection.level, files: selection.locations, old: selection.oldLockfile }).toEqual({ level: 'user', files: [], old: userLockfile });
      });
    });
  });

  describe('record migration', () => {
    const recordFs = new NodeRecordFs();
    const SOURCES = { 'acme-github': { type: 'github', url: 'https://github.com/acme/tools' } };
    const INSTALLED_AT = '2026-01-02T03:04:05.000Z';
    const lockFs: LockfileFs = {
      readFile: (file) => fs.promises.readFile(file, 'utf8'),
      writeFile: (file, contents) => fs.promises.writeFile(file, contents),
      exists: (file) => Promise.resolve(fs.existsSync(file)),
      mkdir: async (dir, opts) => {
        await fs.promises.mkdir(dir, opts);
      }
    };
    let home: string;
    let userRecord: string;
    let userLockfile: string;
    let user: RecordLocation;

    const oldCommitted = (): string => path.join(root, 'prompt-registry.lock.json');
    const oldLocal = (): string => path.join(root, 'prompt-registry.local.lock.json');

    /**
     * Write a 2.0.0 lockfile with one entry per bundle, all from `acme-github`.
     * @param file - Old file.
     * @param bundles - Version and recorded paths per bundle id.
     * @param sources - The old file's sources.
     */
    const writeOld = async (
      file: string,
      bundles: Record<string, { version: string; files?: string[]; installedAt?: string }>,
      sources: Record<string, LockfileSourceEntry> = SOURCES
    ): Promise<void> => {
      let lock = { ...emptyLockfile('prompt-registry-extension@1.0.0'), sources };
      for (const [bundleId, { version, files = [], installedAt = INSTALLED_AT }] of Object.entries(bundles)) {
        lock = upsertBundleEntry(lock, bundleId, {
          version, sourceId: 'acme-github', sourceType: 'github', installedAt,
          files: files.map((recorded) => ({ path: recorded, checksum: '0'.repeat(64) }))
        });
      }
      await writeLockfile(file, lock, lockFs);
    };

    const migrateRepository = (overrides: Partial<MigrationInput> = {}): ReturnType<typeof migrateRecords> =>
      migrateRecords({ store, fs: recordFs, level: 'repository', root, targets: [committed, localOnly], now: () => NOW, ...overrides });

    const migrateUser = (overrides: Partial<MigrationInput> = {}): ReturnType<typeof migrateRecords> =>
      migrateRecords({ store, fs: recordFs, level: 'user', root: home, targets: [user], oldUserLockfile: userLockfile, now: () => NOW, ...overrides });

    const unknownEntry = (version: string, files: object[]): object =>
      ({ version, sourceId: 'acme-github', sourceType: 'github', installedAt: INSTALLED_AT, needsReinstall: true, files });

    const hashAt = (folder: string, relative: string): Promise<string> => recordFs.hashFile(path.join(folder, relative));

    beforeEach(() => {
      home = path.join(base, 'home');
      fs.mkdirSync(home, { recursive: true });
      userRecord = path.join(home, '.config', 'ai-primitives-hub', 'ai-primitives-hub.user.lock.json');
      userLockfile = path.join(home, '.config', 'ai-primitives-hub', 'ai-primitives-hub.lock.json');
      user = store.resolveUser({ home, path: userRecord });
    });

    it.each([
      ['commit', oldCommitted, (): RecordLocation => committed, (): RecordLocation => localOnly, false],
      ['local-only', oldLocal, (): RecordLocation => localOnly, (): RecordLocation => committed, true]
    ])('renames the %s old file to a 3.0.0 record of unknown entries and deletes it', async (_mode, oldFile, target, other, excluded) => {
      write('.github/prompts/a.prompt.md');
      await writeOld(oldFile(), { [BUNDLE]: { version: '1.2.0', files: ['.github/prompts/a.prompt.md'] } });

      const report = await migrateRepository();

      const checksum = await hashAt(root, '.github/prompts/a.prompt.md');
      expect(read(target()).bundles[BUNDLE].tools).toEqual({ unknown: unknownEntry('1.2.0', [{ path: '.github/prompts/a.prompt.md', checksum }]) });
      expect(read(target()).sources).toEqual(SOURCES);
      expect(report).toMatchObject({
        level: 'repository', renamed: [{ from: oldFile(), to: target().path }], mergedFrom: [],
        needsReinstall: [{ bundleId: BUNDLE, version: '1.2.0' }], migratedAt: NOW.toISOString()
      });
      expect([fs.existsSync(oldFile()), fs.existsSync(other().path)]).toEqual([false, false]);
      expect(fs.existsSync(path.join(root, '.git', 'info', 'exclude')) && excludeText().includes('ai-primitives-hub.local.lock.json')).toBe(excluded);
    });

    it.each([
      ['safe and present', (): string => 'docs/kept.md', undefined, INSTALLED_AT, INSTALLED_AT],
      ['safe and present, installed on an impossible date', (): string => 'docs/kept.md', undefined, '2024-02-30T25:00:00Z', NOW.toISOString()],
      ['using ..', (): string => '../escape.md', 'unsafe path', INSTALLED_AT, INSTALLED_AT],
      ['absolute', (): string => path.join(base, 'absolute.md'), 'unsafe path', INSTALLED_AT, INSTALLED_AT],
      ['bundle-relative (CLI)', (): string => 'prompts/a.prompt.md', 'not found', INSTALLED_AT, INSTALLED_AT]
    ])('an old path that is %s is kept only when safe and present, with its disk checksum', async (_label, recordedPath, reason, installedAt, recordedAt) => {
      write('docs/kept.md');
      fs.writeFileSync(path.join(base, 'escape.md'), 'outside\n');
      fs.writeFileSync(path.join(base, 'absolute.md'), 'outside\n');
      await writeOld(oldCommitted(), { [BUNDLE]: { version: '1.0.0', files: [recordedPath()], installedAt } });

      const report = await migrateRepository();

      const files = reason === undefined ? [{ path: recordedPath(), checksum: await hashAt(root, recordedPath()) }] : [];
      expect(read(committed).bundles[BUNDLE].tools.unknown.files).toEqual(files);
      expect(read(committed).bundles[BUNDLE].tools.unknown.installedAt).toBe(recordedAt);
      expect(report?.droppedFiles).toEqual(reason === undefined ? [] : [{ bundleId: BUNDLE, path: recordedPath(), reason }]);
    });

    it.skipIf(POSIX_ONLY)('drops a path whose folder is a symlink leaving the root', async () => {
      fs.mkdirSync(path.join(base, 'outside'));
      fs.writeFileSync(path.join(base, 'outside', 'a.md'), 'outside\n');
      fs.symlinkSync(path.join(base, 'outside'), path.join(root, 'linked'), 'dir');
      await writeOld(oldCommitted(), { [BUNDLE]: { version: '1.0.0', files: ['linked/a.md'] } });

      const report = await migrateRepository();

      expect(read(committed).bundles[BUNDLE].tools.unknown.files).toEqual([]);
      expect(report?.droppedFiles).toEqual([{ bundleId: BUNDLE, path: 'linked/a.md', reason: 'unsafe path' }]);
    });

    it('merges into an existing record: held bundles are skipped, others added, the higher version wins across both old files', async () => {
      await install('vscode', ['.github/prompts/a.prompt.md']);
      const recorded = read(committed).bundles[BUNDLE];
      await writeOld(oldCommitted(), { [BUNDLE]: { version: '0.9.0' }, 'other-bundle': { version: '1.0.0' } });
      await writeOld(oldLocal(), { 'other-bundle': { version: '2.0.0' }, 'third-bundle': { version: '1.0.0' } });

      const report = await migrateRepository();

      expect(read(committed).bundles).toEqual({ [BUNDLE]: recorded });
      expect(read(localOnly).bundles).toEqual({
        'other-bundle': { tools: { unknown: unknownEntry('2.0.0', []) } },
        'third-bundle': { tools: { unknown: unknownEntry('1.0.0', []) } }
      });
      expect(report).toMatchObject({
        renamed: [{ from: oldLocal(), to: localOnly.path }],
        mergedFrom: [oldCommitted()],
        versionConflicts: [{ bundleId: 'other-bundle', kept: '2.0.0', dropped: '1.0.0' }],
        droppedEntries: [{ bundleId: BUNDLE, version: '0.9.0', sourceId: 'acme-github', reason: 'already recorded' }]
      });
      expect([fs.existsSync(oldCommitted()), fs.existsSync(oldLocal())]).toEqual([false, false]);
    });

    it.each([
      ['larger than 10 MB', (): string => ' '.repeat(RECORD_MAX_BYTES + 1)],
      ['holding a __proto__ key', (): string => '{ "bundles": { "__proto__": { "polluted": true } } }'],
      ['of the wrong shape', (): string => '{ "bundles": { "acme-tools": { "version": 1, "files": [] } } }']
    ])('refuses an old file %s with RECORD.MALFORMED naming it, writing nothing', async (_label, text) => {
      const hostile = text();
      fs.writeFileSync(oldCommitted(), hostile);

      await expect(migrateRepository()).rejects.toMatchObject({ code: 'RECORD.MALFORMED', context: { file: oldCommitted() } });

      expect([fs.existsSync(committed.path), fs.existsSync(localOnly.path)]).toEqual([false, false]);
      expect(fs.readFileSync(oldCommitted(), 'utf8') === hostile).toBe(true);
    });

    it('is idempotent: a second run returns no report and leaves the bytes unchanged', async () => {
      await writeOld(oldCommitted(), { [BUNDLE]: { version: '1.0.0' } });
      await migrateRepository();
      const bytes = fs.readFileSync(committed.path, 'utf8');

      const second = await migrateRepository();

      expect(second).toBeUndefined();
      expect(fs.readFileSync(committed.path, 'utf8')).toBe(bytes);
    });

    it('stops with RECORD.WRITE_FAILED when the old file cannot be deleted; the next run only deletes it', async () => {
      await writeOld(oldCommitted(), { [BUNDLE]: { version: '1.0.0' } });

      await expect(migrateRepository({ fs: new FailingOldUnlinkFs() })).rejects.toMatchObject({ code: 'RECORD.WRITE_FAILED', context: { file: oldCommitted() } });
      const afterFailure = toolsIn(committed);
      await install('vscode', ['.github/prompts/a.prompt.md']);
      const next = await migrateRepository();

      expect(afterFailure).toEqual(['unknown']);
      expect(toolsIn(committed)).toEqual(['vscode']);
      expect(next).toMatchObject({ mergedFrom: [oldCommitted()], needsReinstall: [], droppedEntries: [{ bundleId: BUNDLE, reason: 'already recorded' }] });
      expect(fs.existsSync(oldCommitted())).toBe(false);
    });

    it('findLoneUnknown gives a bundle only unknown holds; removeUnknownEntry removes it, deletes nothing and keeps every file it listed', async () => {
      write('docs/own.md', '.github/prompts/a.prompt.md');
      await writeOld(oldCommitted(), {
        [BUNDLE]: { version: '0.9.0', files: ['docs/own.md', '.github/prompts/a.prompt.md'] },
        'other-bundle': { version: '0.9.0' }
      });
      await migrateRepository();
      // Reinstalling clears other-bundle's unknown entry; it shares a.prompt.md.
      await install('vscode', ['.github/prompts/a.prompt.md'], { bundleId: 'other-bundle' });

      const lone = await service.findLoneUnknown([committed, localOnly]);
      const result = await service.removeUnknownEntry(committed, BUNDLE);

      expect([...lone.keys()]).toEqual([BUNDLE]);
      expect(lone.get(BUNDLE)).toMatchObject({ location: committed, tool: 'unknown', entry: { version: '0.9.0' } });
      expect(result).toMatchObject({ deleted: [], kept: ['.github/prompts/a.prompt.md', 'docs/own.md'] });
      expect(Object.keys(read(committed).bundles)).toEqual(['other-bundle']);
      expect([fs.existsSync(path.join(root, 'docs/own.md')), fs.existsSync(path.join(root, '.github/prompts/a.prompt.md'))]).toEqual([true, true]);
    });

    it('imports the old user lockfile once as unknown entries with no files and leaves it byte-identical', async () => {
      await writeOld(userLockfile, { [BUNDLE]: { version: '1.0.0', files: ['prompts/a.prompt.md'] } });
      const oldBytes = fs.readFileSync(userLockfile, 'utf8');

      const report = await migrateUser();
      const second = await migrateUser();

      const record = read(user);
      expect(record.bundles[BUNDLE].tools).toEqual({ unknown: unknownEntry('1.0.0', []) });
      expect(record.importedUserLockfileAt).toBe(NOW.toISOString());
      expect(report).toMatchObject({
        level: 'user', mergedFrom: [userLockfile], needsReinstall: [{ bundleId: BUNDLE, version: '1.0.0' }],
        droppedFiles: [{ bundleId: BUNDLE, path: 'prompts/a.prompt.md', reason: 'no target recorded' }]
      });
      expect(second).toBeUndefined();
      expect(fs.readFileSync(userLockfile, 'utf8')).toBe(oldBytes);
    });

    it('sets the marker with no old user lockfile, then imports nothing and selects no old store', async () => {
      const first = await migrateUser();
      await writeOld(userLockfile, { [BUNDLE]: { version: '1.0.0' } });
      const bytes = fs.readFileSync(userRecord, 'utf8');

      const second = await migrateUser();
      const selection = await selectRecord({
        store, fs: recordFs, cwd: home, given: { scope: 'user' },
        findOldLockfile: () => Promise.resolve(null), userLockfile, userRecord, home
      });

      expect(first).toMatchObject({ needsReinstall: [], mergedFrom: [] });
      expect(read(user)).toMatchObject({ importedUserLockfileAt: NOW.toISOString(), bundles: {} });
      expect(second).toBeUndefined();
      expect(fs.readFileSync(userRecord, 'utf8')).toBe(bytes);
      expect(selection.oldLockfile).toBeUndefined();
    });

    it('keeps an empty user record with its marker when the last user bundle is uninstalled', async () => {
      await migrateUser();
      const absolute = path.join(home, '.copilot', 'prompts', 'a.prompt.md');
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, 'a\n');
      await service.recordInstall({
        location: user, bundleId: BUNDLE, version: '1.0.0', tool: 'vscode',
        source: { sourceId: 'acme-github', type: 'github', url: 'https://github.com/acme/tools' }, sourceType: 'github', writtenPaths: [absolute]
      });

      await service.recordUninstall({ location: user, bundleId: BUNDLE, tool: 'vscode' });

      expect(read(user)).toMatchObject({ importedUserLockfileAt: NOW.toISOString(), bundles: {}, sources: {} });
    });

    it('profile entries replace a lone unknown entry with the version difference reported, and skip a bundle held under the host tool', async () => {
      await writeOld(userLockfile, { [BUNDLE]: { version: '1.0.0' } });
      await migrateUser();
      const held = path.join(home, '.copilot', 'prompts', 'held.prompt.md');
      fs.mkdirSync(path.dirname(held), { recursive: true });
      fs.writeFileSync(held, 'held\n');
      fs.writeFileSync(path.join(home, '.copilot', 'prompts', 'a.prompt.md'), 'a\n');
      await service.recordInstall({
        location: user, bundleId: 'held-bundle', version: '3.0.0', tool: 'vscode',
        source: { sourceId: 'acme-github', type: 'github', url: 'https://github.com/acme/tools' }, sourceType: 'github', writtenPaths: [held]
      });
      const profile = (bundleId: string, version: string): MigratedEntry => ({
        bundleId, tool: 'vscode', version, sourceId: 'acme-github', sourceType: 'github', installedAt: INSTALLED_AT,
        files: [{ path: '.copilot/prompts/a.prompt.md' }], source: SOURCES['acme-github'], from: 'profile-registry-storage'
      });

      const report = await migrateUser({ profileEntries: [profile(BUNDLE, '1.1.0'), profile('held-bundle', '2.0.0')] });

      const bundles = read(user).bundles;
      expect(bundles[BUNDLE].tools).toEqual({
        vscode: {
          version: '1.1.0', sourceId: 'acme-github', sourceType: 'github', installedAt: INSTALLED_AT,
          files: [{ path: '.copilot/prompts/a.prompt.md', checksum: await hashAt(home, '.copilot/prompts/a.prompt.md') }]
        }
      });
      expect(bundles['held-bundle'].tools.vscode.version).toBe('3.0.0');
      expect(report).toMatchObject({
        mergedFrom: [PROFILE_STORE_NAME],
        needsReinstall: [],
        versionConflicts: [{ bundleId: BUNDLE, kept: '1.1.0', dropped: '1.0.0' }],
        droppedEntries: [{ bundleId: 'held-bundle', version: '2.0.0', reason: 'already recorded' }]
      });
    });

    it('reports the version recorded when a bundle is in both the CLI user lockfile and the profile', async () => {
      const held = path.join(home, '.copilot', 'prompts', 'held.prompt.md');
      fs.mkdirSync(path.dirname(held), { recursive: true });
      fs.writeFileSync(held, 'held\n');
      await service.recordInstall({
        location: user, bundleId: 'held-bundle', version: '3.0.0', tool: 'vscode',
        source: { sourceId: 'acme-github', type: 'github', url: 'https://github.com/acme/tools' }, sourceType: 'github', writtenPaths: [held]
      });
      await writeOld(userLockfile, { [BUNDLE]: { version: '1.0.0' }, 'held-bundle': { version: '1.0.0' } });
      const profile = (bundleId: string, version: string): MigratedEntry => ({
        bundleId, tool: 'vscode', version, sourceId: 'acme-github', sourceType: 'github', files: [], from: 'profile-registry-storage'
      });

      const report = await migrateUser({ profileEntries: [profile(BUNDLE, '1.1.0'), profile('held-bundle', '2.0.0')] });

      expect(read(user).bundles['held-bundle'].tools.vscode.version).toBe('3.0.0');
      expect(report?.versionConflicts).toEqual([{ bundleId: BUNDLE, kept: '1.1.0', dropped: '1.0.0' }]);
      expect(report?.droppedEntries).toEqual([
        { bundleId: 'held-bundle', version: '2.0.0', sourceId: 'acme-github', reason: 'already recorded' },
        { bundleId: 'held-bundle', version: '1.0.0', sourceId: 'acme-github', reason: 'already recorded' }
      ]);
    });

    it.each([
      ['committed', oldCommitted, (): RecordLocation => committed],
      ['local-only', oldLocal, (): RecordLocation => localOnly]
    ])('installing for another tool clears the unknown entry from the %s file and keeps every file it listed', async (_label, oldFile, holder) => {
      write('.github/prompts/a.prompt.md');
      await writeOld(oldFile(), { [BUNDLE]: { version: '1.0.0', files: ['.github/prompts/a.prompt.md'] } }, {
        'acme-github': { type: 'github', url: 'https://user:ghp_faketoken@github.com/acme/tools?token=abc' }
      });
      await migrateRepository();
      const migratedSource = read(holder()).sources['acme-github'];

      const change = await install('kiro', ['.kiro/steering/a.md']);
      await service.deleteSuperseded(change);

      expect(migratedSource).toEqual({ type: 'github', url: 'https://github.com/acme/tools' });
      expect({ deletedFiles: change.deletedFiles, keptSharedFiles: change.keptSharedFiles }).toEqual({ deletedFiles: [], keptSharedFiles: [] });
      expect(toolsIn(committed)).toEqual(['kiro']);
      expect(fs.existsSync(localOnly.path)).toBe(false);
      expect(fs.existsSync(path.join(root, '.github', 'prompts', 'a.prompt.md'))).toBe(true);
    });

    describe('one version per bundle and tool', () => {
      const COLL = 'acme-tools-coll';
      const entries = (location: RecordLocation): string[] => (fs.existsSync(location.path) ? Object.entries(read(location).bundles) : [])
        .flatMap(([key, bundle]) => Object.entries(bundle.tools).map(([tool, entry]) => `${key} ${tool} ${entry.version}`))
        .toSorted();
      const installVersion = (tool: string, version: string, files: string[], overrides: Partial<RecordInstallInput> = {}): ReturnType<typeof install> =>
        install(tool, files, { bundleId: `${COLL}-${version}`, version, ...overrides });
      const profile = (version: string): MigratedEntry => ({
        bundleId: `${COLL}-${version}`, tool: 'vscode', version, sourceId: 'acme-github', sourceType: 'github', files: [], from: 'profile-registry-storage'
      });

      it.each([
        ['the committed file', async (): Promise<void> => {
          await writeOld(oldCommitted(), { [`${COLL}-1.0.0`]: { version: '1.0.0' }, [`${COLL}-2.0.0`]: { version: '2.0.0' } });
        }, (): RecordLocation => committed],
        ['both old files', async (): Promise<void> => {
          await writeOld(oldCommitted(), { [`${COLL}-1.0.0`]: { version: '1.0.0' } });
          await writeOld(oldLocal(), { [`${COLL}-2.0.0`]: { version: '2.0.0' } });
        }, (): RecordLocation => localOnly]
      ])('two versions of a versioned id in %s migrate to one entry, the higher version', async (_label, writeOldFiles, holder) => {
        await writeOldFiles();

        const report = await migrateRepository();

        expect([...entries(committed), ...entries(localOnly)].filter((row) => row.startsWith(COLL))).toEqual([`${COLL}-2.0.0 unknown 2.0.0`]);
        expect(entries(holder())).toEqual([`${COLL}-2.0.0 unknown 2.0.0`]);
        expect(report?.versionConflicts).toEqual([{ bundleId: `${COLL}-1.0.0`, kept: '2.0.0', dropped: '1.0.0' }]);
        expect(report?.needsReinstall).toEqual([{ bundleId: `${COLL}-2.0.0`, version: '2.0.0' }]);
      });

      it('an old file\'s older version of a recorded versioned id is dropped; the record\'s entry stays the only one', async () => {
        await installVersion('vscode', '2.0.0', ['docs/a.md']);
        await writeOld(oldCommitted(), { [`${COLL}-1.0.0`]: { version: '1.0.0' } });

        const report = await migrateRepository();

        expect(entries(committed)).toEqual([`${COLL}-2.0.0 vscode 2.0.0`]);
        expect(report).toMatchObject({
          needsReinstall: [],
          droppedEntries: [{ bundleId: `${COLL}-1.0.0`, version: '1.0.0', sourceId: 'acme-github', reason: 'already recorded' }]
        });
      });

      it('recordInstall of another version clears a lone unknown entry of the old versioned id and keeps its files', async () => {
        write('docs/legacy.md');
        await writeOld(oldCommitted(), { [`${COLL}-1.0.0`]: { version: '1.0.0', files: ['docs/legacy.md'] } });
        await migrateRepository();

        const change = await installVersion('vscode', '2.0.0', ['docs/a.md']);
        await service.deleteSuperseded(change);

        expect(entries(committed)).toEqual([`${COLL}-2.0.0 vscode 2.0.0`]);
        expect({ deletedFiles: change.deletedFiles, keptSharedFiles: change.keptSharedFiles }).toEqual({ deletedFiles: [], keptSharedFiles: [] });
        expect(fs.existsSync(path.join(root, 'docs', 'legacy.md'))).toBe(true);
      });

      it.each([
        ['two unknown versions are one lone bundle; removing one removes both and keeps their files', ['unknown', 'unknown'], [`${COLL}-1.0.0`, `${COLL}-2.0.0`]],
        ['an unknown version is not lone when another tool has another version', ['unknown', 'kiro'], []]
      ])('findLoneUnknown and removeUnknownEntry go by identity: %s', async (_label, tools, lone) => {
        write('docs/one.md', 'docs/two.md');
        const entry = (tool: string, version: string, file: string): object => ({
          version, sourceId: 'acme-github', sourceType: 'github', installedAt: INSTALLED_AT,
          files: [{ path: file, checksum: `sha256:${'0'.repeat(64)}` }],
          ...(tool === 'unknown' ? { needsReinstall: true } : {})
        });
        fs.writeFileSync(committed.path, JSON.stringify({
          $schema: 'https://github.com/AmadeusITGroup/ai-primitives-hub/schemas/lockfile.schema.json',
          version: '3.0.0', level: 'repository', generatedAt: INSTALLED_AT, generatedBy: 'ai-primitives-hub-cli@0.3.0',
          bundles: {
            [`${COLL}-1.0.0`]: { tools: { [tools[0]]: entry(tools[0], '1.0.0', 'docs/one.md') } },
            [`${COLL}-2.0.0`]: { tools: { [tools[1]]: entry(tools[1], '2.0.0', 'docs/two.md') } }
          },
          sources: SOURCES
        }));

        const found = await service.findLoneUnknown([committed, localOnly]);

        expect([...found.keys()].toSorted()).toEqual(lone);
        if (lone.length > 0) {
          const result = await service.removeUnknownEntry(committed, `${COLL}-2.0.0`);
          expect(result).toMatchObject({ deleted: [], kept: ['docs/one.md', 'docs/two.md'] });
          expect(fs.existsSync(committed.path)).toBe(false);
          expect([fs.existsSync(path.join(root, 'docs', 'one.md')), fs.existsSync(path.join(root, 'docs', 'two.md'))]).toEqual([true, true]);
        }
      });

      it.each([
        ['two profile versions', [], [profile('1.0.0'), profile('2.0.0')], [`${COLL}-2.0.0 vscode 2.0.0`],
          { versionConflicts: [{ bundleId: `${COLL}-1.0.0`, kept: '2.0.0', dropped: '1.0.0' }] }],
        ['a recorded vscode version and an older profile one', ['2.0.0'], [profile('1.0.0')], [`${COLL}-2.0.0 vscode 2.0.0`],
          { droppedEntries: [{ bundleId: `${COLL}-1.0.0`, version: '1.0.0', sourceId: 'acme-github', reason: 'already recorded' }] }],
        ['a lone unknown version and a newer profile one', ['unknown-1.0.0'], [profile('2.0.0')], [`${COLL}-2.0.0 vscode 2.0.0`],
          { versionConflicts: [{ bundleId: `${COLL}-2.0.0`, kept: '2.0.0', dropped: '1.0.0' }] }]
      ])('user migration of %s leaves one vscode entry', async (_label, recorded, profileEntries, expected, reported) => {
        for (const version of recorded) {
          if (version.startsWith('unknown-')) {
            await writeOld(userLockfile, { [`${COLL}-${version.slice('unknown-'.length)}`]: { version: version.slice('unknown-'.length) } });
            await migrateUser();
            continue;
          }
          const file = path.join(home, '.copilot', 'prompts', 'a.prompt.md');
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, 'a\n');
          await installVersion('vscode', version, [], { location: user, writtenPaths: [file] });
        }

        const report = await migrateUser({ profileEntries });

        expect(entries(user)).toEqual(expected);
        expect(report).toMatchObject(reported);
      });
    });
  });
});
