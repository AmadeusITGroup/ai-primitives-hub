/**
 * Repository-scope install record wiring for CLI `install` (workflow W1;
 * BR2.1–BR2.4, BR3.3–BR3.5, BR4.2).
 *
 * This is the CLI composition root for the install record: it builds a
 * `RecordStore` and an `InstallRecordService` on `NodeRecordFs` and the
 * 3.0.0 `RecordSchemaValidator`, stamped `ai-primitives-hub-cli@<version>`.
 * Only repository-scope installs use it; user scope keeps the old lockfile
 * path until U4. Old `prompt-registry.*` files are never read, changed or
 * deleted here (BR2.4).
 * @module framework/install-record
 */
import * as path from 'node:path';
import {
  InstallRecordService,
  type RecordSourceInput,
  RecordStore,
} from '@ai-primitives-hub/app';
import {
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
  RecordSchemaValidator,
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
  /** The file the install is recorded in, from the commit mode (BR2.2). */
  location: RecordLocation;
  /** Service that records the install and removes superseded files. */
  service: InstallRecordService;
  /** Workspace root the writer installs into (where merged MCP config files sit). */
  workspaceRoot: string;
}

/** What `recordRepositoryInstall` records. */
export interface RepositoryInstallToRecord {
  bundleId: string;
  version: string;
  /** The target's type (BR1.2). */
  tool: string;
  /** Full source details (BR3.2). */
  source: RecordSourceInput;
  /** The writer's `written` list, absolute paths (BR1.7). */
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
 * Re-raise a record error with the command name and its file in the message,
 * so text output shows it next to the code (BR4.2). Code, hint and context are kept.
 * @param command - Command name used as the message prefix.
 * @param error - A `RECORD.*` error.
 * @param written - Files already written, for an install that failed after the write.
 * @returns The error to throw.
 */
const toCommandRecordError = (command: string, error: RegistryError, written?: readonly string[]): RegistryError => {
  const file = typeof error.context?.file === 'string' ? error.context.file : undefined;
  const detail = typeof error.context?.detail === 'string' ? error.context.detail : undefined;
  let message = `${command}: ${error.message}`;
  if (file !== undefined) {
    message += ` File: ${file}.`;
  }
  if (detail !== undefined) {
    message += ` Reason: ${detail}.`;
  }
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
 * Re-raise a record error with its file in the message, so text output shows
 * it next to the code (BR4.2). Code, hint and context are kept.
 * @param error - A `RECORD.*` error.
 * @param written - Files the writer already put down, when the failure came after the write (BR3.5).
 * @returns The error to throw.
 */
export const toInstallRecordError = (error: RegistryError, written?: readonly string[]): RegistryError =>
  toCommandRecordError('install', error, written);

/**
 * Load and check both repository record files before anything is written
 * (W1 steps 2–4, BR3.5). Call only for repository-scope targets.
 * @param ctx - CLI context; `ctx.cwd()` is the fallback start folder.
 * @param target - Effective repository-scope target.
 * @param fs - Filesystem port; `NodeRecordFs` unless a test passes one.
 * @returns The location to record in and the service to record with.
 * @throws {RegistryError} A `RECORD.*` error naming the file; nothing was written.
 */
export const prepareRepositoryRecord = async (
  ctx: Context,
  target: Target,
  fs: RecordFs = new NodeRecordFs()
): Promise<PreparedRepositoryRecord> => {
  const store = new RecordStore({ fs, validator: new RecordSchemaValidator(), generatedBy: CLI_RECORD_GENERATED_BY });
  const service = new InstallRecordService({ store, fs });
  const workspaceRoot = target.rootPath ?? ctx.cwd();
  try {
    const [committed, localOnly] = await store.resolveRepository({ start: workspaceRoot });
    await store.load(committed);
    await store.load(localOnly);
    return { location: target.commitMode === 'local-only' ? localOnly : committed, service, workspaceRoot };
  } catch (error) {
    throw isRecordError(error) ? toInstallRecordError(error) : error;
  }
};

/**
 * Record a repository install, then remove the files it superseded
 * (W1 steps 6–13). A failure here leaves the written files in place and the
 * error lists them (BR3.5).
 * @param prepared - Result of {@link prepareRepositoryRecord}.
 * @param install - What was installed.
 * @returns The record path, removed files and warnings.
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
  /** Tool key: the target's type (BR1.2). */
  tool: string;
  /** `.git/info/exclude` section the repository-scope writer lists local-only files in. */
  exclusion: RepositoryExclusion;
  /**
   * Bundles with an entry for `tool` in either file, sorted, mapped to their
   * recorded root-relative paths (both files merged).
   */
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
 * Load and check both repository record files before anything is removed
 * (repository-scope uninstall, FR4.1 U1 part). Call only for repository-scope
 * targets. A bundle with no entry for the target's type here is not in the
 * map, so the caller can fall back to the old store for it.
 * @param ctx - CLI context; `ctx.cwd()` is the fallback start folder.
 * @param target - Effective repository-scope target.
 * @param fs - Filesystem port; `NodeRecordFs` unless a test passes one.
 * @returns The location, service, tool and the bundles recorded for that tool.
 * @throws {RegistryError} A `RECORD.*` error naming the file; nothing was removed.
 */
export const prepareRepositoryUninstall = async (
  ctx: Context,
  target: Target,
  fs: RecordFs = new NodeRecordFs()
): Promise<PreparedRepositoryUninstall> => {
  const store = new RecordStore({ fs, validator: new RecordSchemaValidator(), generatedBy: CLI_RECORD_GENERATED_BY });
  const service = new InstallRecordService({ store, fs });
  const workspaceRoot = target.rootPath ?? ctx.cwd();
  try {
    const [committed, localOnly] = await store.resolveRepository({ start: workspaceRoot });
    const entries = new Map<string, string[]>();
    for (const location of [committed, localOnly]) {
      const { record } = await store.load(location);
      for (const [bundleId, bundle] of Object.entries(record.bundles)) {
        if (!Object.hasOwn(bundle.tools, target.type)) {
          continue;
        }
        const paths = bundle.tools[target.type].files.map((file) => file.installedPath);
        entries.set(bundleId, [...new Set([...(entries.get(bundleId) ?? []), ...paths])]);
      }
    }
    return {
      location: target.commitMode === 'local-only' ? localOnly : committed,
      service,
      tool: target.type,
      // Same adapter and root the repository-scope writer used at install time.
      exclusion: new GitInfoExclude({ fs: ctx.fs, workspaceRoot }),
      entries: new Map([...entries].toSorted(([left], [right]) => (left < right ? -1 : (left > right ? 1 : 0))))
    };
  } catch (error) {
    throw isRecordError(error) ? toCommandRecordError('uninstall', error) : error;
  }
};

/**
 * Remove one bundle's entry for the target's type from the repository
 * records, then delete its files except those another entry still lists.
 * @param prepared - Result of {@link prepareRepositoryUninstall}.
 * @param bundleId - Bundle to uninstall.
 * @returns The record path, removed and kept files, and warnings.
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
    // A local-only install listed its files in `.git/info/exclude`; drop the
    // entries of the files removed, as the old uninstall path did.
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
