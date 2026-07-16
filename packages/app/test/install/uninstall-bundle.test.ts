/**
 * Tests for app/install/uninstall-bundle.ts.
 *
 * Thin wrapper over UninstallPipeline; tests confirm correct
 * delegation (single-bundle vs all-bundles dispatch) rather than
 * re-testing pipeline internals (covered by uninstall-pipeline.test.ts).
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
  planUninstall,
  uninstallBundle,
} from '../../src/install/uninstall-bundle';
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
const noopWriter: TargetWriter = { write: async () => ({ written: [], skipped: [] }), remove: async () => {} };

const seedBundle = async (fs: InMemoryFileSystem, bundleId: string): Promise<void> => {
  const path = getLockfilePathForMode('/repo', 'commit');
  let lock = (await readLockfile(path, fs)) ?? emptyLockfile('cli@1.0.0');
  lock = upsertBundleEntry(lock, bundleId, {
    version: '1.0.0',
    sourceId: 'github-abc',
    sourceType: 'github',
    installedAt: '2024-01-01T00:00:00.000Z',
    files: [{ path: `.github/prompts/${bundleId}.md`, checksum: 'abc' }]
  });
  await writeLockfile(getLockfilePathForMode('/repo', 'commit'), lock, fs);
};

describe('planUninstall', () => {
  it('dispatches to plan() when a bundleId is given', async () => {
    const fs = new InMemoryFileSystem();
    await seedBundle(fs, 'my-bundle');

    const plan = await planUninstall(
      { bundleId: 'my-bundle', target: TARGET, repositoryPath: '/repo' },
      { fs, writerFactory: () => noopWriter }
    );

    expect(Array.isArray(plan)).toBe(false);
    expect((plan as { bundleId: string }).bundleId).toBe('my-bundle');
  });

  it('dispatches to planAll() when bundleId is omitted', async () => {
    const fs = new InMemoryFileSystem();
    await seedBundle(fs, 'bundle-a');
    await seedBundle(fs, 'bundle-b');

    const plans = await planUninstall(
      { target: TARGET, repositoryPath: '/repo' },
      { fs, writerFactory: () => noopWriter }
    );

    expect(Array.isArray(plans)).toBe(true);
    expect((plans as unknown[])).toHaveLength(2);
  });
});

describe('uninstallBundle', () => {
  it('dispatches to run() when a bundleId is given', async () => {
    const fs = new InMemoryFileSystem();
    await seedBundle(fs, 'my-bundle');

    const result = await uninstallBundle(
      { bundleId: 'my-bundle', target: TARGET, repositoryPath: '/repo' },
      { fs, writerFactory: () => noopWriter }
    );

    expect(Array.isArray(result)).toBe(false);
    expect((result as { removed: string[] }).removed).toEqual(['.github/prompts/my-bundle.md']);
  });

  it('dispatches to runAll() when bundleId is omitted', async () => {
    const fs = new InMemoryFileSystem();
    await seedBundle(fs, 'bundle-a');
    await seedBundle(fs, 'bundle-b');

    const results = await uninstallBundle(
      { target: TARGET, repositoryPath: '/repo' },
      { fs, writerFactory: () => noopWriter }
    );

    expect(Array.isArray(results)).toBe(true);
    expect((results as unknown[])).toHaveLength(2);
  });
});
