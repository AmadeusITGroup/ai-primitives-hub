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
 * `LockfileBundleEntry` because each file record already stores the exact,
 * target-resolved repository-relative destination.
 * @module stores/json-lockfile-store
 */
import * as path from 'node:path';
import type {
  InstalledFileRecord,
  PrimitiveKind,
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
  /**
   * SHA256 of the canonical installed bytes for this path.
   */
  checksum: string;
  /**
   * Primitive kind this file was installed as.
   *
   * Persisted so uninstall/update never has to re-derive a kind from the
   * destination path. Path-prefix inference cannot be correct in general: a
   * layout override may rename a route (`agent` → `ai-agents/`), which would
   * silently mis-classify the file and, for skills, stop directory pruning from
   * firing. Optional only because released CLI 0.1.0 lockfiles predate it — see
   * `LEGACY_REPOSITORY_PREFIXES`.
   */
  kind?: PrimitiveKind;
  /**
   * Id of the manifest item that owns this file.
   *
   * Persisted for the same reason as `kind`: skill-directory pruning keys on the
   * owning item id, which cannot be recovered from a renamed route. Optional for
   * 0.1.0-era lockfiles.
   */
  itemId?: string;
}

export interface ResolveInstalledFilesForLockfileEntryOptions {
  repositoryPath?: string;
  baseDir?: string;
}

export interface ResolvedLockfileEntryFiles {
  files: InstalledFileRecord[];
  warnings: string[];
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
 * Source prefixes written into `files[].path` by released CLI versions.
 *
 * `@ai-primitives-hub/cli@0.1.0` (npm dist-tag `latest`) builds its lockfile
 * entries with `files: checksumFiles(targetFiles, …)` from
 * `@ai-primitives-hub/app@0.1.0`, which keys entries by the **archive source
 * path** (`prompts/foo.prompt.md`) while still stamping `version: '2.0.0'`.
 * Repository-scope destinations for those bundles were actually written under
 * `.github/`, so a lockfile produced by that release cannot be resolved without
 * re-adding the destination prefix. Verified by unpacking both published
 * tarballs (`dist/commands/install.js` → `checksumFiles`,
 * `dist/stores/json-lockfile-store.js` → `LOCKFILE_SCHEMA_VERSION = '2.0.0'`).
 *
 * This layer is therefore read-only compatibility for released 0.1.0
 * lockfiles, not defensive scaffolding: it may be deleted once 0.1.0 installs
 * are no longer supported, since every write path now persists
 * destination-relative paths.
 */
const LEGACY_REPOSITORY_PREFIXES = [
  'prompts/',
  'agents/',
  'instructions/',
  'skills/',
  'hooks/',
  'plugins/'
] as const;

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
 * Remap all bundle entries referencing `oldSourceId` to point at
 * `newSourceId`, and move the source descriptor accordingly. Pure;
 * doesn't touch disk.
 * @param lock - Existing Lockfile.
 * @param oldSourceId - Source id being retired.
 * @param newSourceId - Replacement source id.
 * @param newSourceDescriptor - Source descriptor for the replacement.
 * @returns New Lockfile (input is not mutated).
 */
export const remapSourceId = (
  lock: Lockfile,
  oldSourceId: string,
  newSourceId: string,
  newSourceDescriptor: LockfileSourceEntry
): Lockfile => {
  const bundles: Record<string, LockfileBundleEntry> = {};
  for (const [id, entry] of Object.entries(lock.bundles)) {
    bundles[id] = entry.sourceId === oldSourceId
      ? { ...entry, sourceId: newSourceId }
      : entry;
  }
  const sources = { ...lock.sources };
  delete sources[oldSourceId];
  sources[newSourceId] = newSourceDescriptor;
  return {
    ...lock,
    version: LOCKFILE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    bundles,
    sources
  };
};

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

export const lockfileFilesFromInstalledRecords = (
  installed: readonly InstalledFileRecord[]
): LockfileFileEntry[] =>
  installed.map((file) => ({
    path: normalizeLockfilePath(file.destinationRelativePath),
    checksum: file.installedChecksum,
    kind: file.kind,
    itemId: file.itemId
  }));

export const resolveInstalledFilesForLockfileEntry = (
  bundleId: string,
  entry: LockfileBundleEntry,
  opts: ResolveInstalledFilesForLockfileEntryOptions
): ResolvedLockfileEntryFiles => {
  const root = opts.repositoryPath ?? opts.baseDir;
  if (root === undefined) {
    throw new Error('resolveInstalledFilesForLockfileEntry requires repositoryPath or baseDir');
  }

  const warnings: string[] = [];
  let warnedLegacyRepositoryPaths = false;
  const files = entry.files.map((file, index) => {
    let destinationRelativePath = normalizeLockfilePath(file.path);
    assertSafeLockfilePath(destinationRelativePath);
    if (opts.repositoryPath !== undefined) {
      const compatiblePath = resolveRepositoryLockfilePathCompatibility(destinationRelativePath);
      destinationRelativePath = compatiblePath.path;
      if (compatiblePath.legacy && !warnedLegacyRepositoryPaths) {
        warnings.push(
          `Bundle "${bundleId}" uses legacy repository lockfile paths from CLI 2.0.0. Reinstall or update it to rewrite destination-relative paths in the repository lockfile.`
        );
        warnedLegacyRepositoryPaths = true;
      }
    }
    assertSafeLockfilePath(destinationRelativePath);
    const destinationPath = path.resolve(root, destinationRelativePath);
    const resolvedRoot = path.resolve(root);
    if (destinationPath !== resolvedRoot && !destinationPath.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error(`unsafe lockfile path "${file.path}" escapes target root`);
    }

    return {
      itemId: file.itemId ?? inferInstalledItemId(destinationRelativePath, index),
      kind: file.kind ?? inferInstalledKind(destinationRelativePath),
      sourcePath: destinationRelativePath,
      destinationPath,
      destinationRelativePath,
      installedChecksum: file.checksum
    } satisfies InstalledFileRecord;
  });

  return { files, warnings };
};

/**
 * Resolve the installed records of **every** bundle recorded in a lockfile.
 *
 * This is the set a `TargetWriter` must treat as managed: a destination
 * installed by bundle A is still tool-managed when bundle B legitimately
 * overwrites it, so scoping the writer's `managedFiles` to the bundle being
 * installed makes shared destinations fail the unmanaged-overwrite guard.
 * The uninstall pipeline already reasons across all bundles
 * (`collectFilesUsedByOtherBundles`); this is the write-side counterpart.
 *
 * Records are deduplicated by resolved destination path (first entry wins),
 * and warnings are deduplicated so a legacy lockfile reports once per bundle.
 * @param lock - Lockfile whose bundle entries should be resolved.
 * @param opts - Resolution root (`repositoryPath` for repository scope,
 *   `baseDir` for user scope).
 * @returns Every bundle's installed records plus any compatibility warnings.
 */
export const resolveManagedFilesFromLockfile = (
  lock: Pick<Lockfile, 'bundles'>,
  opts: ResolveInstalledFilesForLockfileEntryOptions
): ResolvedLockfileEntryFiles => {
  const byDestination = new Map<string, InstalledFileRecord>();
  const warnings = new Set<string>();
  for (const [bundleId, entry] of Object.entries(lock.bundles)) {
    const resolved = resolveInstalledFilesForLockfileEntry(bundleId, entry, opts);
    for (const warning of resolved.warnings) {
      warnings.add(warning);
    }
    for (const file of resolved.files) {
      if (!byDestination.has(file.destinationPath)) {
        byDestination.set(file.destinationPath, file);
      }
    }
  }
  return { files: [...byDestination.values()], warnings: [...warnings] };
};

const normalizeLockfilePath = (filePath: string): string => filePath.replaceAll('\\', '/');

const assertSafeLockfilePath = (filePath: string): void => {
  const segments = filePath.split('/');
  if (filePath.length === 0 || path.isAbsolute(filePath)
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(`unsafe lockfile path "${filePath}"`);
  }
};

const resolveRepositoryLockfilePathCompatibility = (filePath: string): { path: string; legacy: boolean } => {
  const normalized = normalizeLockfilePath(filePath);
  if (normalized.startsWith('.github/')) {
    return { path: normalized, legacy: false };
  }
  if (LEGACY_REPOSITORY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return { path: `.github/${normalized}`, legacy: true };
  }
  return { path: normalized, legacy: false };
};

/**
 * Best-effort kind recovery for lockfile entries that predate `files[].kind`
 * (released CLI 0.1.0 and the shipped extension's earlier writes).
 *
 * This is a heuristic and is knowingly wrong when a layout override renames a
 * route, which is exactly why `kind` is now persisted. Every entry written by
 * current code carries its kind, so this only ever runs against historical
 * lockfiles; file removal itself always uses the exact destination path, so a
 * mis-inferred kind can only weaken skill-directory pruning, never delete the
 * wrong file.
 * @param destinationRelativePath - Destination-relative path from the lockfile.
 * @returns The inferred primitive kind, defaulting to `prompt`.
 */
const inferInstalledKind = (destinationRelativePath: string): PrimitiveKind => {
  const normalized = stripRepositoryPrefix(destinationRelativePath);
  if (normalized.startsWith('skills/')) {
    return 'skill';
  }
  if (normalized.startsWith('agents/')) {
    return 'agent';
  }
  if (normalized.startsWith('instructions/')) {
    return 'instruction';
  }
  if (normalized.startsWith('hooks/')) {
    return 'hook';
  }
  if (normalized.startsWith('plugins/')) {
    return 'plugin';
  }
  return 'prompt';
};

/**
 * Best-effort item-id recovery for lockfile entries that predate `files[].itemId`.
 * Same caveats as `inferInstalledKind`.
 * @param destinationRelativePath - Destination-relative path from the lockfile.
 * @param index - Entry index, used only to synthesize a unique fallback id.
 * @returns The inferred owning item id.
 */
const inferInstalledItemId = (destinationRelativePath: string, index: number): string => {
  const normalized = stripRepositoryPrefix(destinationRelativePath);
  if (normalized.startsWith('skills/') || normalized.startsWith('plugins/')) {
    return normalized.split('/')[1] ?? `file-${index}`;
  }
  return path.basename(normalized, path.extname(normalized));
};

const stripRepositoryPrefix = (destinationRelativePath: string): string =>
  destinationRelativePath.startsWith('.github/')
    ? destinationRelativePath.slice('.github/'.length)
    : destinationRelativePath;

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
