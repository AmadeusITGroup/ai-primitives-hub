import * as path from 'node:path';

/**
 * Install lockfile.
 *
 * The lockfile (`prompt-registry.lock.json` by default) records every
 * installed bundle so a subsequent `prompt-registry install --lockfile`
 * is reproducible. Format mirrors the VS Code extension's repository-
 * scope lockfile: an ordered list of entries keyed on
 * `target + sourceId + bundleId`.
 *
 * Schema is stable; future fields land additively.
 *
 * Added commitMode field for repository-scope entries.
 */

export interface LockfileEntry {
  /** Target name the bundle was installed into. */
  target: string;
  /** Source identifier (e.g., `owner/repo`); empty when local-only. */
  sourceId: string;
  /** Bundle id. */
  bundleId: string;
  /** Resolved version. */
  bundleVersion: string;
  /** SHA-256 of the bundle bytes (when downloaded). */
  sha256?: string;
  /** ISO 8601 timestamp of the install. */
  installedAt: string;
  /**
   * List of file paths written. Can be bundle-relative (for install command)
   * or absolute (for profile activation). Readers should handle both formats.
   * Strings for back-compat with earlier schema; readers tolerate both.
   *
   * When checksums have been computed, the same logical
   * file is also recorded in `fileChecksums` (parallel array).
   * Future versions may collapse to `LockfileFileEntry[]` once all
   * known consumers handle the richer shape.
   */
  files: string[];
  /**
   * Optional per-file SHA-256 sums, parallel to `files`. Emitted
   * only when populated; matches extension's
   * `LockfileFileEntry.checksum` semantics.
   */
  fileChecksums?: Record<string, string>;
  /**
   * Commit mode for repository-scope installations.
   * 'commit' = tracked by git, 'local-only' = excluded via .git/info/exclude.
   * Only present for repository-scope entries.
   */
  commitMode?: 'commit' | 'local-only';
}

/**
 * Source descriptor recorded in the lockfile so reproducible installs
 * can replay against the same upstream. Mirrors the extension's
 * `LockfileSourceEntry`.
 */
export interface LockfileSource {
  /** Source type (github, awesome-copilot, apm, skills, local, …). */
  type: string;
  /** Source URL (or local path). */
  url: string;
  /** Optional git branch for git-based sources. */
  branch?: string;
  /** For awesome-copilot sources: path to collections directory (defaults to "collections"). */
  collectionsPath?: string;
}

/** Hub descriptor — mirrors extension's LockfileHubEntry. */
export interface LockfileHub {
  /** Display name. */
  name: string;
  /** Hub config URL. */
  url: string;
}

/** Profile descriptor — mirrors extension's LockfileProfileEntry. */
export interface LockfileProfile {
  /** Display name. */
  name: string;
  /** Member bundle ids. */
  bundleIds: string[];
}

/**
 * Optional pointer linking a project to a (hubId, profileId).
 * Set by `profile activate` and consumed by
 * `install --lockfile` replay so a fresh checkout re-runs
 * the same profile activation.
 */
export interface LockfileUseProfile {
  hubId: string;
  profileId: string;
}

export interface Lockfile {
  schemaVersion: 1;
  entries: LockfileEntry[];
  /**
   * Project<->profile linkage. When set, install --lockfile
   * replay will also re-activate this profile after replaying
   * entries. Unset projects work as before.
   */
  useProfile?: LockfileUseProfile;
  /**
   * Optional source registry; emitted only when populated.
   * Keys are sourceIds produced by `generateSourceId(type, url, …)`.
   */
  sources?: Record<string, LockfileSource>;
  /** Optional hub registry; emitted only when populated. */
  hubs?: Record<string, LockfileHub>;
  /** Optional profile registry; emitted only when populated. */
  profiles?: Record<string, LockfileProfile>;
}

const EMPTY: Lockfile = { schemaVersion: 1, entries: [] };

export interface LockfileFs {
  readFile(p: string): Promise<string>;
  writeFile(p: string, contents: string): Promise<void>;
  exists(p: string): Promise<boolean>;
  mkdir?(p: string, opts?: { recursive?: boolean }): Promise<void>;
}

/**
 * Read a lockfile from disk; returns the empty lockfile when absent.
 * @param file - Absolute lockfile path.
 * @param fs - LockfileFs adapter.
 * @returns Parsed Lockfile.
 * @throws {Error} On schemaVersion mismatch or invalid JSON.
 */
/**
 * Migrate VS Code extension lockfile format to CLI format.
 * VS Code format uses `bundles` (object), CLI format uses `entries` (array).
 * @param parsed
 */
function migrateLockfile(parsed: unknown): Lockfile {
  const raw = parsed as Record<string, unknown>;
  // If the lockfile uses the VS Code extension format with `bundles`, migrate it
  if ('bundles' in raw && typeof raw.bundles === 'object' && raw.bundles !== null && !('entries' in raw)) {
    const bundles = raw.bundles as Record<string, unknown>;
    const entries: LockfileEntry[] = [];
    for (const [bundleId, bundleData] of Object.entries(bundles)) {
      if (typeof bundleData !== 'object' || bundleData === null) {
        continue;
      }
      const data = bundleData as Record<string, unknown>;
      entries.push({
        bundleId,
        sourceId: (data.sourceId as string) ?? '',
        bundleVersion: (data.version as string) ?? '',
        target: (data.target as string) ?? 'copilot',
        installedAt: (data.installedAt as string) ?? new Date().toISOString(),
        sha256: (data.checksum as string | undefined),
        files: Array.isArray(data.files) ? data.files as string[] : []
      });
    }
    return {
      schemaVersion: 1,
      entries,
      sources: (raw.sources as Record<string, LockfileSource> | undefined),
      hubs: (raw.hubs as Record<string, LockfileHub> | undefined),
      profiles: (raw.profiles as Record<string, LockfileProfile> | undefined),
      useProfile: (raw.useProfile as LockfileUseProfile | undefined)
    };
  }
  // Already in CLI format
  return parsed as Lockfile;
}

export const readLockfile = async (file: string, fs: LockfileFs): Promise<Lockfile> => {
  if (!(await fs.exists(file))) {
    return { ...EMPTY };
  }
  const raw = await fs.readFile(file);
  const parsed = JSON.parse(raw);
  const migrated = migrateLockfile(parsed);
  if (migrated.schemaVersion !== 1) {
    throw new Error(`unsupported lockfile schemaVersion ${String(migrated.schemaVersion)}`);
  }
  if (!Array.isArray(migrated.entries)) {
    throw new TypeError('lockfile entries must be an array');
  }
  return migrated;
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
    const dir = file.replace(/[/\\][^/\\]*$/, '');
    if (dir.length > 0 && dir !== file) {
      await fs.mkdir(dir, { recursive: true });
    }
  }
  await fs.writeFile(file, JSON.stringify(lock, null, 2) + '\n');
};

/**
 * Upsert an entry into a lockfile (matching by target + bundleId).
 * Pure; doesn't touch disk.
 * @param lock - Existing Lockfile.
 * @param entry - Entry to add or replace.
 * @returns New Lockfile (input is not mutated).
 */
export const upsertEntry = (lock: Lockfile, entry: LockfileEntry): Lockfile => {
  const next = lock.entries.filter(
    (e) => !(e.target === entry.target && e.bundleId === entry.bundleId)
  );
  next.push(entry);
  return { ...lock, schemaVersion: 1, entries: next };
};

/**
 * Upsert a source descriptor in `lock.sources`. Pure; doesn't touch
 * disk.
 * @param lock - Existing Lockfile.
 * @param sourceId - Stable source id (`generateSourceId` output).
 * @param source - Source descriptor.
 * @returns New Lockfile (input is not mutated).
 */
export const upsertSource = (
  lock: Lockfile,
  sourceId: string,
  source: LockfileSource
): Lockfile => ({
  ...lock,
  schemaVersion: 1,
  sources: { ...lock.sources, [sourceId]: source }
});

/**
 * Upsert a hub descriptor in `lock.hubs`.
 * @param lock - Existing Lockfile.
 * @param hubKey - Stable hub key (`generateHubKey` output).
 * @param hub - Hub descriptor.
 * @returns New Lockfile (input is not mutated).
 */
export const upsertHub = (
  lock: Lockfile,
  hubKey: string,
  hub: LockfileHub
): Lockfile => ({
  ...lock,
  schemaVersion: 1,
  hubs: { ...lock.hubs, [hubKey]: hub }
});

/**
 * Upsert a profile descriptor in `lock.profiles`.
 * @param lock - Existing Lockfile.
 * @param profileId - Profile id.
 * @param profile - Profile descriptor.
 * @returns New Lockfile (input is not mutated).
 */
export const upsertProfile = (
  lock: Lockfile,
  profileId: string,
  profile: LockfileProfile
): Lockfile => ({
  ...lock,
  schemaVersion: 1,
  profiles: { ...lock.profiles, [profileId]: profile }
});

/**
 * Set or clear the `useProfile` link.
 * @param lock Existing lockfile.
 * @param useProfile The link to set; pass `null` to clear.
 * @returns Updated lockfile.
 */
export const upsertUseProfile = (
  lock: Lockfile,
  useProfile: LockfileUseProfile | null
): Lockfile => {
  if (useProfile === null) {
    const next: Lockfile = { ...lock, schemaVersion: 1 };
    delete next.useProfile;
    return next;
  }
  return { ...lock, schemaVersion: 1, useProfile };
};

/**
 * Find the lockfile by walking up from `startDir`, then optionally
 * falling back to a user-level path.
 *
 * Callers that support user-scope config should pass `userLockfile`
 * (from `resolveUserConfigPaths(env).userLockfile`) as a fallback.
 * @param startDir Directory to start the upward walk from.
 * @param fs Filesystem adapter.
 * @param userLockfile Optional user-level lockfile path to try when no
 *   project-level lockfile is found.
 * @returns Absolute path to the first lockfile found, or `null`.
 */
export const findLockfile = async (
  startDir: string,
  fs: Pick<LockfileFs, 'exists'>,
  userLockfile?: string
): Promise<string | null> => {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, 'prompt-registry.lock.json');
    if (await fs.exists(candidate)) {
      return candidate;
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

/**
 * Remove an entry from a lockfile (matching by target + bundleId).
 * Pure; doesn't touch disk.
 * @param lock - Existing Lockfile.
 * @param entry - Entry to remove.
 * @returns New Lockfile (input is not mutated).
 */
export const removeEntry = (lock: Lockfile, entry: LockfileEntry): Lockfile => {
  const next = lock.entries.filter(
    (e) => !(e.target === entry.target && e.bundleId === entry.bundleId)
  );
  return { ...lock, schemaVersion: 1, entries: next };
};
