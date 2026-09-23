/**
 * Self-contained release manifest planning.
 *
 * This module deliberately has no dependency on the newer workspace packages:
 * `@prompt-registry/collection-scripts` remains a Node 18-compatible published
 * package and is used by both its own publisher and the migrated CLI.
 * @module release-manifest
 */
import {
  spawnSync,
} from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type {
  Collection,
  CollectionItem,
} from './types';
import {
  normalizeRepoRelativePath,
} from './validate';

/** Canonical primitive values accepted by governed release manifests. */
const PRIMITIVE_KINDS = new Set([
  'prompt', 'instruction', 'chat-mode', 'agent', 'skill', 'plugin', 'hook',
  'mcp-server', 'steering', 'spec', 'command', 'rule', 'output-style', 'tool',
  'power', 'knowledge', 'playbook'
]);

/** Error message used when governed release evidence is incomplete. */
export const NO_SOURCE_LICENSE_MESSAGE = 'No source license or notice file was found for the governed release';

/** Warning shown when a legacy compatibility archive is produced. */
export const LEGACY_RELEASE_WARNING = 'No committed LICENSE, COPYING, or NOTICE file was found; '
  + 'building a legacy bundle without governed release evidence. '
  + 'Add license text to enable governed self-contained releases.';

/** File roles understood by the governed release contract. */
export type ReleaseManifestFileRole = 'installable' | 'metadata' | 'ignored';

/** Exact data written to one archive entry. */
export interface ReleaseArchiveEntry {
  path: string;
  role: ReleaseManifestFileRole;
  bytes: Buffer;
}

/** A planned governed manifest paired with the exact files it inventories. */
export interface ReleaseManifestPlan {
  manifest: Record<string, unknown>;
  entries: ReleaseArchiveEntry[];
  collectionPath: string;
  readmeSourcePath?: string;
}

/** Inputs resolved by a command or publisher before planning a release. */
export interface CreateReleaseManifestPlanOptions {
  repoRoot: string;
  collectionFile: string;
  version: string;
  source?: string;
  revision?: string;
  packageMetadata?: Record<string, unknown>;
}

interface GitSourceTree {
  revision: string;
  readFile: (repositoryPath: string) => Buffer;
  listFiles: (repositoryDirectory: string) => string[];
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
 * @param options
 */
export function createReleaseManifestPlan(
  options: CreateReleaseManifestPlanOptions
): ReleaseManifestPlan {
  const collectionPath = resolveRepoRelativePath(options.repoRoot, options.collectionFile);
  const sourceTree = createGitSourceTree(options.repoRoot, options.revision);
  const collection = yaml.load(sourceTree.readFile(collectionPath).toString('utf8')) as CollectionWithMcp;
  if (!collection || typeof collection !== 'object') {
    throw new Error(`Invalid collection YAML: ${collectionPath}`);
  }
  if (typeof collection.id !== 'string' || collection.id.length === 0) {
    throw new Error(`Collection id is required: ${collectionPath}`);
  }
  if (typeof collection.name !== 'string' || collection.name.length === 0) {
    throw new Error(`Collection name is required: ${collectionPath}`);
  }

  const packageMetadata = (options.packageMetadata ?? readPackageMetadata(sourceTree)) as PackageMetadata;
  const source = resolveSourceRepository(options.repoRoot, options.source ?? repositoryUrl(packageMetadata.repository));
  const revision = sourceTree.revision;
  const license = collectionLicense(collection, packageMetadata);
  const items = Array.isArray(collection.items) ? collection.items : [];
  const itemEntries = collectItemEntries(sourceTree, items);
  const canonicalItems = items.map((item) => createCanonicalItem(sourceTree, item));
  const legacyItems = canonicalItems.map((item) => createLegacyItem(item));

  const sourceSnapshotPath = `metadata/source/${collectionPath}`;
  const entries: ReleaseArchiveEntry[] = [
    ...itemEntries,
    {
      path: sourceSnapshotPath,
      role: 'metadata',
      bytes: sourceTree.readFile(collectionPath)
    }
  ];

  const readmeSourcePath = resolveCollectionReadmePath(collection);
  let readmePath: string | undefined;
  if (readmeSourcePath !== null) {
    readmePath = 'README.md';
    entries.push({ path: readmePath, role: 'metadata', bytes: sourceTree.readFile(readmeSourcePath) });
  }

  const licenseSourcePath = findLicensePath(sourceTree);
  if (licenseSourcePath === null) {
    throw new Error(NO_SOURCE_LICENSE_MESSAGE);
  }
  const licensePath = 'LICENSE';
  entries.push({
    path: licensePath,
    role: 'metadata',
    bytes: sourceTree.readFile(licenseSourcePath)
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
 * evidence; it is not a relaxed governed-release planner.
 * @param options
 */
export function createLegacyReleaseManifestPlan(
  options: CreateReleaseManifestPlanOptions
): ReleaseManifestPlan {
  const collectionPath = resolveRepoRelativePath(options.repoRoot, options.collectionFile);
  const collectionBytes = readWorkingTreeFile(options.repoRoot, collectionPath);
  const collection = yaml.load(collectionBytes.toString('utf8')) as LegacyCollection;
  if (!collection || typeof collection !== 'object') {
    throw new Error(`Invalid collection YAML: ${collectionPath}`);
  }
  if (typeof collection.id !== 'string' || collection.id.length === 0) {
    throw new Error(`Collection id is required: ${collectionPath}`);
  }
  if (typeof collection.name !== 'string' || collection.name.length === 0) {
    throw new Error(`Collection name is required: ${collectionPath}`);
  }

  const packageMetadata = (options.packageMetadata ?? readWorkingTreePackageMetadata(options.repoRoot)) as PackageMetadata;
  const items = Array.isArray(collection.items) ? collection.items : [];
  const prompts: Record<string, unknown>[] = [];
  const entriesByPath = new Map<string, ReleaseArchiveEntry>();

  for (const item of items) {
    const itemPath = normalizeRepoRelativePath(item.path);
    const itemBytes = readWorkingTreeFile(options.repoRoot, itemPath);
    prompts.push(createLegacyManifestItem(item, itemPath, itemBytes.toString('utf8')));

    for (const entryPath of resolveLegacyItemPaths(options.repoRoot, itemPath, item.kind)) {
      if (!entriesByPath.has(entryPath)) {
        entriesByPath.set(entryPath, {
          path: entryPath,
          role: 'installable',
          bytes: readWorkingTreeFile(options.repoRoot, entryPath)
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
 * @param error
 */
export const isMissingSourceLicenseError = (error: unknown): boolean =>
  error instanceof Error && error.message === NO_SOURCE_LICENSE_MESSAGE;

/**
 * Serialize a planned manifest with the repository's stable YAML settings.
 * @param manifest
 */
export function serializeReleaseManifest(manifest: Record<string, unknown>): string {
  return yaml.dump(manifest, { lineWidth: -1 });
}

/**
 * Resolve an immutable source revision, requiring Git rather than a mutable ref.
 * @param repoRoot
 */
export function resolveGitRevision(repoRoot: string): string {
  return createGitSourceTree(repoRoot).revision;
}

/**
 * Resolve a stable source URL from explicit metadata or Git remote origin.
 * @param repoRoot
 * @param preferredSource
 */
export function resolveSourceRepository(repoRoot: string, preferredSource?: string): string {
  const candidate = preferredSource || readGitRemoteUrl(repoRoot);
  const source = normalizeRepositoryUrl(candidate);
  if (!source) {
    throw new Error('Unable to resolve a source repository URL from package metadata or git remote origin');
  }
  return source;
}

const createGitSourceTree = (repoRoot: string, requestedRevision?: string): GitSourceTree => {
  const revision = resolveGitCommit(repoRoot, requestedRevision ?? 'HEAD');
  return {
    revision,
    readFile: (repositoryPath) => readGitBlob(repoRoot, revision, repositoryPath),
    listFiles: (repositoryDirectory) => listGitTreeFiles(repoRoot, revision, repositoryDirectory)
  };
};

const resolveGitCommit = (repoRoot: string, revision: string): string => {
  const result = runGit(repoRoot, ['rev-parse', '--verify', `${revision}^{commit}`]);
  return assertImmutableRevision(result.trim());
};

const runGit = (repoRoot: string, args: string[]): string => {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'buffer' });
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8').trim() : '';
    throw new Error(`Git command failed: git ${args.join(' ')}${stderr ? `: ${stderr}` : ''}`);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : '';
};

const readGitBlob = (repoRoot: string, revision: string, repositoryPath: string): Buffer => {
  const normalizedPath = normalizeRepoRelativePath(repositoryPath);
  const result = spawnSync('git', ['show', `${revision}:${normalizedPath}`], {
    cwd: repoRoot,
    encoding: 'buffer'
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8').trim() : '';
    throw new Error(`Source file is not present at revision ${revision}: ${normalizedPath}${stderr ? ` (${stderr})` : ''}`);
  }
  return result.stdout;
};

const listGitTreeFiles = (repoRoot: string, revision: string, repositoryDirectory: string): string[] => {
  const normalizedDirectory = normalizeRepoRelativePath(repositoryDirectory);
  const output = normalizedDirectory === '.'
    ? runGit(repoRoot, ['ls-tree', '-r', '--name-only', revision])
    : runGit(repoRoot, ['ls-tree', '-r', '--name-only', revision, '--', normalizedDirectory]);
  return output
    .split('\n')
    .filter((entry): entry is string => entry.length > 0)
    .map((entry) => normalizeRepoRelativePath(entry))
    .filter((entry) => normalizedDirectory === '.' || entry === normalizedDirectory || entry.startsWith(`${normalizedDirectory}/`));
};

const collectItemEntries = (sourceTree: GitSourceTree, items: CollectionItem[]): ReleaseArchiveEntry[] => {
  const entries = new Map<string, ReleaseArchiveEntry>();
  for (const item of items) {
    const itemPath = normalizeRepoRelativePath(item.path);
    const paths = item.kind === 'skill' || item.kind === 'plugin'
      ? listInstallableSkillFiles(sourceTree, path.posix.dirname(itemPath))
      : [itemPath];
    for (const entryPath of paths) {
      if (!entries.has(entryPath)) {
        entries.set(entryPath, {
          path: entryPath,
          role: 'installable',
          bytes: sourceTree.readFile(entryPath)
        });
      }
    }
  }
  return [...entries.values()];
};

const listInstallableSkillFiles = (sourceTree: GitSourceTree, directory: string): string[] =>
  sortStrings(sourceTree.listFiles(directory).filter((entry) => !isIgnoredPath(entry)));

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

const createCanonicalItem = (
  sourceTree: GitSourceTree,
  item: CollectionItem
): Record<string, unknown> => {
  const itemPath = normalizeRepoRelativePath(item.path);
  const kind = normalizeKind(item.kind);
  const content = sourceTree.readFile(itemPath).toString('utf8');
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

const normalizeKind = (value: string): string => {
  const aliases: Record<string, string> = {
    prompts: 'prompt',
    instructions: 'instruction',
    chatmode: 'chat-mode',
    'chat-modes': 'chat-mode',
    agents: 'agent',
    skills: 'skill',
    plugins: 'plugin',
    hooks: 'hook',
    mcp: 'mcp-server',
    specs: 'spec',
    commands: 'command',
    rules: 'rule',
    'output-styles': 'output-style',
    tools: 'tool',
    powers: 'power',
    playbooks: 'playbook'
  };
  const kind = aliases[value.trim().toLowerCase()] ?? value.trim().toLowerCase();
  if (!PRIMITIVE_KINDS.has(kind)) {
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

const readPackageMetadata = (sourceTree: GitSourceTree): Record<string, unknown> => {
  try {
    return JSON.parse(sourceTree.readFile('package.json').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const readWorkingTreePackageMetadata = (repoRoot: string): Record<string, unknown> => {
  try {
    return JSON.parse(readWorkingTreeFile(repoRoot, 'package.json').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const readWorkingTreeFile = (repoRoot: string, repositoryPath: string): Buffer => {
  const normalizedPath = normalizeRepoRelativePath(repositoryPath);
  return fs.readFileSync(path.join(repoRoot, normalizedPath));
};

const resolveLegacyItemPaths = (repoRoot: string, itemPath: string, kind: string): string[] => {
  if (kind !== 'skill' && kind !== 'plugin') {
    return [itemPath];
  }

  const itemDirectory = path.dirname(path.join(repoRoot, itemPath));
  if (!fs.existsSync(itemDirectory) || !fs.statSync(itemDirectory).isDirectory()) {
    return [itemPath];
  }

  return sortStrings(listWorkingTreeFiles(itemDirectory, repoRoot).filter((entry) => !isIgnoredPath(entry)));
};

const listWorkingTreeFiles = (directory: string, repoRoot: string): string[] => {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listWorkingTreeFiles(fullPath, repoRoot));
    } else if (entry.isFile()) {
      files.push(normalizeRepoRelativePath(path.relative(repoRoot, fullPath)));
    }
  }
  return files;
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

const readGitRemoteUrl = (repoRoot: string): string => {
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
};

const assertImmutableRevision = (revision: string): string => {
  if (!/^[a-f0-9]{40,64}$/i.test(revision)) {
    throw new Error(`Source revision must be a full immutable Git object ID, got "${revision}"`);
  }
  return revision.toLowerCase();
};

const collectionLicense = (collection: Collection, packageMetadata: PackageMetadata): string =>
  packageMetadata.license || 'SEE LICENSE IN LICENSE';

const findLicensePath = (sourceTree: GitSourceTree): string | null => {
  const candidate = sourceTree.listFiles('.')
    .filter((entry) => !entry.includes('/'))
    .find((name) => /^(license|copying|notice)(\.[^.]*)?$/i.test(name));
  return candidate ?? null;
};

const sha256 = (content: Buffer): string =>
  `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;

const sortByPath = <T extends { path: string }>(values: readonly T[]): T[] =>
  // eslint-disable-next-line unicorn/no-array-sort -- Node 18 does not provide Array.prototype.toSorted.
  [...values].sort((left, right) => comparePaths(left.path, right.path));

const sortStrings = (values: readonly string[]): string[] =>
  // eslint-disable-next-line unicorn/no-array-sort -- Node 18 does not provide Array.prototype.toSorted.
  [...values].sort(comparePaths);

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
