/**
 * Tests for app/install/uninstall-pipeline.ts.
 *
 * No reference-branch equivalent applies — this pipeline was rewritten
 * for the two-physical-file, object-keyed lockfile schema (see
 * `stores/json-lockfile-store.ts`'s module doc). Written fresh,
 * covering both the `commit` and `local-only` lockfile search order.
 */
import type {
  Target,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  UninstallPipeline,
} from '../../src/install/uninstall-pipeline';
import {
  emptyLockfile,
  getLockfilePathForMode,
  readLockfile,
  upsertBundleEntry,
  writeLockfile,
} from '../../src/stores/json-lockfile-store';
import type {
  TargetWriter,
} from '../../src/writers/file-tree-writer';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

const TARGET: Target = { name: 'repo', type: 'vscode', scope: 'repository', rootPath: '/repo' };

const seedBundle = async (
  fs: InMemoryFileSystem,
  mode: 'commit' | 'local-only',
  bundleId: string
): Promise<void> => {
  const path = getLockfilePathForMode('/repo', mode);
  let lock = (await readLockfile(path, fs)) ?? emptyLockfile('cli@1.0.0');
  lock = upsertBundleEntry(lock, bundleId, {
    version: '1.0.0',
    sourceId: 'github-abc',
    sourceType: 'github',
    installedAt: '2024-01-01T00:00:00.000Z',
    files: [{ path: `.github/prompts/${bundleId}.md`, checksum: 'abc' }]
  });
  await writeLockfile(path, lock, fs);
};

const makeWriter = (): TargetWriter & { removed: string[] } => {
  const removed: string[] = [];
  return {
    removed,
    write: async () => ({ written: [], skipped: [] }),
    remove: async (_t, filePath) => {
      removed.push(filePath);
    }
  };
};

describe('UninstallPipeline.plan', () => {
  it('finds a bundle in the commit lockfile', async () => {
    const fs = new InMemoryFileSystem();
    await seedBundle(fs, 'commit', 'my-bundle');
    const pipeline = new UninstallPipeline({ fs, target: TARGET, repositoryPath: '/repo', writerFactory: makeWriter });

    const plan = await pipeline.plan('my-bundle');

    expect(plan.commitMode).toBe('commit');
    expect(plan.filesToRemove).toEqual(['.github/prompts/my-bundle.md']);
  });

  it('falls back to the local-only lockfile when not found in commit', async () => {
    const fs = new InMemoryFileSystem();
    await seedBundle(fs, 'local-only', 'my-bundle');
    const pipeline = new UninstallPipeline({ fs, target: TARGET, repositoryPath: '/repo', writerFactory: makeWriter });

    const plan = await pipeline.plan('my-bundle');

    expect(plan.commitMode).toBe('local-only');
  });

  it('returns a null entry when the bundle is in neither lockfile', async () => {
    const fs = new InMemoryFileSystem();
    const pipeline = new UninstallPipeline({ fs, target: TARGET, repositoryPath: '/repo', writerFactory: makeWriter });

    const plan = await pipeline.plan('missing');

    expect(plan.lockfileEntry).toBeNull();
    expect(plan.commitMode).toBeUndefined();
  });
});

describe('UninstallPipeline.run', () => {
  it('removes files via the writer and deletes the now-empty lockfile', async () => {
    const fs = new InMemoryFileSystem();
    await seedBundle(fs, 'commit', 'my-bundle');
    const writer = makeWriter();
    const pipeline = new UninstallPipeline({ fs, target: TARGET, repositoryPath: '/repo', writerFactory: () => writer });

    const result = await pipeline.run('my-bundle');

    expect(result.removed).toEqual(['.github/prompts/my-bundle.md']);
    expect(writer.removed).toEqual(['.github/prompts/my-bundle.md']);
    expect(await fs.exists(getLockfilePathForMode('/repo', 'commit'))).toBe(false);
  });

  it('keeps the lockfile when other bundles remain', async () => {
    const fs = new InMemoryFileSystem();
    await seedBundle(fs, 'commit', 'bundle-a');
    await seedBundle(fs, 'commit', 'bundle-b');
    const pipeline = new UninstallPipeline({ fs, target: TARGET, repositoryPath: '/repo', writerFactory: makeWriter });

    await pipeline.run('bundle-a');

    const path = getLockfilePathForMode('/repo', 'commit');
    expect(await fs.exists(path)).toBe(true);
    const raw = await fs.readFile(path);
    expect(JSON.parse(raw).bundles).not.toHaveProperty('bundle-a');
    expect(JSON.parse(raw).bundles).toHaveProperty('bundle-b');
  });

  it('returns an empty result for an unknown bundle', async () => {
    const fs = new InMemoryFileSystem();
    const pipeline = new UninstallPipeline({ fs, target: TARGET, repositoryPath: '/repo', writerFactory: makeWriter });

    const result = await pipeline.run('missing');

    expect(result).toEqual({ bundleId: 'missing', removed: [], skipped: [] });
  });
});

describe('UninstallPipeline.planAll / runAll', () => {
  it('plans bundles across both lockfiles', async () => {
    const fs = new InMemoryFileSystem();
    await seedBundle(fs, 'commit', 'bundle-a');
    await seedBundle(fs, 'local-only', 'bundle-b');
    const pipeline = new UninstallPipeline({ fs, target: TARGET, repositoryPath: '/repo', writerFactory: makeWriter });

    const plans = await pipeline.planAll();

    expect(plans.map((p) => p.bundleId).toSorted()).toEqual(['bundle-a', 'bundle-b']);
  });

  it('removes every bundle across both lockfiles', async () => {
    const fs = new InMemoryFileSystem();
    await seedBundle(fs, 'commit', 'bundle-a');
    await seedBundle(fs, 'local-only', 'bundle-b');
    const pipeline = new UninstallPipeline({ fs, target: TARGET, repositoryPath: '/repo', writerFactory: makeWriter });

    const results = await pipeline.runAll();

    expect(results).toHaveLength(2);
    expect(await fs.exists(getLockfilePathForMode('/repo', 'commit'))).toBe(false);
    expect(await fs.exists(getLockfilePathForMode('/repo', 'local-only'))).toBe(false);
  });

  it('runFromLockfile tolerates a missing lockfile', async () => {
    const fs = new InMemoryFileSystem();
    const pipeline = new UninstallPipeline({ fs, target: TARGET, repositoryPath: '/repo', writerFactory: makeWriter });

    const results = await pipeline.runFromLockfile();

    expect(results).toEqual([]);
  });
});
