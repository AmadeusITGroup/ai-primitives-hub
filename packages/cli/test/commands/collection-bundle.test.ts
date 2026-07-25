/**
 * `collection-*`, `bundle manifest`, `bundle build`, `version compute`,
 * and `skill new` command tests.
 *
 * Uses a real `NodeFileSystem` against a real temp directory (not
 * `createTestContext`'s default in-memory `fs` stub, which rejects
 * every call) since these commands do real file IO; `bundle build`
 * additionally shells out to a real zip stream and `version compute`
 * to a real `git` binary, neither of which can be stubbed through
 * `Context.fs`.
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
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
  BundleBuildCommand,
} from '../../src/commands/bundle-build';
import {
  BundleManifestCommand,
} from '../../src/commands/bundle-manifest';
import {
  CollectionAffectedCommand,
} from '../../src/commands/collection-affected';
import {
  CollectionCreateCommand,
} from '../../src/commands/collection-create';
import {
  CollectionListCommand,
} from '../../src/commands/collection-list';
import {
  CollectionValidateCommand,
} from '../../src/commands/collection-validate';
import {
  SkillNewCommand,
} from '../../src/commands/skill-new';
import {
  VersionComputeCommand,
} from '../../src/commands/version-compute';
import {
  runCommand,
} from '../../src/framework';

const COMMAND_CLASSES = [
  CollectionCreateCommand,
  CollectionListCommand,
  CollectionValidateCommand,
  CollectionAffectedCommand,
  BundleManifestCommand,
  BundleBuildCommand,
  VersionComputeCommand,
  SkillNewCommand
];

interface JsonEnvelope<T> {
  status: string;
  data: T;
}

describe('collection/bundle/version/skill commands', () => {
  let workspace: string;

  const run = (argv: string[]): ReturnType<typeof runCommand> => runCommand(argv, {
    commandClasses: COMMAND_CLASSES,
    context: {
      cwd: workspace,
      fs: new NodeFileSystem(),
      env: {
        HOME: workspace,
        USERPROFILE: workspace,
        XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
        XDG_CACHE_HOME: path.join(workspace, 'xdg-cache')
      }
    }
  });

  const parseJson = <T>(stdout: string): JsonEnvelope<T> => JSON.parse(stdout) as JsonEnvelope<T>;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-collection-test-'));
    await mkdir(path.join(workspace, 'collections'), { recursive: true });
    await mkdir(path.join(workspace, 'prompts'), { recursive: true });
    await writeFile(path.join(workspace, 'prompts', 'hello.prompt.md'), '# Hello Prompt\n\nA test prompt.\n');
    await writeFile(
      path.join(workspace, 'collections', 'foo.collection.yml'),
      `id: foo
name: Foo Collection
description: Test collection
items:
  - path: prompts/hello.prompt.md
    kind: prompt
`
    );
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  describe('collection create', () => {
    it('creates a new collection file', async () => {
      const result = await run(['collection', 'create', 'bar', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ collectionId: string; path: string }>(result.stdout);
      expect(envelope.data.collectionId).toBe('bar');
      const content = await readFile(envelope.data.path, 'utf8');
      expect(content).toContain('id: bar');
    });

    it('fails with a clipanion usage error (exit 64) when <id> is omitted', async () => {
      const result = await run(['collection', 'create', '-o', 'json']);
      expect(result.exitCode).toBe(64);
    });

    it('honors an absolute --path as-is instead of nesting it under cwd', async () => {
      const customDir = path.join(workspace, 'custom-out');
      const result = await run(['collection', 'create', 'bar', '--path', customDir, '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ path: string }>(result.stdout);
      expect(envelope.data.path.startsWith(customDir)).toBe(true);
    });
  });

  describe('collection list', () => {
    it('lists the seeded collection', async () => {
      const result = await run(['collection', 'list', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ id: string }[]>(result.stdout);
      expect(envelope.data.map((c) => c.id)).toContain('foo');
    });

    it('fails with exit 1 when collections/ does not exist', async () => {
      const freshDir = await mkdtemp(path.join(os.tmpdir(), 'cli-collection-test-nocol-'));
      try {
        const result = await runCommand(['collection', 'list', '-o', 'json'], {
          commandClasses: COMMAND_CLASSES,
          context: { cwd: freshDir, fs: new NodeFileSystem(), env: {} }
        });
        expect(result.exitCode).toBe(1);
      } finally {
        await rm(freshDir, { recursive: true, force: true });
      }
    });
  });

  describe('collection validate', () => {
    it('passes for the seeded valid collection', async () => {
      const result = await run(['collection', 'validate', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ ok: boolean }>(result.stdout);
      expect(envelope.data.ok).toBe(true);
    });

    it('fails for a collection missing the required id field', async () => {
      await writeFile(
        path.join(workspace, 'collections', 'bad.collection.yml'),
        'name: Bad Collection\nitems: []\n'
      );
      const result = await run([
        'collection', 'validate', '--collection-file', 'collections/bad.collection.yml', '-o', 'json'
      ]);
      expect(result.exitCode).toBe(1);
      const envelope = parseJson<{ ok: boolean }>(result.stdout);
      expect(envelope.data.ok).toBe(false);
    });
  });

  describe('collection affected', () => {
    it('reports the collection as affected when an item path changed', async () => {
      const result = await run([
        'collection', 'affected', '--changed-path', 'prompts/hello.prompt.md', '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ affected: { id: string }[] }>(result.stdout);
      expect(envelope.data.affected.map((a) => a.id)).toContain('foo');
    });

    it('reports no affected collections for an unrelated path', async () => {
      const result = await run([
        'collection', 'affected', '--changed-path', 'unrelated/file.md', '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ affected: unknown[] }>(result.stdout);
      expect(envelope.data.affected).toEqual([]);
    });
  });

  describe('bundle manifest', () => {
    it('generates a deployment-manifest.yml from the collection', async () => {
      const outFile = path.join(workspace, 'deployment-manifest.yml');
      const result = await run([
        'bundle', 'manifest', '--version', '1.0.0', '--out-file', outFile, '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ id: string; totalItems: number }>(result.stdout);
      expect(envelope.data).toMatchObject({ id: 'foo', totalItems: 1 });
      const content = await readFile(outFile, 'utf8');
      expect(content).toContain('id: foo');
    });

    it('fails with exit 1 when collections/ does not exist and no --collection-file is given', async () => {
      const freshDir = await mkdtemp(path.join(os.tmpdir(), 'cli-collection-test-nocol-'));
      try {
        const result = await runCommand(['bundle', 'manifest', '--version', '1.0.0', '-o', 'json'], {
          commandClasses: COMMAND_CLASSES,
          context: { cwd: freshDir, fs: new NodeFileSystem(), env: {} }
        });
        expect(result.exitCode).toBe(1);
      } finally {
        await rm(freshDir, { recursive: true, force: true });
      }
    });

    it('writes the default deployment-manifest.yml under ctx.cwd(), not process.cwd()', async () => {
      const result = await run(['bundle', 'manifest', '--version', '1.0.0', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ outFile: string }>(result.stdout);
      expect(envelope.data.outFile).toBe(path.join(workspace, 'deployment-manifest.yml'));
      const content = await readFile(path.join(workspace, 'deployment-manifest.yml'), 'utf8');
      expect(content).toContain('id: foo');
      await expect(readFile(path.join(process.cwd(), 'deployment-manifest.yml'), 'utf8')).rejects.toThrow();
    });
  });

  describe('bundle build', () => {
    it('builds a non-trivial, reproducible bundle zip', async () => {
      const result = await run([
        'bundle', 'build', '--version', '1.0.0', '--collection-file', 'collections/foo.collection.yml', '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ zipAsset: string; manifestAsset: string }>(result.stdout);
      const zipStat = await stat(envelope.data.zipAsset);
      expect(zipStat.size).toBeGreaterThan(0);
    });

    it('defaults to the first collection file under collections/ when --collection-file is omitted', async () => {
      const result = await run([
        'bundle', 'build', '--version', '1.0.0', '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ zipAsset: string; manifestAsset: string }>(result.stdout);
      expect(envelope.data.manifestAsset).toContain('deployment-manifest.yml');
      expect(envelope.data.zipAsset).toContain('foo.bundle.zip');
      const zipStat = await stat(envelope.data.zipAsset);
      expect(zipStat.size).toBeGreaterThan(0);
    });
  });

  describe('version compute', () => {
    beforeEach(async () => {
      await run(['bundle', 'manifest', '--version', '1.0.0', '-o', 'json']);
    });

    it('computes 1.0.0 as the initial version with no existing git tags', async () => {
      const result = await run([
        'version', 'compute', '--collection-file', 'collections/foo.collection.yml', '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ collectionId: string; nextVersion: string; tag: string }>(result.stdout);
      expect(envelope.data).toMatchObject({ collectionId: 'foo', nextVersion: '1.0.0', tag: 'foo-v1.0.0' });
    });
  });

  describe('skill new', () => {
    it('creates a new skill folder with SKILL.md', async () => {
      const result = await run([
        'skill', 'new', '--skill-name', 'my-skill', '--description', 'A test skill', '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ path: string }>(result.stdout);
      const content = await readFile(path.join(envelope.data.path, 'SKILL.md'), 'utf8');
      expect(content.length).toBeGreaterThan(0);
    });

    it('fails with exit 1 when --skill-name is omitted', async () => {
      const result = await run(['skill', 'new', '--description', 'A test skill', '-o', 'json']);
      expect(result.exitCode).toBe(1);
    });
  });
});
