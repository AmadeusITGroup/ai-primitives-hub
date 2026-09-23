/**
 * Tests for app/stores/json-lockfile-store.ts.
 *
 * No reference-branch equivalent applies: this module's schema was
 * deliberately rewritten from the reference's (schemaVersion 1,
 * single-file, `entries` array) to interoperate with the VS Code
 * extension's actual on-disk lockfile format (see the module doc for
 * the full rationale) — written fresh against that adapted schema.
 */
import * as nodePath from 'node:path';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  cleanupOrphanedSource,
  deleteLockfile,
  emptyLockfile,
  getLockfilePathForMode,
  LOCAL_LOCKFILE_NAME,
  LOCKFILE_NAME,
  LOCKFILE_SCHEMA_VERSION,
  readLockfile,
  remapSourceId,
  removeBundleEntry,
  upsertBundleEntry,
  upsertSource,
  writeLockfile,
} from '../../src/stores/json-lockfile-store';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

describe('getLockfilePathForMode', () => {
  it('routes commit mode to prompt-registry.lock.json', () => {
    expect(getLockfilePathForMode('/repo', 'commit')).toBe(nodePath.join('/repo', LOCKFILE_NAME));
  });

  it('routes local-only mode to prompt-registry.local.lock.json', () => {
    expect(getLockfilePathForMode('/repo', 'local-only')).toBe(nodePath.join('/repo', LOCAL_LOCKFILE_NAME));
  });
});

describe('emptyLockfile', () => {
  it('produces a valid, schema-versioned empty lockfile', () => {
    const lock = emptyLockfile('ai-primitives-hub-cli@1.0.0');
    expect(lock.version).toBe(LOCKFILE_SCHEMA_VERSION);
    expect(lock.generatedBy).toBe('ai-primitives-hub-cli@1.0.0');
    expect(lock.bundles).toEqual({});
    expect(lock.sources).toEqual({});
  });
});

describe('readLockfile / writeLockfile', () => {
  it('returns null when the file does not exist', async () => {
    const fs = new InMemoryFileSystem();
    const result = await readLockfile('/repo/prompt-registry.lock.json', fs);
    expect(result).toBeNull();
  });

  it('round-trips a lockfile through write then read', async () => {
    const fs = new InMemoryFileSystem();
    const lock = emptyLockfile('cli@1.0.0');
    const path = getLockfilePathForMode('/repo', 'commit');

    await writeLockfile(path, lock, fs);
    const result = await readLockfile(path, fs);

    expect(result).not.toBeNull();
    expect(result?.version).toBe(LOCKFILE_SCHEMA_VERSION);
  });

  it('reads a lockfile written in the extension\'s exact on-disk shape', async () => {
    const fs = new InMemoryFileSystem();
    const path = '/repo/prompt-registry.lock.json';
    fs.seed(path, JSON.stringify({
      $schema: 'https://example.com/lockfile.schema.json',
      version: '2.0.0',
      generatedAt: '2024-01-01T00:00:00.000Z',
      generatedBy: 'ai-primitives-hub@1.0.0',
      bundles: {
        'my-bundle': {
          version: '1.0.0',
          sourceId: 'github-abc123',
          sourceType: 'github',
          installedAt: '2024-01-01T00:00:00.000Z',
          files: [{ path: '.github/prompts/test.md', checksum: 'deadbeef' }]
        }
      },
      sources: {
        'github-abc123': { type: 'github', url: 'https://github.com/owner/repo' }
      }
    }));

    const lock = await readLockfile(path, fs);
    expect(lock?.bundles['my-bundle'].sourceId).toBe('github-abc123');
    expect(lock?.bundles['my-bundle'].files[0].path).toBe('.github/prompts/test.md');
  });
});

describe('deleteLockfile', () => {
  it('removes the file when it exists', async () => {
    const fs = new InMemoryFileSystem();
    const path = '/repo/prompt-registry.lock.json';
    fs.seed(path, '{}');

    await deleteLockfile(path, fs);

    expect(await fs.exists(path)).toBe(false);
  });

  it('is a no-op when the file is already absent', async () => {
    const fs = new InMemoryFileSystem();
    await expect(deleteLockfile('/repo/prompt-registry.lock.json', fs)).resolves.not.toThrow();
  });
});

describe('upsertBundleEntry / removeBundleEntry', () => {
  it('adds a new bundle entry keyed by bundleId', () => {
    const lock = emptyLockfile('cli@1.0.0');
    const next = upsertBundleEntry(lock, 'my-bundle', {
      version: '1.0.0',
      sourceId: 'github-abc',
      sourceType: 'github',
      installedAt: '2024-01-01T00:00:00.000Z',
      files: [{ path: '.github/prompts/test.md', checksum: 'abc' }]
    });

    expect(next.bundles['my-bundle'].version).toBe('1.0.0');
    expect(lock.bundles).toEqual({}); // input not mutated
  });

  it('replaces an existing entry with the same bundleId', () => {
    let lock = emptyLockfile('cli@1.0.0');
    lock = upsertBundleEntry(lock, 'my-bundle', {
      version: '1.0.0', sourceId: 's', sourceType: 'github', installedAt: 't', files: []
    });
    lock = upsertBundleEntry(lock, 'my-bundle', {
      version: '2.0.0', sourceId: 's', sourceType: 'github', installedAt: 't2', files: []
    });

    expect(Object.keys(lock.bundles)).toHaveLength(1);
    expect(lock.bundles['my-bundle'].version).toBe('2.0.0');
  });

  it('removes a bundle entry', () => {
    let lock = emptyLockfile('cli@1.0.0');
    lock = upsertBundleEntry(lock, 'my-bundle', {
      version: '1.0.0', sourceId: 's', sourceType: 'github', installedAt: 't', files: []
    });
    const next = removeBundleEntry(lock, 'my-bundle');

    expect(next.bundles).toEqual({});
  });
});

describe('upsertSource / cleanupOrphanedSource', () => {
  it('adds a source descriptor', () => {
    const lock = emptyLockfile('cli@1.0.0');
    const next = upsertSource(lock, 'github-abc', { type: 'github', url: 'https://github.com/owner/repo' });
    expect(next.sources['github-abc'].url).toBe('https://github.com/owner/repo');
  });

  it('keeps a source referenced by another bundle', () => {
    let lock = emptyLockfile('cli@1.0.0');
    lock = upsertSource(lock, 'github-abc', { type: 'github', url: 'https://x' });
    lock = upsertBundleEntry(lock, 'bundle-a', { version: '1.0.0', sourceId: 'github-abc', sourceType: 'github', installedAt: 't', files: [] });
    lock = upsertBundleEntry(lock, 'bundle-b', { version: '1.0.0', sourceId: 'github-abc', sourceType: 'github', installedAt: 't', files: [] });

    lock = removeBundleEntry(lock, 'bundle-a');
    const next = cleanupOrphanedSource(lock, 'github-abc');

    expect(next.sources['github-abc']).toBeDefined();
  });

  it('removes a source no longer referenced by any bundle', () => {
    let lock = emptyLockfile('cli@1.0.0');
    lock = upsertSource(lock, 'github-abc', { type: 'github', url: 'https://x' });
    lock = upsertBundleEntry(lock, 'bundle-a', { version: '1.0.0', sourceId: 'github-abc', sourceType: 'github', installedAt: 't', files: [] });

    lock = removeBundleEntry(lock, 'bundle-a');
    const next = cleanupOrphanedSource(lock, 'github-abc');

    expect(next.sources['github-abc']).toBeUndefined();
  });
});

describe('remapSourceId', () => {
  it('remaps all bundle entries from old source to new source', () => {
    let lock = emptyLockfile('cli@1.0.0');
    lock = upsertSource(lock, 'github-old', { type: 'github', url: 'https://github.com/org/old-repo' });
    lock = upsertBundleEntry(lock, 'bundle-a', { version: '1.0.0', sourceId: 'github-old', sourceType: 'github', installedAt: 't', files: [] });
    lock = upsertBundleEntry(lock, 'bundle-b', { version: '2.0.0', sourceId: 'github-old', sourceType: 'github', installedAt: 't', files: [] });

    const next = remapSourceId(lock, 'github-old', 'github-new', { type: 'github', url: 'https://github.com/org/new-repo' });

    expect(next.bundles['bundle-a'].sourceId).toBe('github-new');
    expect(next.bundles['bundle-b'].sourceId).toBe('github-new');
    expect(next.sources['github-old']).toBeUndefined();
    expect(next.sources['github-new'].url).toBe('https://github.com/org/new-repo');
  });

  it('does not touch bundles referencing a different source', () => {
    let lock = emptyLockfile('cli@1.0.0');
    lock = upsertSource(lock, 'github-old', { type: 'github', url: 'https://github.com/org/old-repo' });
    lock = upsertSource(lock, 'github-other', { type: 'github', url: 'https://github.com/org/other' });
    lock = upsertBundleEntry(lock, 'bundle-a', { version: '1.0.0', sourceId: 'github-old', sourceType: 'github', installedAt: 't', files: [] });
    lock = upsertBundleEntry(lock, 'bundle-b', { version: '1.0.0', sourceId: 'github-other', sourceType: 'github', installedAt: 't', files: [] });

    const next = remapSourceId(lock, 'github-old', 'github-new', { type: 'github', url: 'https://github.com/org/new-repo' });

    expect(next.bundles['bundle-a'].sourceId).toBe('github-new');
    expect(next.bundles['bundle-b'].sourceId).toBe('github-other');
    expect(next.sources['github-other']).toBeDefined();
  });

  it('does not mutate the input lockfile', () => {
    let lock = emptyLockfile('cli@1.0.0');
    lock = upsertSource(lock, 'github-old', { type: 'github', url: 'https://github.com/org/old-repo' });
    lock = upsertBundleEntry(lock, 'bundle-a', { version: '1.0.0', sourceId: 'github-old', sourceType: 'github', installedAt: 't', files: [] });

    remapSourceId(lock, 'github-old', 'github-new', { type: 'github', url: 'https://github.com/org/new-repo' });

    expect(lock.bundles['bundle-a'].sourceId).toBe('github-old');
    expect(lock.sources['github-old']).toBeDefined();
  });
});
