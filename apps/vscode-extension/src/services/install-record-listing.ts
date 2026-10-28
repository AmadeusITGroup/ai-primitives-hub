/**
 * Install record listing for the extension's repository view (workflow W2;
 * BR5.1, BR5.2, BR5.4, BR5.5, BR5.7).
 *
 * Reads the 3.0.0 repository records (`ai-primitives-hub.lock.json` and
 * `ai-primitives-hub.local.lock.json`, at the git root) through the shared
 * `RecordStore`, and merges them with the prompt-registry lockfiles read by
 * `LockfileManager`: for a bundle id present in a new file, the new item wins
 * and the old one is dropped. Only the listing port of
 * `RegistryManager.listInstalledBundles` uses this; `LockfileManager` and its
 * other callers are unchanged in U1.
 *
 * A bundle whose tools are split across the two new files (BR3.6) is one
 * item, built from its latest entry in either file. Problems (a `RECORD.*`
 * error, or the same bundle and tool in both new files) are shown once
 * per file path and content hash, and logged on every later refresh; the rest
 * of the list is still returned.
 * @module services/install-record-listing
 */
import * as path from 'node:path';
import {
  RecordStore,
} from '@ai-primitives-hub/app';
import {
  type BundleRecord,
  isRecordError,
  RECORD_FILE_NAMES,
  type RecordFs,
  type RecordLocation,
  type RegistryError,
  type ToolEntry,
} from '@ai-primitives-hub/core';
import {
  NodeRecordFs,
  RecordSchemaValidator,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';
import type {
  LockfileBundleEntry,
} from '../types/lockfile';
import type {
  InstalledBundle,
} from '../types/registry';
import {
  Logger,
} from '../utils/logger';
import {
  createInstalledBundleFromLockfile,
} from './lockfile-manager';

/**
 * Writer stamp for records the extension writes (`generatedBy`), from the
 * same version source `LockfileManager` uses.
 * @returns `ai-primitives-hub-extension@<version>`.
 */
export const getExtensionRecordGeneratedBy = (): string => {
  let extensionVersion = '0.0.0';
  try {
    const extension = vscode.extensions.getExtension('prompt-registry');
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
  /** Problem keys already shown to the user (BR5.5). */
  private readonly shown = new Set<string>();

  public constructor(options: InstallRecordListingOptions = {}) {
    this.fs = options.fs ?? new NodeRecordFs();
    this.store = new RecordStore({ fs: this.fs, validator: new RecordSchemaValidator(), generatedBy: getExtensionRecordGeneratedBy() });
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
      // One bundle's tools may be split across the two files (BR3.6). Only
      // the same bundle and tool in both files is a conflict (BR5.4): the
      // committed entry is used for that tool and the conflict is reported.
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
   * Build one item per bundle from its latest tool entry across both files (BR5.2).
   * @param items - Items so far, by bundle id.
   * @param location - File holding the entry; gives `commitMode`.
   * @param bundleId - Bundle id.
   * @param entry - The bundle's latest tool entry.
   */
  private async addItem(items: Map<string, InstalledBundle>, location: RecordLocation, bundleId: string, entry: ToolEntry): Promise<void> {
    // Same minimal manifest and `.github` install path LockfileManager uses:
    // never the git root, which the extension's uninstall would delete recursively.
    const asLockfileEntry: LockfileBundleEntry = {
      version: entry.version,
      sourceId: entry.sourceId,
      sourceType: entry.sourceType,
      installedAt: entry.installedAt,
      files: entry.files.map((file) => ({ path: file.path, checksum: file.checksum }))
    };
    const item = createInstalledBundleFromLockfile(bundleId, asLockfileEntry, {
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
    const name = path.basename(location.path);
    const detail = typeof error.context?.detail === 'string' ? ` Reason: ${error.context.detail}.` : '';
    return {
      key: `${error.code}\u0000${location.path}\u0000${await this.contentHash(location.path)}`,
      message: `${error.code}: ${error.message} File: ${name}.${detail} ${error.hint ?? ''}`.trim()
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
   * Show a problem once per key, log it every time (BR5.5).
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
   * Repository root the records live at (BR2.1): the git root above `start`, or `start` without one.
   * @param start - Workspace root.
   */
  public async resolveRoot(start: string): Promise<string> {
    const [committed] = await this.store.resolveRepository({ start });
    return committed.root;
  }

  /**
   * List repository bundles: new records first, then old lockfile items whose id no new file has (BR5.1).
   * @param workspaceRoot - Workspace root the git-root walk starts from.
   * @param legacy - Reads the prompt-registry lockfiles (`LockfileManager.getInstalledBundles`).
   * @returns One item per bundle id.
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
 * Watch both install record files at a root and call `onChange` on create,
 * change or delete (BR5.7).
 * @param root - Repository root the records live at.
 * @param onChange - Refreshes the listing.
 * @returns The watcher's disposable.
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
