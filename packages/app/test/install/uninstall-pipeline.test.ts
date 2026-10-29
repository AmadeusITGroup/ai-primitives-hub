/**
 * Tests for app/install/uninstall-pipeline.ts.
 *
 * No reference-branch equivalent applies — this pipeline was rewritten
 * for the two-physical-file, object-keyed lockfile schema (see
 * `stores/json-lockfile-store.ts`'s module doc). Written fresh,
 * covering both the `commit` and `local-only` lockfile search order.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import type {
  TargetWriter as CoreTargetWriter,
  FileSystem,
  Target,
} from '@ai-primitives-hub/core';
import {
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  createTargetWriterFactory,
} from '../../src/install/target-writer-factory';
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

describe('UninstallPipeline installed paths', () => {
  it('passes a recorded installedPath to the writer and omits it for older entries', async () => {
    const fs = new InMemoryFileSystem();
    const lockPath = getLockfilePathForMode('/repo', 'commit');
    const lock = upsertBundleEntry(emptyLockfile('cli@1.0.0'), 'sample-skills', {
      version: '1.0.0',
      sourceId: 'local-sample-skills',
      sourceType: 'local',
      installedAt: '2024-01-01T00:00:00.000Z',
      files: [
        { path: '.github/skills/sample-skill/SKILL.md', checksum: 'abc', installedPath: 'skills/sample-skill/SKILL.md' },
        { path: 'prompts/legacy.prompt.md', checksum: 'def' }
      ]
    });
    await writeLockfile(lockPath, lock, fs);
    const calls: unknown[][] = [];
    const writer: TargetWriter = {
      write: async () => ({ written: [], skipped: [] }),
      remove: async (...args) => {
        calls.push(args.slice(1));
      }
    };
    const pipeline = new UninstallPipeline({ fs, target: TARGET, repositoryPath: '/repo', writerFactory: () => writer });

    const result = await pipeline.run('sample-skills');

    expect(calls).toEqual([
      ['.github/skills/sample-skill/SKILL.md', 'skills/sample-skill/SKILL.md'],
      ['prompts/legacy.prompt.md']
    ]);
    expect(result.removed).toHaveLength(2);
  });
});

describe('UninstallPipeline guarded removal', () => {
  const factoryFor = (fs: FileSystem): ((target: Target) => CoreTargetWriter) => createTargetWriterFactory({
    fs, env: { HOME: '/home/u' }, projectDir: null, userConfigDir: null, writerOwnsExclusion: false
  });
  const seedEntry = async (fs: FileSystem, root: string, bundleId: string, files: string[]): Promise<void> => {
    const lockPath = getLockfilePathForMode(root, 'commit');
    const lock = upsertBundleEntry((await readLockfile(lockPath, fs)) ?? emptyLockfile('cli@1.0.0'), bundleId, {
      version: '1.0.0',
      sourceId: 'local-src',
      sourceType: 'local',
      installedAt: '2024-01-01T00:00:00.000Z',
      targetType: 'vscode',
      files: files.map((file) => ({ path: file, checksum: '0'.repeat(64) }))
    });
    await writeLockfile(lockPath, lock, fs);
  };

  it('keeps a file another bundle records and reports it as skipped', async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile('/repo/.github/prompts/shared.prompt.md', '# Shared\n');
    await fs.writeFile('/repo/.github/prompts/a.prompt.md', '# A\n');
    await seedEntry(fs, '/repo', 'bundle-a', ['prompts/shared.prompt.md', 'prompts/a.prompt.md']);
    await seedEntry(fs, '/repo', 'bundle-b', ['prompts/shared.prompt.md']);
    const pipeline = new UninstallPipeline({ fs, target: TARGET, repositoryPath: '/repo', writerFactory: factoryFor(fs) });

    const result = await pipeline.run('bundle-a');

    expect(result.removed).toEqual(['prompts/a.prompt.md']);
    expect(result.skipped).toEqual(['prompts/shared.prompt.md']);
    expect(result.outcome?.kept).toEqual([{ path: 'prompts/shared.prompt.md', reason: 'shared' }]);
    expect(await fs.exists('/repo/.github/prompts/shared.prompt.md')).toBe(true);
    expect(await fs.exists('/repo/.github/prompts/a.prompt.md')).toBe(false);
  });

  it('prunes the directories a plugin uninstall leaves empty', async () => {
    const ws = mkdtempSync(nodePath.join(os.tmpdir(), 'uninstall-pipeline-'));
    try {
      const fs = new NodeFileSystem();
      const plugin = nodePath.join(ws, '.github', 'plugins', 'demo');
      mkdirSync(nodePath.join(plugin, 'scripts'), { recursive: true });
      writeFileSync(nodePath.join(plugin, 'plugin.json'), '{}\n');
      writeFileSync(nodePath.join(plugin, 'scripts', 'run.sh'), 'echo\n');
      await seedEntry(fs, ws, 'demo', ['plugins/demo/plugin.json', 'plugins/demo/scripts/run.sh']);
      const target: Target = { ...TARGET, rootPath: ws };
      const pipeline = new UninstallPipeline({ fs, target, repositoryPath: ws, writerFactory: factoryFor(fs) });

      const result = await pipeline.run('demo');

      expect(result.removed).toHaveLength(2);
      expect(result.outcome?.pruned).toEqual(expect.arrayContaining([
        nodePath.join(plugin, 'scripts'), plugin, nodePath.join(ws, '.github', 'plugins')
      ]));
      expect(existsSync(nodePath.join(ws, '.github', 'plugins'))).toBe(false);
      expect(existsSync(nodePath.join(ws, '.github'))).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
