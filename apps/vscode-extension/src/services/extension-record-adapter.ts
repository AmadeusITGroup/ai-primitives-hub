/**
 * Extension record adapter: the extension's composition of the shared install
 * record. Records every repository install under the host tool and reads and
 * changes the old `prompt-registry.lock.json` files; the record logic lives in app.
 * @module services/extension-record-adapter
 */
import * as path from 'node:path';
import {
  cleanupOrphanedSource,
  createInstallRecordServices,
  deleteLockfile,
  emptyLockfile,
  findModifiedFiles,
  getLockfilePathForMode,
  type InstallRecordService,
  isAnyFileMissing,
  listedPaths,
  type LocatedToolEntry,
  type Lockfile,
  type LockfileBundleEntry,
  type LockfileFs,
  orderConfiguredSources,
  readLockfile,
  RECORD_SOURCE_TYPES,
  type RecordSourceDescriptor,
  type RecordSourceInput,
  type RecordStore,
  remapSourceId,
  removeBundleEntry,
  toRecordSource,
  upsertBundleEntry,
  upsertSource,
  writeFileAtomically,
  writeLockfile,
} from '@ai-primitives-hub/app';
import {
  describeRecordError,
  isRecordError,
  type LockfileSourceDescriptor,
  recordErrorDetails,
  type RecordFs,
  type RecordLocation,
  type RegistrySource,
  type TargetType,
} from '@ai-primitives-hub/core';
import * as vscode from 'vscode';
import type {
  InstalledBundle,
  RepositoryCommitMode,
} from '../types/registry';
import {
  type CliManagedAction,
  cliManagedError,
  markErrorShown,
  wasErrorShown,
} from '../utils/cli-managed';
import {
  detectHostApp,
} from '../utils/host-app';
import {
  Logger,
} from '../utils/logger';
import {
  getExtensionRecordGeneratedBy,
} from './install-record-listing';
import {
  createInstalledBundleFromLockfile,
} from './installed-bundle-from-entry';

/** Largest old lockfile read, in bytes. */
const OLD_LOCKFILE_MAX_BYTES = 10 * 1024 * 1024;

/** Where configured sources come from. */
export interface RecordSourcesPort {
  /** Every stored source, hub and detached ones included. */
  listSources(): Promise<RegistrySource[]>;
  /** Active hub id, when a hub is active. */
  getActiveHubId?(): Promise<string | null>;
}

/** Dependencies of an {@link ExtensionRecordAdapter}. */
export interface ExtensionRecordAdapterOptions {
  sources: RecordSourcesPort;
  /** Filesystem port; `NodeRecordFs` by default. */
  fs?: RecordFs;
  /** Host tool; `detectHostApp()` by default. */
  hostTool?: TargetType;
}

/** One old `prompt-registry` lockfile at a workspace root. */
export interface OldLockfile {
  path: string;
  commitMode: RepositoryCommitMode;
  /** Parsed content; `null` when absent or unreadable. */
  lock: Lockfile | null;
}

/** A bundle entry of an old `prompt-registry` lockfile, with the file holding it. */
export interface OldBundleEntry {
  old: OldLockfile & { lock: Lockfile };
  entry: LockfileBundleEntry;
}

/** Outcome of {@link ExtensionRecordAdapter.retireOldEntry}. */
export interface RetiredOldEntry {
  /** Workspace-relative files removed. */
  deleted: string[];
  /** Workspace-relative files kept: listed by another entry, or modified. */
  kept: string[];
  warnings: string[];
}

const toSlashes = (recordedPath: string): string => recordedPath.replaceAll('\\', '/');

/** `LockfileFs` over `RecordFs`, writing atomically. */
class RecordLockfileFs implements LockfileFs {
  public constructor(private readonly fs: RecordFs) {}

  public async readFile(file: string): Promise<string> {
    return new TextDecoder('utf-8').decode(await this.fs.readCapped(file, OLD_LOCKFILE_MAX_BYTES));
  }

  public writeFile(file: string, contents: string): Promise<void> {
    return writeFileAtomically(this.fs, file, contents);
  }

  public exists(file: string): Promise<boolean> {
    return this.fs.exists(file);
  }

  public remove(file: string): Promise<void> {
    return this.fs.unlink(file);
  }
}

/** The extension's composition of the shared install record. */
export class ExtensionRecordAdapter {
  public readonly fs: RecordFs;
  public readonly store: RecordStore;
  public readonly service: InstallRecordService;
  /** The tool every extension install is recorded under. */
  public readonly hostTool: TargetType;
  private readonly sources: RecordSourcesPort;
  private readonly lockfileFs: LockfileFs;
  private readonly logger = Logger.getInstance();

  public constructor(options: ExtensionRecordAdapterOptions) {
    const services = createInstallRecordServices({ generatedBy: getExtensionRecordGeneratedBy(), fs: options.fs });
    this.fs = services.fs;
    this.store = services.store;
    this.service = services.service;
    this.hostTool = options.hostTool ?? detectHostApp();
    this.sources = options.sources;
    this.lockfileFs = new RecordLockfileFs(this.fs);
  }

  // An I/O error other than "missing" is logged and counts as present.
  private anyMissing(root: string, paths: readonly string[]): Promise<boolean> {
    return isAnyFileMissing(this.fs, root, paths, (recordedPath, error) =>
      this.logger.warn(`Failed to check file existence for ${recordedPath}:`, error instanceof Error ? error : undefined));
  }

  private async saveOldLockfile(file: string, lock: Lockfile): Promise<void> {
    await (Object.keys(lock.bundles).length === 0
      ? deleteLockfile(file, this.lockfileFs)
      : writeLockfile(file, lock, this.lockfileFs));
  }

  /**
   * Both old `prompt-registry` lockfiles of a workspace folder, committed first;
   * an unreadable one has `lock: null`.
   * @param workspaceFolder - Absolute workspace folder path.
   */
  public async readOldLockfiles(workspaceFolder: string): Promise<OldLockfile[]> {
    const files: OldLockfile[] = [];
    for (const commitMode of ['commit', 'local-only'] as const) {
      const file = getLockfilePathForMode(workspaceFolder, commitMode);
      let lock: Lockfile | null = null;
      try {
        lock = await readLockfile(file, this.lockfileFs);
      } catch (error) {
        this.logger.warn(`Could not read ${path.basename(file)}:`, error instanceof Error ? error : undefined);
      }
      files.push({ path: file, commitMode, lock });
    }
    return files;
  }

  /**
   * Record root of a workspace folder: its git root, or the folder itself.
   * @param workspaceFolder - Absolute workspace folder path.
   */
  public async resolveRoot(workspaceFolder: string): Promise<string> {
    const [committed] = await this.store.resolveRepository({ start: workspaceFolder });
    return committed.root;
  }

  /**
   * Both repository record files of a workspace folder, committed first.
   * @param workspaceFolder - Workspace folder.
   */
  public locations(workspaceFolder: string): Promise<[RecordLocation, RecordLocation]> {
    return this.store.resolveRepository({ start: workspaceFolder });
  }

  /**
   * Load and check both record files before an install writes anything, and
   * give the file for the commit mode.
   * @param workspaceFolder - Absolute workspace folder path.
   * @param commitMode - Commit mode of the install.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async prepareInstall(workspaceFolder: string, commitMode: RepositoryCommitMode): Promise<RecordLocation> {
    return (await this.store.loadRepository({ start: workspaceFolder, commitMode })).location;
  }

  /**
   * Every tool entry of a bundle in both record files, committed file first.
   * @param workspaceFolder - Absolute workspace folder path.
   * @param bundleId - Bundle id.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async findEntries(workspaceFolder: string, bundleId: string): Promise<LocatedToolEntry[]> {
    return this.service.findEntries(await this.locations(workspaceFolder), bundleId);
  }

  /**
   * The host tool's entry of a bundle, from the committed file when both hold it.
   * @param workspaceFolder - Absolute workspace folder path.
   * @param bundleId - Bundle id.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async findHostEntry(workspaceFolder: string, bundleId: string): Promise<LocatedToolEntry | undefined> {
    return (await this.service.findEntries(await this.locations(workspaceFolder), bundleId, this.hostTool))[0];
  }

  /**
   * Every tool entry of every bundle in both record files, committed file first.
   * @param workspaceFolder - Absolute workspace folder path.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async listAllEntries(workspaceFolder: string): Promise<LocatedToolEntry[]> {
    return this.service.listToolEntries(await this.locations(workspaceFolder));
  }

  /**
   * Every root-relative path an entry of one record file lists.
   * @param location - Record file.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async listedPathsIn(location: RecordLocation): Promise<Set<string>> {
    return listedPaths([(await this.store.load(location)).record]);
  }

  /**
   * Refuse an action on a bundle whose record entries all belong to another
   * tool. Old-file rows have no tool and count as the host's own.
   * @param bundleId - Bundle the action targets.
   * @param action - The action, for the message.
   * @param workspaceFolder - Absolute workspace folder path.
   * @throws {RegistryError} `RECORD.CLI_MANAGED` naming the tool; any `RECORD.*` error from loading.
   */
  public async assertHostTool(bundleId: string, action: CliManagedAction, workspaceFolder: string): Promise<void> {
    const tools = (await this.findEntries(workspaceFolder, bundleId)).map((located) => located.tool);
    if (tools.length === 0 || tools.includes(this.hostTool)) {
      return;
    }
    throw cliManagedError(bundleId, action, tools.toSorted()[0]);
  }

  /** Configured sources in lookup order, one per id: active hub, detached, then any other. */
  public async configuredSources(): Promise<RegistrySource[]> {
    const activeHubId = (await this.sources.getActiveHubId?.()) ?? null;
    return orderConfiguredSources(await this.sources.listSources(), activeHubId, { includeOtherHubs: true });
  }

  /**
   * The source an install records: the configured source with this id, as the CLI records it.
   * @param sourceId - Source id of the bundle.
   * @throws {Error} When the id is unknown or its type is not a `SourceType`.
   */
  public async buildSource(sourceId: string | undefined): Promise<RecordSourceInput> {
    const configured = sourceId === undefined ? undefined : (await this.configuredSources()).find((candidate) => candidate.id === sourceId);
    if (configured === undefined || !(RECORD_SOURCE_TYPES as readonly string[]).includes(configured.type)) {
      throw new Error(`source ${sourceId ?? '(none)'} is not configured; add it or reinstall from a configured source`);
    }
    return { ...toRecordSource(configured, configured.id) };
  }

  /**
   * Show a `RECORD.*` error once, as a notification with "Open file" and the detail in the log.
   * @param error - Anything thrown.
   * @param written - Absolute files written before the error, left in place.
   * @param root - Record root, to open a file named relative to it.
   * @returns `true` when it was a `RECORD.*` error other than `RECORD.CLI_MANAGED`.
   */
  public showRecordError(error: unknown, written: readonly string[] = [], root?: string): boolean {
    if (!isRecordError(error) || error.code === 'RECORD.CLI_MANAGED') {
      // The other-tool refusal is a warning, shown by `showCliManagedWarning`.
      return false;
    }
    if (wasErrorShown(error)) {
      return true;
    }
    const { file } = recordErrorDetails(error);
    const message = [
      describeRecordError(error),
      written.length === 0 ? '' : `These files were written and left in place: ${written.join(', ')}.`,
      error.hint ?? ''
    ].filter((part) => part !== '').join(' ');
    this.logger.error(`${error.code}: ${message}`, error);
    markErrorShown(error);
    const target = file === undefined || (!path.isAbsolute(file) && root === undefined) ? undefined : path.resolve(root ?? '', file);
    const actions = target === undefined ? [] : ['Open file'];
    void Promise.resolve(vscode.window.showErrorMessage(message, ...actions)).then((choice) => {
      if (choice === 'Open file' && target !== undefined) {
        void vscode.window.showTextDocument(vscode.Uri.file(target));
      }
    });
    return true;
  }

  /**
   * Bundles of the old `prompt-registry` lockfiles, as listing items, committed file first.
   * @param workspaceFolder - Absolute workspace folder path.
   */
  public async listOldBundles(workspaceFolder: string): Promise<InstalledBundle[]> {
    const bundles: InstalledBundle[] = [];
    const seen = new Set<string>();
    for (const old of await this.readOldLockfiles(workspaceFolder)) {
      for (const [bundleId, entry] of Object.entries(old.lock?.bundles ?? {})) {
        if (seen.has(bundleId)) {
          this.logger.error(`Bundle ${bundleId} exists in both lockfiles - manual resolution required`);
          continue;
        }
        seen.add(bundleId);
        bundles.push(createInstalledBundleFromLockfile(bundleId, entry, {
          installPath: path.join(workspaceFolder, '.github'),
          filesMissing: await this.anyMissing(workspaceFolder, entry.files.map((file) => toSlashes(file.path))),
          commitModeOverride: old.commitMode
        }));
      }
    }
    return bundles;
  }

  /**
   * A bundle's entry in the old `prompt-registry` lockfiles, committed file first.
   * @param workspaceFolder - Absolute workspace folder path.
   * @param bundleId - Bundle id.
   */
  public async findOldEntry(workspaceFolder: string, bundleId: string): Promise<OldBundleEntry | undefined> {
    for (const old of await this.readOldLockfiles(workspaceFolder)) {
      if (old.lock !== null && Object.hasOwn(old.lock.bundles, bundleId)) {
        return { old: { ...old, lock: old.lock }, entry: old.lock.bundles[bundleId] };
      }
    }
    return undefined;
  }

  /**
   * Remove a bundle's entry from the old lockfile holding it, without touching installed files.
   * @param workspaceFolder - Absolute workspace folder path.
   * @param bundleId - Bundle id.
   * @returns Whether an entry was removed.
   */
  public async removeOldEntry(workspaceFolder: string, bundleId: string): Promise<boolean> {
    const found = await this.findOldEntry(workspaceFolder, bundleId);
    if (found === undefined) {
      return false;
    }
    const updated = cleanupOrphanedSource(removeBundleEntry(found.old.lock, bundleId), found.entry.sourceId);
    await this.saveOldLockfile(found.old.path, updated);
    return true;
  }

  /**
   * Move an old-file-only bundle's entry, with its source, to the old lockfile
   * of the other commit mode, saving the target first.
   * @param workspaceFolder - Absolute workspace folder path.
   * @param bundleId - Bundle id.
   * @param commitMode - Commit mode to move to.
   * @returns Whether an entry was moved.
   */
  public async moveOldEntry(workspaceFolder: string, bundleId: string, commitMode: RepositoryCommitMode): Promise<boolean> {
    const found = await this.findOldEntry(workspaceFolder, bundleId);
    if (found === undefined || found.old.commitMode === commitMode) {
      return false;
    }
    const targetPath = getLockfilePathForMode(workspaceFolder, commitMode);
    const target = (await readLockfile(targetPath, this.lockfileFs)) ?? emptyLockfile(found.old.lock.generatedBy);
    const { commitMode: _deprecated, ...entry } = found.entry;
    let moved = upsertBundleEntry(target, bundleId, entry);
    const source = found.old.lock.sources[found.entry.sourceId];
    if (source !== undefined) {
      moved = upsertSource(moved, found.entry.sourceId, source);
    }
    await writeLockfile(targetPath, moved, this.lockfileFs);
    await this.saveOldLockfile(found.old.path, cleanupOrphanedSource(removeBundleEntry(found.old.lock, bundleId), found.entry.sourceId));
    return true;
  }

  /**
   * Uninstall an old-file-only bundle: remove its old entry, then delete its
   * files except those another entry lists or that were modified.
   * @param workspaceFolder - Absolute workspace folder path.
   * @param bundleId - Bundle id.
   * @returns `undefined` when no old file has the bundle.
   * @throws {RegistryError} Any `RECORD.*` error from loading the record files.
   */
  public async retireOldEntry(workspaceFolder: string, bundleId: string): Promise<RetiredOldEntry | undefined> {
    const olds = await this.readOldLockfiles(workspaceFolder);
    const holder = olds.find((old) => old.lock !== null && Object.hasOwn(old.lock.bundles, bundleId));
    if (holder?.lock == null) {
      return undefined;
    }
    const entry = holder.lock.bundles[bundleId];
    const files = entry.files.map((file) => ({ path: toSlashes(file.path), checksum: file.checksum }));
    const keep = new Set(await findModifiedFiles(this.fs, workspaceFolder, files));
    for (const old of olds) {
      for (const [id, other] of Object.entries(old.lock?.bundles ?? {})) {
        if (old !== holder || id !== bundleId) {
          other.files.forEach((file) => keep.add(toSlashes(file.path)));
        }
      }
    }
    for (const location of await this.locations(workspaceFolder)) {
      for (const listed of await this.listedPathsIn(location)) {
        keep.add(toSlashes(path.relative(workspaceFolder, path.join(location.root, ...listed.split('/')))));
      }
    }

    const updated = cleanupOrphanedSource(removeBundleEntry(holder.lock, bundleId), entry.sourceId);
    await this.saveOldLockfile(holder.path, updated);

    const removal = await this.service.deleteSuperseded({
      deletedFiles: files.map((file) => file.path).filter((file) => !keep.has(file)),
      location: { level: 'repository', root: workspaceFolder, path: holder.path, commitMode: holder.commitMode }
    });
    return { deleted: removal.deleted, kept: files.map((file) => file.path).filter((file) => keep.has(file)), warnings: removal.warnings };
  }

  /**
   * Remap a source id in both record files, then in the old lockfiles that use it.
   * @param workspaceFolder - Absolute workspace folder path.
   * @param from - Source id being retired.
   * @param to - Replacement source id.
   * @param descriptor - Replacement source.
   * @throws {RegistryError} Any `RECORD.*` error from the record remap; the old files are then unchanged.
   */
  public async remapSource(workspaceFolder: string, from: string, to: string, descriptor: LockfileSourceDescriptor): Promise<void> {
    let recordDescriptor: RecordSourceDescriptor = { ...descriptor };
    try {
      const { sourceId: _sourceId, ...decided } = await this.buildSource(to);
      recordDescriptor = decided;
    } catch {
      // Not a configured source here: record the descriptor app resolved.
    }
    const result = await this.service.remapSource({ root: await this.resolveRoot(workspaceFolder), from, to, descriptor: recordDescriptor });
    result.warnings.forEach((warning) => this.logger.warn(warning));
    for (const old of await this.readOldLockfiles(workspaceFolder)) {
      const uses = old.lock !== null && (Object.hasOwn(old.lock.sources, from)
        || Object.values(old.lock.bundles).some((entry) => entry.sourceId === from));
      if (uses && old.lock !== null) {
        await writeLockfile(old.path, remapSourceId(old.lock, from, to, descriptor), this.lockfileFs);
      }
    }
  }
}
