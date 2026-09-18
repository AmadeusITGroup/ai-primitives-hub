/**
 * Tests for app/install/uninstall-pipeline.ts.
 *
 * No reference-branch equivalent applies — this pipeline was rewritten
 * for the two-physical-file, object-keyed lockfile schema (see
 * `stores/json-lockfile-store.ts`'s module doc). Written fresh,
 * covering both the `commit` and `local-only` lockfile search order.
 */
import {
  createHash,
} from 'node:crypto';
import * as path from 'node:path';
import type {
  InstalledFileRecord,
  Target,
  TargetWritePlan,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  runFileTransaction,
  updateTargetSafely,
} from '../../src/install/target-write';
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
import {
  FileTreeTargetWriter,
} from '../../src/writers/file-tree-writer';
import type {
  TargetWriter,
} from '../../src/writers/file-tree-writer';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

const REPOSITORY_PATH = path.resolve('/repo');
const repositoryFile = (...segments: string[]): string => path.join(REPOSITORY_PATH, ...segments);
const TARGET: Target = { name: 'repo', type: 'vscode', scope: 'repository', rootPath: REPOSITORY_PATH };

const checksum = (contents: string): string =>
  `sha256:${createHash('sha256').update(new TextEncoder().encode(contents)).digest('hex')}`;

const seedBundle = async (
  fs: InMemoryFileSystem,
  mode: 'commit' | 'local-only',
  bundleId: string,
  files: { path: string; checksum: string }[] = [{ path: `.github/prompts/${bundleId}.md`, checksum: 'abc' }]
): Promise<void> => {
  const lockfilePath = getLockfilePathForMode(REPOSITORY_PATH, mode);
  let lock = (await readLockfile(lockfilePath, fs)) ?? emptyLockfile('cli@1.0.0');
  lock = upsertBundleEntry(lock, bundleId, {
    version: '1.0.0',
    sourceId: 'github-abc',
    sourceType: 'github',
    installedAt: '2024-01-01T00:00:00.000Z',
    files
  });
  await writeLockfile(lockfilePath, lock, fs);
};

const makeWriter = (): TargetWriter & { removed: string[] } => {
  const removed: string[] = [];
  return {
    removed,
    write: async () => ({ installed: [] }),
    remove: async (files) => {
      removed.push(...files.map((file) => file.destinationPath));
    }
  };
};

const makeFsWriter = (fs: InMemoryFileSystem): TargetWriter => new FileTreeTargetWriter({ fs, env: {} });

describe('updateTargetSafely', () => {
  it('preserves modified owned files and removes unchanged obsolete destinations', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed('/target/prompts/reused.prompt.md', 'user edit');
    fs.seed('/target/prompts/obsolete.prompt.md', 'obsolete v1');
    const installed: InstalledFileRecord[] = [
      {
        itemId: 'reused',
        kind: 'prompt',
        sourcePath: 'prompts/reused.prompt.md',
        destinationPath: '/target/prompts/reused.prompt.md',
        destinationRelativePath: 'prompts/reused.prompt.md',
        installedChecksum: checksum('reused v1')
      },
      {
        itemId: 'obsolete',
        kind: 'prompt',
        sourcePath: 'prompts/obsolete.prompt.md',
        destinationPath: '/target/prompts/obsolete.prompt.md',
        destinationRelativePath: 'prompts/obsolete.prompt.md',
        installedChecksum: checksum('obsolete v1')
      }
    ];
    const plan: TargetWritePlan = {
      target: { name: 'test', type: 'vscode', scope: 'user' },
      operations: [
        {
          itemId: 'reused',
          kind: 'prompt',
          sourcePath: 'prompts/reused.prompt.md',
          destinationPath: '/target/prompts/reused.prompt.md',
          destinationRelativePath: 'prompts/reused.prompt.md',
          sourceChecksum: checksum('reused v2'),
          bytes: new TextEncoder().encode('reused v2')
        },
        {
          itemId: 'added',
          kind: 'prompt',
          sourcePath: 'prompts/added.prompt.md',
          destinationPath: '/target/prompts/added.prompt.md',
          destinationRelativePath: 'prompts/added.prompt.md',
          sourceChecksum: checksum('added v2'),
          bytes: new TextEncoder().encode('added v2')
        }
      ]
    };

    const result = await updateTargetSafely({
      fs,
      writer: makeFsWriter(fs),
      plan,
      installed
    });

    expect(await fs.readFile('/target/prompts/reused.prompt.md')).toBe('user edit');
    expect(await fs.exists('/target/prompts/obsolete.prompt.md')).toBe(false);
    expect(await fs.readFile('/target/prompts/added.prompt.md')).toBe('added v2');
    expect(result.installed.map((file) => file.destinationRelativePath).toSorted()).toEqual([
      'prompts/added.prompt.md',
      'prompts/reused.prompt.md'
    ]);
    expect(result.retained).toEqual(['prompts/reused.prompt.md']);
  });
});

describe('runFileTransaction', () => {
  it('restores overwritten bytes and removes new files when later metadata persistence fails', async () => {
    const fs = new InMemoryFileSystem();
    const original = new Uint8Array([0, 255, 1, 2]);
    fs.seed('/target/existing.bin', original);

    await expect(runFileTransaction(fs, [
      '/target/existing.bin',
      '/target/new.bin',
      '/metadata/lock.json'
    ], async () => {
      await fs.writeFileBytes('/target/existing.bin', new Uint8Array([9]));
      await fs.writeFileBytes('/target/new.bin', new Uint8Array([8]));
      throw new Error('metadata write failed');
    })).rejects.toThrow('metadata write failed');

    expect(await fs.readFileBytes('/target/existing.bin')).toEqual(original);
    expect(await fs.exists('/target/new.bin')).toBe(false);
    expect(await fs.exists('/metadata/lock.json')).toBe(false);
  });
});

describe('UninstallPipeline.plan', () => {
  it('finds a bundle in the commit lockfile', async () => {
    const fs = new InMemoryFileSystem();
    await seedBundle(fs, 'commit', 'my-bundle');
    const pipeline = new UninstallPipeline({ fs, target: TARGET, repositoryPath: REPOSITORY_PATH, writerFactory: makeWriter });

    const plan = await pipeline.plan('my-bundle');

    expect(plan.commitMode).toBe('commit');
    expect(plan.filesToRemove).toEqual(['.github/prompts/my-bundle.md']);
  });

  it('falls back to the local-only lockfile when not found in commit', async () => {
    const fs = new InMemoryFileSystem();
    await seedBundle(fs, 'local-only', 'my-bundle');
    const pipeline = new UninstallPipeline({ fs, target: TARGET, repositoryPath: REPOSITORY_PATH, writerFactory: makeWriter });

    const plan = await pipeline.plan('my-bundle');

    expect(plan.commitMode).toBe('local-only');
  });

  it('returns a null entry when the bundle is in neither lockfile', async () => {
    const fs = new InMemoryFileSystem();
    const pipeline = new UninstallPipeline({ fs, target: TARGET, repositoryPath: REPOSITORY_PATH, writerFactory: makeWriter });

    const plan = await pipeline.plan('missing');

    expect(plan.lockfileEntry).toBeNull();
    expect(plan.commitMode).toBeUndefined();
  });

  it('routes historical CLI source-prefix paths through the repository compatibility reader', async () => {
    const fs = new InMemoryFileSystem();
    await seedBundle(fs, 'commit', 'legacy-bundle', [{ path: 'prompts/legacy-bundle.md', checksum: checksum('legacy') }]);
    const warnings: string[] = [];
    const pipeline = new UninstallPipeline({
      fs,
      target: TARGET,
      repositoryPath: REPOSITORY_PATH,
      writerFactory: () => makeFsWriter(fs),
      onWarning: (warning) => warnings.push(warning)
    });

    const plan = await pipeline.plan('legacy-bundle');

    expect(plan.filesToRemove).toEqual(['.github/prompts/legacy-bundle.md']);
    expect(plan.warnings).toHaveLength(1);
    expect(warnings[0]).toContain('legacy repository lockfile paths');
  });
});

describe('UninstallPipeline.run', () => {
  it('removes files via the writer and deletes the now-empty lockfile', async () => {
    const fs = new InMemoryFileSystem();
    await seedBundle(fs, 'commit', 'my-bundle');
    const writer = makeWriter();
    const pipeline = new UninstallPipeline({ fs, target: TARGET, repositoryPath: REPOSITORY_PATH, writerFactory: () => writer });

    const result = await pipeline.run('my-bundle');

    expect(result.removed).toEqual(['.github/prompts/my-bundle.md']);
    expect(writer.removed).toEqual([repositoryFile('.github/prompts/my-bundle.md')]);
    expect(await fs.exists(getLockfilePathForMode(REPOSITORY_PATH, 'commit'))).toBe(false);
  });

  it('preserves modified files and removes only unchanged local-only entries from git exclude', async () => {
    const fs = new InMemoryFileSystem();
    await seedBundle(fs, 'local-only', 'my-bundle', [
      { path: '.github/prompts/keep.md', checksum: checksum('original keep') },
      { path: '.github/prompts/remove.md', checksum: checksum('original remove') }
    ]);

    fs.seed(repositoryFile('.github/prompts/keep.md'), 'user edited keep');
    fs.seed(repositoryFile('.github/prompts/remove.md'), 'original remove');
    fs.seed(repositoryFile('.git/info/exclude'), '# Prompt Registry (local)\n.github/prompts/keep.md\n.github/prompts/remove.md\n');
    const pipeline = new UninstallPipeline({
      fs,
      target: TARGET,
      repositoryPath: REPOSITORY_PATH,
      writerFactory: () => makeFsWriter(fs)
    });

    const result = await pipeline.run('my-bundle');

    expect(result.removed).toEqual(['.github/prompts/remove.md']);
    expect(result.skipped).toEqual(['.github/prompts/keep.md']);
    expect(result.warnings.join('\n')).toContain('Preserved modified file');
    expect(await fs.exists(repositoryFile('.github/prompts/keep.md'))).toBe(true);
    expect(await fs.exists(repositoryFile('.github/prompts/remove.md'))).toBe(false);
    const exclude = await fs.readFile(repositoryFile('.git/info/exclude'));
    expect(exclude).toContain('.github/prompts/keep.md');
    expect(exclude).not.toContain('.github/prompts/remove.md');
    const lock = await readLockfile(getLockfilePathForMode(REPOSITORY_PATH, 'local-only'), fs);
    expect(lock?.bundles['my-bundle'].files).toEqual([
      { path: '.github/prompts/keep.md', checksum: checksum('original keep'), kind: 'prompt', itemId: 'keep' }
    ]);
  });

  it('removes unchanged files recorded with historical bare checksums', async () => {
    const fs = new InMemoryFileSystem();
    const bareChecksum = checksum('legacy contents').replace('sha256:', '');
    await seedBundle(fs, 'commit', 'legacy-checksum', [
      { path: '.github/prompts/legacy.prompt.md', checksum: bareChecksum }
    ]);
    fs.seed(repositoryFile('.github/prompts/legacy.prompt.md'), 'legacy contents');
    const pipeline = new UninstallPipeline({
      fs,
      target: TARGET,
      repositoryPath: REPOSITORY_PATH,
      writerFactory: () => makeFsWriter(fs)
    });

    const result = await pipeline.run('legacy-checksum');

    expect(result.removed).toEqual(['.github/prompts/legacy.prompt.md']);
    expect(await fs.exists(repositoryFile('.github/prompts/legacy.prompt.md'))).toBe(false);
  });

  it('removes exact managed skill files, preserves unrelated files, and cleans the skill directory once empty', async () => {
    const fs = new InMemoryFileSystem();
    await seedBundle(fs, 'commit', 'skill-bundle', [
      { path: '.github/skills/review/SKILL.md', checksum: checksum('# Skill') },
      { path: '.github/skills/review/assets/rubric.json', checksum: checksum('{"rubric":true}') }
    ]);
    fs.seed(repositoryFile('.github/skills/review/SKILL.md'), '# Skill');
    fs.seed(repositoryFile('.github/skills/review/assets/rubric.json'), '{"rubric":true}');
    fs.seed(repositoryFile('.github/skills/review/local-notes.md'), 'keep me');
    let pipeline = new UninstallPipeline({
      fs,
      target: TARGET,
      repositoryPath: REPOSITORY_PATH,
      writerFactory: () => makeFsWriter(fs)
    });

    const first = await pipeline.run('skill-bundle');

    expect(first.removed).toEqual([
      '.github/skills/review/SKILL.md',
      '.github/skills/review/assets/rubric.json'
    ]);
    expect(await fs.exists(repositoryFile('.github/skills/review/local-notes.md'))).toBe(true);
    expect(await fs.exists(repositoryFile('.github/skills/review'))).toBe(true);

    await fs.remove(repositoryFile('.github/skills/review/local-notes.md'));
    await seedBundle(fs, 'commit', 'skill-bundle', [{ path: '.github/skills/review/SKILL.md', checksum: checksum('# Skill') }]);
    fs.seed(repositoryFile('.github/skills/review/SKILL.md'), '# Skill');
    pipeline = new UninstallPipeline({
      fs,
      target: TARGET,
      repositoryPath: REPOSITORY_PATH,
      writerFactory: () => makeFsWriter(fs)
    });

    const second = await pipeline.run('skill-bundle');

    expect(second.removed).toEqual(['.github/skills/review/SKILL.md']);
    expect(await fs.exists(repositoryFile('.github/skills/review'))).toBe(false);
  });

  it('keeps the lockfile when other bundles remain', async () => {
    const fs = new InMemoryFileSystem();
    await seedBundle(fs, 'commit', 'bundle-a');
    await seedBundle(fs, 'commit', 'bundle-b');
    const pipeline = new UninstallPipeline({ fs, target: TARGET, repositoryPath: REPOSITORY_PATH, writerFactory: makeWriter });

    await pipeline.run('bundle-a');

    const lockfilePath = getLockfilePathForMode(REPOSITORY_PATH, 'commit');
    expect(await fs.exists(lockfilePath)).toBe(true);
    const raw = await fs.readFile(lockfilePath);
    expect(JSON.parse(raw).bundles).not.toHaveProperty('bundle-a');
    expect(JSON.parse(raw).bundles).toHaveProperty('bundle-b');
  });

  it('does not remove a destination still owned by another bundle', async () => {
    const fs = new InMemoryFileSystem();
    const shared = [{ path: '.github/prompts/shared.md', checksum: checksum('shared') }];
    fs.seed(repositoryFile('.github/prompts/shared.md'), 'shared');
    await seedBundle(fs, 'commit', 'bundle-a', shared);
    await seedBundle(fs, 'local-only', 'bundle-b', shared);
    const writer = makeWriter();
    const pipeline = new UninstallPipeline({ fs, target: TARGET, repositoryPath: REPOSITORY_PATH, writerFactory: () => writer });

    const result = await pipeline.run('bundle-a');

    expect(result.removed).toEqual([]);
    expect(writer.removed).toEqual([]);
    expect(await fs.exists(repositoryFile('.github/prompts/shared.md'))).toBe(true);
  });

  it('returns an empty result for an unknown bundle', async () => {
    const fs = new InMemoryFileSystem();
    const pipeline = new UninstallPipeline({ fs, target: TARGET, repositoryPath: REPOSITORY_PATH, writerFactory: makeWriter });

    const result = await pipeline.run('missing');

    expect(result).toEqual({ bundleId: 'missing', removed: [], skipped: [], warnings: [] });
  });
});

describe('UninstallPipeline.planAll / runAll', () => {
  it('plans bundles across both lockfiles', async () => {
    const fs = new InMemoryFileSystem();
    await seedBundle(fs, 'commit', 'bundle-a');
    await seedBundle(fs, 'local-only', 'bundle-b');
    const pipeline = new UninstallPipeline({ fs, target: TARGET, repositoryPath: REPOSITORY_PATH, writerFactory: makeWriter });

    const plans = await pipeline.planAll();

    expect(plans.map((p) => p.bundleId).toSorted()).toEqual(['bundle-a', 'bundle-b']);
  });

  it('removes every bundle across both lockfiles', async () => {
    const fs = new InMemoryFileSystem();
    await seedBundle(fs, 'commit', 'bundle-a');
    await seedBundle(fs, 'local-only', 'bundle-b');
    const pipeline = new UninstallPipeline({ fs, target: TARGET, repositoryPath: REPOSITORY_PATH, writerFactory: makeWriter });

    const results = await pipeline.runAll();

    expect(results).toHaveLength(2);
    expect(await fs.exists(getLockfilePathForMode(REPOSITORY_PATH, 'commit'))).toBe(false);
    expect(await fs.exists(getLockfilePathForMode(REPOSITORY_PATH, 'local-only'))).toBe(false);
  });

  it('runFromLockfile tolerates a missing lockfile', async () => {
    const fs = new InMemoryFileSystem();
    const pipeline = new UninstallPipeline({ fs, target: TARGET, repositoryPath: REPOSITORY_PATH, writerFactory: makeWriter });

    const results = await pipeline.runFromLockfile();

    expect(results).toEqual([]);
  });
});
