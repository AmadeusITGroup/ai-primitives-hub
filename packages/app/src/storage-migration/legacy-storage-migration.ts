/**
 * Copy-only migration of an IDE's legacy global storage into the shared XDG
 * layout. The legacy root is only ever read. Existing XDG files are never
 * overwritten: JSON documents with a well-defined merge are merged (sources and
 * profiles by id, favorites by union), everything else is reported as a conflict.
 * @module storage-migration/legacy-storage-migration
 */
import * as path from 'node:path';
import type {
  AppStorage,
  FileSystem,
} from '@ai-primitives-hub/core';
import {
  resolveUserConfigPaths,
} from '../registry/user-config-paths';

const JOURNAL_FILE = 'migrations.json';

export interface LegacyStorageDetection {
  present: boolean;
  artifacts: string[];
  completed: boolean;
}

export interface LegacyStorageMigrationResult {
  legacyRoot: string;
  host: string;
  migratedAt: string;
  copied: string[];
  merged: string[];
  conflicts: { path: string; reason: string }[];
}

export interface LegacyStorageConflictNotice {
  legacyHubId?: string;
  sharedHubId?: string;
  otherConflicts: number;
}

export interface LegacyStorageDeps {
  fs: FileSystem;
  storage: AppStorage;
  env: Record<string, string | undefined>;
}

const ARTIFACTS = ['config.json', 'activeHubId.json', 'favorites.json', 'installed', 'bundles', 'profile-activations', 'profiles'];

const stateDir = (storage: AppStorage): string => {
  const state = storage.getPaths().state;
  if (state === undefined) {
    throw new Error('legacy storage migration needs a state directory for its journal');
  }
  return state;
};

async function readJournal(deps: LegacyStorageDeps): Promise<{ migrations: Record<string, unknown>[] }> {
  const file = path.join(stateDir(deps.storage), JOURNAL_FILE);
  if (!await deps.fs.exists(file)) {
    return { migrations: [] };
  }
  const parsed = JSON.parse(await deps.fs.readFile(file)) as { migrations?: Record<string, unknown>[] };
  return { migrations: parsed.migrations ?? [] };
}

/**
 * Return an unacknowledged storage conflict report from an earlier migration.
 * In particular, recover both active-hub IDs from their read-only pointers so
 * a migration completed by an older extension is not silently forgotten.
 * @param deps
 * @param legacyRoot
 */
export async function getLegacyStorageConflictNotice(
  deps: LegacyStorageDeps,
  legacyRoot: string
): Promise<LegacyStorageConflictNotice | undefined> {
  const journal = await readJournal(deps);
  const entry = journal.migrations.find((item) => item.legacyRoot === legacyRoot && item.kind === 'legacy-storage');
  if (entry === undefined || entry.conflictsNotifiedAt !== undefined || !Array.isArray(entry.conflicts)) {
    return undefined;
  }
  const conflicts = entry.conflicts.filter((item): item is { path: string; reason: string } =>
    typeof item === 'object' && item !== null
    && typeof (item as Record<string, unknown>).path === 'string'
    && typeof (item as Record<string, unknown>).reason === 'string');
  if (conflicts.length === 0) {
    return undefined;
  }

  const hasActiveHubConflict = conflicts.some((conflict) => path.basename(conflict.path) === 'active-hub.json');
  let legacyHubId: string | undefined;
  let sharedHubId: string | undefined;
  if (hasActiveHubConflict) {
    const activeConflict = conflicts.find((conflict) => path.basename(conflict.path) === 'active-hub.json')!;
    const legacyFromReason = activeConflict.reason.match(/legacy active hub "([^"]+)"/i)?.[1];
    const sharedFromReason = activeConflict.reason.match(/shared XDG active hub "([^"]+)"/i)?.[1]
      ?? activeConflict.reason.match(/active hub already ([^;]+); kept/i)?.[1];
    legacyHubId = legacyFromReason;
    sharedHubId = sharedFromReason;
    const legacyPointer = path.join(legacyRoot, 'activeHubId.json');
    const sharedPointer = resolveUserConfigPaths(deps.env).activeHub;
    for (const [file, assign] of [
      [legacyPointer, (id: string) => {
        legacyHubId ??= id;
      }],
      [sharedPointer, (id: string) => {
        sharedHubId ??= id;
      }]
    ] as const) {
      if (!await deps.fs.exists(file)) {
        continue;
      }
      const value = await readJson(deps.fs, file);
      if (typeof value === 'object' && value !== null) {
        const record = value as Record<string, unknown>;
        const id = typeof record.hubId === 'string' ? record.hubId : record.hub;
        if (typeof id === 'string') {
          assign(id);
        }
      }
    }
  }
  return {
    ...(legacyHubId === undefined ? {} : { legacyHubId }),
    ...(sharedHubId === undefined ? {} : { sharedHubId }),
    otherConflicts: conflicts.length - Number(hasActiveHubConflict)
  };
}

/**
 * Mark the most recent legacy-root conflict notice as shown.
 * @param deps
 * @param legacyRoot
 */
export async function markLegacyStorageConflictsNotified(deps: LegacyStorageDeps, legacyRoot: string): Promise<void> {
  const journal = await readJournal(deps);
  const entry = journal.migrations.find((item) => item.legacyRoot === legacyRoot && item.kind === 'legacy-storage');
  if (entry === undefined || !Array.isArray(entry.conflicts) || entry.conflicts.length === 0 || entry.conflictsNotifiedAt !== undefined) {
    return;
  }
  entry.conflictsNotifiedAt = new Date().toISOString();
  await writeJson(deps.fs, path.join(stateDir(deps.storage), JOURNAL_FILE), journal);
}

/**
 * Whether the legacy root holds known artifacts and whether a journal entry already covers it.
 * @param deps
 * @param legacyRoot
 */
export async function detectLegacyStorage(deps: LegacyStorageDeps, legacyRoot: string): Promise<LegacyStorageDetection> {
  const artifacts: string[] = [];
  if (await deps.fs.exists(legacyRoot)) {
    for (const entry of await deps.fs.readDirEntries(legacyRoot)) {
      if (ARTIFACTS.includes(entry.name) || (!entry.isDirectory && (entry.name.endsWith('.yml') || entry.name.endsWith('.meta.json')))) {
        artifacts.push(entry.name);
      }
    }
  }
  const journal = await readJournal(deps);
  const completed = journal.migrations.some((m) => m.legacyRoot === legacyRoot);
  return { present: artifacts.length > 0, artifacts: artifacts.toSorted(), completed };
}

async function readJson(fs: FileSystem, file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file));
}

async function writeJson(fs: FileSystem, file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

/**
 * Migrate one legacy root. Safe to repeat: copied files are skipped when identical.
 * @param deps
 * @param input
 * @param input.legacyRoot
 * @param input.host
 */
export async function migrateLegacyStorage(
  deps: LegacyStorageDeps,
  input: { legacyRoot: string; host: string }
): Promise<LegacyStorageMigrationResult> {
  const { fs } = deps;
  const paths = deps.storage.getPaths();
  const config = resolveUserConfigPaths(deps.env);
  const result: LegacyStorageMigrationResult = {
    legacyRoot: input.legacyRoot, host: input.host, migratedAt: new Date().toISOString(), copied: [], merged: [], conflicts: []
  };
  const root = input.legacyRoot;

  const copyFile = async (from: string, to: string): Promise<void> => {
    const bytes = await fs.readFileBytes(from);
    if (await fs.exists(to)) {
      if (!same(bytes, await fs.readFileBytes(to))) {
        result.conflicts.push({ path: to, reason: 'exists with different content; kept' });
      }
      return;
    }
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.writeFileBytes(to, bytes);
    result.copied.push(to);
  };
  const copyTree = async (from: string, to: string): Promise<void> => {
    if (!await fs.exists(from)) {
      return;
    }
    for (const entry of await fs.readDirEntries(from)) {
      const source = path.join(from, entry.name);
      await (entry.isDirectory ? copyTree(source, path.join(to, entry.name)) : copyFile(source, path.join(to, entry.name)));
    }
  };
  const mergeById = (existing: unknown, incoming: unknown, conflictPath: string): unknown[] => {
    const merged = Array.isArray(existing) ? [...existing as { id?: string }[]] : [];
    for (const item of Array.isArray(incoming) ? incoming as { id?: string }[] : []) {
      const found = merged.find((m) => (m).id === item.id);
      if (found === undefined) {
        merged.push(item);
      } else if (JSON.stringify(found) !== JSON.stringify(item)) {
        result.conflicts.push({ path: `${conflictPath}#${String(item.id)}`, reason: 'same id with different content; kept existing' });
      }
    }
    return merged;
  };

  // Registry config: sources/profiles merged by id, settings keep existing values.
  const legacyConfig = path.join(root, 'config.json');
  if (await fs.exists(legacyConfig)) {
    const incoming = await readJson(fs, legacyConfig) as Record<string, unknown>;
    if (await fs.exists(paths.config)) {
      const existing = await readJson(fs, paths.config) as Record<string, unknown>;
      const next: Record<string, unknown> = { ...incoming, ...existing };
      for (const key of ['sources', 'profiles']) {
        if (Array.isArray(existing[key]) || Array.isArray(incoming[key])) {
          next[key] = mergeById(existing[key], incoming[key], paths.config);
        }
      }
      if (existing.settings !== undefined || incoming.settings !== undefined) {
        next.settings = { ...(incoming.settings as object | undefined), ...(existing.settings as object | undefined) };
      }
      if (JSON.stringify(next) !== JSON.stringify(existing)) {
        await writeJson(fs, paths.config, next);
        result.merged.push(paths.config);
      }
    } else {
      await writeJson(fs, paths.config, incoming);
      result.copied.push(paths.config);
    }
  }

  // Hubs and their sidecars.
  for (const entry of await fs.exists(root) ? await fs.readDirEntries(root) : []) {
    if (!entry.isDirectory && (entry.name.endsWith('.yml') || entry.name.endsWith('.meta.json'))) {
      await copyFile(path.join(root, entry.name), path.join(config.hubs, entry.name));
    }
  }

  // Active hub pointer: activeHubId.json -> active-hub.json.
  const legacyActive = path.join(root, 'activeHubId.json');
  if (await fs.exists(legacyActive)) {
    const data = await readJson(fs, legacyActive) as { hubId?: string; hub?: string } | null;
    const hubId = data?.hubId ?? data?.hub ?? null;
    if (hubId !== null) {
      if (await fs.exists(config.activeHub)) {
        const existing = await readJson(fs, config.activeHub) as { hubId?: string; hub?: string } | null;
        const existingHubId = existing?.hubId ?? existing?.hub;
        if (existingHubId !== hubId) {
          result.conflicts.push({
            path: config.activeHub,
            reason: `legacy active hub "${hubId}" differs from shared XDG active hub "${String(existingHubId)}"; kept shared XDG selection`
          });
        }
      } else {
        await writeJson(fs, config.activeHub, { hubId });
        result.copied.push(config.activeHub);
      }
    }
  }

  // Favorites: union per hub.
  const legacyFavorites = path.join(root, 'favorites.json');
  const favoritesPath = path.join(config.hubs, 'favorites.json');
  if (await fs.exists(legacyFavorites)) {
    const incoming = await readJson(fs, legacyFavorites) as Record<string, string[]>;
    if (await fs.exists(favoritesPath)) {
      const existing = await readJson(fs, favoritesPath) as Record<string, string[]>;
      const next: Record<string, string[]> = { ...existing };
      for (const [hub, profiles] of Object.entries(incoming)) {
        next[hub] = [...new Set([...next[hub] ?? [], ...profiles])];
      }
      if (JSON.stringify(next) !== JSON.stringify(existing)) {
        await writeJson(fs, favoritesPath, next);
        result.merged.push(favoritesPath);
      }
    } else {
      await writeJson(fs, favoritesPath, incoming);
      result.copied.push(favoritesPath);
    }
  }

  await copyTree(path.join(root, 'profile-activations'), path.join(config.hubs, 'profile-activations'));
  await copyTree(path.join(root, 'installed'), paths.installed);
  await copyTree(path.join(root, 'profiles'), paths.profiles);
  await copyTree(path.join(root, 'bundles'), path.join(paths.root, 'bundles'));

  const journal = await readJournal(deps);
  journal.migrations.push({ kind: 'legacy-storage', ...result });
  await writeJson(fs, path.join(stateDir(deps.storage), JOURNAL_FILE), journal);
  return result;
}
