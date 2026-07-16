/**
 * Install lockfile (repository scope only).
 *
 * Adapted to interoperate byte-for-byte with the VS Code extension's
 * `LockfileManager` (`src/services/lockfile-manager.ts`) schema, NOT
 * the reference branch's schema this module was ported from
 * (schemaVersion `1`, single `entries: LockfileEntry[]` array,
 * `target`-keyed). The two are structurally incompatible:
 *
 *   - Extension (this module): `version: '2.0.0'` (string), `bundles:
 *     Record<bundleId, LockfileBundleEntry>` (object), `files:
 *     LockfileFileEntry[]` (`{path, checksum}`), TWO separate physical
 *     files (`prompt-registry.lock.json` for `commit` mode,
 *     `prompt-registry.local.lock.json` for `local-only` mode —
 *     commitMode is implicit by which file an entry lives in).
 *   - Reference branch's original: `schemaVersion: 1` (number),
 *     `entries: LockfileEntry[]` (array keyed by target+sourceId+
 *     bundleId, to support multi-target lockfiles), `files: string[]`
 *     + parallel `fileChecksums`, ONE file with an explicit per-entry
 *     `commitMode` field.
 *
 * This module mirrors the extension's actual on-disk shape so a CLI
 * install and an extension install of the same bundle produce
 * byte-compatible lockfile entries. Scope: repository only — the
 * lockfile has never tracked user/workspace-scope installs (no
 * reproducibility/team-sharing use case there), so this store — and
 * the uninstall pipeline that uses it — only applies to
 * `target.scope === 'repository'`. No `target` field exists on
 * `LockfileBundleEntry` for the same reason the extension has none:
 * repository scope always writes to `.github/`, invariant of which
 * IDE type nominally triggered the install (see
 * `writers/repo-scope-writer.ts`'s `RepositoryScopeWriterAdapter`,
 * which ignores its `Target` parameter entirely).
 * @module stores/json-lockfile-store
 */
import {
  createHash,
} from 'node:crypto';
import * as path from 'node:path';
import type {
  ExtractedFiles,
} from '@ai-primitives-hub/core';

/** Lockfile filename for commit-mode (git-tracked) bundle entries. */
export const LOCKFILE_NAME = 'prompt-registry.lock.json';
/** Lockfile filename for local-only (gitignored) bundle entries. */
export const LOCAL_LOCKFILE_NAME = 'prompt-registry.local.lock.json';
/** Schema version written by this store — matches the extension's. */
export const LOCKFILE_SCHEMA_VERSION = '2.0.0';

/**
 * Commit mode for repository-scoped installations.
 */
export type RepositoryCommitMode = 'commit' | 'local-only';

/**
 * File entry within a bundle.
 */
export interface LockfileFileEntry {
  /** Relative path from repository root. */
  path: string;
  /** SHA256 checksum of the file contents. */
  checksum: string;
}

/**
 * Bundle entry in the lockfile.
 */
export interface LockfileBundleEntry {
  /** Semantic version of the installed bundle. */
  version: string;
  /** ID of the source this bundle was installed from. */
  sourceId: string;
  /** Type of the source (github, local, etc.). */
  sourceType: string;
  /** ISO timestamp when the bundle was installed. */
  installedAt: string;
  /**
   * Whether files are committed to Git or excluded. Deprecated: this
   * is implicit based on which lockfile contains the entry. Kept
   * optional for round-tripping entries written by older tooling.
   */
  commitMode?: RepositoryCommitMode;
  /** Optional checksum of the bundle archive. */
  checksum?: string;
  /** List of installed files with their checksums. */
  files: LockfileFileEntry[];
}

/**
 * Source configuration entry.
 */
export interface LockfileSourceEntry {
  /** Source type (github, local, awesome-copilot, apm, etc.). */
  type: string;
  /** URL of the source. */
  url: string;
  /** Optional Git branch for git-based sources. */
  branch?: string;
  /** Optional collections subdirectory, for `awesome-copilot`-type sources. */
  collectionsPath?: string;
}

/**
 * Hub configuration entry.
 */
export interface LockfileHubEntry {
  /** Display name of the hub. */
  name: string;
  /** URL of the hub configuration. */
  url: string;
}

/**
 * Profile entry in the lockfile.
 */
export interface LockfileProfileEntry {
  /** Display name of the profile. */
  name: string;
  /** List of bundle IDs included in this profile. */
  bundleIds: string[];
}

/**
 * Root lockfile structure — matches the extension's `Lockfile` type
 * (`src/types/lockfile.ts`) field-for-field.
 */
export interface Lockfile {
  /** JSON schema reference for validation. */
  $schema: string;
  /** Lockfile schema version (e.g., "2.0.0"). */
  version: string;
  /** ISO timestamp when the lockfile was generated. */
  generatedAt: string;
  /** Extension/CLI name and version that generated the lockfile. */
  generatedBy: string;
  /** Map of bundle IDs to their metadata. */
  bundles: Record<string, LockfileBundleEntry>;
  /** Map of source IDs to their configuration. */
  sources: Record<string, LockfileSourceEntry>;
  /** Optional map of hub IDs to their configuration. */
  hubs?: Record<string, LockfileHubEntry>;
  /** Optional map of profile IDs to their configuration. */
  profiles?: Record<string, LockfileProfileEntry>;
}

const LOCKFILE_SCHEMA_URL = 'https://github.com/AmadeusITGroup/ai-primitives-hub/schemas/lockfile.schema.json';

/**
 * Build an empty lockfile structure with required fields.
 * @param generatedBy - Identifies the tool that generated the lockfile (e.g. `ai-primitives-hub-cli@1.0.0`).
 * @returns Empty Lockfile.
 */
export const emptyLockfile = (generatedBy: string): Lockfile => ({
  $schema: LOCKFILE_SCHEMA_URL,
  version: LOCKFILE_SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  generatedBy,
  bundles: {},
  sources: {}
});

export interface LockfileFs {
  readFile(p: string): Promise<string>;
  writeFile(p: string, contents: string): Promise<void>;
  exists(p: string): Promise<boolean>;
  mkdir?(p: string, opts?: { recursive?: boolean }): Promise<void>;
  remove?(p: string): Promise<void>;
}

/**
 * Get the path to the lockfile for a given commit mode.
 * @param repositoryPath - Repository root.
 * @param commitMode - Commit mode determining which physical file to use.
 * @returns Absolute path to the appropriate lockfile.
 */
export const getLockfilePathForMode = (repositoryPath: string, commitMode: RepositoryCommitMode): string =>
  path.join(repositoryPath, commitMode === 'local-only' ? LOCAL_LOCKFILE_NAME : LOCKFILE_NAME);

/**
 * Read a lockfile from disk; returns `null` when absent.
 * @param file - Absolute lockfile path.
 * @param fs - LockfileFs adapter.
 * @returns Parsed Lockfile, or `null` if the file does not exist.
 * @throws {Error} On invalid JSON.
 */
export const readLockfile = async (file: string, fs: LockfileFs): Promise<Lockfile | null> => {
  if (!(await fs.exists(file))) {
    return null;
  }
  const raw = await fs.readFile(file);
  return JSON.parse(raw) as Lockfile;
};

/**
 * Write a lockfile to disk (pretty-printed JSON for diff-friendliness).
 * @param file - Absolute lockfile path.
 * @param lock - Lockfile to write.
 * @param fs - LockfileFs adapter.
 */
export const writeLockfile = async (
  file: string,
  lock: Lockfile,
  fs: LockfileFs
): Promise<void> => {
  if (fs.mkdir !== undefined) {
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true });
  }
  await fs.writeFile(file, JSON.stringify(lock, null, 2) + '\n');
};

/**
 * Delete a lockfile at the given path if it exists. No-op (does not
 * throw) if the file is already absent or the adapter has no
 * `remove` method.
 * @param file - Absolute lockfile path.
 * @param fs - LockfileFs adapter.
 */
export const deleteLockfile = async (file: string, fs: LockfileFs): Promise<void> => {
  if (fs.remove === undefined) {
    return;
  }
  try {
    if (await fs.exists(file)) {
      await fs.remove(file);
    }
  } catch {
    // Ignore errors — deletion is best-effort cleanup.
  }
};

/**
 * Upsert a bundle entry into a lockfile. Pure; doesn't touch disk.
 * @param lock - Existing Lockfile.
 * @param bundleId - Bundle id (the `bundles` map key).
 * @param entry - Entry to add or replace.
 * @returns New Lockfile (input is not mutated).
 */
export const upsertBundleEntry = (
  lock: Lockfile,
  bundleId: string,
  entry: LockfileBundleEntry
): Lockfile => ({
  ...lock,
  version: LOCKFILE_SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  bundles: { ...lock.bundles, [bundleId]: entry }
});

/**
 * Remove a bundle entry from a lockfile. Pure; doesn't touch disk.
 * @param lock - Existing Lockfile.
 * @param bundleId - Bundle id to remove.
 * @returns New Lockfile (input is not mutated).
 */
export const removeBundleEntry = (lock: Lockfile, bundleId: string): Lockfile => {
  const bundles = { ...lock.bundles };
  delete bundles[bundleId];
  return {
    ...lock,
    version: LOCKFILE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    bundles
  };
};

/**
 * Upsert a source descriptor in `lock.sources`. Pure; doesn't touch disk.
 * @param lock - Existing Lockfile.
 * @param sourceId - Stable source id (`generateSourceId` output).
 * @param source - Source descriptor.
 * @returns New Lockfile (input is not mutated).
 */
export const upsertSource = (
  lock: Lockfile,
  sourceId: string,
  source: LockfileSourceEntry
): Lockfile => ({
  ...lock,
  version: LOCKFILE_SCHEMA_VERSION,
  sources: { ...lock.sources, [sourceId]: source }
});

/**
 * Remove a source descriptor if no remaining bundle references it.
 * Pure; doesn't touch disk.
 * @param lock - Existing Lockfile.
 * @param sourceId - Source id to consider for removal.
 * @returns New Lockfile (input is not mutated).
 */
export const cleanupOrphanedSource = (lock: Lockfile, sourceId: string): Lockfile => {
  const stillReferenced = Object.values(lock.bundles).some((b) => b.sourceId === sourceId);
  if (stillReferenced) {
    return lock;
  }
  const sources = { ...lock.sources };
  delete sources[sourceId];
  return { ...lock, sources };
};

/**
 * Compute SHA256 checksums for every file in an extracted bundle,
 * producing the `{path, checksum}` pairs `LockfileBundleEntry.files`
 * expects. Excludes `deployment-manifest.yml` — it is bundle metadata,
 * not an installed file — matching every writer's own exclusion of it.
 * @param files - Extracted bundle files (path -> raw bytes).
 * @returns Per-file checksum entries, manifest excluded.
 */
export const checksumFiles = (files: ExtractedFiles): LockfileFileEntry[] => {
  const entries: LockfileFileEntry[] = [];
  for (const [filePath, bytes] of files) {
    if (filePath === 'deployment-manifest.yml') {
      continue;
    }
    entries.push({
      path: filePath,
      checksum: createHash('sha256').update(bytes).digest('hex')
    });
  }
  return entries;
};

/**
 * Find a project-scope lockfile by walking up from `startDir`, then
 * optionally falling back to a user-level path. Checks for either
 * physical lockfile (`LOCKFILE_NAME` or `LOCAL_LOCKFILE_NAME`) at each
 * directory level — unlike the reference branch's `findLockfile`
 * (`infra/src/stores/json-lockfile-store.ts`), which only ever checked
 * a single filename, because this store's schema (adapted to the
 * extension's real on-disk format, see the module doc above) splits
 * commit-mode and local-only entries across two physical files rather
 * than the reference's single-file-with-a-`commitMode`-field shape.
 * Path resolution only — does not read or validate file contents, so
 * the lockfile bundle-entry schema difference from the reference is
 * not a concern here.
 * @param startDir - Directory to start the upward walk from.
 * @param fs - LockfileFs adapter (only `exists` is used).
 * @param userLockfile - Optional user-level lockfile path to try when no
 *   project-level lockfile is found (typically
 *   `resolveUserConfigPaths(env).userLockfile`).
 * @returns Absolute path to the first lockfile found, or `null`.
 */
export const findLockfile = async (
  startDir: string,
  fs: Pick<LockfileFs, 'exists'>,
  userLockfile?: string
): Promise<string | null> => {
  let dir = startDir;
  while (true) {
    for (const name of [LOCKFILE_NAME, LOCAL_LOCKFILE_NAME]) {
      const candidate = path.join(dir, name);
      if (await fs.exists(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  if (userLockfile !== undefined && await fs.exists(userLockfile)) {
    return userLockfile;
  }
  return null;
};
