/**
 * Tests for the opt-in partial install (`writeBundleForInstall`).
 *
 * Without `skipUnsupported` the function must behave exactly like
 * `writeBundleSafely`; with it, supported content is written and the rest
 * is reported instead of failing the install.
 */
import * as path from 'node:path';
import type {
  ExtractedFiles,
  Target,
  TargetWritePlan,
  TargetWriter,
  TargetWriteResult,
  ValidatedManifest,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  writeBundleForInstall,
} from '../../src/install/partial-target-write';
import {
  TargetWriteRejectedError,
  writeBundleSafely,
} from '../../src/install/target-write';
import {
  FileTreeTargetWriter,
} from '../../src/writers/file-tree-writer';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

const localPath = (...segments: string[]): string => path.join(...segments);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const env = { HOME: '/home/u' };
const kiroDir = localPath('/home/u', '.kiro');
const kiroTarget = (allowedKinds?: Target['allowedKinds']): Target => ({
  name: 'kiro-ide',
  type: 'kiro',
  scope: 'user',
  ...(allowedKinds === undefined ? {} : { allowedKinds })
});
const kiroReason = 'target "kiro-ide" (kiro) cannot install this content';

/** In-memory filesystem that remembers which files currently exist. */
class ListingFileSystem extends InMemoryFileSystem {
  private readonly present = new Set<string>();

  public override async writeFile(p: string, contents: string): Promise<void> {
    await super.writeFile(p, contents);
    this.present.add(p.replaceAll('\\', '/'));
  }

  public override async writeFileBytes(p: string, bytes: Uint8Array): Promise<void> {
    await super.writeFileBytes(p, bytes);
    this.present.add(p.replaceAll('\\', '/'));
  }

  public override async remove(p: string, opts?: { recursive?: boolean }): Promise<void> {
    await super.remove(p, opts);
    this.present.delete(p.replaceAll('\\', '/'));
  }

  /**
   * Files below a directory, relative to it.
   * @param root Directory to list.
   * @returns Sorted `/`-separated relative paths.
   */
  public list(root: string): string[] {
    const prefix = `${root.replaceAll('\\', '/')}/`;
    return [...this.present]
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length))
      .toSorted();
  }
}

/** A bundle without manifest items: a routable prompt and a Kiro-unroutable hook. */
const pathRoutedBundle = (): Map<string, Uint8Array> => new Map([
  ['deployment-manifest.yml', text('id: sample-mixed\n')],
  ['prompts/a.prompt.md', text('# A')],
  ['hooks/pre-commit.hook.json', text('{"hooks":{}}')]
]);
const pathRoutedManifest = (): ValidatedManifest => ({ id: 'sample-mixed', version: '1.0.0', name: 'Sample Mixed' });

/** A bundle whose manifest lists a skill directory and an instructions file. */
const itemBundle = (): Map<string, Uint8Array> => new Map([
  ['deployment-manifest.yml', text('id: sample-items\n')],
  ['skills/foo/SKILL.md', text('# Foo')],
  ['skills/foo/references/notes.md', text('# Notes')],
  ['instructions/rules.instructions.md', text('# Rules')]
]);
const itemManifest = (): ValidatedManifest => ({
  id: 'sample-items',
  version: '1.0.0',
  name: 'Sample Items',
  prompts: [
    { id: 'foo', name: 'Foo', file: 'skills/foo', type: 'skill' },
    { id: 'rules', name: 'Rules', file: 'instructions/rules.instructions.md', type: 'instructions' }
  ]
});

describe('writeBundleForInstall (default, all-or-nothing)', () => {
  it.each([
    ['option omitted', undefined],
    ['skipUnsupported: false', { skipUnsupported: false }]
  ])('rejects exactly like writeBundleSafely (%s) and writes nothing', async (_label, options) => {
    const expected = await writeBundleSafely(
      new FileTreeTargetWriter({ fs: new ListingFileSystem(), env }),
      kiroTarget(),
      pathRoutedBundle(),
      pathRoutedManifest()
    ).catch((e: unknown) => e);
    const fs = new ListingFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env });

    const error = await writeBundleForInstall(writer, kiroTarget(), pathRoutedBundle(), pathRoutedManifest(), options)
      .catch((e: unknown) => e);

    expect(expected).toBeInstanceOf(TargetWriteRejectedError);
    expect(error).toBeInstanceOf(TargetWriteRejectedError);
    const rejected = error as TargetWriteRejectedError;
    const reference = expected as TargetWriteRejectedError;
    expect(rejected.code).toBe(reference.code);
    expect(rejected.message).toBe(reference.message);
    expect(rejected.skipped).toEqual(reference.skipped);
    expect(fs.list(kiroDir)).toEqual([]);
  });

  it('returns writeBundleSafely\'s result and no skipped content for a supported bundle', async () => {
    const files = itemBundle();
    const reference = await writeBundleSafely(
      new FileTreeTargetWriter({ fs: new ListingFileSystem(), env }),
      kiroTarget(),
      files,
      itemManifest()
    );

    const outcome = await writeBundleForInstall(
      new FileTreeTargetWriter({ fs: new ListingFileSystem(), env }),
      kiroTarget(),
      files,
      itemManifest()
    );

    expect(outcome).toEqual({ ...reference, skipped: [] });
  });
});

describe('writeBundleForInstall (skipUnsupported)', () => {
  const skip = { skipUnsupported: true };

  it('installs the routable files of a path-routed bundle and reports the rest', async () => {
    const fs = new ListingFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env });

    const outcome = await writeBundleForInstall(writer, kiroTarget(), pathRoutedBundle(), pathRoutedManifest(), skip);

    expect(fs.list(kiroDir)).toEqual(['steering/a.prompt.md']);
    expect(outcome.skipped).toEqual([
      { path: 'hooks/pre-commit.hook.json', code: 'BUNDLE.UNSUPPORTED_CONTENT', reason: kiroReason }
    ]);
    expect(outcome.result.skipped).toEqual(['hooks/pre-commit.hook.json']);
    expect(outcome.result.writtenBundlePaths).toEqual(['prompts/a.prompt.md']);
  });

  it('installs a skill item and never path-routes a skipped instructions item', async () => {
    const fs = new ListingFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env });

    const outcome = await writeBundleForInstall(writer, kiroTarget(['skill']), itemBundle(), itemManifest(), skip);

    expect(fs.list(kiroDir)).toEqual(['skills/foo/SKILL.md', 'skills/foo/references/notes.md']);
    expect(outcome.skipped.map((s) => s.path)).toEqual(['instructions/rules.instructions.md']);
    expect(outcome.result.writtenBundlePaths?.toSorted()).toEqual(['skills/foo/SKILL.md', 'skills/foo/references/notes.md']);
    expect(outcome.result.installedPaths?.['skills/foo/SKILL.md']).toBe('skills/foo/SKILL.md');
  });

  it('skips a skill item without writing any file of its directory', async () => {
    const fs = new ListingFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env });

    const outcome = await writeBundleForInstall(writer, kiroTarget(['instructions']), itemBundle(), itemManifest(), skip);

    expect(fs.list(kiroDir)).toEqual(['steering/rules.instructions.md']);
    expect(outcome.skipped.map((s) => s.path)).toEqual(['skills/foo']);
    expect(outcome.result.writtenBundlePaths).toEqual(['instructions/rules.instructions.md']);
  });

  it('skips the later of two colliding items and does not path-route its file', async () => {
    const fs = new ListingFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env });
    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', text('id: sample-rules\n')],
      ['instructions/alpha.md', text('# Alpha')],
      ['instructions/alpha.instructions.md', text('# Alpha instructions')]
    ]);
    const manifest: ValidatedManifest = {
      id: 'sample-rules',
      version: '1.0.0',
      name: 'Sample Rules',
      prompts: [
        { id: 'alpha', name: 'Alpha', file: 'instructions/alpha.md', type: 'instructions' },
        { id: 'alpha.instructions', name: 'Alpha 2', file: 'instructions/alpha.instructions.md', type: 'instructions' }
      ]
    };

    const outcome = await writeBundleForInstall(writer, kiroTarget(), files, manifest, skip);

    expect(fs.list(kiroDir)).toEqual(['steering/alpha.instructions.md']);
    expect(await fs.readFile(localPath(kiroDir, 'steering', 'alpha.instructions.md'))).toBe('# Alpha');
    expect(outcome.skipped.map((s) => s.path)).toEqual(['instructions/alpha.instructions.md']);
    expect(outcome.result.writtenBundlePaths).toEqual(['instructions/alpha.md']);
  });

  it('rejects and writes nothing when the target supports none of the content', async () => {
    const fs = new ListingFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env });
    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', text('id: sample-items\n')],
      ['instructions/rules.instructions.md', text('# Rules')]
    ]);
    const manifest: ValidatedManifest = {
      id: 'sample-items',
      version: '1.0.0',
      name: 'Sample Items',
      prompts: [{ id: 'rules', name: 'Rules', file: 'instructions/rules.instructions.md', type: 'instructions' }]
    };

    const error = await writeBundleForInstall(writer, kiroTarget(['skill']), files, manifest, skip)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TargetWriteRejectedError);
    expect((error as TargetWriteRejectedError).skipped).toEqual(['instructions/rules.instructions.md']);
    expect(fs.list(kiroDir)).toEqual([]);
  });

  it('rejects and writes nothing for a path-routed bundle with no routable file', async () => {
    const fs = new ListingFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env });
    const files = new Map<string, Uint8Array>([
      ['deployment-manifest.yml', text('id: sample-hooks\n')],
      ['hooks/pre-commit.hook.json', text('{}')]
    ]);

    const error = await writeBundleForInstall(writer, kiroTarget(), files, pathRoutedManifest(), skip)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TargetWriteRejectedError);
    expect((error as TargetWriteRejectedError).skipped).toEqual(['hooks/pre-commit.hook.json']);
    expect(fs.list(kiroDir)).toEqual([]);
  });

  it('derives the written bundle paths for a writer that does not report them', async () => {
    const rollback = vi.fn(async (): Promise<void> => {});
    const writer: TargetWriter = {
      preflight: async (): Promise<TargetWritePlan> => ({ writable: ['prompts/a.prompt.md'], skipped: ['hooks/pre-commit.hook.json'] }),
      write: async (): Promise<TargetWriteResult> => ({ written: ['/out/a.prompt.md'], skipped: ['hooks/pre-commit.hook.json'] }),
      rollback,
      remove: async (): Promise<void> => {}
    };
    const files: ExtractedFiles = pathRoutedBundle();

    const outcome = await writeBundleForInstall(writer, kiroTarget(), files, pathRoutedManifest(), skip);

    expect(outcome.result.writtenBundlePaths).toEqual(['deployment-manifest.yml', 'prompts/a.prompt.md']);
    expect(outcome.skipped.map((s) => s.path)).toEqual(['hooks/pre-commit.hook.json']);
    expect(rollback).not.toHaveBeenCalled();
  });

  it('rethrows a write failure and rolls back what was written', async () => {
    class FailingFileSystem extends ListingFileSystem {
      public override async writeFile(p: string, contents: string): Promise<void> {
        if (p.endsWith('b.prompt.md')) {
          throw new Error('disk full');
        }
        await super.writeFile(p, contents);
      }
    }
    const fs = new FailingFileSystem();
    const writer = new FileTreeTargetWriter({ fs, env });
    const files = pathRoutedBundle();
    files.set('prompts/b.prompt.md', text('# B'));

    await expect(writeBundleForInstall(writer, kiroTarget(), files, pathRoutedManifest(), skip))
      .rejects.toThrow('disk full');
    expect(fs.list(kiroDir)).toEqual([]);
  });

  it('matches writeBundleSafely when everything is supported', async () => {
    const files = itemBundle();
    const reference = await writeBundleSafely(
      new FileTreeTargetWriter({ fs: new ListingFileSystem(), env }),
      kiroTarget(),
      files,
      itemManifest()
    );

    const outcome = await writeBundleForInstall(
      new FileTreeTargetWriter({ fs: new ListingFileSystem(), env }),
      kiroTarget(),
      files,
      itemManifest(),
      skip
    );

    expect(outcome.result).toEqual(reference.result);
    expect(outcome.installableFiles).toEqual(reference.installableFiles);
    expect(outcome.skipped).toEqual([]);
  });
});
