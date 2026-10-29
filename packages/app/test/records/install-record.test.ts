/**
 * Contract tests for the repository install record (C2 store, C3 service).
 *
 * Everything runs through the public `RecordStore` and `InstallRecordService`
 * on a real temp git folder, with the real `NodeRecordFs` and
 * `RecordSchemaValidator` from infra.
 */
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
  InstallRecordService,
  type RecordInstallInput,
  RecordStore,
} from '../../src/records';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const POSIX_ONLY = process.platform === 'win32';
const BUNDLE = 'acme-tools';

/** `NodeRecordFs` whose `rename` always fails, to simulate a failed atomic write. */
class FailingRenameFs extends NodeRecordFs {
  public override rename(): Promise<void> {
    return Promise.reject(new Error('EXDEV: rename failed'));
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
   * Write a valid 3.0.0 record with one vscode entry and optional extra fields.
   * @param location - Record file.
   * @param files - Recorded paths of the vscode entry.
   * @param extra - Unknown fields to add at the top and entry level.
   * @param extra.top
   * @param extra.entry
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
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'install-record-'));
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

    const change = await install('vscode', ['docs/new.md']);
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

  it('uninstalling the last local-only entry deletes the file and its info/exclude line', async () => {
    await install('vscode', ['.github/prompts/a.prompt.md'], { location: localOnly });

    await service.recordUninstall({ location: committed, bundleId: BUNDLE, tool: 'vscode' });

    expect(fs.existsSync(localOnly.path)).toBe(false);
    expect(excludeText()).not.toContain('ai-primitives-hub.local.lock.json');
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
});
