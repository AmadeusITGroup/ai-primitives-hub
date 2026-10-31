/**
 * Install record wiring for the CLI: builds the record store and service,
 * selects the record a command acts on and gates record sources. User level
 * records into the shared user record and only reads the old user lockfile;
 * old `prompt-registry.*` files are never touched here.
 * @module framework/install-record
 */
import * as path from 'node:path';
import {
  assertUserFolderInsideHome,
  createInstallRecordServices,
  findLockfile,
  type InstallRecordService,
  type InstallRecordServices,
  type Lockfile,
  type LockfileSourceEntry,
  orderConfiguredSources,
  readLockfile,
  recordIdentityOf,
  type RecordInstallInput,
  type RecordInstallResult,
  type RecordSelection,
  type RecordSourceInput,
  type RecordStore,
  resolveExcludeFile,
  resolveLayoutAsync,
  resolveUserConfigPaths,
  resolveUserHome,
  selectRecord,
  type TargetLayout,
} from '@ai-primitives-hub/app';
import {
  describeRecordError,
  expandPath,
  type InstallationScope,
  isRecordError,
  matchKindRoute,
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
  FileSystemLayoutConfigLoader,
  GitInfoExclude,
  NodeRecordFs,
  resolveUserConfigDir,
  StaticTokenProvider,
  XdgAppStorage,
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

/**
 * The env a target writer expands `${HOME}` and `~` against. For a
 * user-scope target `HOME` is the user level's home from `resolveUserHome`,
 * so an empty `HOME` falls back the same way the pre-write folder check
 * does (NFR4.17); repository and workspace scope get `env` unchanged.
 * @param env - CLI environment (`ctx.env`).
 * @param scope - Effective scope of the target.
 * @returns The env to give the writer.
 */
export const writerEnv = (env: Record<string, string | undefined>, scope: InstallationScope): Record<string, string | undefined> =>
  (scope === 'user' ? { ...env, HOME: resolveUserHome(env) } : env);

/** A repository install whose record files were loaded and checked before writing. */
export interface PreparedRepositoryRecord {
  /** The file the install is recorded in, from the commit mode. */
  location: RecordLocation;
  service: InstallRecordService;
  /** Workspace root the writer installs into (where merged MCP config files sit). */
  workspaceRoot: string;
  /** `info/exclude` section for local-only files; absent at user level. */
  exclusion?: RepositoryExclusion;
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

/**
 * The `info/exclude` section the record store uses at a git root, also in a worktree.
 * @param ctx - CLI context.
 * @param fs - Record filesystem port.
 * @param gitRoot - Git root.
 * @returns The exclusion, or `undefined` without a trusted git directory.
 */
const recordExclusion = async (ctx: Context, fs: RecordFs, gitRoot: string): Promise<RepositoryExclusion | undefined> => {
  const excludeFile = await resolveExcludeFile(fs, gitRoot).catch(() => ({ warning: 'unreadable' }));
  return 'file' in excludeFile
    ? new GitInfoExclude({ fs: ctx.fs, workspaceRoot: gitRoot, excludePath: excludeFile.file })
    : undefined;
};

/** The repository record files a target acts on, and the one it records in. */
interface RepositoryRecords extends InstallRecordServices {
  /** Workspace root the writer installs into (where merged MCP config files sit). */
  workspaceRoot: string;
  /** The record files, committed first. */
  locations: readonly RecordLocation[];
  /** The file the target's commit mode names, or the first one given. */
  location: RecordLocation;
  /** The `info/exclude` section in the file the record store uses. */
  exclusion: RepositoryExclusion;
}

/**
 * Build the record services and locate the repository record files. Without
 * `given`, both files at the git root are loaded and checked first.
 * @param ctx - CLI context.
 * @param target - Repository-scope target.
 * @param fs - Filesystem port.
 * @param given - Record files already selected; both files at the git root otherwise.
 */
const openRepositoryRecords = async (
  ctx: Context,
  target: Target,
  fs: RecordFs,
  given?: readonly RecordLocation[]
): Promise<RepositoryRecords> => {
  const services = createRecordServices(fs);
  const workspaceRoot = target.rootPath ?? ctx.cwd();
  const { locations, location } = given === undefined || given.length === 0
    ? await services.store.loadRepository({ start: workspaceRoot, commitMode: target.commitMode })
    : { locations: given, location: given[0] };
  return {
    ...services,
    workspaceRoot,
    locations,
    location,
    exclusion: (await recordExclusion(ctx, fs, location.root)) ?? new GitInfoExclude({ fs: ctx.fs, workspaceRoot })
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
/**
 * The layout a user-scope target writes with and its base folder, with `HOME` set to home.
 * @param ctx - CLI context.
 * @param target - User-scope target.
 * @param home - Home folder.
 */
const resolveUserTargetLayout = async (
  ctx: Context,
  target: Target,
  home: string
): Promise<{ layout: TargetLayout; baseDir: string }> => {
  const loader = new FileSystemLayoutConfigLoader({ cwd: ctx.cwd(), fs: ctx.fs, userConfigDir: resolveUserConfigDir(ctx.env) });
  const layout = await resolveLayoutAsync(target, loader);
  return { layout, baseDir: path.resolve(expandPath(layout.baseDir, { ...ctx.env, HOME: home })) };
};

/**
 * Load and check the shared user record and refuse a target folder outside
 * home before anything is written.
 * @param ctx - CLI context.
 * @param target - User-scope target.
 * @param fs - Filesystem port.
 * @throws {RegistryError} A `RECORD.*` error naming the file or folder; nothing was written.
 */
export const prepareUserRecord = async (
  ctx: Context,
  target: Target,
  fs: RecordFs = new NodeRecordFs()
): Promise<PreparedRepositoryRecord> => {
  const { store, service } = createRecordServices(fs);
  const home = resolveUserHome(ctx.env);
  try {
    const location = store.resolveUser({ home, path: new XdgAppStorage(ctx.env).getPaths().userRecord });
    await store.load(location);
    const { layout, baseDir } = await resolveUserTargetLayout(ctx, target, home);
    const routes = Object.values(layout.kindRoutes);
    const folders = new Set(routes.length === 0 ? [baseDir] : routes.map((route) => path.join(baseDir, route)));
    for (const folder of folders) {
      await assertUserFolderInsideHome(fs, home, folder);
    }
    return { location, service, workspaceRoot: home };
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
  /** `info/exclude` section local-only files are listed in; absent at user level. */
  exclusion?: RepositoryExclusion;
  /** Bundles with an entry for `tool` in either file, sorted, with their recorded paths. */
  entries: Map<string, string[]>;
  /** User level only: per bundle, paths the old user lockfile still lists; kept on uninstall. */
  keepPaths?: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Outcome of `recordRepositoryUninstall`. */
export interface RecordedRepositoryUninstall {
  /** Absolute path of the record file the entry was removed from (it may now be deleted). */
  lockfile: string;
  /** Root-relative files that were removed. */
  removed: string[];
  /** Root-relative files kept: another entry still lists them, or they were changed or missing since the install. */
  kept: string[];
  /** Non-fatal problems: skipped deletions or a record file that could not be removed. */
  warnings: string[];
}

/**
 * Load and check the repository record files before anything is removed.
 * Bundles not in `entries` fall back to the old store.
 * @param ctx - CLI context.
 * @param target - Repository-scope target.
 * @param options - Record files already selected (`uninstall --lockfile`).
 * @param options.locations - The selected record files.
 * @param fs - Filesystem port.
 * @throws {RegistryError} A `RECORD.*` error naming the file; nothing was removed.
 */
export const prepareRepositoryUninstall = async (
  ctx: Context,
  target: Target,
  options: { locations?: readonly RecordLocation[] } = {},
  fs: RecordFs = new NodeRecordFs()
): Promise<PreparedRepositoryUninstall> => {
  try {
    const { service, locations, location, exclusion } = await openRepositoryRecords(ctx, target, fs, options.locations);
    return {
      location,
      service,
      tool: target.type,
      exclusion,
      entries: await service.entriesForTool(locations, target.type)
    };
  } catch (error) {
    throw isRecordError(error) ? toCommandRecordError('uninstall', error) : error;
  }
};

/**
/**
 * Per bundle, the home-relative paths the old user lockfile lists for a
 * user-scope target, resolved as the old uninstall does.
 * @param ctx - CLI context.
 * @param target - User-scope target.
 * @param home - Home folder.
 */
const oldUserLockfilePaths = async (ctx: Context, target: Target, home: string): Promise<Map<string, Set<string>>> => {
  const out = new Map<string, Set<string>>();
  const lock = await readLockfile(resolveUserConfigPaths(ctx.env).userLockfile, ctx.fs);
  if (lock === null || Object.keys(lock.bundles).length === 0) {
    return out;
  }
  const { layout, baseDir } = await resolveUserTargetLayout(ctx, target, home);
  for (const [bundleId, entry] of Object.entries(lock.bundles)) {
    const paths = new Set<string>();
    for (const file of entry.files) {
      let absolute: string | undefined;
      if (file.installedPath === undefined) {
        const route = matchKindRoute(file.path, layout.kindRoutes);
        absolute = route === null ? undefined : path.join(baseDir, route.outPrefix, route.tail);
      } else {
        absolute = path.join(baseDir, file.installedPath);
      }
      if (absolute !== undefined) {
        paths.add(path.relative(home, path.resolve(absolute)).split(path.sep).join('/'));
      }
    }
    out.set(bundleId, paths);
  }
  return out;
};

/**
 * Load and check the shared user record before anything is removed. Bundles
 * not recorded there fall back to the old user lockfile.
 * @param ctx - CLI context.
 * @param target - User-scope target.
 * @param fs - Filesystem port.
 * @throws {RegistryError} A `RECORD.*` error naming the file; nothing was removed.
 */
export const prepareUserUninstall = async (
  ctx: Context,
  target: Target,
  fs: RecordFs = new NodeRecordFs()
): Promise<PreparedRepositoryUninstall> => {
  const { store, service } = createRecordServices(fs);
  const home = resolveUserHome(ctx.env);
  try {
    const location = store.resolveUser({ home, path: new XdgAppStorage(ctx.env).getPaths().userRecord });
    const { record } = await store.load(location);
    const entries = new Map<string, string[]>();
    for (const bundleId of Object.keys(record.bundles).toSorted()) {
      const tools = record.bundles[bundleId].tools;
      if (Object.hasOwn(tools, target.type)) {
        entries.set(bundleId, tools[target.type].files.map((file) => file.path));
      }
    }
    const keepPaths = entries.size === 0 ? new Map<string, Set<string>>() : await oldUserLockfilePaths(ctx, target, home);
    return { location, service, tool: target.type, entries, keepPaths };
  } catch (error) {
    throw isRecordError(error) ? toCommandRecordError('uninstall', error) : error;
  }
};

/**
 * Remove one bundle's entry for the target's type, then delete its files except
 * those another entry lists or that changed since the install (each kept with a warning).
 * @param prepared - From {@link prepareRepositoryUninstall}.
 * @param bundleId - Bundle to uninstall.
 * @throws {RegistryError} `RECORD.ENTRY_NOT_FOUND` or another `RECORD.*` error naming the file.
 */
export const recordRepositoryUninstall = async (
  prepared: PreparedRepositoryUninstall,
  bundleId: string
): Promise<RecordedRepositoryUninstall> => {
  let result;
  try {
    result = await prepared.service.uninstallEntry({
      location: prepared.location,
      bundleId,
      tool: prepared.tool,
      // Files the old user lockfile still lists stay on disk for it.
      keep: prepared.keepPaths?.get(bundleId)
    });
  } catch (error) {
    throw isRecordError(error) ? toCommandRecordError('uninstall', error) : error;
  }
  const { change, deleted } = result;
  const warnings = [...result.warnings, ...result.modified.map((file) => `Did not remove ${file}: it was changed after install.`)];
  if (change.location.commitMode === 'local-only' && deleted.length > 0 && prepared.exclusion !== undefined) {
    // Drop the removed files' `info/exclude` entries, as the old uninstall did.
    try {
      await prepared.exclusion.remove(deleted.map((relative) => path.join(change.location.root, ...relative.split('/'))));
    } catch (error) {
      warnings.push(`Could not update .git/info/exclude: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    lockfile: change.location.path,
    removed: deleted,
    kept: result.kept,
    warnings
  };
};

/** What a command was given that fixes the record level. */
export interface RecordSelectionInput {
  /** Command name, the prefix of a `RECORD.*` error message. */
  command: string;
  /** `--lockfile <path>` as typed. */
  lockfile?: string;
  scope?: InstallationScope;
}

/** A selected record with the store and service to act on it. */
export interface PreparedRecordSelection {
  selection: RecordSelection;
  store: RecordStore;
  service: InstallRecordService;
  fs: RecordFs;
  /** `info/exclude` section at the repository record's root, for the writers; absent at user level. */
  exclusion?: RepositoryExclusion;
}

/**
 * Select the record a command acts on and load every selected file before anything is written.
 * @param ctx - CLI context.
 * @param input - Command name, `--lockfile` and `--scope`.
 * @param target - Resolved target, when the command has one.
 * @param fs - Filesystem port.
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
      userLockfile,
      userRecord: new XdgAppStorage(ctx.env).getPaths().userRecord,
      home: resolveUserHome(ctx.env)
    });
    const exclusion = selection.level === 'repository' && selection.locations.length > 0
      ? await recordExclusion(ctx, fs, selection.root)
      : undefined;
    return { selection, store, service, fs, ...(exclusion === undefined ? {} : { exclusion }) };
  } catch (error) {
    throw isRecordError(error) ? toCommandRecordError(input.command, error) : error;
  }
};

/**
 * Configured sources by id for the source trust gate, in `orderConfiguredSources`
 * order. A hub that cannot be read contributes no source.
 * @param ctx - CLI context.
 */
export const configuredSources = async (ctx: Context): Promise<Map<string, RegistrySource>> => {
  const manager = createHubManager({ ctx });
  // No readable active hub pointer: no source counts as the active hub's.
  const activeHubId = await manager.getActiveHubId().catch(() => null);
  const ordered = orderConfiguredSources(await manager.listSourcesAcrossAllHubs(), activeHubId);
  return new Map(ordered.map((source) => [source.id, source]));
};

/** Token provider that never returns a token. */
const NO_TOKENS: TokenProvider = new StaticTokenProvider('');

/**
 * The token provider for a planned entry: none for a source taken from the record.
 * @param tokens - The command's token provider.
 * @param fromRecordOnly - `true` when no configured source has the entry's id.
 */
export const tokensForRecordSource = (tokens: TokenProvider, fromRecordOnly: boolean): TokenProvider =>
  fromRecordOnly ? NO_TOKENS : tokens;

/** A planned (bundle, tool) entry, as {@link recordPlannedInstall} re-records it. */
export interface PlannedRecordInstall {
  bundleId: string;
  tool: string;
  /** The file that holds the entry. */
  location: RecordLocation;
  sourceId: string;
  /** Source decided by the trust gate, in the legacy lockfile shape. */
  source: LockfileSourceEntry;
  sourceType: string;
}

/**
 * Re-record a planned entry after its writer ran; {@link finishRecordRun} deletes superseded files.
 * @param service - Record service.
 * @param item - The planned entry.
 * @param target - Effective target that wrote it.
 * @param ctx - CLI context.
 * @param version - Version written.
 * @param written - The writer's `written` list.
 * @param syncSiblings - Which sibling entries to sync.
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
  // User level: home is the workspace root, as the user-scope install records it.
  workspaceRoot: item.location.level === 'user' ? item.location.root : (target.rootPath ?? ctx.cwd()),
  syncSiblings
});

/**
 * End a replay or update run: remove superseded files after every save, keeping still-listed ones.
 * @param service - Record service.
 * @param changes - Every record change of the run.
 * @returns The warnings of the saves and of the removal.
 */
export const finishRecordRun = async (service: InstallRecordService, changes: readonly RecordInstallResult[]): Promise<string[]> => {
  const removal = await service.deleteSupersededAfterAll(changes);
  return [...changes.flatMap((change) => change.warnings), ...removal.warnings];
};

/** The selected level's old `prompt-registry.*` file and the bundles only it has. */
export interface OldFileOnlyBundles {
  lockPath: string;
  lock: Lockfile;
  /** Ids of the old file's bundles the record does not have at any version, in file order. */
  bundleIds: string[];
}

/**
 * The bundles only the old file has; the old code handles them, and the record wins for the others.
 * @param ctx - CLI context.
 * @param prepared - The command's record selection.
 * @returns `undefined` when there is no readable old file.
 */
export const oldFileOnlyBundles = async (ctx: Context, prepared: PreparedRecordSelection): Promise<OldFileOnlyBundles | undefined> => {
  const lockPath = prepared.selection.oldLockfile;
  const lock = lockPath === undefined ? null : await readLockfile(lockPath, ctx.fs);
  if (lockPath === undefined || lock === null) {
    return undefined;
  }
  const rows = await prepared.service.listEntries(prepared.selection.locations);
  const recordedIds = new Set(rows.map((row) => row.bundleId));
  const recordedIdentities = new Set(rows.map((row) => recordIdentityOf(row.bundleId, row.version)));
  const onlyOld = (bundleId: string): boolean =>
    !recordedIds.has(bundleId) && !recordedIdentities.has(recordIdentityOf(bundleId, lock.bundles[bundleId].version));
  return { lockPath, lock, bundleIds: Object.keys(lock.bundles).filter((bundleId) => onlyOld(bundleId)) };
};

/** How {@link prepareOldFileOnly} finds the target that writes the old-file-only bundles. */
export interface OldFileTargetInput {
  /** Command name, for the target errors. */
  command: string;
  /** Effective target to write with, used as is. */
  target?: Target;
  /** `--scope` / `--commit-mode` applied to an inferred target. */
  overrides?: TargetOverrides;
}

/** Old-file-only bundles with the target that writes them, or why no target could be found. */
export type OldFileOnlyPlan = OldFileOnlyBundles & ({ target: Target } | { reason: string });

/**
 * The old-file-only bundles and their target: the given one, else the only configured one, else the last used one.
 * @param ctx - CLI context.
 * @param prepared - The command's record selection.
 * @param resolve - Command name, the given target and the overrides.
 * @returns `undefined` when no bundle is only in the old file.
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

/** The `level` and `records` fields every record command reports. */
export interface RecordOutputFields {
  level: RecordLevel;
  /** Absolute paths of the record files the command read or wrote. */
  records: string[];
}

/**
 * The `level` and `records` JSON fields: the record files that exist, or the old file.
 * @param selection - The command's record selection.
 * @param fs - Filesystem port.
 * @param oldFileRead - The old file, when the command also read it.
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
 * The `Record: <level> <path>` text line; several files are comma-separated.
 * @param fields - Output fields.
 */
export const renderRecordLine = (fields: RecordOutputFields): string =>
  `Record: ${fields.level} ${fields.records.join(', ')}\n`;
