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
  createReleaseManifestPlan,
  LEGACY_RELEASE_WARNING,
  RegistryError,
  type ReleaseSourceReader,
  type ReleaseSourceTree,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  validateCollectionFile,
} from '../../src/collection/read-collection';
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

type SourcesDouble = ReleaseSourceReader & { workingTreeOpened: number; revisionOpened: number };

const createSources = (
  files: Record<string, string>,
  workingFiles: Record<string, string> = files
): SourcesDouble => {
  const revisionTree = new Map(Object.entries(files));
  const workingTree = new Map(Object.entries(workingFiles));
  const sources = {
    workingTreeOpened: 0,
    revisionOpened: 0,
    openRevision: () => {
      sources.revisionOpened += 1;
      return Promise.resolve({ revision: 'a'.repeat(40), ...createTree(revisionTree) });
    },
    openWorkingTree: () => {
      sources.workingTreeOpened += 1;
      return createTree(workingTree);
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

describe('planBundleRelease() plugin items', () => {
  const SCHEMA_URI = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
  const PREFIX = `${COLLECTION_FILE}: items[0]`;
  const validManifest = (name: string): Record<string, unknown> => ({
    $schema: SCHEMA_URI,
    name,
    version: '1.0.0',
    description: 'Test plugin.',
    author: { name: 'Test' }
  });
  const pluginFiles = (
    itemPath: string,
    manifest: unknown,
    { kind = 'plugin', license = true }: { kind?: string; license?: boolean } = {}
  ): Record<string, string> => {
    const root = path.posix.dirname(itemPath);
    return {
      [COLLECTION_FILE]: `id: foo\nname: Foo\nitems:\n  - path: ${itemPath}\n    kind: ${kind}\n`,
      [itemPath]: JSON.stringify(manifest),
      [`${root}/skills/demo/SKILL.md`]: '# Demo\n',
      ...(license ? { LICENSE: 'License\n' } : {})
    };
  };
  const plan = (sources: ReleaseSourceReader): ReturnType<typeof planBundleRelease> =>
    planBundleRelease({ repoRoot: '/repo', collectionFile: COLLECTION_FILE, version: '1.0.0', sources });
  const rejection = async (sources: ReleaseSourceReader): Promise<RegistryError> => {
    const error = await plan(sources).then(() => undefined, (err: unknown) => err);
    expect(error).toBeInstanceOf(RegistryError);
    return error as RegistryError;
  };
  const withoutSchema = { name: 'demo', version: '1.0.0', description: 'Test plugin.', author: { name: 'Test' } };

  it.each([
    {
      label: 'a missing "$schema"',
      itemPath: 'plugins/demo/plugin.json',
      manifest: withoutSchema,
      kind: 'plugin',
      error: `${PREFIX} plugin plugins/demo/plugin.json: missing required field "$schema"; set it to "${SCHEMA_URI}"`
    },
    {
      label: 'an invalid "name"',
      itemPath: 'plugins/Bad_Name/plugin.json',
      manifest: validManifest('Bad_Name'),
      kind: 'plugin',
      error: `${PREFIX} plugin plugins/Bad_Name/plugin.json: "name" must be 1-64 characters of lowercase letters, digits, "." or "-", `
        + 'start and end with a letter or digit, and contain no "--" or ".." (got "Bad_Name")'
    },
    {
      label: 'a string "author"',
      itemPath: 'plugins/demo/plugin.json',
      manifest: { ...validManifest('demo'), author: 'someone' },
      kind: 'plugin',
      error: `${PREFIX} plugin plugins/demo/plugin.json: "author" must be an object with optional string fields "name", "email", "url" (got a string)`
    },
    {
      label: 'a string "author" under the "plugins" kind alias',
      itemPath: 'plugins/demo/plugin.json',
      manifest: { ...validManifest('demo'), author: 'someone' },
      kind: 'plugins',
      error: `${PREFIX} plugin plugins/demo/plugin.json: "author" must be an object with optional string fields "name", "email", "url" (got a string)`
    },
    {
      label: 'a plugin.json outside the plugin root',
      itemPath: 'plugins/demo/.github/plugin/plugin.json',
      manifest: validManifest('demo'),
      kind: 'plugin',
      error: expect.stringContaining(
        `${PREFIX} plugin plugins/demo/.github/plugin/plugin.json: plugin name "demo" must match its directory "plugin" `
      ) as unknown as string
    },
    {
      label: 'an item path that is not a plugin.json',
      itemPath: 'plugins/demo/README.md',
      manifest: validManifest('demo'),
      kind: 'plugin',
      error: expect.stringContaining(
        `${PREFIX} plugin plugins/demo/README.md: plugin item path must point to the plugin's root plugin.json`
      ) as unknown as string
    }
  ])('fails with PLUGIN.INVALID_MANIFEST for $label', async ({ itemPath, manifest, kind, error }) => {
    const sources = createSources(pluginFiles(itemPath, manifest, { kind }));
    const err = await rejection(sources);
    expect(err).toMatchObject({ code: 'PLUGIN.INVALID_MANIFEST', context: { errors: [error], warnings: [] } });
    expect(err.message).toBe((err.context?.errors as string[]).join('\n'));
    expect(err.hint).toContain('commit');
    expect(sources.workingTreeOpened).toBe(0);
  });

  it('reports a missing plugin.json with the collection validate message', async () => {
    const files = pluginFiles('plugins/demo/plugin.json', validManifest('demo'));
    delete files['plugins/demo/plugin.json'];
    const err = await rejection(createSources(files));
    expect(err.context?.errors).toEqual([`${PREFIX} referenced file not found: plugins/demo/plugin.json`]);
  });

  it('reports a plugin.json that is a directory as not a readable file', async () => {
    const files = pluginFiles('plugins/demo/plugin.json', validManifest('demo'));
    delete files['plugins/demo/plugin.json'];
    files['plugins/demo/plugin.json/nested.txt'] = 'x';
    const err = await rejection(createSources(files));
    expect(err.context?.errors).toEqual([`${PREFIX} plugin plugins/demo/plugin.json: plugin.json is not a readable file`]);
  });

  it('returns non-fatal plugin issues as warnings without blocking', async () => {
    const result = await plan(createSources(pluginFiles(
      'plugins/demo/plugin.json',
      { ...validManifest('demo'), hooks: 'hooks.json' }
    )));
    expect(result.warnings).toEqual([
      expect.stringContaining(`${PREFIX} plugin plugins/demo/plugin.json: unknown top-level field "hooks" is ignored;`)
    ]);
    expect(result.plan.manifest.formatVersion).toBe(1);
  });

  it('plans a spec-compliant plugin exactly as the core planner does, from one revision', async () => {
    const files = pluginFiles('plugins/demo/plugin.json', validManifest('demo'));
    const sources = createSources(files);
    const result = await plan(sources);
    expect(result.warnings).toEqual([]);
    expect(result.plan).toEqual(await createReleaseManifestPlan(
      { repoRoot: '/repo', collectionFile: COLLECTION_FILE, version: '1.0.0' },
      createSources(files)
    ));
    expect(sources.revisionOpened).toBe(1);
    expect(sources.workingTreeOpened).toBe(0);
  });

  it('validates the working tree on the legacy fallback', async () => {
    const committed = pluginFiles('plugins/demo/plugin.json', validManifest('demo'), { license: false });
    const working = pluginFiles('plugins/demo/plugin.json', { ...validManifest('demo'), author: 'someone' }, { license: false });
    const sources = createSources(committed, working);
    const err = await rejection(sources);
    expect(err.code).toBe('PLUGIN.INVALID_MANIFEST');
    expect(err.context?.errors).toEqual([expect.stringContaining('"author" must be an object')]);
    expect(sources.workingTreeOpened).toBe(1);
  });

  it('does not let committed plugin errors block the legacy fallback', async () => {
    const committed = pluginFiles('plugins/demo/plugin.json', { ...validManifest('demo'), author: 'someone' }, { license: false });
    const working = pluginFiles('plugins/demo/plugin.json', validManifest('demo'), { license: false });
    const sources = createSources(committed, working);
    const result = await plan(sources);
    expect(result.warnings).toEqual([LEGACY_RELEASE_WARNING]);
    expect(sources.workingTreeOpened).toBe(1);
  });

  it('appends working-tree plugin warnings after the legacy warning', async () => {
    const committed = pluginFiles('plugins/demo/plugin.json', { ...validManifest('demo'), extra: true }, { license: false });
    const working = pluginFiles('plugins/demo/plugin.json', { ...validManifest('demo'), hooks: 'hooks.json' }, { license: false });
    const result = await plan(createSources(committed, working));
    expect(result.warnings).toEqual([
      LEGACY_RELEASE_WARNING,
      expect.stringContaining('unknown top-level field "hooks" is ignored;')
    ]);
  });

  it('leaves non-plugin planning errors to the core planner', async () => {
    const files = { ...baseFiles, LICENSE: 'License\n', [COLLECTION_FILE]: 'id: [foo\n' };
    const expected = await createReleaseManifestPlan(
      { repoRoot: '/repo', collectionFile: COLLECTION_FILE, version: '1.0.0' },
      createSources(files)
    ).then(() => 'resolved', (err: unknown) => (err as Error).message);
    await expect(plan(createSources(files))).rejects.toThrow(expected);
  });

  it('reads the committed revision of a real Git repository, not the working tree', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-bundle-release-plugin-test-'));
    try {
      const write = (relativePath: string, content: string): void => {
        fs.mkdirSync(path.dirname(path.join(repo, relativePath)), { recursive: true });
        fs.writeFileSync(path.join(repo, relativePath), content);
      };
      const git = (args: string[]): string =>
        execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const collectionFile = 'collections/example.collection.yml';
      const options = { repoRoot: repo, collectionFile, version: '1.0.0' };
      const writeManifest = (manifest: Record<string, unknown>): void =>
        write('plugins/demo/plugin.json', JSON.stringify(manifest));
      write('LICENSE', 'Example license\n');
      write('README.md', '# Example\n');
      write('plugins/demo/skills/demo/SKILL.md', '# Demo\n');
      write(collectionFile, 'id: example\nname: Example\nreadme:\n  path: README.md\nitems:\n  - path: plugins/demo/plugin.json\n    kind: plugin\n');
      writeManifest({ ...validManifest('demo'), author: 'someone' });
      git(['init']);
      git(['config', 'user.email', 'test@example.invalid']);
      git(['config', 'user.name', 'Plan Bundle Release Test']);
      git(['remote', 'add', 'origin', 'https://github.com/example/example.git']);
      git(['add', '.']);
      git(['commit', '-m', 'Invalid plugin']);

      const committedInvalid = await planBundleRelease(options).then(() => undefined, (err: unknown) => err as RegistryError);
      expect(committedInvalid?.code).toBe('PLUGIN.INVALID_MANIFEST');
      expect(committedInvalid?.context?.errors).toEqual(validateCollectionFile(repo, collectionFile).errors);

      writeManifest(validManifest('demo'));
      await expect(planBundleRelease(options)).rejects.toMatchObject({ code: 'PLUGIN.INVALID_MANIFEST' });

      git(['commit', '-am', 'Valid plugin']);
      writeManifest({ ...validManifest('demo'), author: 'someone' });
      const result = await planBundleRelease(options);
      expect(result.warnings).toEqual([]);
      expect(result.plan.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining([
        'plugins/demo/plugin.json',
        'plugins/demo/skills/demo/SKILL.md'
      ]));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }, REAL_FS_TIMEOUT_MS);
});
