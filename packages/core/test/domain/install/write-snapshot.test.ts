import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  mergeReplacedFiles,
  replacedFiles,
  restoreOrRemove,
  snapshotBeforeWrite,
  type WriteSnapshots,
} from '../../../src/domain/install/write-snapshot';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/**
 * Files plus modes, with the subset of the filesystem port the helpers use.
 * @param seed
 */
const fakeFs = (seed: Record<string, { bytes: Uint8Array; mode?: number }> = {}) => {
  const files = new Map(Object.entries(seed));
  const directories = new Set<string>();
  return {
    files,
    directories,
    exists: (p: string): Promise<boolean> => Promise.resolve(files.has(p) || directories.has(p)),
    readFileBytes: (p: string): Promise<Uint8Array> => {
      const file = files.get(p);
      return file === undefined ? Promise.reject(new Error(`EISDIR: ${p}`)) : Promise.resolve(file.bytes);
    },
    stat: (p: string): Promise<{ mode?: number }> => Promise.resolve({ mode: files.get(p)?.mode }),
    writeFileBytes: (p: string, bytes: Uint8Array): Promise<void> => {
      files.set(p, { bytes, mode: files.get(p)?.mode });
      return Promise.resolve();
    },
    setExecutable: (p: string, executable: boolean): Promise<void> => {
      const file = files.get(p);
      if (file !== undefined) {
        file.mode = executable ? 0o755 : 0o644;
      }
      return Promise.resolve();
    },
    remove: (p: string): Promise<void> => {
      files.delete(p);
      return Promise.resolve();
    }
  };
};

describe('snapshotBeforeWrite', () => {
  it('keeps the bytes and mode of an existing file and null for a missing one', async () => {
    const fs = fakeFs({ '/t/a.md': { bytes: text('user\n'), mode: 0o644 } });
    const snapshots: WriteSnapshots = new Map();

    await snapshotBeforeWrite(fs, snapshots, '/t/a.md');
    await snapshotBeforeWrite(fs, snapshots, '/t/b.md');

    expect(snapshots.get('/t/a.md')).toEqual(text('user\n'));
    expect(snapshots.get('/t/a.md')?.mode).toBe(0o644);
    expect(snapshots.get('/t/b.md')).toBeNull();
  });

  it('keeps the first snapshot of a path written twice in one write', async () => {
    const fs = fakeFs();
    const snapshots: WriteSnapshots = new Map();
    await snapshotBeforeWrite(fs, snapshots, '/t/a.md');
    fs.files.set('/t/a.md', { bytes: text('first write\n') });

    await snapshotBeforeWrite(fs, snapshots, '/t/a.md');

    expect(snapshots.get('/t/a.md')).toBeNull();
    expect(replacedFiles(snapshots)).toBeUndefined();
  });

  it('keeps the bytes without a mode when stat fails after the read', async () => {
    const fs = { ...fakeFs({ '/t/a.md': { bytes: text('user\n'), mode: 0o755 } }), stat: () => Promise.reject(new Error('EPERM')) };
    const snapshots: WriteSnapshots = new Map();

    await snapshotBeforeWrite(fs, snapshots, '/t/a.md');

    expect(snapshots.get('/t/a.md')).toEqual(text('user\n'));
    expect(snapshots.get('/t/a.md')?.mode).toBeUndefined();
  });

  it('takes no snapshot of a destination it cannot read', async () => {
    const fs = fakeFs();
    fs.directories.add('/t/dir');
    const snapshots: WriteSnapshots = new Map();

    await snapshotBeforeWrite(fs, snapshots, '/t/dir');

    expect(snapshots.has('/t/dir')).toBe(false);
  });
});

describe('restoreOrRemove', () => {
  it('restores the bytes and executable bit of a replaced file and removes a created one', async () => {
    const fs = fakeFs({ '/t/run.sh': { bytes: text('user\n'), mode: 0o644 } });
    const snapshots: WriteSnapshots = new Map();
    await snapshotBeforeWrite(fs, snapshots, '/t/run.sh');
    await snapshotBeforeWrite(fs, snapshots, '/t/new.md');
    fs.files.set('/t/run.sh', { bytes: text('bundle\n'), mode: 0o755 });
    fs.files.set('/t/new.md', { bytes: text('bundle\n') });

    await restoreOrRemove(fs, ['/t/run.sh', '/t/new.md'], replacedFiles(snapshots));

    expect(fs.files.get('/t/run.sh')).toEqual({ bytes: text('user\n'), mode: 0o644 });
    expect(fs.files.has('/t/new.md')).toBe(false);
  });

  it('removes every path without replaced files and goes on after a failure', async () => {
    const fs = fakeFs({ '/t/a.md': { bytes: text('a') }, '/t/b.md': { bytes: text('b') } });
    const failing = { ...fs, remove: (p: string) => (p === '/t/a.md' ? Promise.reject(new Error('busy')) : fs.remove(p)) };

    await restoreOrRemove(failing, ['/t/a.md', '/t/b.md']);

    expect([...fs.files.keys()]).toEqual(['/t/a.md']);
  });
});

describe('mergeReplacedFiles', () => {
  it('keeps the earlier write\'s snapshot of a path both writes replaced', () => {
    expect(mergeReplacedFiles(
      { written: ['/t/a'], replaced: { '/t/a': text('original') } },
      { written: ['/t/a', '/t/b'], replaced: { '/t/a': text('first write'), '/t/b': text('b') } }
    )).toEqual({ '/t/a': text('original'), '/t/b': text('b') });
    expect(mergeReplacedFiles({ written: [] }, { written: [] })).toBeUndefined();
  });

  it('drops the later snapshot of a path the earlier write created, so a rollback removes it', async () => {
    const fs = fakeFs();
    const first: WriteSnapshots = new Map();
    await snapshotBeforeWrite(fs, first, '/t/a.md');
    fs.files.set('/t/a.md', { bytes: text('item write') });
    const second: WriteSnapshots = new Map();
    await snapshotBeforeWrite(fs, second, '/t/a.md');
    fs.files.set('/t/a.md', { bytes: text('rest write') });

    const replaced = mergeReplacedFiles(
      { written: ['/t/a.md'], replaced: replacedFiles(first) },
      { written: ['/t/a.md'], replaced: replacedFiles(second) }
    );
    await restoreOrRemove(fs, ['/t/a.md', '/t/a.md'], replaced);

    expect(replaced).toBeUndefined();
    expect(fs.files.has('/t/a.md')).toBe(false);
  });
});
