/**
 * Find the bundles inside a source checkout, without needing a release archive.
 *
 * A bundle is the installable form of a collection, so the files that matter are the ones the
 * collection lists. Two layouts are recognised, in this order:
 *
 * - `collections/*.collection.yml`: one bundle per collection (id = collection id). Its files are
 *   the collection file, every item (a `skill` item brings its whole folder) and the readme.
 * - `skills/<name>/SKILL.md`: one bundle per skill folder, with the id the skills adapter builds:
 *   `skills-<owner>-<repo>-<name>`.
 *
 * Paths that leave the repository, and symlinks, are ignored.
 * @module app/quality/bundle-discovery
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  BundleFiles,
  QualityBundleMetadata,
  QualityReportMode,
} from '@ai-primitives-hub/core';
import {
  normalizeRepoRelativePath,
} from '@ai-primitives-hub/core';
import * as yaml from 'js-yaml';

export interface BundleDiscoveryOptions {
  /** `owner/repo`, used for skill bundle ids and authors. */
  repository: string;
  collectionsPath?: string;
  skillsPath?: string;
}

export interface DiscoveredBundles {
  mode: Exclude<QualityReportMode, 'release-archives'>;
  bundles: BundleFiles[];
  warnings: string[];
}

const KIND_NAMES: Readonly<Record<string, string>> = {
  prompt: 'prompt',
  instruction: 'instruction',
  instructions: 'instruction',
  'chat-mode': 'chat-mode',
  chatmode: 'chat-mode',
  agent: 'agent',
  skill: 'skill'
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toPosix = (value: string): string => value.split(path.sep).join('/');

const isOutside = (relative: string): boolean => relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);

/**
 * Resolve a repository-relative path inside `root`, or undefined when it escapes (also through a
 * symlinked folder) or is invalid. A path that does not exist yet is returned as is.
 * @param root - Repository root
 * @param relative - Path from a collection or option
 */
const resolveInside = (root: string, relative: unknown): string | undefined => {
  if (typeof relative !== 'string') {
    return undefined;
  }
  try {
    const normalized = normalizeRepoRelativePath(relative);
    const absolute = path.resolve(root, normalized);
    const inside = path.relative(path.resolve(root), absolute);
    if (inside === '' || isOutside(inside)) {
      return undefined;
    }
    try {
      const real = path.relative(fs.realpathSync(root), fs.realpathSync(absolute));
      return isOutside(real) ? undefined : normalized;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? normalized : undefined;
    }
  } catch {
    return undefined;
  }
};

const regularFilesUnder = (root: string, folder: string): string[] => {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        files.push(toPosix(path.relative(root, absolute)));
      }
    }
  };
  walk(path.join(root, folder));
  return files.toSorted();
};

const isFile = (absolute: string): boolean => {
  try {
    const stat = fs.lstatSync(absolute);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
};

const listDirectory = (absolute: string): fs.Dirent[] => {
  try {
    return fs.readdirSync(absolute, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
};

const discoverCollections = (root: string, collectionsPath: string): { bundles: BundleFiles[]; warnings: string[] } => {
  const folder = resolveInside(root, collectionsPath);
  const bundles: BundleFiles[] = [];
  const warnings: string[] = [];
  if (folder === undefined) {
    warnings.push(`${collectionsPath}: collections path is outside the repository or invalid`);
    return { bundles, warnings };
  }
  for (const entry of listDirectory(path.join(root, folder))) {
    if (!entry.isFile() || !entry.name.endsWith('.collection.yml')) {
      continue;
    }
    const collectionFile = `${folder}/${entry.name}`;
    let document: unknown;
    try {
      document = yaml.load(fs.readFileSync(path.join(root, collectionFile), 'utf8'));
    } catch {
      continue;
    }
    if (!isRecord(document) || typeof document.id !== 'string' || document.id.trim() === '') {
      continue;
    }

    const files = new Set<string>([collectionFile]);
    const kinds: Record<string, number> = {};
    const references: { path: unknown; kind?: unknown }[] = Array.isArray(document.items)
      ? document.items.filter((candidate) => isRecord(candidate)).map((item) => ({ path: item.path, kind: item.kind }))
      : [];
    if (isRecord(document.readme)) {
      references.push({ path: document.readme.path });
    }
    for (const reference of references) {
      const relative = resolveInside(root, reference.path);
      if (relative === undefined || !isFile(path.join(root, relative))) {
        warnings.push(`${collectionFile}: item not found or outside the repository: ${String(reference.path)}`);
        continue;
      }
      // A skill or plugin item brings its folder, but never the whole repository for a root-level file.
      const skillFolder = path.posix.dirname(relative);
      if ((reference.kind === 'skill' || reference.kind === 'plugin') && skillFolder !== '.') {
        for (const file of regularFilesUnder(root, skillFolder)) {
          files.add(file);
        }
      } else {
        files.add(relative);
      }
      const kind = typeof reference.kind === 'string' ? KIND_NAMES[reference.kind] : undefined;
      if (kind !== undefined) {
        kinds[kind] = (kinds[kind] ?? 0) + 1;
      }
    }
    const mcp = isRecord(document.mcp) ? document.mcp.items : undefined;
    const servers = isRecord(document.mcpServers) ? document.mcpServers : (isRecord(mcp) ? mcp : undefined);
    if (servers !== undefined && Object.keys(servers).length > 0) {
      kinds['mcp-server'] = Object.keys(servers).length;
    }
    const tags = Array.isArray(document.tags)
      ? [...new Set(document.tags.filter((tag): tag is string => typeof tag === 'string' && tag !== ''))]
      : [];
    const metadata: QualityBundleMetadata = {
      author: typeof document.author === 'string' && document.author !== '' ? document.author : null,
      kind: Object.fromEntries(Object.entries(kinds).toSorted(([a], [b]) => a.localeCompare(b))),
      labels: tags
    };
    bundles.push({
      id: document.id.trim(),
      version: typeof document.version === 'string' || typeof document.version === 'number' ? String(document.version) : '1.0.0',
      files: [...files].toSorted(),
      metadata
    });
  }
  return { bundles, warnings };
};

const contentHash = (root: string, files: readonly string[]): string => {
  const digest = crypto.createHash('sha1');
  for (const file of files) {
    digest.update(file);
    digest.update(fs.readFileSync(path.join(root, file)));
  }
  return `hash:${digest.digest('hex').slice(0, 12)}`;
};

const discoverSkills = (root: string, skillsPath: string, repository: string): { bundles: BundleFiles[]; warnings: string[] } => {
  const folder = resolveInside(root, skillsPath);
  if (folder === undefined) {
    return { bundles: [], warnings: [`${skillsPath}: skills path is outside the repository or invalid`] };
  }
  const [owner = '', repo = ''] = repository.split('/');
  const bundles: BundleFiles[] = [];
  for (const entry of listDirectory(path.join(root, folder))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isFile(path.join(root, folder, entry.name, 'SKILL.md'))) {
      continue;
    }
    const files = regularFilesUnder(root, `${folder}/${entry.name}`);
    bundles.push({
      id: `skills-${owner}-${repo}-${entry.name}`,
      version: contentHash(root, files),
      files,
      metadata: { author: owner === '' ? null : owner, kind: { skill: 1 }, labels: [] }
    });
  }
  return { bundles, warnings: [] };
};

/**
 * Find the bundles of a source checkout: collections first, then skill folders.
 * @param root - Repository root
 * @param options - Repository name and folder overrides
 */
export const discoverBundles = (root: string, options: BundleDiscoveryOptions): DiscoveredBundles => {
  const collections = discoverCollections(root, options.collectionsPath ?? 'collections');
  if (collections.bundles.length > 0) {
    return { mode: 'collections', bundles: collections.bundles, warnings: collections.warnings };
  }
  const skills = discoverSkills(root, options.skillsPath ?? 'skills', options.repository);
  const warnings = [...collections.warnings, ...skills.warnings];
  return skills.bundles.length > 0
    ? { mode: 'skills', bundles: skills.bundles, warnings }
    : { mode: 'repository', bundles: [], warnings };
};
