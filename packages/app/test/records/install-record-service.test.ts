/**
 * Tests for app/records/install-record-service.ts (W1 steps 6–13; BR1.2,
 * BR1.4–BR1.7, BR3.1, BR3.2, BR3.4, BR3.6, BR3.7; NFR4.2, NFR4.5).
 *
 * Runs against a real temp git folder through `NodeRecordFs`; only the
 * unlink-failure case wraps the port to fail on demand.
 */
import {
  createHash,
} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type InstallRecord,
  LOCAL_RECORD_FILE_NAME,
  RECORD_FILE_NAME,
  type RecordLocation,
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
  isMergedMcpConfigPath,
  type RecordInstallInput,
} from '../../src/records/install-record-service';
import {
  RecordStore,
} from '../../src/records/record-store';
import {
  canSymlinkFile,
  createTempDir,
  expectRecordError,
  makeGitDir,
} from './record-test-utils';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const SOURCE = { sourceId: 'acme-github', type: 'github', url: 'https://ghp_secret@github.com/acme/tools' };

/** `NodeRecordFs` whose `unlink` fails for paths ending in `failSuffix`. */
class FailingUnlinkFs extends NodeRecordFs {
  public constructor(private readonly failSuffix: string) {
    super();
  }

  public override async unlink(file: string): Promise<void> {
    if (file.endsWith(this.failSuffix)) {
      throw new Error('EBUSY: resource busy');
    }
    await super.unlink(file);
  }
}

describe('InstallRecordService', () => {
  let base: string;
  let root: string;
  let cleanup: () => void;
  let recordFs: NodeRecordFs;
  let store: RecordStore;
  let service: InstallRecordService;
  let committed: RecordLocation;
  let localOnly: RecordLocation;

  const build = async (fsPort: NodeRecordFs = new NodeRecordFs()): Promise<void> => {
    recordFs = fsPort;
    store = new RecordStore({ fs: recordFs, validator: new RecordSchemaValidator(), generatedBy: 'ai-primitives-hub-cli@0.3.0-test', now: () => NOW });
    service = new InstallRecordService({ store, fs: recordFs, now: () => NOW });
    [committed, localOnly] = await store.resolveRepository({ start: root });
  };

  /**
   * Write bundle files under the root and return their absolute paths.
   * @param relativePaths - Paths relative to the root.
   */
  const writeFiles = (...relativePaths: string[]): string[] => relativePaths.map((relative) => {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `content of ${relative}\n`);
    return absolute;
  });

  const input = (overrides: Partial<RecordInstallInput> & Pick<RecordInstallInput, 'writtenPaths'>): RecordInstallInput => ({
    location: committed,
    bundleId: 'acme-tools',
    version: '1.0.0',
    tool: 'vscode',
    source: SOURCE,
    sourceType: 'github',
    ...overrides
  });

  const readRecord = (location: RecordLocation): InstallRecord =>
    JSON.parse(fs.readFileSync(location.path, 'utf8')) as InstallRecord;

  const pathsOf = (record: InstallRecord, bundleId: string, tool: string): string[] =>
    record.bundles[bundleId].tools[tool].files.map((file) => file.installedPath);

  beforeEach(async () => {
    [base, cleanup] = createTempDir('install-record-service-');
    root = path.join(base, 'repo');
    makeGitDir(root);
    await build();
  });

  afterEach(() => {
    cleanup();
  });

  it('records vscode then kiro side by side for one bundle', async () => {
    await service.recordInstall(input({ writtenPaths: writeFiles('.github/instructions/style.instructions.md') }));
    const change = await service.recordInstall(input({ tool: 'kiro', writtenPaths: writeFiles('.kiro/steering/style.md') }));

    const record = readRecord(committed);
    expect(Object.keys(record.bundles['acme-tools'].tools).toSorted()).toEqual(['kiro', 'vscode']);
    expect(pathsOf(record, 'acme-tools', 'vscode')).toEqual(['.github/instructions/style.instructions.md']);
    expect(pathsOf(record, 'acme-tools', 'kiro')).toEqual(['.kiro/steering/style.md']);
    const kiro = record.bundles['acme-tools'].tools.kiro;
    expect(kiro).toMatchObject({ version: '1.0.0', sourceId: 'acme-github', sourceType: 'github', installedAt: NOW.toISOString() });
    const expected = createHash('sha256').update('content of .kiro/steering/style.md\n').digest('hex');
    expect(kiro.files[0].checksum).toBe(`sha256:${expected}`);
    expect(record.sources['acme-github']).toEqual({ type: 'github', url: 'https://github.com/acme/tools' });
    expect(change).toMatchObject({ changedEntries: [{ bundleId: 'acme-tools', tool: 'kiro' }], deletedFiles: [], keptSharedFiles: [], location: committed });
  });

  it('replaces only its own entry on reinstall', async () => {
    await service.recordInstall(input({ writtenPaths: writeFiles('.github/prompts/a.prompt.md') }));
    await service.recordInstall(input({ tool: 'kiro', writtenPaths: writeFiles('.kiro/steering/a.md') }));
    await service.recordInstall(input({ bundleId: 'other-bundle', writtenPaths: writeFiles('.github/prompts/other.prompt.md') }));
    const before = readRecord(committed);

    await service.recordInstall(input({ version: '2.0.0', writtenPaths: writeFiles('.github/prompts/a.prompt.md') }));

    const after = readRecord(committed);
    expect(after.bundles['acme-tools'].tools.vscode.version).toBe('2.0.0');
    expect(after.bundles['acme-tools'].tools.kiro).toEqual(before.bundles['acme-tools'].tools.kiro);
    expect(after.bundles['other-bundle']).toEqual(before.bundles['other-bundle']);
  });

  it('deletes a superseded file and keeps one another entry still lists', async () => {
    await service.recordInstall(input({ bundleId: 'shared-owner', writtenPaths: writeFiles('.github/prompts/shared.prompt.md') }));
    await service.recordInstall(input({ writtenPaths: writeFiles('.github/prompts/old.prompt.md', '.github/prompts/shared.prompt.md') }));

    const change = await service.recordInstall(input({ version: '2.0.0', writtenPaths: writeFiles('.github/prompts/new.prompt.md') }));
    expect(change.deletedFiles).toEqual(['.github/prompts/old.prompt.md']);
    expect(change.keptSharedFiles).toEqual(['.github/prompts/shared.prompt.md']);
    // recordInstall itself deletes nothing.
    expect(fs.existsSync(path.join(root, '.github/prompts/old.prompt.md'))).toBe(true);

    const result = await service.deleteSuperseded(change);
    expect(result).toEqual({ deleted: ['.github/prompts/old.prompt.md'], warnings: [] });
    expect(fs.existsSync(path.join(root, '.github/prompts/old.prompt.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.github/prompts/shared.prompt.md'))).toBe(true);
  });

  it('skips a superseded path that is now a folder, with a warning', async () => {
    await service.recordInstall(input({ writtenPaths: writeFiles('.github/prompts/old.prompt.md') }));
    const oldPath = path.join(root, '.github/prompts/old.prompt.md');
    fs.rmSync(oldPath);
    fs.mkdirSync(oldPath);
    fs.writeFileSync(path.join(oldPath, 'keep.txt'), 'keep');

    const change = await service.recordInstall(input({ version: '2.0.0', writtenPaths: writeFiles('.github/prompts/new.prompt.md') }));
    const result = await service.deleteSuperseded(change);

    expect(result.deleted).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('.github/prompts/old.prompt.md');
    expect(fs.existsSync(path.join(oldPath, 'keep.txt'))).toBe(true);
  });

  it('unlinks a superseded symlink that points outside the root and keeps its target', async (context) => {
    if (!canSymlinkFile(base)) {
      context.skip();
    }
    const outside = path.join(base, 'outside.md');
    fs.writeFileSync(outside, 'outside\n');
    const link = path.join(root, '.github/prompts/link.prompt.md');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(outside, link, 'file');
    await service.recordInstall(input({ writtenPaths: [link] }));

    const change = await service.recordInstall(input({ version: '2.0.0', writtenPaths: writeFiles('.github/prompts/new.prompt.md') }));
    expect(change.deletedFiles).toEqual(['.github/prompts/link.prompt.md']);
    const result = await service.deleteSuperseded(change);

    expect(result.deleted).toEqual(['.github/prompts/link.prompt.md']);
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside\n');
  });

  it('moves an entry between the two repository files when the commit mode changes', async () => {
    await service.recordInstall(input({ writtenPaths: writeFiles('.github/prompts/a.prompt.md') }));
    await service.recordInstall(input({ bundleId: 'stays', writtenPaths: writeFiles('.github/prompts/stays.prompt.md') }));

    const change = await service.recordInstall(input({ location: localOnly, writtenPaths: writeFiles('.github/prompts/a.prompt.md') }));
    expect(change.location).toBe(localOnly);
    expect(change.deletedFiles).toEqual([]);
    const local = readRecord(localOnly);
    expect(pathsOf(local, 'acme-tools', 'vscode')).toEqual(['.github/prompts/a.prompt.md']);
    expect(local.sources['acme-github']).toBeDefined();
    const remaining = readRecord(committed);
    expect(Object.keys(remaining.bundles)).toEqual(['stays']);
    expect(fs.readFileSync(path.join(root, '.git/info/exclude'), 'utf8')).toContain(LOCAL_RECORD_FILE_NAME);

    // Moving the last bundle out removes the committed file (BR3.6).
    await service.recordInstall(input({ bundleId: 'stays', location: localOnly, writtenPaths: writeFiles('.github/prompts/stays.prompt.md') }));
    expect(fs.existsSync(path.join(root, RECORD_FILE_NAME))).toBe(false);
    expect(Object.keys(readRecord(localOnly).bundles).toSorted()).toEqual(['acme-tools', 'stays']);
  });

  it('carries the moved entry\'s files into the superseded check', async () => {
    await service.recordInstall(input({ writtenPaths: writeFiles('.github/prompts/old.prompt.md') }));
    const change = await service.recordInstall(input({ location: localOnly, writtenPaths: writeFiles('.github/prompts/new.prompt.md') }));
    expect(change.deletedFiles).toEqual(['.github/prompts/old.prompt.md']);
  });

  it('refuses a tool that is not a target type with RECORD.UNKNOWN_TOOL and writes nothing', async () => {
    await expectRecordError(service.recordInstall(input({ tool: 'my-vscode-target', writtenPaths: writeFiles('a.md') })), 'RECORD.UNKNOWN_TOOL');
    expect(fs.existsSync(committed.path)).toBe(false);
  });

  it('refuses a sourceType that does not match source.type, or is not a source type', async () => {
    await expectRecordError(service.recordInstall(input({ sourceType: 'local', writtenPaths: writeFiles('a.md') })), 'RECORD.MALFORMED');
    await expectRecordError(
      service.recordInstall(input({ sourceType: 'ftp', source: { ...SOURCE, type: 'ftp' }, writtenPaths: writeFiles('a.md') })),
      'RECORD.MALFORMED'
    );
    expect(fs.existsSync(committed.path)).toBe(false);
  });

  it('leaves merged MCP config files out of the record', async () => {
    const written = writeFiles('.vscode/mcp.json', '.kiro/settings/mcp.json', '.github/prompts/a.prompt.md');
    await service.recordInstall(input({ writtenPaths: written }));
    expect(pathsOf(readRecord(committed), 'acme-tools', 'vscode')).toEqual(['.github/prompts/a.prompt.md']);
    expect(isMergedMcpConfigPath('.mcp.json')).toBe(true);
    expect(isMergedMcpConfigPath('.github/prompts/mcp.prompt.md')).toBe(false);
  });

  it('leaves out the merged MCP config of a workspace below the git root', async () => {
    const written = writeFiles('packages/web/.vscode/mcp.json', 'packages/web/.github/prompts/a.prompt.md');
    await service.recordInstall(input({ writtenPaths: written, workspaceRoot: path.join(root, 'packages', 'web') }));
    expect(pathsOf(readRecord(committed), 'acme-tools', 'vscode')).toEqual(['packages/web/.github/prompts/a.prompt.md']);
    expect(isMergedMcpConfigPath('packages/web/.vscode/mcp.json', 'packages/web')).toBe(true);
    expect(isMergedMcpConfigPath('.vscode/mcp.json', 'packages/web')).toBe(false);
  });

  it('records a bundle file named like an MCP config inside a bundle folder (a plugin\'s .mcp.json)', async () => {
    const written = writeFiles('.github/plugins/foo/.mcp.json', '.github/plugins/foo/plugin.json');
    await service.recordInstall(input({ writtenPaths: written }));
    expect(pathsOf(readRecord(committed), 'acme-tools', 'vscode'))
      .toEqual(['.github/plugins/foo/.mcp.json', '.github/plugins/foo/plugin.json']);
    expect(isMergedMcpConfigPath('.github/plugins/foo/.mcp.json')).toBe(false);
  });

  it('reports a failed deletion as a warning and leaves the saved record unchanged', async () => {
    await build(new FailingUnlinkFs('old.prompt.md'));
    await service.recordInstall(input({ writtenPaths: writeFiles('.github/prompts/old.prompt.md') }));
    const change = await service.recordInstall(input({ version: '2.0.0', writtenPaths: writeFiles('.github/prompts/new.prompt.md') }));
    const saved = fs.readFileSync(committed.path, 'utf8');

    const result = await service.deleteSuperseded(change);

    expect(result.deleted).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining('EBUSY')]);
    expect(fs.readFileSync(committed.path, 'utf8')).toBe(saved);
    expect(fs.existsSync(path.join(root, '.github/prompts/old.prompt.md'))).toBe(true);
  });

  it('refuses a written path outside the root with RECORD.PATH_OUTSIDE_ROOT', async () => {
    const outside = path.join(base, 'elsewhere.md');
    fs.writeFileSync(outside, 'x');
    await expectRecordError(service.recordInstall(input({ writtenPaths: [outside] })), 'RECORD.PATH_OUTSIDE_ROOT');
    expect(fs.existsSync(committed.path)).toBe(false);
  });

  it('stops on a malformed record and leaves it byte-identical', async () => {
    fs.writeFileSync(committed.path, '{ not json');
    await expectRecordError(service.recordInstall(input({ writtenPaths: writeFiles('a.md') })), 'RECORD.MALFORMED');
    expect(fs.readFileSync(committed.path, 'utf8')).toBe('{ not json');
  });

  describe('recordUninstall', () => {
    it('removes only the kiro entry and keeps the vscode entry and its files', async () => {
      await service.recordInstall(input({ writtenPaths: writeFiles('.github/prompts/a.prompt.md') }));
      await service.recordInstall(input({ tool: 'kiro', writtenPaths: writeFiles('.kiro/steering/a.md') }));
      const vscodeBefore = readRecord(committed).bundles['acme-tools'].tools.vscode;

      const change = await service.recordUninstall({ location: committed, bundleId: 'acme-tools', tool: 'kiro' });
      expect(change).toMatchObject({
        changedEntries: [{ bundleId: 'acme-tools', tool: 'kiro' }],
        deletedFiles: ['.kiro/steering/a.md'],
        keptSharedFiles: [],
        location: committed
      });
      // recordUninstall itself deletes no installed file.
      expect(fs.existsSync(path.join(root, '.kiro/steering/a.md'))).toBe(true);
      expect(await service.deleteSuperseded(change)).toEqual({ deleted: ['.kiro/steering/a.md'], warnings: [] });

      const after = readRecord(committed);
      expect(Object.keys(after.bundles['acme-tools'].tools)).toEqual(['vscode']);
      expect(after.bundles['acme-tools'].tools.vscode).toEqual(vscodeBefore);
      expect(after.sources['acme-github']).toBeDefined();
      expect(fs.existsSync(path.join(root, '.kiro/steering/a.md'))).toBe(false);
      expect(fs.existsSync(path.join(root, '.github/prompts/a.prompt.md'))).toBe(true);
    });

    it('deletes the record file when the last entry is removed', async () => {
      await service.recordInstall(input({ writtenPaths: writeFiles('.github/prompts/a.prompt.md') }));

      const change = await service.recordUninstall({ location: committed, bundleId: 'acme-tools', tool: 'vscode' });
      await service.deleteSuperseded(change);

      expect(fs.existsSync(committed.path)).toBe(false);
      expect(fs.existsSync(path.join(root, '.github/prompts/a.prompt.md'))).toBe(false);
    });

    it('keeps a file another entry in the other repository file still lists, and drops the unused source', async () => {
      await service.recordInstall(input({ writtenPaths: writeFiles('.github/prompts/shared.prompt.md', '.github/prompts/own.prompt.md') }));
      await service.recordInstall(input({
        location: localOnly,
        bundleId: 'other',
        source: { sourceId: 'other-src', type: 'local', url: '/tmp/other' },
        sourceType: 'local',
        writtenPaths: writeFiles('.github/prompts/shared.prompt.md')
      }));
      await service.recordInstall(input({ bundleId: 'stays', writtenPaths: writeFiles('.github/prompts/stays.prompt.md') }));

      const change = await service.recordUninstall({ location: committed, bundleId: 'other', tool: 'vscode' });
      expect(change.location).toEqual(localOnly);
      expect(change.deletedFiles).toEqual([]);
      expect(change.keptSharedFiles).toEqual(['.github/prompts/shared.prompt.md']);
      expect(fs.existsSync(localOnly.path)).toBe(false);

      const kept = await service.recordUninstall({ location: committed, bundleId: 'acme-tools', tool: 'vscode' });
      expect(kept.deletedFiles).toEqual(['.github/prompts/own.prompt.md', '.github/prompts/shared.prompt.md']);
      const record = readRecord(committed);
      expect(Object.keys(record.bundles)).toEqual(['stays']);
      expect(Object.keys(record.sources)).toEqual(['acme-github']);
    });

    it('throws RECORD.ENTRY_NOT_FOUND and changes nothing when there is no entry', async () => {
      await service.recordInstall(input({ writtenPaths: writeFiles('.github/prompts/a.prompt.md') }));
      const saved = fs.readFileSync(committed.path, 'utf8');

      await expectRecordError(service.recordUninstall({ location: committed, bundleId: 'acme-tools', tool: 'kiro' }), 'RECORD.ENTRY_NOT_FOUND');
      await expectRecordError(service.recordUninstall({ location: localOnly, bundleId: 'missing', tool: 'vscode' }), 'RECORD.ENTRY_NOT_FOUND');
      expect(fs.readFileSync(committed.path, 'utf8')).toBe(saved);
      expect(fs.existsSync(localOnly.path)).toBe(false);
    });

    it('stops on a malformed other file before changing anything', async () => {
      await service.recordInstall(input({ writtenPaths: writeFiles('.github/prompts/a.prompt.md') }));
      const saved = fs.readFileSync(committed.path, 'utf8');
      fs.writeFileSync(localOnly.path, '[]');

      await expectRecordError(service.recordUninstall({ location: committed, bundleId: 'acme-tools', tool: 'vscode' }), 'RECORD.MALFORMED');
      expect(fs.readFileSync(committed.path, 'utf8')).toBe(saved);
      expect(fs.readFileSync(localOnly.path, 'utf8')).toBe('[]');
    });
  });
});
