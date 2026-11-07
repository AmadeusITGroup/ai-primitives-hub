/**
 * Tests for app/install/recorded-files.ts (`locateRecord`,
 * `inspectRecordedFiles`, `isRecordIncomplete`).
 */
import {
  createHash,
} from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  Target,
  TargetWriter,
} from '@ai-primitives-hub/core';
import {
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  inspectRecordedFiles,
  isRecordIncomplete,
  locateRecord,
} from '../../src/install/recorded-files';
import {
  createTargetWriterFactory,
} from '../../src/install/target-writer-factory';
import type {
  InstallRecord,
} from '../../src/stores/install-record-store';
import type {
  LockfileFileEntry,
} from '../../src/stores/json-lockfile-store';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

const vscodeRepo: Target = { name: 'v', type: 'vscode', scope: 'repository', rootPath: '/ws', commitMode: 'commit' };
const factory = createTargetWriterFactory({
  fs: new InMemoryFileSystem(), env: { HOME: '/home/u' }, projectDir: null, userConfigDir: null, writerOwnsExclusion: false
});
const record = (targetType: string | undefined, files: string[] = ['prompts/a.prompt.md']): InstallRecord => ({
  entry: {
    version: '1.0.0',
    sourceId: 's',
    sourceType: 'local',
    installedAt: '2026-01-01T00:00:00.000Z',
    ...(targetType === undefined ? {} : { targetType }),
    files: files.map((p) => ({ path: p, checksum: '0'.repeat(64) }))
  },
  commitMode: 'local-only'
});

describe('locateRecord', () => {
  it('locates with the writer of the recorded target type and the record commit mode', async () => {
    const located = await locateRecord(factory, vscodeRepo, record('kiro', ['prompts/a.prompt.md', 'README.md']));

    expect(located.kind).toBe('located');
    if (located.kind !== 'located') {
      return;
    }
    expect(located.target).toMatchObject({ type: 'kiro', scope: 'repository', rootPath: '/ws', commitMode: 'local-only' });
    expect(located.located).toEqual({
      root: path.join('/ws', '.kiro'),
      paths: [path.join('/ws', '.kiro', 'steering', 'a.prompt.md'), null]
    });
  });

  it('locates a record of another target type at that type\'s base directory, not at the caller\'s path', async () => {
    const vscodeUser: Target = { name: 'v', type: 'vscode', scope: 'user', path: '/custom/vscode', allowedKinds: ['agent'] };

    const located = await locateRecord(factory, vscodeUser, { entry: record('kiro').entry });

    expect(located.kind).toBe('located');
    if (located.kind !== 'located') {
      return;
    }
    expect(located.target).toEqual({ name: 'v', type: 'kiro', scope: 'user' });
    expect(located.located).toEqual({
      root: path.join('/home/u', '.kiro'),
      paths: [path.join('/home/u', '.kiro', 'steering', 'a.prompt.md')]
    });
  });

  it('honours the caller\'s path and allowed kinds for a record of the caller\'s target type', async () => {
    const kiroUser: Target = { name: 'k', type: 'kiro', scope: 'user', path: '/custom/kiro', allowedKinds: ['prompt'] };

    const located = await locateRecord(factory, kiroUser, { entry: record('kiro').entry });

    expect(located.kind).toBe('located');
    if (located.kind !== 'located') {
      return;
    }
    expect(located.target).toEqual(kiroUser);
    expect(located.located).toEqual({
      root: path.join('/custom/kiro'),
      paths: [path.join('/custom/kiro', 'steering', 'a.prompt.md')]
    });
  });

  it('uses the caller target type when the record has none', async () => {
    const located = await locateRecord(factory, vscodeRepo, record(undefined));

    expect(located.kind === 'located' && located.located.paths).toEqual([path.join('/ws', '.github', 'prompts', 'a.prompt.md')]);
  });

  it('is unresolvable for an unknown target type', async () => {
    expect(await locateRecord(factory, vscodeRepo, record('emacs'))).toEqual({
      kind: 'unresolvable',
      reason: 'unknown target type "emacs"'
    });
  });

  it('is unresolvable when locate throws', async () => {
    const writer: TargetWriter = {
      write: () => Promise.resolve({ written: [], skipped: [] }),
      remove: () => Promise.resolve(),
      locate: () => Promise.reject(new Error('No layout defined for target type "vscode"'))
    };

    expect(await locateRecord(() => writer, vscodeRepo, record('vscode'))).toEqual({
      kind: 'unresolvable',
      reason: 'No layout defined for target type "vscode"'
    });
  });

  it('is unresolvable when the writer factory throws', async () => {
    const located = await locateRecord(factory, { name: 'v', type: 'vscode', scope: 'repository' }, record('vscode'));

    expect(located).toEqual({ kind: 'unresolvable', reason: 'repository target needs rootPath' });
  });

  it('reports a writer without locate', async () => {
    const writer: TargetWriter = { write: () => Promise.resolve({ written: [], skipped: [] }), remove: () => Promise.resolve() };

    const located = await locateRecord(() => writer, vscodeRepo, record('vscode'));

    expect(located.kind).toBe('no-locate');
  });
});

describe('inspectRecordedFiles', () => {
  const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
  const nodeFs = new NodeFileSystem();
  let tmp: string;
  let ws: string;
  let target: Target;
  let diskFactory: ReturnType<typeof createTargetWriterFactory>;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'inspect-recorded-'));
    ws = path.join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    target = { name: 'v', type: 'vscode', scope: 'repository', rootPath: ws, commitMode: 'commit' };
    diskFactory = createTargetWriterFactory({
      fs: nodeFs, env: { HOME: path.join(tmp, 'home') }, projectDir: null, userConfigDir: null, writerOwnsExclusion: false
    });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Write a file below the workspace's `.github/`.
   * @param relativePath
   * @param content
   */
  const seed = (relativePath: string, content: string): string => {
    const location = path.join(ws, '.github', relativePath);
    mkdirSync(path.dirname(location), { recursive: true });
    writeFileSync(location, content);
    return location;
  };
  const fileEntry = (p: string, content: string, extra: Partial<LockfileFileEntry> = {}): LockfileFileEntry =>
    ({ path: p, checksum: sha256(content), ...extra });
  const recordOf = (files: LockfileFileEntry[], targetType = 'vscode'): InstallRecord => ({
    entry: { version: '1.0.0', sourceId: 's', sourceType: 'local', installedAt: '2026-01-01T00:00:00.000Z', targetType, files }
  });
  const inspect = async (files: LockfileFileEntry[], targetType?: string, writerFactory = diskFactory) => inspectRecordedFiles({
    located: await locateRecord(writerFactory, target, recordOf(files, targetType)),
    files,
    fs: nodeFs
  });
  const clean = { missing: [], modified: [], unknown: [] };

  it('reports nothing for a located file present and unchanged', async () => {
    seed('prompts/hello.prompt.md', '# Hello\n');

    expect(await inspect([fileEntry('prompts/hello.prompt.md', '# Hello\n')])).toEqual(clean);
  });

  it('reports a deleted file as missing', async () => {
    seed('prompts/kept.prompt.md', '# Kept\n');

    const result = await inspect([fileEntry('prompts/kept.prompt.md', '# Kept\n'), fileEntry('prompts/gone.prompt.md', '# Gone\n')]);

    expect(result).toEqual({ ...clean, missing: ['prompts/gone.prompt.md'] });
    expect(isRecordIncomplete(result)).toBe(true);
  });

  it('reports an edited file as modified with the checksum on disk', async () => {
    seed('prompts/hello.prompt.md', '# Edited\n');

    const result = await inspect([fileEntry('prompts/hello.prompt.md', '# Hello\n')]);

    expect(result).toEqual({ ...clean, modified: [{ path: 'prompts/hello.prompt.md', currentChecksum: sha256('# Edited\n') }] });
    expect(isRecordIncomplete(result)).toBe(false);
  });

  it('compares a transformed file against its installedChecksum', async () => {
    seed('prompts/hello.prompt.md', '# Transformed\n');

    const result = await inspect([fileEntry('prompts/hello.prompt.md', '# Hello\n', { installedChecksum: sha256('# Transformed\n') })]);

    expect(result).toEqual(clean);
  });

  it('reports a recorded path with no location inside the root as missing, even when the file exists', async () => {
    const outside = path.join(tmp, 'ext', 'bundles', 'x', 'plugin.json');
    mkdirSync(path.dirname(outside), { recursive: true });
    writeFileSync(outside, '{}');

    const result = await inspect([fileEntry('../ext/bundles/x/plugin.json', '{}')]);

    expect(result).toEqual({ ...clean, missing: ['../ext/bundles/x/plugin.json'] });
  });

  it('reports every file as unknown for an unknown target type', async () => {
    seed('prompts/hello.prompt.md', '# Hello\n');
    const files = [fileEntry('prompts/hello.prompt.md', '# Hello\n'), fileEntry('prompts/gone.prompt.md', '# Gone\n')];

    const result = await inspect(files, 'emacs');

    expect(result).toEqual({ ...clean, unknown: ['prompts/hello.prompt.md', 'prompts/gone.prompt.md'] });
    expect(isRecordIncomplete(result)).toBe(false);
  });

  it('reports every file as unknown for a writer that cannot locate files', async () => {
    const writer: TargetWriter = { write: () => Promise.resolve({ written: [], skipped: [] }), remove: () => Promise.resolve() };

    const result = await inspect([fileEntry('prompts/hello.prompt.md', '# Hello\n')], 'vscode', () => writer);

    expect(result).toEqual({ ...clean, unknown: ['prompts/hello.prompt.md'] });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports a file it cannot read as unknown', async () => {
    const location = seed('prompts/locked.prompt.md', '# Locked\n');
    chmodSync(location, 0o000);
    try {
      const result = await inspect([fileEntry('prompts/locked.prompt.md', '# Locked\n')]);

      expect(result).toEqual({ ...clean, unknown: ['prompts/locked.prompt.md'] });
      expect(isRecordIncomplete(result)).toBe(false);
    } finally {
      chmodSync(location, 0o644);
    }
  });
});
