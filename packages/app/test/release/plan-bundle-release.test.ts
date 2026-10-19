/**
 * `planBundleRelease` tests: governed plan, legacy fallback with warning,
 * blocking failures, and wiring of the default Node source reader.
 */
import {
  execFileSync,
} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LEGACY_RELEASE_WARNING,
  type ReleaseSourceReader,
  type ReleaseSourceTree,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  planBundleRelease,
} from '../../src/release/plan-bundle-release';

const COLLECTION_FILE = 'collections/foo.collection.yml';
const REAL_FS_TIMEOUT_MS = 30_000;

const encoder = new TextEncoder();

const createTree = (files: Map<string, string>): ReleaseSourceTree => ({
  readFile: (repositoryPath) => {
    const content = files.get(repositoryPath);
    return content === undefined
      ? Promise.reject(new Error(`missing: ${repositoryPath}`))
      : Promise.resolve(encoder.encode(content));
  },
  listFiles: (directory) => Promise.resolve([...files.keys()].filter(
    (file) => directory === '.' || file.startsWith(`${directory}/`)
  ))
});

const createSources = (files: Record<string, string>): ReleaseSourceReader & { workingTreeOpened: number } => {
  const tree = new Map(Object.entries(files));
  const sources = {
    workingTreeOpened: 0,
    openRevision: () => Promise.resolve({ revision: 'a'.repeat(40), ...createTree(tree) }),
    openWorkingTree: () => {
      sources.workingTreeOpened += 1;
      return createTree(tree);
    },
    readRemoteUrl: () => Promise.resolve('https://github.com/example/foo.git')
  };
  return sources;
};

const baseFiles = {
  'prompts/hello.prompt.md': '# Hello\n',
  [COLLECTION_FILE]: 'id: foo\nname: Foo\nitems:\n  - path: prompts/hello.prompt.md\n    kind: prompt\n'
};

describe('planBundleRelease()', () => {
  it('returns the governed plan without warnings when license evidence is committed', async () => {
    const result = await planBundleRelease({
      repoRoot: '/repo',
      collectionFile: COLLECTION_FILE,
      version: '1.0.0',
      sources: createSources({ ...baseFiles, LICENSE: 'License\n' })
    });
    expect(result.warnings).toEqual([]);
    expect(result.plan.manifest.formatVersion).toBe(1);
  });

  it('falls back to the legacy plan with a warning when license evidence is missing', async () => {
    const sources = createSources(baseFiles);
    const result = await planBundleRelease({
      repoRoot: '/repo',
      collectionFile: COLLECTION_FILE,
      version: '1.0.0',
      sources
    });
    expect(result.warnings).toEqual([LEGACY_RELEASE_WARNING]);
    expect(result.plan.manifest).not.toHaveProperty('formatVersion');
    expect(result.plan.entries.map((entry) => entry.path)).toEqual(['prompts/hello.prompt.md']);
    expect(sources.workingTreeOpened).toBe(1);
  });

  it('rejects other planning failures without falling back', async () => {
    const sources = createSources({
      ...baseFiles,
      [COLLECTION_FILE]: 'id: foo\nname: Foo\nitems:\n  - path: prompts/hello.prompt.md\n    kind: unknown-kind\n'
    });
    await expect(planBundleRelease({
      repoRoot: '/repo',
      collectionFile: COLLECTION_FILE,
      version: '1.0.0',
      sources
    })).rejects.toThrow('Collection item kind is not a canonical primitive kind: unknown-kind');
    expect(sources.workingTreeOpened).toBe(0);
  });

  it('plans from a real Git repository with the default source reader', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-bundle-release-test-'));
    try {
      const write = (relativePath: string, content: string): void => {
        fs.mkdirSync(path.dirname(path.join(repo, relativePath)), { recursive: true });
        fs.writeFileSync(path.join(repo, relativePath), content);
      };
      const git = (args: string[]): string =>
        execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      write('LICENSE', 'Example license\n');
      write('README.md', '# Collection overview\n');
      write('prompts/hello.prompt.md', '# Hello\n');
      write('skills/example/SKILL.md', '# Example skill\n');
      write('skills/example/references/reference.md', '# Reference\n');
      write('skills/example/__pycache__/ignored.pyc', 'cache');
      write('collections/example.collection.yml', `id: example
name: Example
readme:
  path: README.md
items:
  - path: prompts/hello.prompt.md
    kind: prompt
  - path: skills/example/SKILL.md
    kind: skill
`);
      git(['init']);
      git(['config', 'user.email', 'test@example.invalid']);
      git(['config', 'user.name', 'Plan Bundle Release Test']);
      git(['remote', 'add', 'origin', 'https://github.com/example/example.git']);
      git(['add', '.']);
      git(['commit', '-m', 'Fixture']);

      const { plan, warnings } = await planBundleRelease({
        repoRoot: repo,
        collectionFile: 'collections/example.collection.yml',
        version: '1.2.3'
      });
      expect(warnings).toEqual([]);
      expect(plan.entries.map((entry) => entry.path)).toEqual([
        'LICENSE',
        'README.md',
        'metadata/source/collections/example.collection.yml',
        'prompts/hello.prompt.md',
        'skills/example/SKILL.md',
        'skills/example/references/reference.md'
      ]);
      expect(plan.manifest.provenance).toMatchObject({
        source: 'https://github.com/example/example',
        revision: git(['rev-parse', 'HEAD'])
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }, REAL_FS_TIMEOUT_MS);
});
