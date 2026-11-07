/**
 * Extension record adapter: the extension's composition of the shared install
 * record. Records every repository install under the host tool, handles the
 * shared user record, migrates older records before a level's first record
 * change, and reads the old `prompt-registry.lock.json` files; the record
 * logic lives in app.
 * @module services/extension-record-adapter
 */
import * as path from 'node:path';
import {
  assertUserFolderInsideHome,
  createInstallRecordServices,
  getLockfilePathForMode,
  type InstallRecordService,
  isAnyFileMissing,
  isLoneUnknown,
  listedPaths,
  type LocatedToolEntry,
  type Lockfile,
  type LockfileBundleEntry,
  type LockfileFs,
  type MigratedEntry,
  migrateLevel,
  type MigrationReport,
  orderConfiguredSources,
  readLockfile,
  RECORD_SOURCE_TYPES,
  recordIdentityOf,
  type RecordSourceDescriptor,
  type RecordSourceInput,
  type RecordStore,
  resolveUserHome,
  toRecordSource,
  writeFileAtomically,
} from '@ai-primitives-hub/app';
import {
  describeRecordError,
  isRecordError,
  type LockfileSourceDescriptor,
  RECORD_NAME_PATTERN,
  recordError,
  recordErrorDetails,
  type RecordFs,
  type RecordLevel,
  type RecordLocation,
  type RegistryError,
  type RegistrySource,
  type TargetType,
  UNKNOWN_TOOL_NAME,
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
  /** Absolute user record path; the user record is not used without it. */
  userRecordPath?: string;
  /** Environment for the home folder and the CLI's old user lockfile; `process.env` by default. */
  env?: Record<string, string | undefined>;
  /** This profile's RegistryStorage user installs, migrated at user level outside WSL (BR20.2); none without it. */
  profileStore?: ProfileStorePort;
  /** Where shown migration reports are remembered (BR22.2): the extension's `globalState`; in memory without it. */
  memento?: Pick<vscode.Memento, 'get' | 'update'>;
}

/** This profile's RegistryStorage user installs, as user-level migration reads and retires them (BR20.2). */
export interface ProfileStorePort {
  /** RegistryStorage installs with scope `user` (`RegistryStorage.getInstalledBundles('user')`). */
  getInstalledBundles(): Promise<InstalledBundle[]>;
  /** Absolute user files the profile synced for a bundle (`UserScopeService.syncedTargetPaths`). */
  syncedTargetPaths(bundleId: string): Promise<string[]>;
  /** Removes the RegistryStorage install without touching its files (`RegistryStorage.removeInstallation`). */
  removeInstallation(bundleId: string): Promise<void>;
}

/** Prefix of the globalState key remembering a shown migration report (BR22.2). */
export const MIGRATION_SHOWN_KEY_PREFIX = 'aiPrimitivesHub.migrationShown';

/** Prefix of the log line holding a migration report. */
export const MIGRATION_LOG_PREFIX = 'Install record migration';

/** Button of the migration notification that opens the output channel. */
const SHOW_DETAILS = 'Show details';

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

/**
 * Refusal of a move or commit-mode switch of a bundle whose only entry is `unknown`.
 * @param bundleId - Refused bundle.
 * @param action - Refused action.
 */
const unknownToolError = (bundleId: string, action: CliManagedAction): RegistryError =>
  recordError('RECORD.CLI_MANAGED', {
    message: `${bundleId} was migrated and its tool is unknown; reinstall it first`,
    hint: '',
    context: { bundleId, action, tool: UNKNOWN_TOOL_NAME }
  });

/**
 * Whether a report records anything besides the user record's import marker.
 * @param report
 */
const hasMigrated = (report: MigrationReport): boolean =>
  [report.renamed, report.mergedFrom, report.needsReinstall, report.versionConflicts, report.droppedFiles, report.droppedEntries]
    .some((list) => list.length > 0);

/**
 * The notification text of a migration report.
 * @param report - The report.
 */
const migrationMessage = (report: MigrationReport): string => {
  const count = report.needsReinstall.length;
  if (count > 0) {
    return `Migrated the ${report.level} install record: ${count} bundle${count === 1 ? ' needs' : 's need'} reinstalling.`;
  }
  const done = [
    ...report.renamed.map((renamed) => `renamed ${path.basename(renamed.from)} to ${path.basename(renamed.to)}`),
    ...report.mergedFrom.map((merged) => `merged ${path.isAbsolute(merged) ? path.basename(merged) : merged}`)
  ];
  return `Migrated the ${report.level} install record${done.length === 0 ? '.' : `: ${done.join(', ')}.`}`;
};

const toSlashes = (recordedPath: string): string => recordedPath.replaceAll('\\', '/');

/**
 * The entry under `bundleId`, first in file order; otherwise the latest installed.
 * @param found - Entries of one bundle identity.
 * @param bundleId - Key asked for.
 */
const preferredEntry = (found: readonly LocatedToolEntry[], bundleId: string): LocatedToolEntry | undefined =>
  found.find((located) => located.bundleId === bundleId)
  ?? found.reduce<LocatedToolEntry | undefined>((latest, located) =>
    latest === undefined || Date.parse(located.entry.installedAt) > Date.parse(latest.entry.installedAt) ? located : latest, undefined);

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
  /** The user level's home folder, the root of every user record path. */
  public readonly home: string;
  private readonly userRecordPath: string | undefined;
  private readonly env: Record<string, string | undefined>;
  private readonly profileStore: ProfileStorePort | undefined;
  private readonly memento: Pick<vscode.Memento, 'get' | 'update'> | undefined;
  /** Shown migration reports when no memento is given. */
  private readonly shownMigrations = new Set<string>();
  private loggedWslUserRecord = false;
  /** Tail of each record file's job queue, by resolved path. */
  private readonly recordQueues = new Map<string, Promise<unknown>>();

  public constructor(options: ExtensionRecordAdapterOptions) {
    const services = createInstallRecordServices({ generatedBy: getExtensionRecordGeneratedBy(), fs: options.fs });
    this.fs = services.fs;
    this.store = services.store;
    this.service = services.service;
    this.hostTool = options.hostTool ?? detectHostApp();
    this.sources = options.sources;
    this.lockfileFs = new RecordLockfileFs(this.fs);
    this.env = options.env ?? process.env;
    this.home = resolveUserHome(this.env);
    this.userRecordPath = options.userRecordPath;
    this.profileStore = options.profileStore;
    this.memento = options.memento;
  }

  private entriesIn(locations: readonly RecordLocation[], bundleId: string, tool?: string): Promise<LocatedToolEntry[]> {
    return this.service.findEntries(locations, bundleId, tool);
  }

  private allEntriesIn(locations: readonly RecordLocation[]): Promise<LocatedToolEntry[]> {
    return this.service.listToolEntries(locations);
  }

  // The host tool's entries under the key, or under another key of the same identity at that entry's version.
  private async hostEntriesIn(locations: readonly RecordLocation[], bundleId: string, version?: string): Promise<LocatedToolEntry[]> {
    const identity = version === undefined ? bundleId : recordIdentityOf(bundleId, version);
    return (await this.allEntriesIn(locations)).filter((located) =>
      located.tool === this.hostTool
      && (located.bundleId === bundleId || recordIdentityOf(located.bundleId, located.entry.version) === identity));
  }

  // Refuse a bundle whose entries in these files all belong to another tool; a lone `unknown` entry only for a move or switch.
  private async assertHostToolIn(
    locations: readonly RecordLocation[],
    bundleId: string,
    action: CliManagedAction,
    level: RecordLevel
  ): Promise<void> {
    const tools = (await this.entriesIn(locations, bundleId)).map((located) => located.tool);
    if (this.isAllowed(bundleId, action, tools)) {
      return;
    }
    throw cliManagedError(bundleId, action, tools.toSorted()[0], level);
  }

  // An I/O error other than "missing" is logged and counts as present.
  private anyMissing(root: string, paths: readonly string[]): Promise<boolean> {
    return isAnyFileMissing(this.fs, root, paths, (recordedPath, error) =>
      this.logger.warn(`Failed to check file existence for ${recordedPath}:`, error instanceof Error ? error : undefined));
  }

  /**
   * Whether an action may run on a bundle with these entry tools.
   * @param bundleId - Bundle the action targets.
   * @param action - The action.
   * @param tools - Tools of the bundle's entries at the level.
   * @throws {RegistryError} The reinstall hint for a move or switch of a lone `unknown` entry.
   */
  private isAllowed(bundleId: string, action: CliManagedAction, tools: readonly string[]): boolean {
    if (tools.length === 0 || tools.includes(this.hostTool)) {
      return true;
    }
    if (isLoneUnknown(tools)) {
      if (action === 'update' || action === 'uninstall') {
        return true;
      }
      throw unknownToolError(bundleId, action);
    }
    return false;
  }

  // This profile's user installs as host-tool entries; linked `local-skills` installs stay in RegistryStorage.
  private async buildProfileEntries(): Promise<MigratedEntry[]> {
    const entries: MigratedEntry[] = [];
    for (const installed of await this.profileStore?.getInstalledBundles() ?? []) {
      if (installed.sourceType === 'local-skills') {
        continue;
      }
      let source: RecordSourceInput | undefined;
      try {
        source = await this.buildSource(installed.sourceId);
      } catch {
        // Not a configured source: the entry keeps its id and type only.
      }
      const sourceType = installed.sourceType ?? source?.type;
      if (installed.sourceId === undefined || sourceType === undefined || !RECORD_NAME_PATTERN.test(sourceType)) {
        this.logger.warn(`Not migrating the profile install of ${installed.bundleId}: it records no source id or source type`);
        continue;
      }
      const files = (await this.profileStore?.syncedTargetPaths(installed.bundleId) ?? [])
        .map((file) => ({ path: toSlashes(path.relative(this.home, file)) }));
      const { sourceId: _sourceId, ...recordedSource } = source ?? { sourceId: '' };
      entries.push({
        bundleId: installed.bundleId,
        tool: this.hostTool,
        version: installed.version,
        sourceId: installed.sourceId,
        sourceType,
        installedAt: installed.installedAt,
        files,
        source: source === undefined ? undefined : recordedSource,
        from: 'profile-registry-storage'
      });
    }
    return entries;
  }

  /**
   * Remove migrated profile installs from RegistryStorage, files untouched.
   * @param bundleIds - Bundles to remove.
   */
  private async retireProfileInstalls(bundleIds: readonly string[]): Promise<void> {
    const failed: string[] = [];
    for (const bundleId of bundleIds) {
      try {
        await this.profileStore?.removeInstallation(bundleId);
      } catch (error) {
        failed.push(bundleId);
        this.logger.error(`Could not remove the migrated profile install of ${bundleId}`, error instanceof Error ? error : undefined);
      }
    }
    if (failed.length > 0) {
      void vscode.window.showWarningMessage(
        `Migrated the user install record, but could not remove the old profile entries of ${failed.join(', ')}. They are removed on the next change.`
      );
    }
  }

  /**
   * Run a job inside the queues of several record files, entered in the given
   * order; callers always pass the committed file first, so nesting cannot deadlock.
   * @param recordPaths - Record files the job changes, in a fixed order.
   * @param work - The job.
   */
  private serializeAll<T>(recordPaths: readonly string[], work: () => Promise<T>): Promise<T> {
    const [first, ...rest] = recordPaths;
    return first === undefined ? work() : this.serialize(first, () => this.serializeAll(rest, work));
  }

  /**
   * Run a record mutation after every earlier one queued for the same file;
   * concurrent load-change-save cycles of one file would lose entries.
   * @param recordPath - Record file the job changes.
   * @param work - The mutation.
   */
  public serialize<T>(recordPath: string, work: () => Promise<T>): Promise<T> {
    const key = path.resolve(recordPath);
    const previous = this.recordQueues.get(key) ?? Promise.resolve();
    const run = previous.then(work);
    const tail = run.then(() => undefined, () => undefined);
    this.recordQueues.set(key, tail);
    void tail.then(() => {
      if (this.recordQueues.get(key) === tail) {
        this.recordQueues.delete(key);
      }
    });
    return run;
  }

  /**
   * Both old `prompt-registry` lockfiles at the record root of a workspace
   * folder, committed first; an unreadable one has `lock: null`.
   * @param workspaceFolder - Absolute workspace folder path.
   */
  public async readOldLockfiles(workspaceFolder: string): Promise<OldLockfile[]> {
    const root = await this.resolveRoot(workspaceFolder);
    const files: OldLockfile[] = [];
    for (const commitMode of ['commit', 'local-only'] as const) {
      const file = getLockfilePathForMode(root, commitMode);
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
    return this.entriesIn(await this.locations(workspaceFolder), bundleId);
  }

  /**
   * The host tool's entries of a bundle: under its key, or under another key
   * of the same identity, each identity taken with the entry's recorded version.
   * @param workspaceFolder - Absolute workspace folder path.
   * @param bundleId - Bundle id, or a bare identity when `version` is not given.
   * @param version - Version `bundleId` carries, to find older or newer versioned keys.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async findHostEntries(workspaceFolder: string, bundleId: string, version?: string): Promise<LocatedToolEntry[]> {
    return this.hostEntriesIn(await this.locations(workspaceFolder), bundleId, version);
  }

  /**
   * The host tool's entry of a bundle, from the committed file when both hold
   * it; without one under `bundleId`, the latest installed of the same identity.
   * @param workspaceFolder - Absolute workspace folder path.
   * @param bundleId - Bundle id, or a bare identity when `version` is not given.
   * @param version - Version `bundleId` carries.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async findHostEntry(workspaceFolder: string, bundleId: string, version?: string): Promise<LocatedToolEntry | undefined> {
    return preferredEntry(await this.findHostEntries(workspaceFolder, bundleId, version), bundleId);
  }

  /**
   * Every tool entry of every bundle in both record files, committed file first.
   * @param workspaceFolder - Absolute workspace folder path.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async listAllEntries(workspaceFolder: string): Promise<LocatedToolEntry[]> {
    return this.allEntriesIn(await this.locations(workspaceFolder));
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
   * tool. A lone `unknown` entry is allowed for update and uninstall only.
   * @param bundleId - Bundle the action targets.
   * @param action - The action, for the message.
   * @param workspaceFolder - Absolute workspace folder path.
   * @throws {RegistryError} `RECORD.CLI_MANAGED` naming the tool, or the reinstall hint; any `RECORD.*` error from loading.
   */
  public async assertHostTool(bundleId: string, action: CliManagedAction, workspaceFolder: string): Promise<void> {
    await this.assertHostToolIn(await this.locations(workspaceFolder), bundleId, action, 'repository');
  }

  /**
   * Whether user installs use the shared user record. Not in WSL, where user
   * files go to the Windows home, outside the WSL home the record is rooted at.
   */
  public usesSharedUserRecord(): boolean {
    if (vscode.env.remoteName === 'wsl') {
      if (!this.loggedWslUserRecord) {
        this.loggedWslUserRecord = true;
        this.logger.info('The shared user record is not used in WSL; user installs are tracked by the extension only.');
      }
      return false;
    }
    return this.userRecordPath !== undefined;
  }

  /**
   * The user record location, rooted at the home folder.
   * @throws {Error} When no user record path is configured.
   */
  public userLocation(): RecordLocation {
    if (this.userRecordPath === undefined) {
      throw new Error('No user record path is configured for the extension record adapter');
    }
    return this.store.resolveUser({ home: this.home, path: this.userRecordPath });
  }

  /**
   * Load and check the user record and refuse a user target folder outside home, before anything is written.
   * @param folders - Absolute folders the user install writes into.
   * @throws {RegistryError} A `RECORD.*` error.
   */
  public async prepareUserInstall(folders: readonly string[]): Promise<RecordLocation> {
    const location = this.userLocation();
    await this.store.load(location);
    for (const folder of folders) {
      await assertUserFolderInsideHome(this.fs, this.home, folder);
    }
    return location;
  }

  /**
   * Every tool entry of a bundle in the user record.
   * @param bundleId - Bundle id.
   */
  public async findUserEntries(bundleId: string): Promise<LocatedToolEntry[]> {
    return this.entriesIn([this.userLocation()], bundleId);
  }

  /**
   * The host tool's user record entries of a bundle: under its key, or with `version`
   * under another key of the same identity, each taken at the entry's recorded version.
   * @param bundleId - Bundle id.
   * @param version - Version `bundleId` carries; without it only the key matches.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async findUserHostEntries(bundleId: string, version?: string): Promise<LocatedToolEntry[]> {
    const locations = [this.userLocation()];
    return version === undefined ? this.entriesIn(locations, bundleId, this.hostTool) : this.hostEntriesIn(locations, bundleId, version);
  }

  /**
   * The host tool's entry of a bundle in the user record: under its key, or
   * with `version` the latest installed of the same identity.
   * @param bundleId - Bundle id.
   * @param version - Version `bundleId` carries; without it only the key matches.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async findUserHostEntry(bundleId: string, version?: string): Promise<LocatedToolEntry | undefined> {
    return preferredEntry(await this.findUserHostEntries(bundleId, version), bundleId);
  }

  /** Every tool entry of every bundle in the user record. */
  public async listUserEntries(): Promise<LocatedToolEntry[]> {
    return this.allEntriesIn([this.userLocation()]);
  }

  /**
   * Refuse an action on a user-level bundle whose user record entries all belong to another tool.
   * @param bundleId - Bundle the action targets.
   * @param action - The action, for the message.
   * @throws {RegistryError} `RECORD.CLI_MANAGED`, or a `RECORD.*` error from loading.
   */
  public async assertUserHostTool(bundleId: string, action: CliManagedAction): Promise<void> {
    await this.assertHostToolIn([this.userLocation()], bundleId, action, 'user');
  }

  /**
   * Retire a bundle's profile (user) installation: unsync its user files except
   * those a user record entry still lists, then remove the installation.
   * @param bundleId - Bundle being retired.
   * @param unsync - Removes the bundle's user files, leaving every path in `keep`.
   * @param removeInstallation - Removes the extension's installation of the bundle.
   */
  public async retireProfileEntry(
    bundleId: string,
    unsync: (keep: Set<string>) => Promise<void>,
    removeInstallation: () => Promise<void>
  ): Promise<void> {
    const location = this.userLocation();
    const keep = new Set<string>();
    for (const listed of await this.listedPathsIn(location)) {
      keep.add(path.join(location.root, ...listed.split('/')));
    }
    this.logger.debug(`Retiring the profile installation of ${bundleId}; ${keep.size} user record path(s) kept`);
    await unsync(keep);
    await removeInstallation();
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
   * Bundles of the old `prompt-registry` lockfiles at the record root, as listing items, committed file first.
   * @param workspaceFolder - Absolute workspace folder path.
   */
  public async listOldBundles(workspaceFolder: string): Promise<InstalledBundle[]> {
    const bundles: InstalledBundle[] = [];
    const seen = new Set<string>();
    const root = await this.resolveRoot(workspaceFolder);
    for (const old of await this.readOldLockfiles(workspaceFolder)) {
      for (const [bundleId, entry] of Object.entries(old.lock?.bundles ?? {})) {
        if (seen.has(bundleId)) {
          this.logger.error(`Bundle ${bundleId} exists in both lockfiles - manual resolution required`);
          continue;
        }
        seen.add(bundleId);
        bundles.push(createInstalledBundleFromLockfile(bundleId, entry, {
          installPath: path.join(root, '.github'),
          filesMissing: await this.anyMissing(root, entry.files.map((file) => toSlashes(file.path))),
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
   * Remap a source id in both record files; the caller migrates the old files first.
   * @param workspaceFolder - Absolute workspace folder path.
   * @param from - Source id being retired.
   * @param to - Replacement source id.
   * @param descriptor - Replacement source.
   * @throws {RegistryError} Any `RECORD.*` error from the record remap.
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
  }

  /**
   * A bundle's `unknown` entry when it is the bundle's only entry at the level
   * (BR21.4): a migrated bundle no tool has reinstalled yet.
   * @param bundleId - Bundle id.
   * @param workspaceFolder - Absolute workspace folder path for the repository level; the user level without it.
   * @throws {RegistryError} Any `RECORD.*` error from loading.
   */
  public async findLoneUnknownEntry(bundleId: string, workspaceFolder?: string): Promise<LocatedToolEntry | undefined> {
    const locations = workspaceFolder === undefined ? [this.userLocation()] : await this.locations(workspaceFolder);
    return (await this.service.findLoneUnknown(locations)).get(bundleId);
  }

  /**
   * Migrate the older records of a level into its 3.0.0 records before an
   * action's first record change (W24; BR18.1, BR18.2). Called only at the
   * write entry points, never from a lookup or a listing.
   *
   * - repository level: app's `migrateLevel` at the git root of `root`,
   *   which renames and merges `prompt-registry.lock.json` and
   *   `prompt-registry.local.lock.json` there;
   * - user level, outside WSL: the same on the user record, importing the
   *   CLI's old user lockfile once and this profile's RegistryStorage user
   *   installs under the host tool (BR20.2); each of those is then removed from
   *   RegistryStorage without touching its files. A failed removal is logged
   *   and shown once; the next run removes it. In WSL nothing is migrated.
   *
   * The report is logged and shown once (see {@link showMigrationReport}).
   * Runs in the queue of every record file it changes (committed, then
   * local-only at repository level), after any earlier change of them.
   * @param level - Level the action changes.
   * @param root - Repository: a workspace folder or its git root. User: ignored (the home folder).
   * @returns The report, or `undefined` when there was nothing to migrate.
   * @throws {RegistryError} Any `RECORD.*` error from the migration, after it was shown once; nothing was written then.
   */
  public async migrateBeforeWrite(level: RecordLevel, root: string): Promise<MigrationReport | undefined> {
    if (level === 'user' && !this.usesSharedUserRecord()) {
      return undefined;
    }
    const targets = level === 'user' ? [this.userLocation()] : await this.locations(root);
    return this.serializeAll(targets.map((target) => target.path), async () => {
      const profileEntries = level === 'user' ? await this.buildProfileEntries() : [];
      let report: MigrationReport | undefined;
      try {
        report = await migrateLevel({ store: this.store, fs: this.fs, targets, env: this.env, profileEntries });
      } catch (error) {
        this.showRecordError(error, [], targets[0].root);
        throw error;
      }
      if (report !== undefined) {
        await this.retireProfileInstalls(profileEntries.map((entry) => entry.bundleId));
        this.showMigrationReport(report, targets[0].path);
      }
      return report;
    });
  }

  /**
   * Log a migration report and show it once (BR22.2, NFR5.4): one information
   * notification per record path and `migratedAt`, remembered in
   * `globalState`, with "Show details" opening the output channel. A report
   * that only marks the user record as imported is logged without a notification.
   * @param report - The report.
   * @param recordPath - Record file the report belongs to (the committed file at repository level).
   */
  public showMigrationReport(report: MigrationReport, recordPath: string): void {
    this.logger.info(`${MIGRATION_LOG_PREFIX} (${recordPath}): ${JSON.stringify(report)}`);
    const key = `${MIGRATION_SHOWN_KEY_PREFIX}:${recordPath}:${report.migratedAt}`;
    if (!hasMigrated(report) || this.shownMigrations.has(key) || this.memento?.get<boolean>(key) === true) {
      return;
    }
    this.shownMigrations.add(key);
    void Promise.resolve(this.memento?.update(key, true)).catch((error: unknown) => {
      this.logger.warn(`Could not remember the migration notification ${key}:`, error instanceof Error ? error : undefined);
    });
    void Promise.resolve(vscode.window.showInformationMessage(migrationMessage(report), SHOW_DETAILS)).then((choice) => {
      if (choice === SHOW_DETAILS) {
        this.logger.show();
      }
    });
  }
}
