/** Contract tests for the record plan, the record services factory and the legacy lockfile shapes. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type RecordLocation,
  RegistryError,
  type RegistrySource,
  type SourceRecord,
  type Target,
  type ToolEntry,
} from '@ai-primitives-hub/core';
import {
  NodeRecordFs,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  createInstallRecordServices,
  type HoldingFileRule,
  type InstallRecordServices,
  LOCAL_SOURCE_OUTSIDE_REASON,
  planRecordEntries,
  type RecordPlan,
  toLockfileBundleEntry,
  toLockfileSourceEntry,
} from '../../src/records';

const CHECKSUM = `sha256:${'0'.repeat(64)}`;
const GENERATED_BY = 'ai-primitives-hub-cli@0.3.0';

interface EntrySpec {
  bundleId: string;
  tool: string;
  sourceId?: string;
  files?: string[];
  needsReinstall?: true;
}

describe('record plan and services', () => {
  let base: string;
  let root: string;
  let services: InstallRecordServices;
  let committed: RecordLocation;
  let localOnly: RecordLocation;

  const target = (name: string, type: Target['type'], scope: Target['scope'] = 'repository'): Target =>
    ({ name, type, scope, ...(scope === 'repository' ? { rootPath: root, commitMode: 'commit' } : {}) });

  const write = (...relativePaths: string[]): string[] => relativePaths.map((relative) => {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `content of ${relative}\n`);
    return absolute;
  });

  /**
   * Write a valid record file with the given entries and sources.
   * @param location - Record file.
   * @param entries - Entries to write.
   * @param sources - Sources by id.
   */
  const writeRecord = (location: RecordLocation, entries: EntrySpec[], sources: Record<string, SourceRecord>): void => {
    const bundles: Record<string, { tools: Record<string, object> }> = {};
    for (const spec of entries) {
      const files = spec.files ?? [`.github/prompts/${spec.bundleId}.prompt.md`];
      write(...files);
      bundles[spec.bundleId] ??= { tools: {} };
      bundles[spec.bundleId].tools[spec.tool] = {
        version: '1.0.0', sourceId: spec.sourceId ?? 'acme', sourceType: 'github', installedAt: '2026-10-24T10:00:00.000Z',
        files: files.map((file) => ({ path: file, checksum: CHECKSUM })),
        ...(spec.needsReinstall ? { needsReinstall: true } : {})
      };
    }
    fs.writeFileSync(location.path, JSON.stringify({
      $schema: 'https://github.com/AmadeusITGroup/ai-primitives-hub/schemas/lockfile.schema.json',
      version: '3.0.0', level: 'repository', generatedAt: '2026-10-24T10:00:00.000Z', generatedBy: GENERATED_BY,
      bundles, sources
    }));
  };

  const acme: SourceRecord = { type: 'github', url: 'https://github.com/acme/tools' };
  const configuredAcme: RegistrySource = {
    id: 'acme', name: 'Acme', type: 'github', url: 'https://github.com/acme/tools', enabled: true, priority: 0, config: { branch: 'main' }
  };

  const plan = (options: { targets: Target[]; explicit?: Target; holdingFile?: HoldingFileRule; configured?: RegistrySource[] }): Promise<RecordPlan> =>
    planRecordEntries({
      service: services.service,
      store: services.store,
      fs: services.fs,
      selection: { level: 'repository', root, locations: [committed, localOnly], inferred: false, reason: 'explicit-scope' },
      targets: options.targets,
      configured: new Map((options.configured ?? [configuredAcme]).map((source) => [source.id, source])),
      explicit: options.explicit,
      cwd: root,
      holdingFile: options.holdingFile ?? 'first-holding'
    });

  const planned = (result: RecordPlan): { bundleId: string; tool: string; target: string; record: string; fromRecordOnly: boolean }[] =>
    result.items.map((item) => ({
      bundleId: item.bundleId, tool: item.tool, target: item.target.name, record: path.basename(item.location.path), fromRecordOnly: item.fromRecordOnly
    }));

  beforeEach(async () => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'record-plan-')));
    root = path.join(base, 'repo');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    services = createInstallRecordServices({ generatedBy: GENERATED_BY });
    [committed, localOnly] = await services.store.resolveRepository({ start: root });
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  describe('createInstallRecordServices', () => {
    it('builds a store and service that record with the given writer stamp', async () => {
      await services.service.recordInstall({
        location: committed, bundleId: 'b1', version: '1.0.0', tool: 'vscode',
        source: { sourceId: 'acme', ...acme }, sourceType: 'github', writtenPaths: write('.github/prompts/a.prompt.md')
      });

      expect(services.fs).toBeInstanceOf(NodeRecordFs);
      expect(JSON.parse(fs.readFileSync(committed.path, 'utf8'))).toMatchObject({ generatedBy: GENERATED_BY, bundles: { b1: { tools: { vscode: { version: '1.0.0' } } } } });
    });

    it('uses the given filesystem port', () => {
      const recordFs = new NodeRecordFs();

      expect(createInstallRecordServices({ generatedBy: GENERATED_BY, fs: recordFs }).fs).toBe(recordFs);
    });
  });

  describe('planRecordEntries', () => {
    it('plans each entry with its target and source, marking sources only the record knows', async () => {
      writeRecord(committed, [
        { bundleId: 'b1', tool: 'vscode' },
        { bundleId: 'b2', tool: 'kiro', sourceId: 'other' }
      ], { acme, other: { type: 'github', url: 'https://github.com/other/tools' } });

      const result = await plan({ targets: [target('vscode-main', 'vscode'), target('kiro-main', 'kiro')] });

      expect(planned(result)).toEqual([
        { bundleId: 'b1', tool: 'vscode', target: 'vscode-main', record: 'ai-primitives-hub.lock.json', fromRecordOnly: false },
        { bundleId: 'b2', tool: 'kiro', target: 'kiro-main', record: 'ai-primitives-hub.lock.json', fromRecordOnly: true }
      ]);
      expect(result.items.map((item) => item.source)).toEqual([
        { sourceId: 'acme', type: 'github', url: 'https://github.com/acme/tools', branch: 'main' },
        { sourceId: 'other', type: 'github', url: 'https://github.com/other/tools' }
      ]);
      expect(result.items[0].entry).toMatchObject({ version: '1.0.0', sourceId: 'acme' });
      expect({ considered: result.considered, skipped: result.skipped, needsReinstall: result.needsReinstall, notes: result.notes })
        .toEqual({ considered: 2, skipped: [], needsReinstall: [], notes: [] });
    });

    it('with --target, plans only entries of that tool', async () => {
      writeRecord(committed, [{ bundleId: 'b1', tool: 'vscode' }, { bundleId: 'b1', tool: 'kiro' }, { bundleId: 'b2', tool: 'kiro' }], { acme });
      const kiro = target('kiro-main', 'kiro');

      const result = await plan({ targets: [target('vscode-main', 'vscode'), kiro], explicit: kiro });

      expect(planned(result).map((item) => `${item.bundleId}/${item.tool}`)).toEqual(['b1/kiro', 'b2/kiro']);
      expect(result.considered).toBe(2);
    });

    it('maps each tool once and reports a several-targets note once', async () => {
      writeRecord(committed, [{ bundleId: 'b1', tool: 'vscode' }, { bundleId: 'b2', tool: 'vscode' }], { acme });

      const result = await plan({ targets: [target('vscode-b', 'vscode'), target('vscode-a', 'vscode')] });

      expect(result.items.map((item) => item.target.name)).toEqual(['vscode-a', 'vscode-a']);
      expect(result.items[0].target).toBe(result.items[1].target);
      expect(await result.mapTool('vscode')).toBe(await result.mapTool('vscode'));
      expect(result.notes).toEqual(['several vscode targets match; using vscode-a']);
    });

    it('maps a sibling tool on demand', async () => {
      writeRecord(committed, [{ bundleId: 'b1', tool: 'vscode' }], { acme });

      const result = await plan({ targets: [target('vscode-main', 'vscode'), target('copilot-main', 'copilot-cli')] });

      expect(await result.mapTool('copilot-cli')).toEqual({ target: target('copilot-main', 'copilot-cli') });
      expect(await result.mapTool('claude-code')).toEqual({ skip: 'no claude-code target configured; add one with `target add`' });
    });

    it('skips an entry with no target and one whose source fails the trust gate', async () => {
      fs.mkdirSync(path.join(base, 'outside'));
      writeRecord(committed, [
        { bundleId: 'b1', tool: 'claude-code' },
        { bundleId: 'b2', tool: 'vscode', sourceId: 'mine' }
      ], { acme, mine: { type: 'local', url: '../outside' } });

      const result = await plan({ targets: [target('vscode-main', 'vscode')] });

      expect(result.items).toEqual([]);
      expect(result.skipped).toEqual([
        { bundleId: 'b1', tool: 'claude-code', reason: 'no claude-code target configured; add one with `target add`' },
        { bundleId: 'b2', tool: 'vscode', reason: LOCAL_SOURCE_OUTSIDE_REASON }
      ]);
      expect(result.considered).toBe(2);
    });

    it('lists unknown-tool entries as needing a reinstall and never plans them', async () => {
      writeRecord(committed, [{ bundleId: 'b1', tool: 'unknown', needsReinstall: true }, { bundleId: 'b2', tool: 'vscode' }], { acme });

      const result = await plan({ targets: [target('vscode-main', 'vscode')] });

      expect(result.needsReinstall).toEqual([
        { bundleId: 'b1', tool: 'unknown', level: 'repository', version: '1.0.0', record: committed.path, needsReinstall: true }
      ]);
      expect(planned(result).map((item) => item.bundleId)).toEqual(['b2']);
      expect(result.considered).toBe(1);
    });

    it.each([
      ['first-holding', ['ai-primitives-hub.lock.json', 'ai-primitives-hub.lock.json']],
      ['listed', ['ai-primitives-hub.local.lock.json', 'ai-primitives-hub.lock.json']]
    ] as [HoldingFileRule, string[]][])('re-records an entry held in both files in the %s file', async (holdingFile, expected) => {
      writeRecord(committed, [{ bundleId: 'b1', tool: 'vscode' }], { acme });
      writeRecord(localOnly, [{ bundleId: 'b1', tool: 'vscode' }], { acme });

      const result = await plan({ targets: [target('vscode-main', 'vscode')], holdingFile });

      expect(planned(result).map((item) => item.record).toSorted()).toEqual(expected.toSorted());
    });

    it('stops with RECORD.MALFORMED when an entry\'s source is not in the record', async () => {
      writeRecord(committed, [{ bundleId: 'b1', tool: 'vscode', sourceId: 'gone' }], { acme });

      const result = plan({ targets: [target('vscode-main', 'vscode')] });

      await expect(result).rejects.toBeInstanceOf(RegistryError);
      await expect(result).rejects.toMatchObject({ code: 'RECORD.MALFORMED' });
    });
  });

  describe('record entry queries and cleanup', () => {
    it('lists the recorded paths of one tool by bundle, merged over both files', async () => {
      writeRecord(committed, [
        { bundleId: 'b2', tool: 'vscode', files: ['docs/b2.md'] },
        { bundleId: 'b1', tool: 'vscode', files: ['docs/a.md', 'docs/shared.md'] },
        { bundleId: 'b1', tool: 'kiro', files: ['.kiro/k.md'] }
      ], { acme });
      writeRecord(localOnly, [{ bundleId: 'b1', tool: 'vscode', files: ['docs/shared.md', 'docs/z.md'] }], { acme });

      const entries = await services.service.entriesForTool([committed, localOnly], 'vscode');

      expect([...entries]).toEqual([
        ['b1', ['docs/a.md', 'docs/shared.md', 'docs/z.md']],
        ['b2', ['docs/b2.md']]
      ]);
    });

    it('finds no holding file for an entry that is not recorded', async () => {
      writeRecord(committed, [{ bundleId: 'b1', tool: 'vscode' }], { acme });

      expect(await services.service.holdingLocation([committed, localOnly], 'b1', 'kiro')).toBeUndefined();
    });

    it('after several changes, deletes each superseded file once and keeps any file still listed', async () => {
      write('docs/old.md', 'docs/gone.md');
      writeRecord(committed, [{ bundleId: 'b1', tool: 'vscode', files: ['docs/still.md'] }], { acme });

      const result = await services.service.deleteSupersededAfterAll([
        { deletedFiles: ['docs/old.md', 'docs/still.md'], location: committed },
        { deletedFiles: ['docs/old.md', 'docs/gone.md', 'docs/missing.md'], location: committed }
      ]);

      expect(result).toEqual({ deleted: ['docs/old.md', 'docs/gone.md'], warnings: [] });
      expect(fs.existsSync(path.join(root, 'docs', 'still.md'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'docs', 'old.md'))).toBe(false);
    });

    it('warns instead of deleting a superseded path that is a folder', async () => {
      fs.mkdirSync(path.join(root, 'docs', 'folder'), { recursive: true });

      const result = await services.service.deleteSuperseded({ deletedFiles: ['docs/folder'], location: committed });

      expect(result).toEqual({ deleted: [], warnings: ['Did not remove docs/folder: it is a folder.'] });
      expect(fs.existsSync(path.join(root, 'docs', 'folder'))).toBe(true);
    });
  });
});

describe('legacy lockfile shapes', () => {
  it.each([
    ['keeps the known fields of a GitHub source',
      { type: 'github', url: 'https://github.com/acme/tools', branch: 'main', collectionsPath: 'collections' },
      { type: 'github', url: 'https://github.com/acme/tools', branch: 'main', collectionsPath: 'collections' }],
    ['keeps an Artifactory bearer source with its credential reference',
      { type: 'artifactory', url: 'https://art.example/repo', indexFile: 'index.json', authMode: 'bearer', credentialRef: 'ART_TOKEN' },
      { type: 'artifactory', url: 'https://art.example/repo', indexFile: 'index.json', authMode: 'bearer', credentialRef: 'ART_TOKEN' }],
    ['drops an unknown auth mode and unknown fields',
      { type: 'artifactory', url: 'https://art.example/repo', authMode: 'basic', extra: 'x' },
      { type: 'artifactory', url: 'https://art.example/repo' }]
  ] as [string, SourceRecord, object][])('a record source %s', (_label, source, expected) => {
    expect(toLockfileSourceEntry(source)).toEqual(expected);
  });

  it('a tool entry keeps its version, source and file checksums only', () => {
    const entry = {
      version: '1.2.0', sourceId: 'acme', sourceType: 'github', installedAt: '2026-10-24T10:00:00.000Z', needsReinstall: true,
      files: [{ path: 'docs/a.md', checksum: CHECKSUM, extra: 1 }]
    } as unknown as ToolEntry;

    expect(toLockfileBundleEntry(entry)).toEqual({
      version: '1.2.0', sourceId: 'acme', sourceType: 'github', installedAt: '2026-10-24T10:00:00.000Z',
      files: [{ path: 'docs/a.md', checksum: CHECKSUM }]
    });
  });
});
