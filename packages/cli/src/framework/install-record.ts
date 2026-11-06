/**
 * Install record wiring for the CLI: builds the record store and service,
 * selects the record a command acts on and gates record sources. User level
 * still uses the old lockfile, and old `prompt-registry.*` files are never
 * touched here.
 * @module framework/install-record
 */
import * as path from 'node:path';
import {
  createInstallRecordServices,
  findLockfile,
  type InstallRecordService,
  type InstallRecordServices,
  type Lockfile,
  type LockfileSourceEntry,
  type RecordInstallInput,
  type RecordInstallResult,
  type RecordSelection,
  type RecordSourceInput,
  type RecordStore,
  readLockfile,
  resolveExcludeFile,
  resolveUserConfigPaths,
  selectRecord,
} from '@ai-primitives-hub/app';
import {
  compareCodeUnits,
  DEFAULT_LOCAL_HUB_ID,
  describeRecordError,
  type InstallationScope,
  isRecordError,
  type RecordFs,
  type RecordLevel,
  type RecordLocation,
  RegistryError,
  type RegistrySource,
  type RepositoryExclusion,
  type Target,
  type TokenProvider,
} from '@ai-primitives-hub/core';
import {
  GitInfoExclude,
  NodeRecordFs,
  StaticTokenProvider,
} from '@ai-primitives-hub/infra';
import {
  CLI_VERSION,
} from '../version';
import type {
  Context,
} from './context';
import {
  readTargetsSafely,
  resolveTarget,
  resolveTargetName,
} from './error';
import {
  createHubManager,
} from './hub-manager';
import {
  loadTargets,
  resolveEffectiveTarget,
  type TargetOverrides,
} from './target';

/** Writer stamp for records written by the CLI. */
export const CLI_RECORD_GENERATED_BY = `ai-primitives-hub-cli@${CLI_VERSION}`;

/** A repository install whose record files were loaded and checked before writing. */
export interface PreparedRepositoryRecord {
  /** The file the install is recorded in, from the commit mode. */
  location: RecordLocation;
  service: InstallRecordService;
  /** Workspace root the writer installs into (where merged MCP config files sit). */
  workspaceRoot: string;
  /** `info/exclude` section for local-only files, shared with the local-only record. */
  exclusion: RepositoryExclusion;
}

/** What `recordRepositoryInstall` records. */
export interface RepositoryInstallToRecord {
  bundleId: string;
  version: string;
  /** The target's type. */
  tool: string;
  source: RecordSourceInput;
  /** The writer's `written` list, absolute paths. */
  writtenPaths: readonly string[];
}

/** Outcome of `recordRepositoryInstall`. */
export interface RecordedRepositoryInstall {
  /** Absolute path of the record file written. */
  lockfile: string;
  /** Root-relative superseded files that were removed. */
  deleted: string[];
  /** Non-fatal problems: exclude-file updates and skipped deletions. */
  warnings: string[];
}

/**
 * Re-raise a record error with the command name and its file in the message; code, hint and context are kept.
 * @param command - Message prefix.
 * @param error - A `RECORD.*` error.
 * @param written - Files already written, for an install that failed after the write.
 */
export const toCommandRecordError = (command: string, error: RegistryError, written?: readonly string[]): RegistryError => {
  let message = `${command}: ${describeRecordError(error)}`;
  if (written !== undefined && written.length > 0) {
    message += ` These files were written but are not recorded; run the install again to record them: ${written.join(', ')}`;
  }
  return new RegistryError({
    code: error.code,
    message,
    hint: error.hint,
    context: {
      ...error.context,
      ...(written !== undefined && written.length > 0 ? { written: [...written] } : {})
    },
    cause: error
  });
};

/**
 * Re-raise a record error for `install`, with its file in the message.
 * @param error - A `RECORD.*` error.
 * @param written - Files already written, for a failure after the write.
 */
export const toInstallRecordError = (error: RegistryError, written?: readonly string[]): RegistryError =>
  toCommandRecordError('install', error, written);

const createRecordServices = (fs: RecordFs): InstallRecordServices =>
  createInstallRecordServices({ generatedBy: CLI_RECORD_GENERATED_BY, fs });

/** Both repository record files for a target, and the one its commit mode names. */
interface RepositoryRecords extends InstallRecordServices {
  /** Workspace root the writer installs into (where merged MCP config files sit). */
  workspaceRoot: string;
  committed: RecordLocation;
  localOnly: RecordLocation;
  /** The file the target's commit mode names. */
  location: RecordLocation;
  /** The `info/exclude` section in the file the record store uses. */
  exclusion: RepositoryExclusion;
}

/**
 * Build the record services and locate both repository record files. Loads
 * nothing. The exclusion uses the same `info/exclude` as the record store,
 * also in a worktree.
 * @param ctx - CLI context.
 * @param target - Repository-scope target.
 * @param fs - Filesystem port.
 */
const openRepositoryRecords = async (ctx: Context, target: Target, fs: RecordFs): Promise<RepositoryRecords> => {
  const services = createRecordServices(fs);
  const workspaceRoot = target.rootPath ?? ctx.cwd();
  const [committed, localOnly] = await services.store.resolveRepository({ start: workspaceRoot });
  // An unreadable `.git` keeps the default file; the record store warns about it on save.
  const excludeFile = await resolveExcludeFile(fs, committed.root).catch(() => ({ warning: 'unreadable' }));
  return {
    ...services,
    workspaceRoot,
    committed,
    localOnly,
    location: target.commitMode === 'local-only' ? localOnly : committed,
    exclusion: 'file' in excludeFile
      // Exclude patterns are relative to the work tree root, which is the record root.
      ? new GitInfoExclude({ fs: ctx.fs, workspaceRoot: committed.root, excludePath: excludeFile.file })
      : new GitInfoExclude({ fs: ctx.fs, workspaceRoot })
  };
};

/**
 * Load and check both repository record files before anything is written.
 * @param ctx - CLI context.
 * @param target - Repository-scope target.
 * @param fs - Filesystem port.
 * @throws {RegistryError} A `RECORD.*` error naming the file; nothing was written.
 */
export const prepareRepositoryRecord = async (
  ctx: Context,
  target: Target,
  fs: RecordFs = new NodeRecordFs()
): Promise<PreparedRepositoryRecord> => {
  try {
    const records = await openRepositoryRecords(ctx, target, fs);
    await records.store.load(records.committed);
    await records.store.load(records.localOnly);
    return {
      location: records.location,
      service: records.service,
      workspaceRoot: records.workspaceRoot,
      exclusion: records.exclusion
    };
  } catch (error) {
    throw isRecordError(error) ? toInstallRecordError(error) : error;
  }
};

/**
 * Record a repository install, then remove the files it superseded. On failure
 * the written files stay and the error lists them.
 * @param prepared - From {@link prepareRepositoryRecord}.
 * @param install - What was installed.
 * @throws {RegistryError} A `RECORD.*` error naming the file and the written files.
 */
export const recordRepositoryInstall = async (
  prepared: PreparedRepositoryRecord,
  install: RepositoryInstallToRecord
): Promise<RecordedRepositoryInstall> => {
  let change;
  try {
    change = await prepared.service.recordInstall({
      location: prepared.location,
      bundleId: install.bundleId,
      version: install.version,
      tool: install.tool,
      source: install.source,
      sourceType: install.source.type,
      writtenPaths: install.writtenPaths,
      workspaceRoot: prepared.workspaceRoot
    });
  } catch (error) {
    throw isRecordError(error) ? toInstallRecordError(error, install.writtenPaths) : error;
  }
  const removal = await prepared.service.deleteSuperseded(change);
  return {
    lockfile: prepared.location.path,
    deleted: removal.deleted,
    warnings: [...change.warnings, ...removal.warnings]
  };
};

/** Both repository record files, loaded and checked for an uninstall. */
export interface PreparedRepositoryUninstall {
  /** The file named by the commit mode; `recordUninstall` reads both files from its root. */
  location: RecordLocation;
  service: InstallRecordService;
  /** The target's type. */
  tool: string;
  /** `info/exclude` section local-only files are listed in. */
  exclusion: RepositoryExclusion;
  /** Bundles with an entry for `tool` in either file, sorted, with their recorded paths. */
  entries: Map<string, string[]>;
}

/** Outcome of `recordRepositoryUninstall`. */
export interface RecordedRepositoryUninstall {
  /** Absolute path of the record file the entry was removed from (it may now be deleted). */
  lockfile: string;
  /** Root-relative files that were removed. */
  removed: string[];
  /** Root-relative files kept because another entry still lists them. */
  kept: string[];
  /** Non-fatal problems: skipped deletions or a record file that could not be removed. */
  warnings: string[];
}

/**
 * Load and check both repository record files before anything is removed.
 * Bundles not in `entries` fall back to the old store.
 * @param ctx - CLI context.
 * @param target - Repository-scope target.
 * @param fs - Filesystem port.
 * @throws {RegistryError} A `RECORD.*` error naming the file; nothing was removed.
 */
export const prepareRepositoryUninstall = async (
  ctx: Context,
  target: Target,
  fs: RecordFs = new NodeRecordFs()
): Promise<PreparedRepositoryUninstall> => {
  try {
    const { store, service, committed, localOnly, location, exclusion } = await openRepositoryRecords(ctx, target, fs);
    const entries = new Map<string, string[]>();
    for (const recordLocation of [committed, localOnly]) {
      const { record } = await store.load(recordLocation);
      for (const [bundleId, bundle] of Object.entries(record.bundles)) {
        if (!Object.hasOwn(bundle.tools, target.type)) {
          continue;
        }
        const paths = bundle.tools[target.type].files.map((file) => file.path);
        entries.set(bundleId, [...new Set([...(entries.get(bundleId) ?? []), ...paths])]);
      }
    }
    return {
      location,
      service,
      tool: target.type,
      exclusion,
      entries: new Map([...entries].toSorted(([left], [right]) => compareCodeUnits(left, right)))
    };
  } catch (error) {
    throw isRecordError(error) ? toCommandRecordError('uninstall', error) : error;
  }
};

/**
 * Remove one bundle's entry for the target's type, then delete its files except those another entry lists.
 * @param prepared - From {@link prepareRepositoryUninstall}.
 * @param bundleId - Bundle to uninstall.
 * @throws {RegistryError} `RECORD.ENTRY_NOT_FOUND` or another `RECORD.*` error naming the file.
 */
export const recordRepositoryUninstall = async (
  prepared: PreparedRepositoryUninstall,
  bundleId: string
): Promise<RecordedRepositoryUninstall> => {
  let change;
  try {
    change = await prepared.service.recordUninstall({ location: prepared.location, bundleId, tool: prepared.tool });
  } catch (error) {
    throw isRecordError(error) ? toCommandRecordError('uninstall', error) : error;
  }
  const removal = await prepared.service.deleteSuperseded(change);
  const warnings = [...change.warnings, ...removal.warnings];
  if (change.location.commitMode === 'local-only' && removal.deleted.length > 0) {
    // Drop the removed files' `info/exclude` entries, as the old uninstall did.
    try {
      await prepared.exclusion.remove(removal.deleted.map((relative) => path.join(change.location.root, ...relative.split('/'))));
    } catch (error) {
      warnings.push(`Could not update .git/info/exclude: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    lockfile: change.location.path,
    removed: removal.deleted,
    kept: change.keptSharedFiles,
    warnings
  };
};

/** What a command was given that fixes the record level (BR6.1). */
export interface RecordSelectionInput {
  /** Command name, used as the prefix of a `RECORD.*` error message. */
  command: string;
  /** `--lockfile <path>` as typed (not a path found by an upward walk). */
  lockfile?: string;
  /** `--scope`. */
  scope?: InstallationScope;
}

/** A selected record with the store and service to act on it. */
export interface PreparedRecordSelection {
  /** Level, root, loaded new record files and the old-store file (W4). */
  selection: RecordSelection;
  /** Store the selected files were loaded with. */
  store: RecordStore;
  /** Service to record, list and remove entries with. */
  service: InstallRecordService;
  /** Filesystem port the store and service use. */
  fs: RecordFs;
}

/**
 * Select the record a command acts on and load every selected file before
 * anything is written (W4; BR6.1, BR6.2, NFR4.8). The old `prompt-registry.*`
 * file is found with today's upward walk from the selection's start folder.
 * @param ctx - CLI context; `ctx.cwd()` is the current folder.
 * @param input - Command name and the `--lockfile` / `--scope` values the person typed.
 * @param target - Resolved target, when the command has one: its scope gives the level, its root the start folder.
 * @param fs - Filesystem port; `NodeRecordFs` unless a test passes one.
 * @returns The selection with the store and service that loaded it.
 * @throws {RegistryError} A `RECORD.*` error naming the command and the file; nothing was written.
 */
export const prepareRecordSelection = async (
  ctx: Context,
  input: RecordSelectionInput,
  target?: Target,
  fs: RecordFs = new NodeRecordFs()
): Promise<PreparedRecordSelection> => {
  const { store, service } = createRecordServices(fs);
  const userLockfile = resolveUserConfigPaths(ctx.env).userLockfile;
  try {
    const selection = await selectRecord({
      store,
      fs,
      cwd: ctx.cwd(),
      given: {
        ...(input.lockfile === undefined || input.lockfile === '' ? {} : { lockfile: input.lockfile }),
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(target === undefined ? {} : { target: { scope: target.scope, rootPath: target.rootPath } })
      },
      findOldLockfile: (start) => findLockfile(start, ctx.fs, userLockfile),
      userLockfile
    });
    return { selection, store, service, fs };
  } catch (error) {
    throw isRecordError(error) ? toCommandRecordError(input.command, error) : error;
  }
};

/**
 * Configured sources by id for the source trust gate (NFR4.11): the active
 * hub's sources first, then detached (`default-local`) sources whose id the
 * active hub does not use. A hub that cannot be read contributes no source,
 * so its entries fall back to the record's copy without credentials.
 * @param ctx - CLI context.
 * @returns Configured sources keyed by id, in lookup order.
 */
export const configuredSources = async (ctx: Context): Promise<Map<string, RegistrySource>> => {
  const manager = createHubManager({ ctx });
  const sources = new Map<string, RegistrySource>();
  let active: RegistrySource[] = [];
  try {
    active = await manager.listSources();
  } catch {
    // No readable active hub: no configured source from it.
  }
  const detached = (await manager.listSourcesAcrossAllHubs()).filter((source) => source.hubId === DEFAULT_LOCAL_HUB_ID);
  for (const source of [...active, ...detached]) {
    if (!sources.has(source.id)) {
      sources.set(source.id, source);
    }
  }
  return sources;
};

/** Token provider that never returns a token. */
const NO_TOKENS: TokenProvider = new StaticTokenProvider('');

/**
 * The token provider for a planned entry's lookup and download: none for a
 * source the trust gate took from the record, so such a fetch runs without
 * credentials (NFR4.11).
 * @param tokens - The command's token provider.
 * @param fromRecordOnly - `true` when no configured source has the entry's id.
 * @returns The provider to fetch with.
 */
export const tokensForRecordSource = (tokens: TokenProvider, fromRecordOnly: boolean): TokenProvider =>
  fromRecordOnly ? NO_TOKENS : tokens;

/** A planned (bundle, tool) entry, as {@link recordPlannedInstall} re-records it. */
export interface PlannedRecordInstall {
  bundleId: string;
  tool: string;
  /** The file that holds the entry (BR6.5). */
  location: RecordLocation;
  sourceId: string;
  /** Source decided by the trust gate, in the legacy lockfile shape. */
  source: LockfileSourceEntry;
  /** Source type to record for the entry. */
  sourceType: string;
}

/**
 * Re-record a planned entry after its target's writer wrote it (W5 step 5,
 * W6 step 3). Superseded files are not deleted here: see {@link finishRecordRun}.
 * @param service - Record service of the selection.
 * @param item - The planned entry.
 * @param target - Effective target that wrote it; its root is the workspace root.
 * @param ctx - CLI context; `ctx.cwd()` is the fallback workspace root.
 * @param version - Version written.
 * @param written - The writer's `written` list, absolute paths.
 * @param syncSiblings - Which sibling entries sharing the files to sync (BR8.3).
 * @returns The record change.
 * @throws {RegistryError} A `RECORD.*` error naming the file.
 */
export const recordPlannedInstall = (
  service: InstallRecordService,
  item: PlannedRecordInstall,
  target: Target,
  ctx: Context,
  version: string,
  written: readonly string[],
  syncSiblings: RecordInstallInput['syncSiblings']
): Promise<RecordInstallResult> => service.recordInstall({
  location: item.location,
  bundleId: item.bundleId,
  version,
  tool: item.tool,
  source: { sourceId: item.sourceId, ...item.source },
  sourceType: item.sourceType,
  writtenPaths: written,
  workspaceRoot: target.rootPath ?? ctx.cwd(),
  syncSiblings
});

/**
 * End a replay or update run: remove the superseded files only after every
 * save, keeping any file an entry of either file still lists (FR3.2, NFR4.9).
 * @param service - Record service of the selection.
 * @param changes - Every record change of the run.
 * @returns The warnings of the saves and of the removal.
 */
export const finishRecordRun = async (service: InstallRecordService, changes: readonly RecordInstallResult[]): Promise<string[]> => {
  const removal = await service.deleteSupersededAfterAll(changes);
  return [...changes.flatMap((change) => change.warnings), ...removal.warnings];
};

/** The selected level's old `prompt-registry.*` file and the bundles only it has (BR10.1). */
export interface OldFileOnlyBundles {
  /** Absolute path of the old file. */
  lockPath: string;
  /** The old file, read with today's code. */
  lock: Lockfile;
  /** Ids of the old file's bundles the new record does not have, in file order; may be empty. */
  bundleIds: string[];
}

/**
 * Read the selected level's old file and find the bundles the new record does
 * not have: today's code handles those, on that file, and the record wins for
 * the others (BR10.1; W5 step 6, W6 step 4, W8).
 * @param ctx - CLI context.
 * @param prepared - The command's record selection.
 * @returns The old file and its old-file-only bundles, or `undefined` when there is no readable old file.
 */
export const oldFileOnlyBundles = async (ctx: Context, prepared: PreparedRecordSelection): Promise<OldFileOnlyBundles | undefined> => {
  const lockPath = prepared.selection.oldLockfile;
  const lock = lockPath === undefined ? null : await readLockfile(lockPath, ctx.fs);
  if (lockPath === undefined || lock === null) {
    return undefined;
  }
  const recorded = new Set((await prepared.service.listEntries(prepared.selection.locations)).map((row) => row.bundleId));
  return { lockPath, lock, bundleIds: Object.keys(lock.bundles).filter((bundleId) => !recorded.has(bundleId)) };
};

/** How {@link prepareOldFileOnly} finds the target that writes the old-file-only bundles. */
export interface OldFileTargetInput {
  /** Command name, for the target errors. */
  command: string;
  /** The target to write with, already effective, when the command has one; it is used as is. */
  target?: Target;
  /** `--scope` / `--commit-mode` applied to an inferred target. */
  overrides?: TargetOverrides;
}

/** Old-file-only bundles with the target that writes them, or why no target could be found. */
export type OldFileOnlyPlan = OldFileOnlyBundles & ({ target: Target } | { reason: string });

/**
 * The old-file-only bundles and the target that writes them, as today: the
 * given target, else the only configured target, else the last used one,
 * made effective with the overrides (BR10.1).
 * @param ctx - CLI context.
 * @param prepared - The command's record selection.
 * @param resolve - Command name, the given target and the overrides.
 * @returns The bundles and their target or the reason none was found, or `undefined` when no bundle is only in the old file.
 */
export const prepareOldFileOnly = async (
  ctx: Context,
  prepared: PreparedRecordSelection,
  resolve: OldFileTargetInput
): Promise<OldFileOnlyPlan | undefined> => {
  const old = await oldFileOnlyBundles(ctx, prepared);
  if (old === undefined || old.bundleIds.length === 0) {
    return undefined;
  }
  if (resolve.target !== undefined) {
    return { ...old, target: resolve.target };
  }
  try {
    const targets = await readTargetsSafely(loadTargets(ctx));
    const name = targets.length === 1 ? targets[0].name : await resolveTargetName(undefined, resolve.command, ctx, () => loadTargets(ctx));
    const configured = await resolveTarget(name, resolve.command, ctx, () => loadTargets(ctx));
    return { ...old, target: resolveEffectiveTarget(ctx, configured, resolve.overrides) };
  } catch (error) {
    return { ...old, reason: error instanceof Error ? error.message : String(error) };
  }
};

/** The `level` and `records` fields every record command reports (BR6.3, NFR5.1). */
export interface RecordOutputFields {
  /** Level of the selected record. */
  level: RecordLevel;
  /** Absolute paths of the record files the command read or wrote. */
  records: string[];
}

/**
 * The `level` and `records` JSON fields for a selection: the selected new
 * record files that exist (the first one when none exists yet), or the old
 * store file at user level and for an old-format `--lockfile`.
 * @param selection - The command's record selection.
 * @param fs - Filesystem port, for the existence checks.
 * @param oldFileRead - The old-store file, when the command also read it (`status`):
 * listed after the existing new files, and instead of a new file that does not exist yet.
 * @returns The output fields.
 */
export const recordOutputFields = async (selection: RecordSelection, fs: RecordFs, oldFileRead?: string): Promise<RecordOutputFields> => {
  if (selection.locations.length === 0) {
    return { level: selection.level, records: selection.oldLockfile === undefined ? [] : [selection.oldLockfile] };
  }
  const existing: string[] = [];
  for (const location of selection.locations) {
    if (await fs.exists(location.path)) {
      existing.push(location.path);
    }
  }
  if (oldFileRead !== undefined) {
    existing.push(oldFileRead);
  }
  return { level: selection.level, records: existing.length > 0 ? existing : [selection.locations[0].path] };
};

/**
 * The `Record: <level> <path>` text line (BR6.3); several files are comma-separated.
 * @param fields - Output fields from {@link recordOutputFields}.
 * @returns The line, newline-terminated.
 */
export const renderRecordLine = (fields: RecordOutputFields): string =>
  `Record: ${fields.level} ${fields.records.join(', ')}\n`;
