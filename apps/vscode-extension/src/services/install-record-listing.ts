/**
 * Install record listing for the extension's repository view. Reads both
 * repository records at the git root and merges them with the old
 * prompt-registry lockfiles; the install record wins for any version of a
 * bundle. A bundle split across the two files is one item, and a tool's older
 * version under another versioned key is not listed. Problems are shown once
 * per file and content, and logged on every refresh.
 * @module services/install-record-listing
 */
import * as path from 'node:path';
import {
  createInstallRecordServices,
  isAnyFileMissing,
  recordIdentityOf,
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
} from './installed-bundle-from-entry';

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
  /** Record store to read with; one over `fs` by default. */
  store?: RecordStore;
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

/** A tool entry with its key, tool and the record file it was read from. */
interface LocatedEntry {
  bundleId: string;
  tool: string;
  entry: ToolEntry;
  location: RecordLocation;
}

/** The record's listing items, and the identity of every entry for the old-file merge. */
interface RecordItems {
  items: Map<string, InstalledBundle>;
  identities: Set<string>;
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
    this.store = options.store ?? createInstallRecordServices({ fs: this.fs, generatedBy: getExtensionRecordGeneratedBy() }).store;
    this.showProblem = options.showProblem ?? ((message) => {
      void vscode.window.showWarningMessage(message);
    });
  }

  private async readRecords(workspaceRoot: string): Promise<RecordItems> {
    const items = new Map<string, InstalledBundle>();
    const identities = new Set<string>();
    let locations: [RecordLocation, RecordLocation];
    try {
      locations = await this.store.resolveRepository({ start: workspaceRoot });
    } catch (error) {
      this.logger.warn('Failed to resolve the repository root for install records:', error instanceof Error ? error : undefined);
      return { items, identities };
    }
    const [committed, localOnly] = locations;
    const committedBundles = await this.loadBundles(committed);
    const localBundles = await this.loadBundles(localOnly);
    const candidates: LocatedEntry[] = [];
    for (const bundleId of new Set([...committedBundles.keys(), ...localBundles.keys()])) {
      // Tools may be split across the files; the same tool in both is a conflict and the committed entry wins.
      const committedTools = committedBundles.get(bundleId)?.tools ?? {};
      candidates.push(...Object.entries(committedTools).map(([tool, entry]) => ({ bundleId, tool, entry, location: committed })));
      const duplicateTools: string[] = [];
      for (const [tool, entry] of Object.entries(localBundles.get(bundleId)?.tools ?? {})) {
        if (Object.hasOwn(committedTools, tool)) {
          duplicateTools.push(tool);
          continue;
        }
        candidates.push({ bundleId, tool, entry, location: localOnly });
      }
      if (duplicateTools.length > 0) {
        this.report(await this.conflictProblem(bundleId, duplicateTools, committed, localOnly));
      }
    }
    // A tool lists one version of a bundle: its latest install across the versioned keys.
    const byIdentity = new Map<string, LocatedEntry[]>();
    for (const candidate of candidates) {
      const identity = recordIdentityOf(candidate.bundleId, candidate.entry.version);
      identities.add(identity);
      const key = JSON.stringify([identity, candidate.tool]);
      byIdentity.set(key, [...(byIdentity.get(key) ?? []), candidate]);
    }
    const listed = new Set([...byIdentity.values()].map((group) => latestEntry(group)));
    for (const bundleId of new Set(candidates.map((candidate) => candidate.bundleId))) {
      const latest = latestEntry(candidates.filter((candidate) => candidate.bundleId === bundleId && listed.has(candidate)));
      if (latest !== undefined) {
        await this.addItem(items, latest.location, bundleId, latest.entry);
      }
    }
    return { items, identities };
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
    // Use `.github`: never the git root, which uninstall would delete recursively.
    const item = createInstalledBundleFromLockfile(bundleId, toLockfileBundleEntry(entry), {
      installPath: path.join(location.root, '.github'),
      filesMissing: await this.filesMissing(location.root, entry),
      commitModeOverride: location.commitMode ?? 'commit'
    });
    item.recordOrigin = 'install-record';
    items.set(bundleId, item);
  }

  // An I/O error other than "missing" is logged and counts as present.
  private filesMissing(root: string, entry: ToolEntry): Promise<boolean> {
    return isAnyFileMissing(this.fs, root, entry.files.map((file) => file.path), (recordedPath, error) =>
      this.logger.warn(`Failed to check file existence for ${recordedPath}:`, error instanceof Error ? error : undefined));
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
   * List repository bundles: install records first, then old lockfile items of other bundles.
   * @param workspaceRoot - Workspace root the git-root walk starts from.
   * @param legacy - Reads the old prompt-registry lockfiles.
   */
  public async listRepositoryBundles(
    workspaceRoot: string,
    legacy: () => Promise<InstalledBundle[]>
  ): Promise<InstalledBundle[]> {
    const { items, identities } = await this.readRecords(workspaceRoot);
    let old: InstalledBundle[] = [];
    try {
      old = await legacy();
    } catch (error) {
      this.logger.warn('Failed to query repository bundles from lockfile:', error instanceof Error ? error : undefined);
    }
    // The record wins over an old item of any version; old items list one version, the latest installed.
    const oldByIdentity = new Map<string, InstalledBundle>();
    for (const bundle of old) {
      const identity = recordIdentityOf(bundle.bundleId, bundle.version);
      const kept = oldByIdentity.get(identity);
      if (!items.has(bundle.bundleId) && !identities.has(identity)
        && (kept === undefined || Date.parse(bundle.installedAt) > Date.parse(kept.installedAt))) {
        oldByIdentity.set(identity, bundle);
      }
    }
    return [...items.values(), ...oldByIdentity.values()];
  }
}

/**
 * Call `onChange` when either install record file at a root is created, changed or deleted.
 * @param root - Repository root.
 * @param onChange - Refreshes the listing.
 */
export const watchInstallRecords = (root: string, onChange: () => void): vscode.Disposable =>
  watchFiles(root, `{${RECORD_FILE_NAMES.join(',')}}`, onChange);

/**
 * Call `onChange` when an old `prompt-registry*.lock.json` file of a folder is created, changed or deleted.
 * @param workspaceFolder - Folder the old files live in.
 * @param onChange - Refreshes the listing.
 */
export const watchOldLockfiles = (workspaceFolder: string, onChange: () => void): vscode.Disposable =>
  watchFiles(workspaceFolder, 'prompt-registry*.lock.json', onChange);

const watchFiles = (base: string, pattern: string, onChange: () => void): vscode.Disposable => {
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, pattern));
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
