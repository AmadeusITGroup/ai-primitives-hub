/**
 * Repository-scope install record wiring for CLI `install` and `uninstall`.
 * User scope still uses the old lockfile, and old `prompt-registry.*` files
 * are never touched here.
 * @module framework/install-record
 */
import * as path from 'node:path';
import {
  createInstallRecordServices,
  type InstallRecordService,
  type InstallRecordServices,
  type RecordSourceInput,
  resolveExcludeFile,
} from '@ai-primitives-hub/app';
import {
  compareCodeUnits,
  describeRecordError,
  isRecordError,
  type RecordFs,
  type RecordLocation,
  RegistryError,
  type RepositoryExclusion,
  type Target,
} from '@ai-primitives-hub/core';
import {
  GitInfoExclude,
  NodeRecordFs,
} from '@ai-primitives-hub/infra';
import {
  CLI_VERSION,
} from '../version';
import type {
  Context,
} from './context';

/** Writer stamp for records written by the CLI. */
export const CLI_RECORD_GENERATED_BY = `ai-primitives-hub-cli@${CLI_VERSION}`;

/** A repository install whose record files were loaded and checked before writing. */
export interface PreparedRepositoryRecord {
  /** The file the install is recorded in, from the commit mode. */
  location: RecordLocation;
  /** Service that records the install and removes superseded files. */
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
const toCommandRecordError = (command: string, error: RegistryError, written?: readonly string[]): RegistryError => {
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

/**
 * Record store and service for one CLI command, stamped with {@link CLI_RECORD_GENERATED_BY}.
 * @param fs - Filesystem port.
 */
const createRecordServices = (fs: RecordFs): InstallRecordServices =>
  createInstallRecordServices({ generatedBy: CLI_RECORD_GENERATED_BY, fs });

/** Both repository record files for a target, and the one its commit mode names. */
interface RepositoryRecords extends InstallRecordServices {
  /** Workspace root the writer installs into (where merged MCP config files sit). */
  workspaceRoot: string;
  /** The committed record file at the git root. */
  committed: RecordLocation;
  /** The local-only record file at the git root. */
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
  /** Service that removes the entry and its files. */
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
