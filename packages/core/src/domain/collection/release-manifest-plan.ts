/**
 * Release manifest planning for `bundle build`.
 *
 * Plans the deployment manifest and the exact archive entries of one
 * source collection: the governed (`formatVersion: 1`) release read from an
 * immutable Git revision, and the pre-`formatVersion` legacy compatibility
 * release read from the working tree.
 *
 * This is the packages-side reference implementation, ported from the
 * legacy `lib/` package module `lib/src/release-manifest.ts` (and
 * `lib/src/bundle-id.ts`, superseded by `domain/bundle/id.ts`). `lib/` is legacy and intentionally left
 * unchanged, so the two copies may coexist; behavior here (error messages,
 * manifest key order, YAML format) is kept byte-identical to that source.
 *
 * Pure domain logic over the injected {@link ReleaseSourceReader} port: no
 * `node:fs`, no `node:child_process`.
 * @module domain/collection/release-manifest-plan
 */
import {
  createHash,
} from 'node:crypto';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type {
  ReleaseSourceReader,
  ReleaseSourceTree,
} from '../../ports/release-source';
import {
  normalizePrimitiveKind,
} from '../primitive/types';
import type {
  Collection,
  CollectionItem,
  ReleaseManifestFileRole,
} from './types';
import {
  normalizeRepoRelativePath,
} from './validate';

/** Error message used when governed release evidence is incomplete. */
export const NO_SOURCE_LICENSE_MESSAGE = 'No source license or notice file was found for the governed release';

/** Warning shown when a legacy compatibility archive is produced. */
export const LEGACY_RELEASE_WARNING = 'No committed LICENSE, COPYING, or NOTICE file was found; '
  + 'building a legacy bundle without governed release evidence. '
  + 'Add license text to enable governed self-contained releases.';

/** Exact data written to one archive entry. */
export interface ReleaseArchiveEntry {
  path: string;
  role: ReleaseManifestFileRole;
  bytes: Uint8Array;
}

/** A planned manifest paired with the exact files it inventories. */
export interface ReleaseManifestPlan {
  manifest: Record<string, unknown>;
  entries: ReleaseArchiveEntry[];
  collectionPath: string;
  readmeSourcePath?: string;
}

/** Inputs resolved by a command before planning a release. */
export interface CreateReleaseManifestPlanOptions {
  /** Absolute repository root. */
  repoRoot: string;
  /** Collection file, repo-relative or absolute under `repoRoot`. */
  collectionFile: string;
  version: string;
  /** Explicit source repository URL; defaults to package metadata, then `origin`. */
  source?: string;
  /** Revision to plan from (default `HEAD`). */
  revision?: string;
  /** Explicit package metadata; defaults to the source tree's `package.json`. */
  packageMetadata?: Record<string, unknown>;
}

interface PackageMetadata {
  name?: string;
  description?: string;
  author?: string;
  keywords?: string[];
  license?: string;
  repository?: string | { url?: string };
}

interface CollectionWithMcp extends Collection {
  mcpServers?: Record<string, unknown>;
  mcp?: { items?: Record<string, unknown>; inputs?: unknown[] };
}

interface LegacyCollection extends CollectionWithMcp {
  license?: string;
}

/**
 * Plan the canonical manifest and all non-manifest ZIP entries for one source
 * collection. The returned inventory is based on exact bytes, so callers must
 * write these bytes unchanged into the final archive.
 * @param options - Planning inputs.
 * @param sources - Source reader for the revisioned tree and `origin` remote.
 * @returns The governed release plan. Rejects with {@link NO_SOURCE_LICENSE_MESSAGE}
 * when the revision has no root license/copying/notice file.
 */
export async function createReleaseManifestPlan(
  options: CreateReleaseManifestPlanOptions,
  sources: ReleaseSourceReader
): Promise<ReleaseManifestPlan> {
  const collectionPath = resolveRepoRelativePath(options.repoRoot, options.collectionFile);
  const sourceTree = await sources.openRevision(options.repoRoot, options.revision);
  const collection = yaml.load(decodeUtf8(await sourceTree.readFile(collectionPath))) as CollectionWithMcp;
  if (!collection || typeof collection !== 'object') {
    throw new Error(`Invalid collection YAML: ${collectionPath}`);
  }
  if (typeof collection.id !== 'string' || collection.id.length === 0) {
    throw new Error(`Collection id is required: ${collectionPath}`);
  }
  if (typeof collection.name !== 'string' || collection.name.length === 0) {
    throw new Error(`Collection name is required: ${collectionPath}`);
  }

  const packageMetadata = (options.packageMetadata ?? await readPackageMetadata(sourceTree)) as PackageMetadata;
  const source = await resolveSourceRepository(
    sources,
    options.repoRoot,
    options.source ?? repositoryUrl(packageMetadata.repository)
  );
  const revision = sourceTree.revision;
  const license = collectionLicense(collection, packageMetadata);
  const items = Array.isArray(collection.items) ? collection.items : [];
  const itemEntries = await collectItemEntries(sourceTree, items);
  const canonicalItems: Record<string, unknown>[] = [];
  for (const item of items) {
    canonicalItems.push(await createCanonicalItem(sourceTree, item));
  }
  const legacyItems = canonicalItems.map((item) => createLegacyItem(item));

  const sourceSnapshotPath = `metadata/source/${collectionPath}`;
  const entries: ReleaseArchiveEntry[] = [
    ...itemEntries,
    {
      path: sourceSnapshotPath,
      role: 'metadata',
      bytes: await sourceTree.readFile(collectionPath)
    }
  ];

  const readmeSourcePath = resolveCollectionReadmePath(collection);
  let readmePath: string | undefined;
  if (readmeSourcePath !== null) {
    readmePath = 'README.md';
    entries.push({ path: readmePath, role: 'metadata', bytes: await sourceTree.readFile(readmeSourcePath) });
  }

  const licenseSourcePath = await findLicensePath(sourceTree);
  if (licenseSourcePath === null) {
    throw new Error(NO_SOURCE_LICENSE_MESSAGE);
  }
  const licensePath = 'LICENSE';
  entries.push({
    path: licensePath,
    role: 'metadata',
    bytes: await sourceTree.readFile(licenseSourcePath)
  });

  assertUniqueArchivePaths(entries);
  assertUniqueCanonicalItems(canonicalItems);

  const mcpServers = collection.mcpServers ?? collection.mcp?.items;
  const mcpInputs = collection.mcp?.inputs;
  const manifest = {
    formatVersion: 1,
    id: collection.id,
    version: options.version,
    name: collection.name || packageMetadata.description || '',
    description: collection.description || packageMetadata.description || '',
    author: collection.author || packageMetadata.author || 'Prompt Registry',
    tags: collection.tags || packageMetadata.keywords || [],
    environments: ['vscode', 'windsurf', 'cursor'],
    ...(readmePath === undefined ? {} : { readme: readmePath }),
    license,
    repository: source,
    items: canonicalItems,
    files: sortByPath(entries.map((entry) => ({
      path: entry.path,
      role: entry.role,
      size: entry.bytes.byteLength,
      sha256: sha256(entry.bytes)
    }))),
    provenance: {
      source,
      revision,
      collectionPath,
      sourceSnapshotPath,
      license,
      licensePath
    },
    prompts: legacyItems,
    dependencies: [],
    ...(mcpServers && Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(mcpInputs && mcpInputs.length > 0 ? { mcpInputs } : {})
  };

  return {
    manifest,
    entries: sortByPath(entries),
    collectionPath,
    ...(readmeSourcePath === null ? {} : { readmeSourcePath })
  };
}

/**
 * Plan the pre-formatVersion archive used for legacy compatibility builds.
 *
 * This deliberately reads the working tree and emits the historical manifest
 * shape. It must only be used after governed planning reports missing license
 * evidence (see {@link isMissingSourceLicenseError}); it is not a relaxed
 * governed-release planner.
 * @param options - Planning inputs (`source` and `revision` are ignored).
 * @param sources - Source reader providing the working tree.
 * @returns The legacy release plan.
 */
export async function createLegacyReleaseManifestPlan(
  options: CreateReleaseManifestPlanOptions,
  sources: ReleaseSourceReader
): Promise<ReleaseManifestPlan> {
  const workingTree = sources.openWorkingTree(options.repoRoot);
  const collectionPath = resolveRepoRelativePath(options.repoRoot, options.collectionFile);
  const collectionBytes = await workingTree.readFile(collectionPath);
  const collection = yaml.load(decodeUtf8(collectionBytes)) as LegacyCollection;
  if (!collection || typeof collection !== 'object') {
    throw new Error(`Invalid collection YAML: ${collectionPath}`);
  }
  if (typeof collection.id !== 'string' || collection.id.length === 0) {
    throw new Error(`Collection id is required: ${collectionPath}`);
  }
  if (typeof collection.name !== 'string' || collection.name.length === 0) {
    throw new Error(`Collection name is required: ${collectionPath}`);
  }

  const packageMetadata = (options.packageMetadata ?? await readPackageMetadata(workingTree)) as PackageMetadata;
  const items = Array.isArray(collection.items) ? collection.items : [];
  const prompts: Record<string, unknown>[] = [];
  const entriesByPath = new Map<string, ReleaseArchiveEntry>();

  for (const item of items) {
    const itemPath = normalizeRepoRelativePath(item.path);
    const itemBytes = await workingTree.readFile(itemPath);
    prompts.push(createLegacyManifestItem(item, itemPath, decodeUtf8(itemBytes)));

    for (const entryPath of await resolveLegacyItemPaths(workingTree, itemPath, item.kind)) {
      if (!entriesByPath.has(entryPath)) {
        entriesByPath.set(entryPath, {
          path: entryPath,
          role: 'installable',
          bytes: await workingTree.readFile(entryPath)
        });
      }
    }
  }

  const entries = sortByPath([...entriesByPath.values()]);
  assertUniqueArchivePaths(entries);

  const readmeSourcePath = resolveCollectionReadmePath(collection);
  const mcpServers = collection.mcpServers ?? collection.mcp?.items;
  const mcpInputs = collection.mcp?.inputs;
  const repository = normalizeRepositoryUrl(repositoryUrl(packageMetadata.repository));
  const manifest = {
    id: collection.id,
    version: options.version,
    name: collection.name || packageMetadata.description || '',
    description: collection.description || packageMetadata.description || '',
    author: collection.author || packageMetadata.author || 'Prompt Registry',
    tags: collection.tags || packageMetadata.keywords || [],
    environments: ['vscode', 'windsurf', 'cursor'],
    license: collection.license || packageMetadata.license || 'MIT',
    repository,
    prompts,
    dependencies: [],
    ...(readmeSourcePath === null ? {} : { readme: path.basename(readmeSourcePath) }),
    ...(mcpServers && Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(mcpInputs && mcpInputs.length > 0 ? { mcpInputs } : {})
  };

  return {
    manifest,
    entries,
    collectionPath,
    ...(readmeSourcePath === null ? {} : { readmeSourcePath })
  };
}

/**
 * Identify the one governed-planning failure that permits legacy fallback.
 * All other planning failures remain blocking.
 * @param error - Rejection reason from {@link createReleaseManifestPlan}.
 * @returns `true` only for the missing source license error.
 */
export const isMissingSourceLicenseError = (error: unknown): boolean =>
  error instanceof Error && error.message === NO_SOURCE_LICENSE_MESSAGE;

/**
 * Serialize a planned manifest with the repository's stable YAML settings.
 * @param manifest - Planned manifest.
 * @returns YAML text without line wrapping.
 */
export function serializeReleaseManifest(manifest: Record<string, unknown>): string {
  return yaml.dump(manifest, { lineWidth: -1 });
}

/**
 * Require a full immutable Git object id rather than a mutable ref.
 * @param revision - Candidate revision.
 * @returns The lowercased revision.
 */
export function assertImmutableRevision(revision: string): string {
  if (!/^[a-f0-9]{40,64}$/i.test(revision)) {
    throw new Error(`Source revision must be a full immutable Git object ID, got "${revision}"`);
  }
  return revision.toLowerCase();
}

/**
 * Decode UTF-8 like Node's `Buffer#toString('utf8')`: a leading BOM is kept
 * (`ignoreBOM: true`; the default `TextDecoder` strips it, which would change
 * heading matches) and invalid sequences become U+FFFD.
 *
 * Read-only use: the decoded string only feeds YAML/JSON parsing and item
 * metadata extraction. Archive entries always carry the original bytes from
 * `ReleaseSourceTree.readFile`, so binary files are never round-tripped
 * through this decoder.
 * @param bytes - Raw bytes.
 */
const utf8Decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const decodeUtf8 = (bytes: Uint8Array): string => utf8Decoder.decode(bytes);

const resolveSourceRepository = async (
  sources: ReleaseSourceReader,
  repoRoot: string,
  preferredSource?: string
): Promise<string> => {
  const candidate = preferredSource || await sources.readRemoteUrl(repoRoot);
  const source = normalizeRepositoryUrl(candidate);
  if (!source) {
    throw new Error('Unable to resolve a source repository URL from package metadata or git remote origin');
  }
  return source;
};

const collectItemEntries = async (
  sourceTree: ReleaseSourceTree,
  items: CollectionItem[]
): Promise<ReleaseArchiveEntry[]> => {
  const entries = new Map<string, ReleaseArchiveEntry>();
  for (const item of items) {
    const itemPath = normalizeRepoRelativePath(item.path);
    const paths = item.kind === 'skill' || item.kind === 'plugin'
      ? await listInstallableSkillFiles(sourceTree, path.posix.dirname(itemPath))
      : [itemPath];
    for (const entryPath of paths) {
      if (!entries.has(entryPath)) {
        entries.set(entryPath, {
          path: entryPath,
          role: 'installable',
          bytes: await sourceTree.readFile(entryPath)
        });
      }
    }
  }
  return [...entries.values()];
};

const listInstallableSkillFiles = async (sourceTree: ReleaseSourceTree, directory: string): Promise<string[]> =>
  (await sourceTree.listFiles(directory)).filter((entry) => !isIgnoredPath(entry)).toSorted(comparePaths);

const isIgnoredPath = (entry: string): boolean => {
  const segments = entry.split('/');
  const fileName = segments.at(-1) ?? '';
  return segments.includes('__pycache__')
    || segments.includes('.git')
    || segments.includes('node_modules')
    || fileName === '.DS_Store'
    || fileName.endsWith('.pyc')
    || fileName.endsWith('.pyo');
};

const itemTags = (item: CollectionItem): string[] | undefined =>
  Array.isArray(item.tags) && item.tags.length > 0 ? [...item.tags] : undefined;

const createCanonicalItem = async (
  sourceTree: ReleaseSourceTree,
  item: CollectionItem
): Promise<Record<string, unknown>> => {
  const itemPath = normalizeRepoRelativePath(item.path);
  const kind = normalizeKind(item.kind);
  const content = decodeUtf8(await sourceTree.readFile(itemPath));
  const metadata = extractItemMetadata(content, itemPath);
  const id = generateItemId(itemPath, kind);
  const tags = itemTags(item);
  return {
    id,
    path: itemPath,
    kind,
    name: metadata.name || id,
    description: metadata.description,
    ...(tags === undefined ? {} : { tags })
  };
};

const createLegacyItem = (canonical: Record<string, unknown>): Record<string, unknown> => {
  return {
    id: canonical.id,
    name: canonical.name,
    description: canonical.description,
    file: canonical.path,
    type: legacyType(String(canonical.kind)),
    ...(canonical.tags === undefined ? {} : { tags: canonical.tags })
  };
};

const extractItemMetadata = (content: string, itemPath: string): { name: string; description: string } => {
  if (itemPath.endsWith('.json')) {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      return {
        name: typeof parsed.name === 'string' ? parsed.name : '',
        description: typeof parsed.description === 'string' ? parsed.description : ''
      };
    } catch {
      return { name: '', description: '' };
    }
  }
  const nameMatch = /^#\s+(.+)$/m.exec(content);
  const descriptionMatch = /^##?\s*Description[:\s]+(.+)$/im.exec(content)
    ?? /^>\s*(.+)$/m.exec(content);
  return {
    name: nameMatch?.[1] ?? '',
    description: descriptionMatch?.[1] ?? ''
  };
};

/**
 * Canonicalize an item kind via the shared primitive alias table.
 * `value.trim()` runs first so a non-string kind fails exactly as before.
 * @param value - Declared item kind.
 */
const normalizeKind = (value: string): string => {
  const kind = normalizePrimitiveKind(value.trim());
  if (kind === null) {
    throw new Error(`Collection item kind is not a canonical primitive kind: ${value}`);
  }
  return kind;
};

const legacyType = (kind: string): string => ({
  instruction: 'instructions',
  'chat-mode': 'chatmode'
})[kind] ?? kind;

const generateItemId = (itemPath: string, kind: string): string => {
  const extension = path.extname(itemPath);
  if (kind === 'skill' || kind === 'plugin') {
    const parts = itemPath.split('/');
    return parts.length >= 2 ? (parts.at(-2) ?? path.basename(itemPath, extension)) : path.basename(itemPath, extension);
  }
  return path.basename(itemPath, extension);
};

const resolveCollectionReadmePath = (collection: Collection): string | null =>
  collection.readme?.path ? normalizeRepoRelativePath(collection.readme.path) : null;

const resolveRepoRelativePath = (repoRoot: string, candidate: string): string => {
  const relative = path.isAbsolute(candidate) ? path.relative(repoRoot, candidate) : candidate;
  return normalizeRepoRelativePath(relative);
};

const readPackageMetadata = async (tree: ReleaseSourceTree): Promise<Record<string, unknown>> => {
  try {
    return JSON.parse(decodeUtf8(await tree.readFile('package.json'))) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/**
 * Installable working-tree paths of one legacy item. Skills and plugins ship
 * their whole directory. The item file itself was already read from that
 * directory, so the directory exists; the listing is used as-is (an empty
 * listing means it holds no regular files).
 * @param workingTree - Working tree of the repository.
 * @param itemPath - Normalized item path.
 * @param kind - Declared item kind.
 */
const resolveLegacyItemPaths = async (
  workingTree: ReleaseSourceTree,
  itemPath: string,
  kind: string
): Promise<string[]> => {
  if (kind !== 'skill' && kind !== 'plugin') {
    return [itemPath];
  }
  return (await workingTree.listFiles(path.posix.dirname(itemPath)))
    .filter((entry) => !isIgnoredPath(entry))
    .toSorted(comparePaths);
};

const createLegacyManifestItem = (
  item: CollectionItem,
  itemPath: string,
  content: string
): Record<string, unknown> => {
  const metadata = extractItemMetadata(content, itemPath);
  const kind = item.kind.trim().toLowerCase();
  const id = generateItemId(itemPath, kind);
  const tags = itemTags(item);
  return {
    id,
    name: metadata.name || id,
    description: metadata.description,
    file: itemPath,
    type: legacyType(kind),
    ...(tags === undefined ? {} : { tags })
  };
};

const repositoryUrl = (repository: PackageMetadata['repository']): string =>
  typeof repository === 'string' ? repository : repository?.url ?? '';

const normalizeRepositoryUrl = (value: string): string =>
  value.replace(/^git\+/, '').replace(/\.git$/, '');

const collectionLicense = (_collection: Collection, packageMetadata: PackageMetadata): string =>
  packageMetadata.license || 'SEE LICENSE IN LICENSE';

const findLicensePath = async (sourceTree: ReleaseSourceTree): Promise<string | null> => {
  const candidate = (await sourceTree.listFiles('.'))
    .filter((entry) => !entry.includes('/'))
    .find((name) => /^(license|copying|notice)(\.[^.]*)?$/i.test(name));
  return candidate ?? null;
};

const sha256 = (content: Uint8Array): string =>
  `sha256:${createHash('sha256').update(content).digest('hex')}`;

const sortByPath = <T extends { path: string }>(values: readonly T[]): T[] =>
  values.toSorted((left, right) => comparePaths(left.path, right.path));

const comparePaths = (left: string, right: string): number =>
  left < right ? -1 : (left > right ? 1 : 0);

const assertUniqueArchivePaths = (entries: ReleaseArchiveEntry[]): void => {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) {
      throw new Error(`Release archive contains duplicate path: ${entry.path}`);
    }
    seen.add(entry.path);
  }
};

const assertUniqueCanonicalItems = (items: Record<string, unknown>[]): void => {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const item of items) {
    const id = String(item.id);
    const itemPath = String(item.path);
    if (ids.has(id)) {
      throw new Error(`Release manifest contains duplicate item id: ${id}`);
    }
    if (paths.has(itemPath)) {
      throw new Error(`Release manifest contains duplicate item path: ${itemPath}`);
    }
    ids.add(id);
    paths.add(itemPath);
  }
};
