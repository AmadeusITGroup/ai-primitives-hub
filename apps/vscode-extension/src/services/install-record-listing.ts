/**
 * Install record listing for the extension's repository view. Reads both
 * repository records at the git root and merges them with the old
 * prompt-registry lockfiles; the install record wins for the same bundle id.
 * Problems are shown once per file and content, and logged on every refresh.
 * @module services/install-record-listing
 */
import * as path from 'node:path';
import {
  createInstallRecordServices,
  type RecordStore,
  toLockfileBundleEntry,
} from '@ai-primitives-hub/app';
import {
  type BundleRecord,
  describeRecordError,
  isRecordError,
  RECORD_FILE_NAMES,
  type RecordFs,
  type RecordLocation,
  type RegistryError,
  type ToolEntry,
} from '@ai-primitives-hub/core';
import {
  NodeRecordFs,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';
import type {
  InstalledBundle,
} from '../types/registry';
import {
  Logger,
} from '../utils/logger';
import {
  createInstalledBundleFromLockfile,
} from './lockfile-manager';

/** Marketplace id of this extension (`<publisher>.<name>`, unchanged by ADR-0004). */
export const EXTENSION_ID = 'AmadeusITGroup.prompt-registry';

/** Writer stamp for records the extension writes: `ai-primitives-hub-extension@<version>`. */
export const getExtensionRecordGeneratedBy = (): string => {
  let extensionVersion = '0.0.0';
  try {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    if (extension) {
      const { version } = extension.packageJSON as { version?: string };
      extensionVersion = version || '0.0.0';
    }
  } catch {
    // Use the default version when extension info is not available
  }
  return `ai-primitives-hub-extension@${extensionVersion}`;
};

/** Dependencies of an {@link InstallRecordListing}; all optional. */
export interface InstallRecordListingOptions {
  /** Filesystem port; `NodeRecordFs` by default. */
  fs?: RecordFs;
  /** Shows a listing problem to the user; a warning notification by default. */
  showProblem?: (message: string) => void;
}

/** Problem kinds the listing reports. */
interface ListingProblem {
  /** Show-once key: file path(s) and content hash(es). */
  key: string;
  message: string;
}

const UNREADABLE = 'unreadable';

/** A tool entry with the record file it was read from. */
interface LocatedEntry {
  entry: ToolEntry;
  location: RecordLocation;
}

/**
 * The entry with the latest `installedAt`; on a tie the first one (committed before local-only) wins.
 * @param candidates - Entries in file order.
 */
const latestEntry = (candidates: readonly LocatedEntry[]): LocatedEntry | undefined => {
  let latest: LocatedEntry | undefined;
  for (const candidate of candidates) {
    if (latest === undefined || Date.parse(candidate.entry.installedAt) > Date.parse(latest.entry.installedAt)) {
      latest = candidate;
    }
  }
  return latest;
};

/** Reads and merges repository install records for the extension's listing. */
export class InstallRecordListing {
  private readonly fs: RecordFs;
  private readonly store: RecordStore;
  private readonly showProblem: (message: string) => void;
  private readonly logger = Logger.getInstance();
  /** Problem keys already shown to the user. */
  private readonly shown = new Set<string>();

  public constructor(options: InstallRecordListingOptions = {}) {
    this.fs = options.fs ?? new NodeRecordFs();
    this.store = createInstallRecordServices({ fs: this.fs, generatedBy: getExtensionRecordGeneratedBy() }).store;
    this.showProblem = options.showProblem ?? ((message) => {
      void vscode.window.showWarningMessage(message);
    });
  }

  private async readRecords(workspaceRoot: string): Promise<Map<string, InstalledBundle>> {
    const items = new Map<string, InstalledBundle>();
    let locations: [RecordLocation, RecordLocation];
    try {
      locations = await this.store.resolveRepository({ start: workspaceRoot });
    } catch (error) {
      this.logger.warn('Failed to resolve the repository root for install records:', error instanceof Error ? error : undefined);
      return items;
    }
    const [committed, localOnly] = locations;
    const committedBundles = await this.loadBundles(committed);
    const localBundles = await this.loadBundles(localOnly);
    for (const bundleId of new Set([...committedBundles.keys(), ...localBundles.keys()])) {
      // Tools may be split across the files; the same tool in both is a conflict and the committed entry wins.
      const committedTools = committedBundles.get(bundleId)?.tools ?? {};
      const candidates: LocatedEntry[] = Object.values(committedTools).map((entry) => ({ entry, location: committed }));
      const duplicateTools: string[] = [];
      for (const [tool, entry] of Object.entries(localBundles.get(bundleId)?.tools ?? {})) {
        if (Object.hasOwn(committedTools, tool)) {
          duplicateTools.push(tool);
          continue;
        }
        candidates.push({ entry, location: localOnly });
      }
      if (duplicateTools.length > 0) {
        this.report(await this.conflictProblem(bundleId, duplicateTools, committed, localOnly));
      }
      const latest = latestEntry(candidates);
      if (latest !== undefined) {
        await this.addItem(items, latest.location, bundleId, latest.entry);
      }
    }
    return items;
  }

  /**
   * Bundles of one record file; a `RECORD.*` error is reported and gives none.
   * @param location - Record file.
   */
  private async loadBundles(location: RecordLocation): Promise<Map<string, BundleRecord>> {
    try {
      const { record } = await this.store.load(location);
      return new Map(Object.entries(record.bundles));
    } catch (error) {
      if (!isRecordError(error)) {
        throw error;
      }
      this.report(await this.errorProblem(location, error));
      return new Map();
    }
  }

  /**
   * Build one item per bundle from its latest tool entry across both files.
   * @param items - Items so far, by bundle id.
   * @param location - File holding the entry; gives `commitMode`.
   * @param bundleId - Bundle id.
   * @param entry - The bundle's latest tool entry.
   */
  private async addItem(items: Map<string, InstalledBundle>, location: RecordLocation, bundleId: string, entry: ToolEntry): Promise<void> {
    // Use `.github`, as LockfileManager does: never the git root, which uninstall would delete recursively.
    const item = createInstalledBundleFromLockfile(bundleId, toLockfileBundleEntry(entry), {
      installPath: path.join(location.root, '.github'),
      filesMissing: await this.filesMissing(location.root, entry),
      commitModeOverride: location.commitMode ?? 'commit'
    });
    item.recordOrigin = 'install-record';
    items.set(bundleId, item);
  }

  /**
   * Whether any file of the entry is missing on disk.
   * @param root - Record root.
   * @param entry - Tool entry.
   */
  private async filesMissing(root: string, entry: ToolEntry): Promise<boolean> {
    for (const file of entry.files) {
      try {
        if (await this.fs.lstat(path.join(root, ...file.path.split('/'))) === undefined) {
          return true;
        }
      } catch (error) {
        // Same policy as LockfileManager: on an I/O error other than "missing", assume the file exists.
        this.logger.warn(`Failed to check file existence for ${file.path}:`, error instanceof Error ? error : undefined);
      }
    }
    return false;
  }

  private async contentHash(file: string): Promise<string> {
    try {
      return await this.fs.hashFile(file);
    } catch {
      return UNREADABLE;
    }
  }

  private async errorProblem(location: RecordLocation, error: RegistryError): Promise<ListingProblem> {
    return {
      key: `${error.code}\u0000${location.path}\u0000${await this.contentHash(location.path)}`,
      message: `${error.code}: ${describeRecordError(error, path.basename(location.path))} ${error.hint ?? ''}`.trim()
    };
  }

  private async conflictProblem(
    bundleId: string,
    tools: readonly string[],
    committed: RecordLocation,
    localOnly: RecordLocation
  ): Promise<ListingProblem> {
    const [committedHash, localHash] = await Promise.all([this.contentHash(committed.path), this.contentHash(localOnly.path)]);
    const toolList = tools.map((tool) => `"${tool}"`).join(', ');
    return {
      key: `conflict\u0000${bundleId}\u0000${tools.join(',')}\u0000${committed.path}\u0000${committedHash}\u0000${localOnly.path}\u0000${localHash}`,
      message: `Bundle "${bundleId}" (tool ${toolList}) is in both ${RECORD_FILE_NAMES[0]} and ${RECORD_FILE_NAMES[1]}. `
        + `The entry from ${RECORD_FILE_NAMES[0]} is used; remove it from one of the files.`
    };
  }

  /**
   * Show a problem once per key, log it every time.
   * @param problem - Problem to report.
   */
  private report(problem: ListingProblem): void {
    this.logger.warn(`Install record listing: ${problem.message}`);
    if (this.shown.has(problem.key)) {
      return;
    }
    this.shown.add(problem.key);
    this.showProblem(problem.message);
  }

  /**
   * Repository root the records live at: the git root above `start`, or `start` without one.
   * @param start - Workspace root.
   */
  public async resolveRoot(start: string): Promise<string> {
    const [committed] = await this.store.resolveRepository({ start });
    return committed.root;
  }

  /**
   * List repository bundles: install records first, then old lockfile items with other ids.
   * @param workspaceRoot - Workspace root the git-root walk starts from.
   * @param legacy - Reads the prompt-registry lockfiles.
   */
  public async listRepositoryBundles(
    workspaceRoot: string,
    legacy: () => Promise<InstalledBundle[]>
  ): Promise<InstalledBundle[]> {
    const fromRecords = await this.readRecords(workspaceRoot);
    let old: InstalledBundle[] = [];
    try {
      old = await legacy();
    } catch (error) {
      this.logger.warn('Failed to query repository bundles from lockfile:', error instanceof Error ? error : undefined);
    }
    return [...fromRecords.values(), ...old.filter((bundle) => !fromRecords.has(bundle.bundleId))];
  }
}

/**
 * Call `onChange` when either install record file at a root is created, changed or deleted.
 * @param root - Repository root.
 * @param onChange - Refreshes the listing.
 */
export const watchInstallRecords = (root: string, onChange: () => void): vscode.Disposable => {
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(root, `{${RECORD_FILE_NAMES.join(',')}}`)
  );
  const subscriptions = [watcher.onDidCreate(onChange), watcher.onDidChange(onChange), watcher.onDidDelete(onChange)];
  return {
    dispose: () => {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
      watcher.dispose();
    }
  };
};
