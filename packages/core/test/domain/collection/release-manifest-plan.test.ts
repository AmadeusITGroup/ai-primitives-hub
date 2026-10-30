/**
 * Release manifest planning tests.
 *
 * Ported from the legacy `lib/test/release-manifest.test.ts` (reference
 * only, left unchanged) onto an in-memory `ReleaseSourceReader`, plus the
 * cases `bundle build` depends on (fallback classification, error text,
 * serialization).
 */
import {
  createHash,
} from 'node:crypto';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  applyReleaseLayout,
} from '../../../src/domain/collection/apm-release-plan';
import {
  assertImmutableRevision,
  createLegacyReleaseManifestPlan,
  createReleaseManifestPlan,
  isMissingSourceLicenseError,
  LEGACY_RELEASE_WARNING,
  NO_SOURCE_LICENSE_MESSAGE,
  RELEASE_EXECUTABLE_FILE_MODE,
  RELEASE_FILE_MODE,
  serializeReleaseManifest,
} from '../../../src/domain/collection/release-manifest-plan';
import {
  PRIMITIVE_KINDS,
} from '../../../src/domain/primitive/types';
import type {
  ReleaseSourceReader,
  ReleaseSourceTree,
} from '../../../src/ports/release-source';

const REVISION = 'abcdef0123456789abcdef0123456789abcdef01';
const COLLECTION_FILE = 'collections/example.collection.yml';

const encoder = new TextEncoder();
const decode = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

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

interface FakeSources extends ReleaseSourceReader {
  committed: Map<string, string>;
  working: Map<string, string>;
  remoteUrl: string;
}

const fixtureFiles = (): Map<string, string> => new Map([
  ['LICENSE', 'Example license\n'],
  ['README.md', '# Collection overview\n'],
  ['prompts/hello.prompt.md', '# Hello\n'],
  ['skills/example/SKILL.md', '# Example skill\n'],
  ['skills/example/references/reference.md', '# Reference\n'],
  ['skills/example/__pycache__/ignored.pyc', 'cache'],
  [COLLECTION_FILE, `id: example
name: Example
readme:
  path: README.md
items:
  - path: prompts/hello.prompt.md
    kind: prompt
  - path: skills/example/SKILL.md
    kind: skill
`]
]);

const createSources = (): FakeSources => {
  const sources: FakeSources = {
    committed: fixtureFiles(),
    working: fixtureFiles(),
    remoteUrl: 'https://github.com/example/example.git',
    openRevision: () => Promise.resolve({ revision: REVISION, ...createTree(sources.committed) }),
    openWorkingTree: () => createTree(sources.working),
    readRemoteUrl: () => Promise.resolve(sources.remoteUrl)
  };
  return sources;
};

/**
 * Set a file in both the committed and the working tree.
 * @param sources
 * @param file
 * @param content
 */
const commit = (sources: FakeSources, file: string, content: string): void => {
  sources.committed.set(file, content);
  sources.working.set(file, content);
};

const governedOptions = {
  repoRoot: '/repo',
  collectionFile: COLLECTION_FILE,
  version: '1.2.3',
  source: 'https://github.com/example/example.git',
  revision: REVISION,
  packageMetadata: { license: 'Example-License' }
};

describe('APM release layout', () => {
  it('leaves the default plan and its bytes untouched', async () => {
    const plan = await createReleaseManifestPlan(governedOptions, createSources());

    expect(applyReleaseLayout(plan)).toEqual({ plan, warnings: [] });
  });

  it.each(['', '.github/', '.apm/'])('rewires %s primitives once and retains skill resources and source metadata', async (prefix) => {
    const sources = createSources();
    const rootFiles = [...sources.committed];
    for (const [file, content] of rootFiles) {
      if (file.startsWith('prompts/') || file.startsWith('skills/')) {
        sources.committed.delete(file);
        sources.committed.set(`${prefix}${file}`, content);
      }
    }
    sources.committed.set(COLLECTION_FILE, sources.committed.get(COLLECTION_FILE)!
      .replace('path: prompts/', `path: ${prefix}prompts/`)
      .replace('path: skills/', `path: ${prefix}skills/`));
    const plan = await createReleaseManifestPlan(governedOptions, sources);
    const original = serializeReleaseManifest(plan.manifest);
    const transformed = applyReleaseLayout(plan, 'apm').plan;

    expect(transformed.entries.map((entry) => entry.path)).toEqual([
      '.apm/LICENSE',
      '.apm/README.md',
      '.apm/metadata/source/collections/example.collection.yml',
      '.apm/prompts/hello.prompt.md',
      '.apm/skills/example/SKILL.md',
      '.apm/skills/example/references/reference.md',
      'apm.yml'
    ]);
    for (const entry of plan.entries) {
      const newPath = `.apm/${entry.path.replace(/^(?:\.github|\.apm)\//, '')}`;
      expect(transformed.entries.find((candidate) => candidate.path === newPath))
        .toMatchObject({ bytes: entry.bytes, mode: entry.mode, role: entry.role });
    }
    expect(serializeReleaseManifest(plan.manifest)).toBe(original);
    expect(serializeReleaseManifest(applyReleaseLayout(plan, 'apm').plan.manifest))
      .toBe(serializeReleaseManifest(transformed.manifest));
  });

  it('rewires legacy manifests without inventing governed source evidence', async () => {
    const plan = await createLegacyReleaseManifestPlan(governedOptions, createSources());
    const transformed = applyReleaseLayout(plan, 'apm').plan;

    expect(transformed.manifest).not.toHaveProperty('formatVersion');
    expect(transformed.manifest).not.toHaveProperty('provenance');
    expect(transformed.manifest.readme).toBe('README.md');
    expect(transformed.manifest).toMatchObject({
      prompts: [
        { file: '.apm/prompts/hello.prompt.md' },
        { file: '.apm/skills/example/SKILL.md' }
      ]
    });
  });

  it('rejects relocation collisions instead of overwriting one payload', async () => {
    const plan = await createReleaseManifestPlan(governedOptions, createSources());
    const prompt = plan.entries.find((entry) => entry.path === 'prompts/hello.prompt.md')!;
    plan.entries.push({ ...prompt, path: '.github/prompts/hello.prompt.md' });

    expect(() => applyReleaseLayout(plan, 'apm')).toThrowError(
      expect.objectContaining({ code: 'BUNDLE.APM_UNSUPPORTED_CONTENT', message: expect.stringContaining('duplicate') })
    );
  });

  it.each(['hook', 'plugin'])('fails explicitly for unsupported native %s semantics', async (kind) => {
    const plan = await createReleaseManifestPlan(governedOptions, createSources());
    plan.manifest.items = [{ id: 'unsupported', path: 'prompts/hello.prompt.md', kind }];

    expect(() => applyReleaseLayout(plan, 'apm')).toThrowError(
      expect.objectContaining({ code: 'BUNDLE.APM_UNSUPPORTED_CONTENT' })
    );
  });

  it('does not silently reinterpret APH dependencies as APM dependencies', async () => {
    const plan = await createReleaseManifestPlan(governedOptions, createSources());
    plan.manifest.mcpServers = { example: { type: 'http', url: 'https://example.invalid' } };

    const result = applyReleaseLayout(plan, 'apm');

    expect(result.warnings).toEqual([expect.stringContaining('not translated')]);
    expect(result.plan.manifest.mcpServers).toEqual(plan.manifest.mcpServers);
  });

  it.each([
    { kind: 'instruction', itemPath: 'instructions/team/rules.instructions.md' },
    { kind: 'chat-mode', itemPath: 'chatmodes/legacy.chatmode.md' }
  ])('warns about native discovery without rejecting APH-supported $kind paths', async ({ kind, itemPath }) => {
    const sources = createSources();
    sources.committed.set(itemPath, '# Rules\n');
    sources.committed.set(COLLECTION_FILE, [
      'id: example',
      'name: Example',
      'items:',
      `  - path: ${itemPath}`,
      `    kind: ${kind}`
    ].join('\n'));
    const plan = await createReleaseManifestPlan(governedOptions, sources);

    const formatted = applyReleaseLayout(plan, 'apm');

    expect(formatted.warnings).toEqual([expect.stringContaining(`.apm/${itemPath}`)]);
    expect(formatted.plan.manifest).toMatchObject({
      items: [{ path: `.apm/${itemPath}` }]
    });
  });
});

describe('createReleaseManifestPlan()', () => {
  it('creates a canonical manifest with an integrity inventory over archive bytes', async () => {
    const plan = await createReleaseManifestPlan(governedOptions, createSources());
    const manifest = plan.manifest as {
      formatVersion: number;
      items: { path: string; kind: string }[];
      files: { path: string; role: string; size: number; sha256: string }[];
      provenance: { source: string; revision: string; sourceSnapshotPath: string; licensePath: string };
    };

    expect(manifest.formatVersion).toBe(1);
    expect(manifest.items.map((item) => item.kind)).toEqual(['prompt', 'skill']);
    expect(plan.entries.map((entry) => entry.path)).toEqual([
      'LICENSE',
      'README.md',
      'metadata/source/collections/example.collection.yml',
      'prompts/hello.prompt.md',
      'skills/example/SKILL.md',
      'skills/example/references/reference.md'
    ]);
    expect(plan.entries.some((entry) => entry.path.includes('__pycache__'))).toBe(false);
    expect(manifest.provenance.source).toBe('https://github.com/example/example');
    expect(manifest.provenance.revision).toBe(REVISION);
    expect(manifest.provenance.sourceSnapshotPath).toBe('metadata/source/collections/example.collection.yml');
    expect(manifest.provenance.licensePath).toBe('LICENSE');
    expect(manifest.files.every((file) => /^sha256:[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(manifest.files.some((file) => file.path === 'README.md' && file.role === 'metadata')).toBe(true);
    expect(manifest.files.some(
      (file) => file.path === 'skills/example/references/reference.md' && file.role === 'installable'
    )).toBe(true);
    expect(plan.readmeSourcePath).toBe('README.md');
  });

  it('keeps collection tags at the root and does not clone them onto items', async () => {
    const sources = createSources();
    commit(sources, COLLECTION_FILE, `id: example
name: Example
tags: [argos, splunk]
readme:
  path: README.md
items:
  - path: prompts/hello.prompt.md
    kind: prompt
  - path: skills/example/SKILL.md
    kind: skill
    tags: [orchestration]
`);

    const manifest = (await createReleaseManifestPlan(governedOptions, sources)).manifest as {
      tags?: string[];
      items: { path: string; tags?: string[] }[];
    };
    expect(manifest.tags).toEqual(['argos', 'splunk']);
    expect(manifest.items.find((item) => item.path === 'prompts/hello.prompt.md')?.tags).toBeUndefined();
    expect(manifest.items.find((item) => item.path === 'skills/example/SKILL.md')?.tags).toEqual(['orchestration']);

    const legacy = (await createLegacyReleaseManifestPlan({
      repoRoot: '/repo',
      collectionFile: COLLECTION_FILE,
      version: '1.2.3'
    }, sources)).manifest as {
      tags?: string[];
      prompts: { file: string; tags?: string[] }[];
    };
    expect(legacy.tags).toEqual(['argos', 'splunk']);
    expect(legacy.prompts.find((item) => item.file === 'prompts/hello.prompt.md')?.tags).toBeUndefined();
    expect(legacy.prompts.find((item) => item.file === 'skills/example/SKILL.md')?.tags).toEqual(['orchestration']);
  });

  it('uses exact committed source bytes instead of later working-tree changes', async () => {
    const sources = createSources();
    sources.working.set('prompts/hello.prompt.md', '# Changed only in the worktree\n');
    sources.working.set(COLLECTION_FILE, 'id: changed\nname: Changed\nitems: []\n');

    const plan = await createReleaseManifestPlan(governedOptions, sources);
    const manifest = plan.manifest as { id: string; provenance: { revision: string } };
    const prompt = plan.entries.find((entry) => entry.path === 'prompts/hello.prompt.md');
    const snapshot = plan.entries.find((entry) => entry.path === 'metadata/source/collections/example.collection.yml');

    expect(manifest.id).toBe('example');
    expect(manifest.provenance.revision).toBe(REVISION);
    expect(decode(prompt?.bytes)).toBe('# Hello\n');
    expect(decode(snapshot?.bytes)).toContain('id: example');
  });

  it('rejects with the missing-license error that permits legacy fallback', async () => {
    const sources = createSources();
    sources.committed.delete('LICENSE');

    const error = await createReleaseManifestPlan(governedOptions, sources).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(NO_SOURCE_LICENSE_MESSAGE);
    expect(isMissingSourceLicenseError(error)).toBe(true);
  });

  it('accepts COPYING or NOTICE at the root as license evidence', async () => {
    const sources = createSources();
    sources.committed.delete('LICENSE');
    sources.committed.set('COPYING.txt', 'copying\n');

    const plan = await createReleaseManifestPlan(governedOptions, sources);
    expect(decode(plan.entries.find((entry) => entry.path === 'LICENSE')?.bytes)).toBe('copying\n');
  });

  it('rejects an unknown item kind', async () => {
    const sources = createSources();
    commit(sources, COLLECTION_FILE, 'id: example\nname: Example\nitems:\n  - path: prompts/hello.prompt.md\n    kind: unknown-kind\n');

    await expect(createReleaseManifestPlan(governedOptions, sources)).rejects.toThrow(
      'Collection item kind is not a canonical primitive kind: unknown-kind'
    );
  });

  it('canonicalizes item kind aliases and packages skill directories for aliased kinds', async () => {
    const sources = createSources();
    commit(sources, COLLECTION_FILE, 'id: example\nname: Example\nitems:\n  - path: prompts/hello.prompt.md\n    kind: Instructions\n  - path: skills/example/SKILL.md\n    kind: Skills\n');

    const plan = await createReleaseManifestPlan(governedOptions, sources);
    const manifest = plan.manifest as {
      items: { kind: string }[];
      prompts: { type: string }[];
    };
    expect(manifest.items[0].kind).toBe('instruction');
    expect(manifest.prompts[0].type).toBe('instructions');
    expect(manifest.items[1].kind).toBe('skill');
    expect(plan.entries.map((entry) => entry.path)).toContain('skills/example/references/reference.md');

    const legacyPlan = await createLegacyReleaseManifestPlan({
      repoRoot: '/repo',
      collectionFile: COLLECTION_FILE,
      version: '1.2.3'
    }, sources);
    expect(legacyPlan.entries.map((entry) => entry.path)).toContain('skills/example/references/reference.md');
  });

  it('requires a collection id and name', async () => {
    const sources = createSources();
    commit(sources, COLLECTION_FILE, 'name: Example\nitems: []\n');
    await expect(createReleaseManifestPlan(governedOptions, sources)).rejects.toThrow(
      `Collection id is required: ${COLLECTION_FILE}`
    );

    commit(sources, COLLECTION_FILE, 'id: example\nitems: []\n');
    await expect(createReleaseManifestPlan(governedOptions, sources)).rejects.toThrow(
      `Collection name is required: ${COLLECTION_FILE}`
    );
  });

  it('reports an unresolvable source repository before a missing license', async () => {
    const sources = createSources();
    sources.remoteUrl = '';
    sources.committed.delete('LICENSE');

    const error = await createReleaseManifestPlan({
      repoRoot: '/repo',
      collectionFile: COLLECTION_FILE,
      version: '1.2.3'
    }, sources).catch((err: unknown) => err);
    expect((error as Error).message).toBe(
      'Unable to resolve a source repository URL from package metadata or git remote origin'
    );
    expect(isMissingSourceLicenseError(error)).toBe(false);
  });

  it('resolves the source from package.json, then from the origin remote', async () => {
    const sources = createSources();
    sources.remoteUrl = 'https://github.com/example/remote.git';
    const options = { repoRoot: '/repo', collectionFile: COLLECTION_FILE, version: '1.2.3' };

    expect((await createReleaseManifestPlan(options, sources)).manifest.repository)
      .toBe('https://github.com/example/remote');

    sources.committed.set('package.json', JSON.stringify({
      license: 'Pkg-License',
      repository: { url: 'git+https://github.com/example/package.git' }
    }));
    const manifest = (await createReleaseManifestPlan(options, sources)).manifest as {
      repository: string;
      license: string;
    };
    expect(manifest.repository).toBe('https://github.com/example/package');
    expect(manifest.license).toBe('Pkg-License');
  });

  it('rejects duplicate item ids', async () => {
    const sources = createSources();
    commit(sources, 'prompts/other/hello.prompt.md', '# Other\n');
    commit(sources, COLLECTION_FILE, `id: example
name: Example
items:
  - path: prompts/hello.prompt.md
    kind: prompt
  - path: prompts/other/hello.prompt.md
    kind: prompt
`);

    await expect(createReleaseManifestPlan(governedOptions, sources)).rejects.toThrow(
      'Release manifest contains duplicate item id: hello.prompt'
    );
  });

  it('keeps a leading BOM when extracting item metadata', async () => {
    const sources = createSources();
    commit(sources, 'prompts/hello.prompt.md', '\uFEFF# Hello\n');

    const manifest = (await createReleaseManifestPlan(governedOptions, sources)).manifest as {
      items: { id: string; name: string }[];
    };
    // `^#` does not match after a BOM, so the name falls back to the id (lib parity).
    expect(manifest.items[0].name).toBe('hello.prompt');
  });
});

describe('createLegacyReleaseManifestPlan()', () => {
  it('plans a legacy archive without fabricating governed license evidence', async () => {
    const sources = createSources();
    sources.working.delete('LICENSE');

    const plan = await createLegacyReleaseManifestPlan({
      repoRoot: '/repo',
      collectionFile: COLLECTION_FILE,
      version: '1.2.3'
    }, sources);
    const manifest = plan.manifest as Record<string, unknown> & { prompts: { file: string }[] };

    expect(manifest.formatVersion).toBeUndefined();
    expect(manifest.files).toBeUndefined();
    expect(manifest.provenance).toBeUndefined();
    expect(manifest.license).toBe('MIT');
    expect(plan.entries.map((entry) => entry.path)).toEqual([
      'prompts/hello.prompt.md',
      'skills/example/SKILL.md',
      'skills/example/references/reference.md'
    ]);
    expect(manifest.prompts.map((item) => item.file)).toEqual([
      'prompts/hello.prompt.md',
      'skills/example/SKILL.md'
    ]);
    expect(manifest.readme).toBe('README.md');
  });

  it('reads the working tree rather than the committed revision', async () => {
    const sources = createSources();
    sources.working.set('prompts/hello.prompt.md', '# Edited\n');

    const plan = await createLegacyReleaseManifestPlan({
      repoRoot: '/repo',
      collectionFile: COLLECTION_FILE,
      version: '1.2.3'
    }, sources);
    expect(decode(plan.entries.find((entry) => entry.path === 'prompts/hello.prompt.md')?.bytes)).toBe('# Edited\n');
  });
});

describe('isMissingSourceLicenseError()', () => {
  it('is false for other errors and non-errors', () => {
    expect(isMissingSourceLicenseError(new Error('other'))).toBe(false);
    expect(isMissingSourceLicenseError(NO_SOURCE_LICENSE_MESSAGE)).toBe(false);
    expect(isMissingSourceLicenseError(undefined)).toBe(false);
  });
});

describe('serializeReleaseManifest()', () => {
  it('does not wrap long strings', () => {
    const description = 'word '.repeat(60).trim();
    expect(serializeReleaseManifest({ id: 'example', description })).toBe(
      `id: example\ndescription: ${description}\n`
    );
  });
});

describe('assertImmutableRevision()', () => {
  it('accepts a full object id and lowercases it', () => {
    expect(assertImmutableRevision(REVISION.toUpperCase())).toBe(REVISION);
  });

  it('rejects a mutable ref', () => {
    expect(() => assertImmutableRevision('HEAD')).toThrow(
      'Source revision must be a full immutable Git object ID, got "HEAD"'
    );
  });
});

describe('LEGACY_RELEASE_WARNING', () => {
  it('keeps the text pinned by the bundle build command tests', () => {
    expect(LEGACY_RELEASE_WARNING).toBe(
      'No committed LICENSE, COPYING, or NOTICE file was found; building a legacy bundle without governed release evidence. Add license text to enable governed self-contained releases.'
    );
  });
});
describe('binary skill assets', () => {
  // Invalid UTF-8 (PNG signature + lone continuation/0xFF bytes): any text
  // round-trip would replace these with U+FFFD and corrupt the asset.
  const BINARY_PATH = 'skills/example/assets/logo.png';
  const BINARY = Uint8Array.of(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF, 0xFE, 0x80, 0xC3, 0x28);

  const withBinary = (tree: ReleaseSourceTree): ReleaseSourceTree => ({
    readFile: (repositoryPath) => (repositoryPath === BINARY_PATH
      ? Promise.resolve(BINARY.slice())
      : tree.readFile(repositoryPath)),
    listFiles: async (directory) => [
      ...await tree.listFiles(directory),
      ...(directory === '.' || BINARY_PATH.startsWith(`${directory}/`) ? [BINARY_PATH] : [])
    ]
  });

  const createBinarySources = (): FakeSources => {
    const sources = createSources();
    const base = createSources();
    sources.openRevision = async (repoRoot, revision) => {
      const tree = await base.openRevision(repoRoot, revision);
      return { revision: tree.revision, ...withBinary(tree) };
    };
    sources.openWorkingTree = (repoRoot) => withBinary(base.openWorkingTree(repoRoot));
    return sources;
  };

  it('passes binary bytes through the governed plan unchanged', async () => {
    const plan = await createReleaseManifestPlan(governedOptions, createBinarySources());
    expect(plan.entries.find((entry) => entry.path === BINARY_PATH)?.bytes).toEqual(BINARY);
  });

  it('passes binary bytes through the legacy plan unchanged', async () => {
    const plan = await createLegacyReleaseManifestPlan({
      repoRoot: '/repo',
      collectionFile: COLLECTION_FILE,
      version: '1.2.3'
    }, createBinarySources());
    expect(plan.entries.find((entry) => entry.path === BINARY_PATH)?.bytes).toEqual(BINARY);
  });
});

describe('archive entry modes', () => {
  const SCRIPT_PATH = 'skills/example/scripts/run.sh';
  const SCRIPT = '#!/bin/sh\necho run\n';

  /**
   * Add a script file to a tree and, when `executable` is given, the
   * optional `isExecutable` capability reporting those paths.
   * @param tree - Base tree.
   * @param executable - Paths the tree reports as executable.
   */
  const withScript = (tree: ReleaseSourceTree, executable?: ReadonlySet<string>): ReleaseSourceTree => ({
    readFile: (repositoryPath) => (repositoryPath === SCRIPT_PATH
      ? Promise.resolve(encoder.encode(SCRIPT))
      : tree.readFile(repositoryPath)),
    listFiles: async (directory) => [
      ...await tree.listFiles(directory),
      ...(directory === '.' || SCRIPT_PATH.startsWith(`${directory}/`) ? [SCRIPT_PATH] : [])
    ],
    ...(executable === undefined
      ? {}
      : { isExecutable: (repositoryPath: string) => Promise.resolve(executable.has(repositoryPath)) })
  });

  const createScriptSources = (executable?: ReadonlySet<string>): FakeSources => {
    const sources = createSources();
    const base = createSources();
    sources.openRevision = async (repoRoot, revision) => {
      const tree = await base.openRevision(repoRoot, revision);
      return { revision: tree.revision, ...withScript(tree, executable) };
    };
    sources.openWorkingTree = (repoRoot) => withScript(base.openWorkingTree(repoRoot), executable);
    return sources;
  };

  const modesOf = (plan: { entries: { path: string; mode: number }[] }): Record<string, number> =>
    Object.fromEntries(plan.entries.map((entry) => [entry.path, entry.mode]));

  it('pins the two permission values written to archive entries', () => {
    expect(RELEASE_FILE_MODE).toBe(0o644);
    expect(RELEASE_EXECUTABLE_FILE_MODE).toBe(0o755);
  });

  it('marks executable installable files 0755 and everything else, including metadata, 0644', async () => {
    // LICENSE is reported executable to prove metadata copies are never executable.
    const plan = await createReleaseManifestPlan(
      governedOptions,
      createScriptSources(new Set([SCRIPT_PATH, 'LICENSE']))
    );
    expect(modesOf(plan)).toEqual({
      LICENSE: 0o644,
      'README.md': 0o644,
      'metadata/source/collections/example.collection.yml': 0o644,
      'prompts/hello.prompt.md': 0o644,
      'skills/example/SKILL.md': 0o644,
      'skills/example/references/reference.md': 0o644,
      [SCRIPT_PATH]: 0o755
    });
  });

  it('treats a tree without isExecutable as all 0644', async () => {
    const plan = await createReleaseManifestPlan(governedOptions, createScriptSources());
    expect(plan.entries.length).toBeGreaterThan(0);
    expect(new Set(plan.entries.map((entry) => entry.mode))).toEqual(new Set([0o644]));
  });

  it('leaves the deployment manifest unchanged by entry modes', async () => {
    const executablePlan = await createReleaseManifestPlan(governedOptions, createScriptSources(new Set([SCRIPT_PATH])));
    const plainPlan = await createReleaseManifestPlan(governedOptions, createScriptSources());
    expect(executablePlan.manifest).toEqual(plainPlan.manifest);
    const files = executablePlan.manifest.files as Record<string, unknown>[];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(Object.keys(file)).toEqual(['path', 'role', 'size', 'sha256']);
    }
  });

  it('marks executable working-tree files 0755 in the legacy plan', async () => {
    const plan = await createLegacyReleaseManifestPlan({
      repoRoot: '/repo',
      collectionFile: COLLECTION_FILE,
      version: '1.2.3'
    }, createScriptSources(new Set([SCRIPT_PATH])));
    expect(modesOf(plan)).toEqual({
      'prompts/hello.prompt.md': 0o644,
      'skills/example/SKILL.md': 0o644,
      'skills/example/references/reference.md': 0o644,
      [SCRIPT_PATH]: 0o755
    });
  });
});

describe('characterisation: per-kind directory and id rules', () => {
  // Pins today's planner output for every primitive kind (issue #552,
  // ADR-0009 step M1): the item id and kind, the installable archive
  // entries with their modes, and a digest of the serialized manifest.
  // The values were captured from the code before the install-category
  // refactor and must not change.
  const FILE = RELEASE_FILE_MODE;
  const EXEC = RELEASE_EXECUTABLE_FILE_MODE;

  /**
   * Source reader over one in-memory file map, used for both the revision
   * and the working tree, reporting `executable` paths as executable.
   * @param files - Repository files.
   * @param executable - Paths reported as executable.
   */
  const sourcesFrom = (
    files: Map<string, string>,
    executable: ReadonlySet<string> = new Set()
  ): ReleaseSourceReader => {
    const tree = (): ReleaseSourceTree => ({
      ...createTree(files),
      isExecutable: (repositoryPath: string) => Promise.resolve(executable.has(repositoryPath))
    });
    return {
      openRevision: () => Promise.resolve({ revision: REVISION, ...tree() }),
      openWorkingTree: () => tree(),
      readRemoteUrl: () => Promise.resolve('https://github.com/example/example.git')
    };
  };

  interface Fixture {
    path: string;
    extra?: Record<string, string>;
    executable?: string[];
  }

  const FIXTURES: Record<string, Fixture> = {
    prompt: { path: 'prompts/x.prompt.md' },
    instruction: { path: 'instructions/x.instructions.md' },
    'chat-mode': { path: 'chatmodes/x.chatmode.md' },
    agent: { path: 'agents/x.agent.md' },
    skill: {
      path: 'skills/foo/SKILL.md',
      extra: { 'skills/foo/references/x.md': '# Ref\n', 'skills/foo/scripts/run.sh': '#!/bin/sh\n' },
      executable: ['skills/foo/scripts/run.sh']
    },
    plugin: {
      path: 'plugins/foo/plugin.json',
      extra: { 'plugins/foo/skills/s/SKILL.md': '# S\n', 'plugins/foo/mcp.json': '{}\n' }
    },
    hook: { path: 'hooks/x.json' },
    'mcp-server': { path: 'mcp-servers/x.mcp.json' },
    steering: { path: '.kiro/steering/x.md' },
    spec: { path: '.kiro/specs/feature/requirements.md' },
    command: { path: 'commands/x.md' },
    rule: { path: 'rules/x.md' },
    'output-style': { path: 'output-styles/x.md' },
    tool: { path: 'tools/x.md' },
    power: { path: 'powers/stripe/POWER.md', extra: { 'powers/stripe/steering/payments.md': '# Pay\n' } },
    knowledge: { path: 'knowledge/x.md' },
    playbook: { path: 'playbooks/x.md' }
  };

  /** Declared kind → fixture kind, for the alias rows. */
  const ALIASES: Record<string, string> = { skills: 'skill', Skill: 'skill' };

  interface Expected {
    governed: { id: string; kind: string; entries: [string, number][]; manifestSha256: string };
    legacy: { id: string; type: string; entries: [string, number][]; manifestSha256: string };
  }

  const EXPECTED: Record<string, Expected> = {
    prompt: {
      governed: {
        id: 'x.prompt',
        kind: 'prompt',
        entries: [
          ['prompts/x.prompt.md', FILE]
        ],
        manifestSha256: '8c4895101b3b4d404d9a4fc9feb8402b19b3b91d54630b8f60f2274092d79c09'
      },
      legacy: {
        id: 'x.prompt',
        type: 'prompt',
        entries: [
          ['prompts/x.prompt.md', FILE]
        ],
        manifestSha256: 'e7a494698ac8626f3f617fb7ff5f1f74e5cc1d94d202f706ef48bc18c9530ac8'
      }
    },
    instruction: {
      governed: {
        id: 'x.instructions',
        kind: 'instruction',
        entries: [
          ['instructions/x.instructions.md', FILE]
        ],
        manifestSha256: 'c6a42d0a308e6de01d5fe7833512d043aa0be3cb7afab8a083938d337b8b522c'
      },
      legacy: {
        id: 'x.instructions',
        type: 'instructions',
        entries: [
          ['instructions/x.instructions.md', FILE]
        ],
        manifestSha256: '27100296eb0ca73df9707138741d9ecbe86291916f90eb6a56ce9a824bc2738f'
      }
    },
    'chat-mode': {
      governed: {
        id: 'x.chatmode',
        kind: 'chat-mode',
        entries: [
          ['chatmodes/x.chatmode.md', FILE]
        ],
        manifestSha256: 'cc7e517973b46a71366bb319aba2138ee8cf6a871f5dbd01f8aa33d815922e94'
      },
      legacy: {
        id: 'x.chatmode',
        type: 'chatmode',
        entries: [
          ['chatmodes/x.chatmode.md', FILE]
        ],
        manifestSha256: '26af409316260bea3eaa3b31d89ea262d430c73adc86e5852a00e7dcbea1ca84'
      }
    },
    agent: {
      governed: {
        id: 'x.agent',
        kind: 'agent',
        entries: [
          ['agents/x.agent.md', FILE]
        ],
        manifestSha256: 'a45cfe04759fb6087e88ae8833224c2c5b085a06e71b0c1c3cc5d40094128041'
      },
      legacy: {
        id: 'x.agent',
        type: 'agent',
        entries: [
          ['agents/x.agent.md', FILE]
        ],
        manifestSha256: '1664f7b1a19a6faf9e88053b69bac41f898d2243654929aeb5359a852969fbfa'
      }
    },
    skill: {
      governed: {
        id: 'foo',
        kind: 'skill',
        entries: [
          ['skills/foo/SKILL.md', FILE],
          ['skills/foo/references/x.md', FILE],
          ['skills/foo/scripts/run.sh', EXEC]
        ],
        manifestSha256: '7c70312de4d60f614c5a4849716ecc0a7f8b4342b203a03a95cd93d2cc9a5a07'
      },
      legacy: {
        id: 'foo',
        type: 'skill',
        entries: [
          ['skills/foo/SKILL.md', FILE],
          ['skills/foo/references/x.md', FILE],
          ['skills/foo/scripts/run.sh', EXEC]
        ],
        manifestSha256: '324f3acc380fe37bfb0718175cb6e7c0d55242d6257635163bbc22872c9f8527'
      }
    },
    skills: {
      governed: {
        id: 'foo',
        kind: 'skill',
        entries: [
          ['skills/foo/SKILL.md', FILE],
          ['skills/foo/references/x.md', FILE],
          ['skills/foo/scripts/run.sh', EXEC]
        ],
        manifestSha256: '2cd03b8f714879e3235a48d05b8061830622384c031e14b0ca0bef1f5956dc72'
      },
      legacy: {
        id: 'SKILL',
        type: 'skills',
        entries: [
          ['skills/foo/SKILL.md', FILE],
          ['skills/foo/references/x.md', FILE],
          ['skills/foo/scripts/run.sh', EXEC]
        ],
        manifestSha256: '23d495463bf7a074d1d1cb892a9e67ec4ae55e4c1d7149fbc3ab043814ef465b'
      }
    },
    Skill: {
      governed: {
        id: 'foo',
        kind: 'skill',
        entries: [
          ['skills/foo/SKILL.md', FILE],
          ['skills/foo/references/x.md', FILE],
          ['skills/foo/scripts/run.sh', EXEC]
        ],
        manifestSha256: 'e9aa8243d80470ac7b3f3c29e355916cb4a2f5f9c8fb6b3f6716a71ecdc0ad3b'
      },
      legacy: {
        id: 'foo',
        type: 'skill',
        entries: [
          ['skills/foo/SKILL.md', FILE],
          ['skills/foo/references/x.md', FILE],
          ['skills/foo/scripts/run.sh', EXEC]
        ],
        manifestSha256: '324f3acc380fe37bfb0718175cb6e7c0d55242d6257635163bbc22872c9f8527'
      }
    },
    plugin: {
      governed: {
        id: 'foo',
        kind: 'plugin',
        entries: [
          ['plugins/foo/mcp.json', FILE],
          ['plugins/foo/plugin.json', FILE],
          ['plugins/foo/skills/s/SKILL.md', FILE]
        ],
        manifestSha256: '70ceb68a78122f5d2df4e23d0d987f70cf7c7d84b490d46e04276322850426f6'
      },
      legacy: {
        id: 'foo',
        type: 'plugin',
        entries: [
          ['plugins/foo/mcp.json', FILE],
          ['plugins/foo/plugin.json', FILE],
          ['plugins/foo/skills/s/SKILL.md', FILE]
        ],
        manifestSha256: 'ba13ee8124e6d4e59bdd42d27a047ccfcfb322d9931ee12134edd5d5311282ec'
      }
    },
    hook: {
      governed: {
        id: 'x',
        kind: 'hook',
        entries: [
          ['hooks/x.json', FILE]
        ],
        manifestSha256: 'ae9fd9d14da52cee67f7e613d05f83ab0d3b3aee170bf42ede4b5756153047e9'
      },
      legacy: {
        id: 'x',
        type: 'hook',
        entries: [
          ['hooks/x.json', FILE]
        ],
        manifestSha256: '3d17bb5db1ab3f3edee6cb043c8bbe95533cb4b4b3fe5aef40497990ea145b77'
      }
    },
    'mcp-server': {
      governed: {
        id: 'x.mcp',
        kind: 'mcp-server',
        entries: [
          ['mcp-servers/x.mcp.json', FILE]
        ],
        manifestSha256: 'e1214d6dc9f601ecac7df293b8e15d7d4b49f05fd758162d94edbfce13bb0d73'
      },
      legacy: {
        id: 'x.mcp',
        type: 'mcp-server',
        entries: [
          ['mcp-servers/x.mcp.json', FILE]
        ],
        manifestSha256: 'bb7611591fa7b9f6155926beee13b4e3210561752f6ffaaea11f9356fb219f42'
      }
    },
    steering: {
      governed: {
        id: 'x',
        kind: 'steering',
        entries: [
          ['.kiro/steering/x.md', FILE]
        ],
        manifestSha256: 'c8734f0d07440bea77c99ba2fdc2ade4ce3c8ed57301c0b4122b2533790397ca'
      },
      legacy: {
        id: 'x',
        type: 'steering',
        entries: [
          ['.kiro/steering/x.md', FILE]
        ],
        manifestSha256: 'f7ec1ca1ef63412b87ebcbf32ca82f8b9a7baf916312e04a052e1677c8086b8e'
      }
    },
    spec: {
      governed: {
        id: 'requirements',
        kind: 'spec',
        entries: [
          ['.kiro/specs/feature/requirements.md', FILE]
        ],
        manifestSha256: 'd6d534df10527d345b16c5c0d3caf65d8e81e2ae4d4d338fe83b88c1ef4195e7'
      },
      legacy: {
        id: 'requirements',
        type: 'spec',
        entries: [
          ['.kiro/specs/feature/requirements.md', FILE]
        ],
        manifestSha256: '18642f379a5c7f4b6eb150da4018cc25834de9d608d43d20d94e21d4c25f7e2b'
      }
    },
    command: {
      governed: {
        id: 'x',
        kind: 'command',
        entries: [
          ['commands/x.md', FILE]
        ],
        manifestSha256: '54f783860f5a9fb3b0cc89d9ae3d0bd231cd106c7f20a158a588b7f8bc13852b'
      },
      legacy: {
        id: 'x',
        type: 'command',
        entries: [
          ['commands/x.md', FILE]
        ],
        manifestSha256: '747e8f2bd2c234b82ad9589e5a7420893e5b0a0d593eb73755b152ed1b7249c9'
      }
    },
    rule: {
      governed: {
        id: 'x',
        kind: 'rule',
        entries: [
          ['rules/x.md', FILE]
        ],
        manifestSha256: '9c0f48ec3a1febc6bb140973469506919d26d81689505d4ef9401d7482b8b588'
      },
      legacy: {
        id: 'x',
        type: 'rule',
        entries: [
          ['rules/x.md', FILE]
        ],
        manifestSha256: 'e3797885748b5cfb24d3f1e963d4f1f487273ffeba75662f5b27b717d36e4bdb'
      }
    },
    'output-style': {
      governed: {
        id: 'x',
        kind: 'output-style',
        entries: [
          ['output-styles/x.md', FILE]
        ],
        manifestSha256: 'abc67c23c9d313e40cf94b3481e4e961612c9ec430c5194f8dbd4c3638d50bdc'
      },
      legacy: {
        id: 'x',
        type: 'output-style',
        entries: [
          ['output-styles/x.md', FILE]
        ],
        manifestSha256: '4708e28ac120539ffa8878e8ff1532293769f72f90879eb60fe5580ffa733993'
      }
    },
    tool: {
      governed: {
        id: 'x',
        kind: 'tool',
        entries: [
          ['tools/x.md', FILE]
        ],
        manifestSha256: '0f450d2421750454cdd56985260ea039f937030571dbd5482788f31d7a673300'
      },
      legacy: {
        id: 'x',
        type: 'tool',
        entries: [
          ['tools/x.md', FILE]
        ],
        manifestSha256: 'cee5ca9e350d3a896667f8a17b31e8cd9ef382b988aa41ef00664ffa910ad2f3'
      }
    },
    power: {
      governed: {
        id: 'POWER',
        kind: 'power',
        entries: [
          ['powers/stripe/POWER.md', FILE]
        ],
        manifestSha256: '96a0fa84b53aa23b18e99bc1b8dc981ae393382ed5b2372cb30d8de8dd4e83bf'
      },
      legacy: {
        id: 'POWER',
        type: 'power',
        entries: [
          ['powers/stripe/POWER.md', FILE]
        ],
        manifestSha256: '889a64cfd806c5c6c37e3074a43a662848916f74fabf112e1d3f0449d7eca644'
      }
    },
    knowledge: {
      governed: {
        id: 'x',
        kind: 'knowledge',
        entries: [
          ['knowledge/x.md', FILE]
        ],
        manifestSha256: '6fc9a79699a78994baa2c3cba2bbcad2e8e0acbca2038e6f1513e3a1cdf366c8'
      },
      legacy: {
        id: 'x',
        type: 'knowledge',
        entries: [
          ['knowledge/x.md', FILE]
        ],
        manifestSha256: 'b936a201e6bc9c50f4c51f2a62d97e7534aa3da88b99ef0e62751a5ce1560fe2'
      }
    },
    playbook: {
      governed: {
        id: 'x',
        kind: 'playbook',
        entries: [
          ['playbooks/x.md', FILE]
        ],
        manifestSha256: 'effcac561296a5c82f7c764144f06c19b7049deabc5437fe18e74746a137e297'
      },
      legacy: {
        id: 'x',
        type: 'playbook',
        entries: [
          ['playbooks/x.md', FILE]
        ],
        manifestSha256: '10beed8aecf148d0fb224f20ecb026ad628cb964abab393b09e648e9e25910e3'
      }
    }
  };

  const sourcesForKind = (declaredKind: string): ReleaseSourceReader => {
    const fixture = FIXTURES[ALIASES[declaredKind] ?? declaredKind];
    const files = new Map<string, string>([
      ['LICENSE', 'License\n'],
      [fixture.path, fixture.path.endsWith('.json') ? '{"name":"N","description":"D"}\n' : '# Title\n'],
      ...Object.entries(fixture.extra ?? {}),
      [COLLECTION_FILE, `id: c\nname: C\nitems:\n  - path: ${fixture.path}\n    kind: ${declaredKind}\n`]
    ]);
    return sourcesFrom(files, new Set(fixture.executable));
  };

  const digest = (manifest: Record<string, unknown>): string =>
    createHash('sha256').update(serializeReleaseManifest(manifest)).digest('hex');

  it('covers every primitive kind', () => {
    expect(Object.keys(FIXTURES).toSorted()).toEqual([...PRIMITIVE_KINDS].toSorted());
  });

  it.each(Object.keys(EXPECTED))('governed plan for kind "%s"', async (declaredKind) => {
    const plan = await createReleaseManifestPlan({
      repoRoot: '/repo',
      collectionFile: COLLECTION_FILE,
      version: '1.0.0',
      revision: REVISION,
      packageMetadata: { license: 'MIT' }
    }, sourcesForKind(declaredKind));
    const item = (plan.manifest.items as Record<string, unknown>[])[0];
    const entries = plan.entries
      .filter((entry) => entry.role === 'installable')
      .map((entry): [string, number] => [entry.path, entry.mode]);
    expect({ id: item.id, kind: item.kind, entries, manifestSha256: digest(plan.manifest) })
      .toEqual(EXPECTED[declaredKind].governed);
  });

  it.each(Object.keys(EXPECTED))('legacy plan for kind "%s"', async (declaredKind) => {
    const plan = await createLegacyReleaseManifestPlan({
      repoRoot: '/repo',
      collectionFile: COLLECTION_FILE,
      version: '1.0.0'
    }, sourcesForKind(declaredKind));
    const item = (plan.manifest.prompts as Record<string, unknown>[])[0];
    const entries = plan.entries.map((entry): [string, number] => [entry.path, entry.mode]);
    expect({ id: item.id, type: item.type, entries, manifestSha256: digest(plan.manifest) })
      .toEqual(EXPECTED[declaredKind].legacy);
  });
});
