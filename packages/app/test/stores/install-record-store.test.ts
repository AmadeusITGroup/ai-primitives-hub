/**
 * Tests for app/stores/install-record-store.ts.
 */
import * as path from 'node:path';
import type {
  RepositoryExclusion,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  createLockfileRecordStore,
} from '../../src/stores/install-record-store';
import {
  LOCAL_LOCKFILE_NAME,
  type Lockfile,
  LOCKFILE_NAME,
  type LockfileBundleEntry,
  type LockfileSourceEntry,
} from '../../src/stores/json-lockfile-store';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

const ROOT = '/ws';
const COMMIT_LOCK = path.join(ROOT, LOCKFILE_NAME);
const LOCAL_LOCK = path.join(ROOT, LOCAL_LOCKFILE_NAME);

class RecordingExclusion implements RepositoryExclusion {
  public readonly added: string[][] = [];
  public readonly removed: string[][] = [];

  public constructor(private readonly failing = false) {}

  public add(paths: readonly string[]): Promise<void> {
    this.added.push([...paths]);
    return this.failing ? Promise.reject(new Error('exclude unwritable')) : Promise.resolve();
  }

  public remove(paths: readonly string[]): Promise<void> {
    this.removed.push([...paths]);
    return this.failing ? Promise.reject(new Error('exclude unwritable')) : Promise.resolve();
  }
}

const entry = (version: string, files: string[] = ['prompts/a.prompt.md']): LockfileBundleEntry => ({
  version,
  sourceId: 'local-src',
  sourceType: 'local',
  installedAt: '2026-01-01T00:00:00.000Z',
  targetType: 'vscode',
  files: files.map((p) => ({ path: p, checksum: '0'.repeat(64) }))
});
const source = (url = '/bundles/a'): { id: string; descriptor: LockfileSourceEntry } => ({
  id: 'local-src',
  descriptor: { type: 'local', url }
});

const lockfile = (bundles: Record<string, LockfileBundleEntry>): string => JSON.stringify({
  $schema: 'x',
  version: '2.0.0',
  generatedAt: '2026-01-01T00:00:00.000Z',
  generatedBy: 'seed',
  bundles,
  sources: { 'local-src': { type: 'local', url: '/bundles/a' } }
});

const read = async (fs: InMemoryFileSystem, file: string): Promise<Lockfile> => JSON.parse(await fs.readFile(file)) as Lockfile;

const repositoryStore = (fs: InMemoryFileSystem, exclusion: RepositoryExclusion = new RecordingExclusion()) =>
  createLockfileRecordStore({ scope: 'repository', fs, rootPath: ROOT, generatedBy: 'test-cli', exclusion });

describe('createLockfileRecordStore (repository)', () => {
  it('gets a record from the commit lockfile before the local one, with the commit mode of its file', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(COMMIT_LOCK, lockfile({ both: entry('1.0.0') }));
    fs.seed(LOCAL_LOCK, lockfile({ both: entry('2.0.0'), local: entry('3.0.0') }));
    const store = repositoryStore(fs);

    expect(await store.get('both')).toEqual({ entry: entry('1.0.0'), commitMode: 'commit' });
    expect(await store.get('local')).toEqual({ entry: entry('3.0.0'), commitMode: 'local-only' });
    expect(await store.get('missing')).toBeUndefined();
  });

  it('lists every other record of both files', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(COMMIT_LOCK, lockfile({ a: entry('1.0.0'), b: entry('1.0.1') }));
    fs.seed(LOCAL_LOCK, lockfile({ a: entry('2.0.0'), c: entry('3.0.0') }));
    const store = repositoryStore(fs);

    const others = await store.others('a');

    expect(others).toEqual([
      { entry: entry('1.0.1'), commitMode: 'commit' },
      { entry: entry('3.0.0'), commitMode: 'local-only' }
    ]);
  });

  it('puts a record in the lockfile of its commit mode', async () => {
    const fs = new InMemoryFileSystem();
    const store = repositoryStore(fs);

    await store.put('a', entry('1.0.0'), source(), 'commit');
    await store.put('b', entry('1.0.0'), source(), 'local-only');

    const commit = await read(fs, COMMIT_LOCK);
    const local = await read(fs, LOCAL_LOCK);
    expect(Object.keys(commit.bundles)).toEqual(['a']);
    expect(Object.keys(local.bundles)).toEqual(['b']);
    expect(commit.sources['local-src']).toEqual({ type: 'local', url: '/bundles/a' });
    expect(commit.generatedBy).toBe('test-cli');
  });

  it('defaults to the commit lockfile', async () => {
    const fs = new InMemoryFileSystem();

    await repositoryStore(fs).put('a', entry('1.0.0'), source());

    expect(Object.keys((await read(fs, COMMIT_LOCK)).bundles)).toEqual(['a']);
    expect(await fs.exists(LOCAL_LOCK)).toBe(false);
  });

  it('moves a record to the other lockfile on a commit-mode change and deletes the emptied file', async () => {
    const fs = new InMemoryFileSystem();
    const exclusion = new RecordingExclusion();
    const store = repositoryStore(fs, exclusion);
    await store.put('a', entry('1.0.0'), source(), 'local-only');
    await store.put('keep', entry('1.0.0'), source(), 'commit');

    await store.put('a', entry('2.0.0'), source(), 'commit');

    expect(Object.keys((await read(fs, COMMIT_LOCK)).bundles).toSorted()).toEqual(['a', 'keep']);
    expect(await fs.exists(LOCAL_LOCK)).toBe(false);
    expect(await store.get('a')).toEqual({ entry: entry('2.0.0'), commitMode: 'commit' });
    expect(exclusion.removed).toEqual([[LOCAL_LOCK]]);

    await store.put('a', entry('3.0.0'), source(), 'local-only');

    expect(Object.keys((await read(fs, COMMIT_LOCK)).bundles)).toEqual(['keep']);
    expect(Object.keys((await read(fs, LOCAL_LOCK)).bundles)).toEqual(['a']);
  });

  it('excludes the local lockfile on every local-only put and un-excludes it when it deletes it', async () => {
    const fs = new InMemoryFileSystem();
    const exclusion = new RecordingExclusion();
    const store = repositoryStore(fs, exclusion);

    await store.put('a', entry('1.0.0'), source(), 'local-only');
    await store.put('b', entry('1.0.0'), source(), 'local-only');
    await store.put('c', entry('1.0.0'), source(), 'commit');

    expect(exclusion.added).toEqual([[LOCAL_LOCK], [LOCAL_LOCK]]);

    await store.remove('a');
    expect(exclusion.removed).toEqual([]);
    await store.remove('b');

    expect(await fs.exists(LOCAL_LOCK)).toBe(false);
    expect(exclusion.removed).toEqual([[LOCAL_LOCK]]);
  });

  it('excludes a local lockfile that already exists', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(LOCAL_LOCK, lockfile({ earlier: entry('1.0.0') }));
    const exclusion = new RecordingExclusion();

    await repositoryStore(fs, exclusion).put('a', entry('1.0.0'), source(), 'local-only');

    expect(exclusion.added).toEqual([[LOCAL_LOCK]]);
  });

  it('ignores exclusion errors around the local lockfile', async () => {
    const fs = new InMemoryFileSystem();
    const store = repositoryStore(fs, new RecordingExclusion(true));

    await store.put('a', entry('1.0.0'), source(), 'local-only');
    await store.remove('a');

    expect(await fs.exists(LOCAL_LOCK)).toBe(false);
  });

  it('removes a record and its orphaned source, deleting a file left without bundles', async () => {
    const fs = new InMemoryFileSystem();
    const store = repositoryStore(fs);
    await store.put('a', entry('1.0.0'), source(), 'commit');
    await store.put('b', { ...entry('1.0.0'), sourceId: 'other-src' }, { id: 'other-src', descriptor: { type: 'local', url: '/b' } }, 'commit');

    await store.remove('b');

    const commit = await read(fs, COMMIT_LOCK);
    expect(Object.keys(commit.bundles)).toEqual(['a']);
    expect(Object.keys(commit.sources)).toEqual(['local-src']);

    await store.remove('a');
    expect(await fs.exists(COMMIT_LOCK)).toBe(false);
  });

  it('removes nothing for an unknown key', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(COMMIT_LOCK, lockfile({ a: entry('1.0.0') }));

    await repositoryStore(fs).remove('missing');

    expect(Object.keys((await read(fs, COMMIT_LOCK)).bundles)).toEqual(['a']);
  });

  it.each([
    ['key', '', entry('1.0.0'), source()],
    ['sourceId', 'a', { ...entry('1.0.0'), sourceId: '' }, source()],
    ['sourceType', 'a', { ...entry('1.0.0'), sourceType: '' }, source()],
    ['source.type', 'a', entry('1.0.0'), { id: 'local-src', descriptor: { type: '', url: '/x' } }],
    ['source.url', 'a', entry('1.0.0'), source('')]
  ] as const)('rejects an empty %s', async (field, key, bundleEntry, bundleSource) => {
    const fs = new InMemoryFileSystem();

    await expect(repositoryStore(fs).put(key, bundleEntry, bundleSource, 'commit')).rejects.toThrow(field);
    expect(await fs.exists(COMMIT_LOCK)).toBe(false);
  });

  it('rejects removing an empty key', async () => {
    await expect(repositoryStore(new InMemoryFileSystem()).remove('')).rejects.toThrow('key');
  });
});

describe('createLockfileRecordStore (user)', () => {
  const USER_LOCK = path.join('/home/u', '.config', 'ai-primitives-hub', 'lock.json');
  const userStore = (fs: InMemoryFileSystem) =>
    createLockfileRecordStore({ scope: 'user', fs, lockfilePath: USER_LOCK, generatedBy: 'test-cli' });

  it('keeps every record in its single lockfile, without a commit mode', async () => {
    const fs = new InMemoryFileSystem();
    const store = userStore(fs);

    await store.put('a', entry('1.0.0'), source(), 'local-only');
    await store.put('b', entry('1.0.0'), source());

    expect(Object.keys((await read(fs, USER_LOCK)).bundles)).toEqual(['a', 'b']);
    expect(await store.get('a')).toEqual({ entry: entry('1.0.0') });
    expect(await store.others('a')).toEqual([{ entry: entry('1.0.0') }]);
    expect(await fs.exists(COMMIT_LOCK)).toBe(false);
    expect(await fs.exists(LOCAL_LOCK)).toBe(false);
  });

  it('keeps the lockfile when its last record is removed', async () => {
    const fs = new InMemoryFileSystem();
    const store = userStore(fs);
    await store.put('a', entry('1.0.0'), source());

    await store.remove('a');

    const lock = await read(fs, USER_LOCK);
    expect(lock.bundles).toEqual({});
    expect(lock.sources).toEqual({});
  });

  it('validates its inputs like the repository store', async () => {
    await expect(userStore(new InMemoryFileSystem()).put('a', entry('1.0.0'), source(''))).rejects.toThrow('source.url');
  });
});
