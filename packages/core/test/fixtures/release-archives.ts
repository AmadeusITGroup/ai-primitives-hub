import {
  createHash,
} from 'node:crypto';
import {
  dump as dumpYaml,
} from 'js-yaml';
import type {
  DiagnosticBundle,
  FixtureFile,
} from '../../src/domain/diagnostics/primitives';
import type {
  ExtractedFiles,
} from '../../src/ports/bundle-extractor';

export interface ReleaseArchiveFixtureOptions {
  id?: string;
  version?: string;
}

const bytes = (content: string): Uint8Array => new TextEncoder().encode(content);

const sha256 = (content: string): string =>
  `sha256:${createHash('sha256').update(bytes(content)).digest('hex')}`;

/**
 * Minimal historical archive shape: no formatVersion and no governed
 * inventory. Its archive entries represent the historical installable
 * content emitted by the legacy builder.
 * @param options
 */
export const createLegacyReleaseArchive = (
  options: ReleaseArchiveFixtureOptions = {}
): ExtractedFiles => {
  const id = options.id ?? 'legacy-bundle';
  const version = options.version ?? '1.0.0';
  const archiveFiles = { 'prompts/hello.prompt.md': '# Hello Prompt\n' };
  const manifest = `id: ${id}\nversion: ${version}\nname: Legacy Bundle\nprompts:\n  - id: hello\n    file: prompts/hello.prompt.md\n    type: prompt\n`;

  return new Map([
    ['deployment-manifest.yml', bytes(manifest)],
    ...Object.entries(archiveFiles).map(([filePath, content]) => [filePath, bytes(content)] as const)
  ]);
};

/**
 * Fully governed archive shape: canonical items, complete file inventory,
 * immutable provenance, embedded source/license evidence, and explicit
 * metadata-only and ignored classifications.
 * @param options
 */
export const createGovernedReleaseArchive = (
  options: ReleaseArchiveFixtureOptions = {}
): Map<string, Uint8Array> => {
  const id = options.id ?? 'governed-bundle';
  const version = options.version ?? '1.0.0';
  const sourceSnapshotPath = 'metadata/source/collections/governed.collection.yml';
  const archiveFiles = {
    'prompts/hello.prompt.md': '# Hello Prompt\n',
    [sourceSnapshotPath]: `id: ${id}\n`,
    'README.md': '# Governed bundle\n',
    LICENSE: 'Governed license text\n',
    'ignored/build/cache.pyc': 'cache bytes\n'
  };
  const files = Object.entries(archiveFiles).map(([filePath, content]) => ({
    path: filePath,
    role: filePath.startsWith('prompts/')
      ? 'installable'
      : (filePath.startsWith('ignored/') ? 'ignored' : 'metadata'),
    size: bytes(content).byteLength,
    sha256: sha256(content)
  }));
  const manifest = {
    formatVersion: 1,
    id,
    version,
    name: 'Governed Bundle',
    readme: 'README.md',
    items: [{ id: 'hello', path: 'prompts/hello.prompt.md', kind: 'prompt' }],
    prompts: [{ id: 'hello', file: 'prompts/hello.prompt.md', type: 'prompt' }],
    provenance: {
      source: 'https://github.com/example/governed-bundle',
      revision: '0123456789abcdef0123456789abcdef01234567',
      collectionPath: 'collections/governed.collection.yml',
      sourceSnapshotPath,
      license: 'Governed-License',
      licensePath: 'LICENSE'
    },
    files
  };

  return new Map([
    ['deployment-manifest.yml', bytes(dumpYaml(manifest, { lineWidth: -1 }))],
    ...Object.entries(archiveFiles).map(([filePath, content]) => [filePath, bytes(content)] as const)
  ]);
};

export interface PrimitiveReleaseArchiveOptions {
  revision?: string;
  /** Item source files left out of both the archive and the inventory (a build drop, e.g. the power-directory-unit gap). */
  omitFiles?: readonly string[];
  /** Manifest id per item path; defaults to the item's expectedId. */
  itemIds?: Readonly<Record<string, string>>;
}

/**
 * Governed archive of a primitive diagnostics bundle, built in memory from
 * the core fixture like `bundle build` would: the item files (role
 * installable), LICENSE, README.md and the collection snapshot under
 * metadata/source/ (role metadata), and a formatVersion 1 manifest with a
 * complete, digest-checked file inventory.
 * @param bundle - Catalogue bundle.
 * @param fixture - Fixture repository (`buildPrimitiveFixture()`).
 * @param options - Variants for evaluator tests.
 */
export const createPrimitiveReleaseArchive = (
  bundle: DiagnosticBundle,
  fixture: ReadonlyMap<string, FixtureFile>,
  options: PrimitiveReleaseArchiveOptions = {}
): ExtractedFiles => {
  const omitted = new Set(options.omitFiles);
  const sourceSnapshotPath = `metadata/source/${bundle.collectionFile}`;
  const fixtureBytes = (filePath: string): Uint8Array => {
    const file = fixture.get(filePath);
    if (file === undefined) {
      throw new Error(`fixture has no ${filePath}`);
    }
    return file.bytes;
  };
  const entries: [string, Uint8Array, 'installable' | 'metadata'][] = [
    ...bundle.items
      .flatMap((item) => item.files)
      .filter((filePath) => !omitted.has(filePath))
      .map((filePath): [string, Uint8Array, 'installable'] => [filePath, fixtureBytes(filePath), 'installable']),
    ['LICENSE', fixtureBytes('LICENSE'), 'metadata'],
    ['README.md', fixtureBytes('README.md'), 'metadata'],
    [sourceSnapshotPath, fixtureBytes(bundle.collectionFile), 'metadata']
  ];
  const manifest = {
    formatVersion: 1,
    id: bundle.id,
    version: bundle.version,
    name: bundle.id,
    readme: 'README.md',
    items: bundle.items.map((item) => ({ id: options.itemIds?.[item.path] ?? item.expectedId, path: item.path, kind: item.kind })),
    provenance: {
      source: 'https://github.com/example/aph-e2e-fixture',
      revision: options.revision ?? '0123456789abcdef0123456789abcdef01234567',
      collectionPath: bundle.collectionFile,
      sourceSnapshotPath,
      license: 'SEE LICENSE IN LICENSE',
      licensePath: 'LICENSE'
    },
    files: entries.map(([filePath, content, role]) => ({
      path: filePath,
      role,
      size: content.byteLength,
      sha256: `sha256:${createHash('sha256').update(content).digest('hex')}`
    }))
  };

  return new Map([
    ['deployment-manifest.yml', bytes(dumpYaml(manifest, { lineWidth: -1 }))],
    ...entries.map(([filePath, content]) => [filePath, content] as const)
  ]);
};
