/**
 * Extension record adapter: the extension's composition of the shared
 * install record (U3; BR11.1–BR11.9, BR12.1, NFR4.12, NFR4.15, NFR5.2).
 *
 * Wires app's `RecordStore` and `InstallRecordService` to infra's
 * `NodeRecordFs` and `RecordSchemaValidator`, stamps
 * `generatedBy = ai-primitives-hub-extension@<version>`, and records every
 * repository install under the host tool from `detectHostApp()`. It holds no
 * record logic of its own; it supplies the extension-side inputs the app
 * functions need:
 * - `resolveRoot`: the record root of a workspace folder (git root, or the folder);
 * - `assertHostTool`: refuse actions on bundles only another tool's entry holds;
 * - `buildSource`: the configured source an install records (active hub,
 *   then detached `default-local`, then any stored source);
 * - `showRecordError`: one error notification with "Open file";
 * - the old `prompt-registry.lock.json` files, read and changed through
 *   app's `json-lockfile-store` (listing, retirement, source remap).
 * @module services/extension-record-adapter
 */
import * as path from 'node:path';
import {
  cleanupOrphanedSource,
  deleteLockfile,
  emptyLockfile,
  findModifiedFiles,
  getLockfilePathForMode,
  InstallRecordService,
  type Lockfile,
  type LockfileBundleEntry,
  type LockfileFs,
  readLockfile,
  RECORD_SOURCE_TYPES,
  type RecordSourceDescriptor,
  type RecordSourceInput,
  RecordStore,
  remapSourceId,
  removeBundleEntry,
  upsertBundleEntry,
  upsertSource,
  writeLockfile,
} from '@ai-primitives-hub/app';
import {
  DEFAULT_LOCAL_HUB_ID,
  isRecordError,
  type LockfileSourceDescriptor,
  type RecordFs,
  type RecordLocation,
  type RegistrySource,
  type TargetType,
  type ToolEntry,
} from '@ai-primitives-hub/core';
import {
  NodeRecordFs,
  RecordSchemaValidator,
} from '@ai-primitives-hub/infra';
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

/** Largest old lockfile read, in bytes (the record cap). */
const OLD_LOCKFILE_MAX_BYTES = 10 * 1024 * 1024;

/** Optional source fields copied from a configured source's `config` (C1). */
const SOURCE_CONFIG_FIELDS = ['branch', 'collectionsPath', 'indexFile', 'authMode', 'credentialRef'] as const;

/** Where configured sources come from. */
export interface RecordSourcesPort {
  /** Every stored source, hub-provisioned and detached ones included (`RegistryStorage.getSources`). */
  listSources(): Promise<RegistrySource[]>;
  /** Active hub id, when a hub is active. */
  getActiveHubId?(): Promise<string | null>;
}

/** Dependencies of an {@link ExtensionRecordAdapter}. */
export interface ExtensionRecordAdapterOptions {
  /** Configured sources for `buildSource`. */
  sources: RecordSourcesPort;
  /** Filesystem port; `NodeRecordFs` by default. */
  fs?: RecordFs;
  /** Host tool; `detectHostApp()` by default. */
  hostTool?: TargetType;
}

/** One tool entry of a bundle, with the record file holding it. */
export interface LocatedToolEntry {
  location: RecordLocation;
  tool: string;
  entry: ToolEntry;
}

/** One tool entry of any bundle in a record file. */
export interface LocatedBundleToolEntry extends LocatedToolEntry {
  bundleId: string;
}

/** One old `prompt-registry` lockfile at a workspace root. */
export interface OldLockfile {
  /** Absolute file path. */
  path: string;
  /** Commit mode the file stands for. */
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
  /** Non-fatal problems, for the caller to log. */
  warnings: string[];
}

/**
 * Forward-slash form of a recorded path.
 * @param recordedPath - Path as recorded.
 */
const toSlashes = (recordedPath: string): string => recordedPath.replaceAll('\\', '/');

/**
 * `LockfileFs` over `RecordFs`; writes go to an exclusive temp file renamed over the target.
 */
class RecordLockfileFs implements LockfileFs {
  public constructor(private readonly fs: RecordFs) {}

  public async readFile(file: string): Promise<string> {
    return new TextDecoder('utf-8').decode(await this.fs.readCapped(file, OLD_LOCKFILE_MAX_BYTES));
  }

  public async writeFile(file: string, contents: string): Promise<void> {
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await this.fs.writeFile(temp, contents);
    try {
      await this.fs.rename(temp, file);
    } catch (error) {
      await this.fs.unlink(temp).catch(() => undefined);
      throw error;
    }
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
    this.fs = options.fs ?? new NodeRecordFs();
    this.store = new RecordStore({ fs: this.fs, validator: new RecordSchemaValidator(), generatedBy: getExtensionRecordGeneratedBy() });
    this.service = new InstallRecordService({ store: this.store, fs: this.fs });
    this.hostTool = options.hostTool ?? detectHostApp();
    this.sources = options.sources;
    this.lockfileFs = new RecordLockfileFs(this.fs);
  }

  /**
   * Both old `prompt-registry` lockfiles of a workspace folder, committed first.
   * An unreadable file is logged and given as `lock: null`.
   * @param workspaceFolder - Absolute workspace folder path (where the old files live).
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
   * Whether any of the paths is missing.
   * @param root - Root the paths are relative to.
   * @param paths - Root-relative paths.
   */
  private async anyMissing(root: string, paths: readonly string[]): Promise<boolean> {
    for (const recordedPath of paths) {
      try {
        if (await this.fs.lstat(path.join(root, ...recordedPath.split('/'))) === undefined) {
          return true;
        }
      } catch (error) {
        this.logger.warn(`Failed to check file existence for ${recordedPath}:`, error instanceof Error ? error : undefined);
      }
    }
    return false;
  }

  /**
   * Record root of a workspace folder (BR2.1): its git root, or the folder itself.
   * @param workspaceFolder - Absolute workspace folder path.
   */
  public async resolveRoot(workspaceFolder: string): Promise<string> {
    const [committed] = await this.store.resolveRepository({ start: workspaceFolder });
    return committed.root;
  }

  /**
   * Both repository record files of a workspace folder, committed first.
   * @param workspaceFolder - Absolute workspace folder path.
   */
  public locations(workspaceFolder: string): Promise<[RecordLocation, RecordLocation]> {
    return this.store.resolveRepository({ start: workspaceFolder });
  }

  /**
   * Load and check both record files, so a bad record stops an install before
   * any file is written (NFR5.2), and give the file for the commit mode.
   * @param workspaceFolder - Absolute workspace folder path.
   * @param commitMode - Commit mode of the install.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async prepareInstall(workspaceFolder: string, commitMode: RepositoryCommitMode): Promise<RecordLocation> {
    const [committed, localOnly] = await this.locations(workspaceFolder);
    await this.store.load(committed);
    await this.store.load(localOnly);
    return commitMode === 'local-only' ? localOnly : committed;
  }

  /**
   * Every tool entry of a bundle in both record files, committed file first.
   * @param workspaceFolder - Absolute workspace folder path.
   * @param bundleId - Bundle id.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async findEntries(workspaceFolder: string, bundleId: string): Promise<LocatedToolEntry[]> {
    const entries: LocatedToolEntry[] = [];
    for (const location of await this.locations(workspaceFolder)) {
      const { record } = await this.store.load(location);
      const bundle = Object.hasOwn(record.bundles, bundleId) ? record.bundles[bundleId] : undefined;
      for (const [tool, entry] of Object.entries(bundle?.tools ?? {})) {
        entries.push({ location, tool, entry });
      }
    }
    return entries;
  }

  /**
   * The host tool's entry of a bundle, from the first file holding it (BR6.5).
   * @param workspaceFolder - Absolute workspace folder path.
   * @param bundleId - Bundle id.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async findHostEntry(workspaceFolder: string, bundleId: string): Promise<LocatedToolEntry | undefined> {
    return (await this.findEntries(workspaceFolder, bundleId)).find((located) => located.tool === this.hostTool);
  }

  /**
   * Every tool entry of every bundle in both record files, committed file first.
   * @param workspaceFolder - Absolute workspace folder path.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async listAllEntries(workspaceFolder: string): Promise<LocatedBundleToolEntry[]> {
    const entries: LocatedBundleToolEntry[] = [];
    for (const location of await this.locations(workspaceFolder)) {
      const { record } = await this.store.load(location);
      for (const [bundleId, bundle] of Object.entries(record.bundles)) {
        for (const [tool, entry] of Object.entries(bundle.tools)) {
          entries.push({ bundleId, location, tool, entry });
        }
      }
    }
    return entries;
  }

  /**
   * Every root-relative path an entry of one record file lists.
   * @param location - Record file.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async listedPathsIn(location: RecordLocation): Promise<Set<string>> {
    const { record } = await this.store.load(location);
    const listed = new Set<string>();
    for (const bundle of Object.values(record.bundles)) {
      for (const entry of Object.values(bundle.tools)) {
        for (const file of entry.files) {
          listed.add(file.path);
        }
      }
    }
    return listed;
  }

  /**
   * Refuse an action on a bundle whose record entries all belong to another
   * tool (BR11.2, NFR4.12). A bundle with a host-tool entry, or with no record
   * entry (old-file rows have no tool and are the host's own), is allowed.
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

  /**
   * Configured sources in lookup order, one per id: the active hub's sources,
   * then detached (`default-local`) sources, then any other stored source.
   */
  public async configuredSources(): Promise<RegistrySource[]> {
    const all = await this.sources.listSources();
    const activeHubId = (await this.sources.getActiveHubId?.()) ?? null;
    const rank = (source: RegistrySource): number => {
      if (activeHubId !== null && source.hubId === activeHubId) {
        return 0;
      }
      return source.hubId === DEFAULT_LOCAL_HUB_ID ? 1 : 2;
    };
    const ordered = all.map((source, index) => ({ source, index }))
      .toSorted((left, right) => rank(left.source) - rank(right.source) || left.index - right.index);
    const byId = new Map<string, RegistrySource>();
    for (const { source } of ordered) {
      if (!byId.has(source.id)) {
        byId.set(source.id, source);
      }
    }
    return [...byId.values()];
  }

  /**
   * The source an install records (NFR4.15): the configured source with this
   * id, mapped to the C1 fields (`type`, `url`, `branch`, `collectionsPath`,
   * `indexFile`, `authMode`, `credentialRef`).
   * @param sourceId - Source id of the bundle.
   * @throws {Error} When the id is unknown or its type is not a `SourceType`.
   */
  public async buildSource(sourceId: string | undefined): Promise<RecordSourceInput> {
    const configured = sourceId === undefined ? undefined : (await this.configuredSources()).find((candidate) => candidate.id === sourceId);
    if (configured === undefined || !(RECORD_SOURCE_TYPES as readonly string[]).includes(configured.type)) {
      throw new Error(`source ${sourceId ?? '(none)'} is not configured; add it or reinstall from a configured source`);
    }
    const source: RecordSourceInput = { sourceId: configured.id, type: configured.type, url: configured.url };
    for (const field of SOURCE_CONFIG_FIELDS) {
      const value = configured.config?.[field];
      if (typeof value === 'string') {
        source[field] = value;
      }
    }
    return source;
  }

  /**
   * Show a `RECORD.*` error once: one error notification naming the file, with
   * an "Open file" button, and the full detail in the log (NFR5.2).
   * @param error - Anything thrown.
   * @param written - Absolute files the writer wrote before the error; they are left in place.
   * @param root - Record root, to open a file named relative to it.
   * @returns `true` when `error` was a `RECORD.*` error (other than `RECORD.CLI_MANAGED`) and was shown, now or before.
   */
  public showRecordError(error: unknown, written: readonly string[] = [], root?: string): boolean {
    if (!isRecordError(error) || error.code === 'RECORD.CLI_MANAGED') {
      // The other-tool refusal is a warning, shown by `showCliManagedWarning`.
      return false;
    }
    if (wasErrorShown(error)) {
      return true;
    }
    const file = typeof error.context?.file === 'string' ? error.context.file : undefined;
    const detail = typeof error.context?.detail === 'string' ? error.context.detail : undefined;
    const message = [
      error.message,
      file === undefined ? '' : `File: ${file}.`,
      detail === undefined ? '' : `Reason: ${detail}.`,
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
   * Bundles of the old `prompt-registry` lockfiles, as listing items. A bundle
   * in both old files is listed once, from the committed file.
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
   * Save an old lockfile, or delete it when it has no bundle left.
   * @param file - Absolute old lockfile path.
   * @param lock - Content to save.
   */
  private async saveOldLockfile(file: string, lock: Lockfile): Promise<void> {
    await (Object.keys(lock.bundles).length === 0
      ? deleteLockfile(file, this.lockfileFs)
      : writeLockfile(file, lock, this.lockfileFs));
  }

  /**
   * Remove a bundle's entry from the old lockfile holding it, without touching
   * any installed file (stale cleanup, BR12.2). Its source is dropped when no
   * other entry uses it.
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
   * of the other commit mode (today's behaviour for bundles never rewritten).
   * The target file is saved first, then the entry leaves the first file.
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
   * Remove a bundle's entry from the old `prompt-registry` lockfiles and
   * delete its files (BR12.1; the old-only uninstall). A file another old
   * entry or any record entry lists, or that was modified, is kept. The old
   * file is saved first (removed when empty), then files are deleted.
   * @param workspaceFolder - Absolute workspace folder path.
   * @param bundleId - Bundle id.
   * @returns What was deleted and kept, or `undefined` when no old file has the bundle.
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
   * Remap a source id (BR11.9): both record files first, through
   * `InstallRecordService.remapSource`, then the old `prompt-registry`
   * lockfiles that use it, through app's `remapSourceId`.
   * @param workspaceFolder - Absolute workspace folder path.
   * @param from - Source id being retired.
   * @param to - Replacement source id.
   * @param descriptor - Replacement source as resolved by app's `remapBundleSource`.
   * @throws {RegistryError} Any `RECORD.*` error from the record remap; nothing is changed in the old files then.
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
