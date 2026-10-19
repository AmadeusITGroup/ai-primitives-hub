/**
 * Release manifest planning tests.
 *
 * Ported from the legacy `lib/test/release-manifest.test.ts` (reference
 * only, left unchanged) onto an in-memory `ReleaseSourceReader`, plus the
 * cases `bundle build` depends on (fallback classification, error text,
 * serialization).
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
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
