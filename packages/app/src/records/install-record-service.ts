/**
 * Install record service: records a tool's install or uninstall of a bundle in
 * the shared record and keeps sibling tools that share its files in step. It
 * also moves entries between the two repository files and remaps source ids.
 * It deletes nothing itself; superseded files come back in `deletedFiles` for
 * `deleteSuperseded` to remove after the save.
 * @module records/install-record-service
 */
import * as path from 'node:path';
import {
  compareCodeUnits,
  FORBIDDEN_KEYS,
  type InstallRecord,
  otherRepositoryLocation,
  type RecordChange,
  type RecordedFile,
  recordError,
  type RecordFs,
  type RecordLevel,
  type RecordLocation,
  relativeInside,
  repositoryLocations,
  type SourceRecord,
  type SourceType,
  TARGET_TYPES,
  type ToolEntry,
  UNKNOWN_TOOL_NAME,
  WORKSPACE_ROOT_TOKEN,
} from '@ai-primitives-hub/core';
import {
  defaultLayouts,
} from '@ai-primitives-hub/infra';
import {
  resolveMcpLayoutConfig,
} from '../install/layout-resolver';
import {
  confinePath,
  resolveDeleteTarget,
} from './confine-path';
import {
  removeExcluded,
} from './git-root';
import {
  findModifiedFiles,
} from './modified-files';
import {
  createBundle,
  hashRecordedFile,
  putToolEntry,
} from './record-entry';
import {
  recordIdentityOf,
} from './record-identity';
import type {
  LoadedRecord,
  RecordStore,
} from './record-store';
import {
  sanitizeSource,
} from './sanitize-source';

/** Typed as `Record<SourceType, true>` so the compiler keeps it in step with the union. */
const SOURCE_TYPE_KEYS: Readonly<Record<SourceType, true>> = {
  github: true,
  local: true,
  'awesome-copilot': true,
  'local-awesome-copilot': true,
  apm: true,
  'local-apm': true,
  skills: true,
  'local-skills': true,
  'azure-devops': true,
  artifactory: true
};

/** Every `SourceType` value, the only `sourceType` a new entry may carry. */
export const RECORD_SOURCE_TYPES: readonly SourceType[] = Object.keys(SOURCE_TYPE_KEYS) as SourceType[];

/** Source details passed to `recordInstall`, with the key they are recorded under. */
export interface RecordSourceInput {
  sourceId: string;
  /** Must equal `RecordInstallInput.sourceType`. */
  type: string;
  /** Credentials are removed before it is recorded. */
  url: string;
  branch?: string;
  collectionsPath?: string;
  indexFile?: string;
  authMode?: string;
  credentialRef?: string;
  /** Any other field is dropped, never recorded. */
  [key: string]: unknown;
}

/** Input of {@link InstallRecordService.recordInstall}. */
export interface RecordInstallInput {
  /** File the entry is recorded in. */
  location: RecordLocation;
  bundleId: string;
  version: string;
  /** The target's type, never the user's target name. */
  tool: string;
  source: RecordSourceInput;
  /** A `SourceType` value equal to `source.type`. */
  sourceType: string;
  /** The writer's `written` list, as absolute paths. */
  writtenPaths: readonly string[];
  /** Workspace root the writer installed into, where merged MCP configs sit; defaults to the record's root. */
  workspaceRoot?: string;
  /**
   * Which sibling tools that share this tool's files to bring to the same version:
   * all (default), the accepted ones, or none. Pass `false` when re-recording a sibling, so the sync never loops.
   */
  syncSiblings?: boolean | ((tool: string) => boolean);
}

/** One sibling entry found by the shared-folder sync. */
export interface SiblingSync {
  tool: string;
  /** Its version now: the new one when synced, the old one otherwise. */
  version: string;
  /** The file that holds the sibling. */
  location: RecordLocation;
  /** `false` when `syncSiblings` did not accept the tool, so the entry is out of date. */
  synced: boolean;
}

/** Outcome of {@link InstallRecordService.recordInstall}. */
export interface RecordInstallResult extends RecordChange {
  /** Non-fatal problems from the saves, for the caller to log. */
  warnings: string[];
  /** Sibling entries found by the shared-folder sync, sorted by tool; empty for an uninstall. */
  siblings: SiblingSync[];
}

/** One `status` row: one (bundle, tool) entry of a record file. */
export interface StatusRow {
  bundleId: string;
  tool: string;
  level: RecordLevel;
  version: string;
  /** Absolute path of the record file the entry is in. */
  record: string;
  /** `true` for an entry under the `unknown` tool that must be reinstalled. */
  needsReinstall: boolean;
}

/** One tool entry of a bundle, with the record file holding it. */
export interface LocatedToolEntry {
  location: RecordLocation;
  bundleId: string;
  tool: string;
  entry: ToolEntry;
}

/** Input of {@link InstallRecordService.uninstallEntry}. */
export interface UninstallEntryInput {
  /** A record file holding the entry; for a repository file both files at its root are read. */
  location: RecordLocation;
  bundleId: string;
  tool: string;
  /** More root-relative paths to keep. */
  keep?: ReadonlySet<string>;
}

/** Outcome of {@link InstallRecordService.uninstallEntry}. */
export interface UninstallEntryResult {
  change: RecordInstallResult;
  /** Root-relative files removed. */
  deleted: string[];
  /** Root-relative files kept: listed by another entry, modified, missing or in `keep`. */
  kept: string[];
  /** Kept files still on disk whose content changed since the install, sorted. */
  modified: string[];
  warnings: string[];
}

/** Outcome of {@link InstallRecordService.deleteSuperseded}. */
export interface DeleteSupersededResult {
  /** Root-relative paths that were removed. */
  deleted: string[];
  /** One message per path that was skipped or could not be removed. */
  warnings: string[];
}

/** Input of {@link InstallRecordService.moveEntry}. */
export interface MoveEntryInput {
  /** The repository file holding the entry now. */
  location: RecordLocation;
  bundleId: string;
  tool: string;
}

/** Outcome of {@link InstallRecordService.moveEntry}. */
export interface MoveEntryResult {
  from: RecordLocation;
  to: RecordLocation;
  /** Root-relative files only the replaced entries listed, for `deleteSuperseded` at `to`; sorted. */
  deletedFiles: string[];
  /** Root-relative files of the replaced entries another entry still lists; sorted. */
  keptSharedFiles: string[];
  warnings: string[];
}

/** The configured source a remapped id points to: `RecordSourceInput` without the key. */
export interface RecordSourceDescriptor {
  /** A `SourceType` value. */
  type: string;
  /** Source URL; credentials are removed before it is recorded. */
  url: string;
  branch?: string;
  collectionsPath?: string;
  indexFile?: string;
  authMode?: string;
  credentialRef?: string;
  /** Any other field is dropped, never recorded. */
  [key: string]: unknown;
}

/** Input of {@link InstallRecordService.remapSource}. */
export interface RemapSourceInput {
  /** Repository root whose two record files are rewritten. */
  root: string;
  from: string;
  to: string;
  /** Fields recorded under `sources.<to>`. */
  descriptor: RecordSourceDescriptor;
}

/** Outcome of {@link InstallRecordService.remapSource}. */
export interface RemapSourceResult {
  /** Record files that changed and were saved, committed first. */
  changed: RecordLocation[];
  warnings: string[];
}

/** Dependencies of an {@link InstallRecordService}. */
export interface InstallRecordServiceOptions {
  /** Record store; loads and saves both repository files. */
  store: RecordStore;
  /** Filesystem port used for confinement, checksums and deletions. */
  fs: RecordFs;
  /** Clock for `installedAt`; defaults to the current time. */
  now?: () => Date;
}

/** Repository-scope MCP config paths of the built-in layouts; merged, not owned, so never recorded. */
const mergedMcpConfigPaths = (): string[] => {
  const prefix = WORKSPACE_ROOT_TOKEN;
  const paths = new Set<string>();
  for (const type of TARGET_TYPES) {
    const config = resolveMcpLayoutConfig(type, 'repository', [defaultLayouts]);
    if (config?.path.startsWith(prefix)) {
      paths.add(config.path.slice(prefix.length).replaceAll('\\', '/').replace(/^\/+/, ''));
    }
  }
  return [...paths];
};

const MERGED_MCP_CONFIG_PATHS = mergedMcpConfigPaths();

/**
 * Whether a git-root-relative path is exactly a merged MCP config file of the
 * install's workspace; a same-named bundle file elsewhere is still recorded.
 * @param relative - Path relative to the git root.
 * @param workspacePrefix - Workspace root relative to the git root; `''` when they are the same.
 */
export const isMergedMcpConfigPath = (relative: string, workspacePrefix = ''): boolean =>
  MERGED_MCP_CONFIG_PATHS.some((mcpPath) => relative === (workspacePrefix === '' ? mcpPath : `${workspacePrefix}/${mcpPath}`));

const copyRecordedFile = (file: RecordedFile): RecordedFile => {
  const copy = Object.create(null) as RecordedFile;
  copy.path = file.path;
  copy.checksum = file.checksum;
  return copy;
};

/**
 * Whether a bundle's only entry at a level is `unknown`: migrated, and not reinstalled by any tool.
 * @param tools - Tool keys of the bundle's entries at the level.
 */
export const isLoneUnknown = (tools: Iterable<string>): boolean => {
  const names = new Set(tools);
  return names.size === 1 && names.has(UNKNOWN_TOOL_NAME);
};

/**
 * Every installed path listed by any entry of the given records.
 * @param records - Records to scan.
 */
export const listedPaths = (records: readonly InstallRecord[]): Set<string> => {
  const listed = new Set<string>();
  for (const record of records) {
    for (const bundle of Object.values(record.bundles)) {
      for (const entry of Object.values(bundle.tools)) {
        for (const file of entry.files) {
          listed.add(file.path);
        }
      }
    }
  }
  return listed;
};

const isSameSource = (left: SourceRecord, right: SourceRecord): boolean => {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => left[key] === right[key]);
};

const remapInRecord = (record: InstallRecord, from: string, to: string, source: SourceRecord): boolean => {
  if (!Object.hasOwn(record.sources, from)) {
    return false;
  }
  let changed = false;
  for (const bundle of Object.values(record.bundles)) {
    for (const entry of Object.values(bundle.tools)) {
      if (entry.sourceId !== from && entry.sourceId !== to) {
        continue;
      }
      if (entry.sourceId !== to || entry.sourceType !== source.type) {
        changed = true;
      }
      entry.sourceId = to;
      entry.sourceType = source.type;
    }
  }
  if (from !== to) {
    delete record.sources[from];
    changed = true;
  }
  const current = Object.hasOwn(record.sources, to) ? record.sources[to] : undefined;
  if (current === undefined || !isSameSource(current, source)) {
    record.sources[to] = source;
    changed = true;
  }
  return changed;
};

/** The pending record change of each root, in this process. */
const pendingChanges = new Map<string, Promise<unknown>>();

/**
 * Run record changes of one root one at a time in this process, so two
 * concurrent installs cannot load the same record and lose each other's entry.
 * A failed change does not stop the next one.
 * @param root - Record root.
 * @param change - Load, change and save of the record files at the root.
 */
const serializeByRoot = async <T>(root: string, change: () => Promise<T>): Promise<T> => {
  const current = (pendingChanges.get(root) ?? Promise.resolve()).catch(() => undefined).then(change);
  const settled = current.catch(() => undefined);
  pendingChanges.set(root, settled);
  try {
    return await current;
  } finally {
    if (pendingChanges.get(root) === settled) {
      pendingChanges.delete(root);
    }
  }
};

/** Records installs and uninstalls in the shared install record. */
export class InstallRecordService {
  private readonly store: RecordStore;
  private readonly fs: RecordFs;
  private readonly now: () => Date;

  public constructor(options: InstallRecordServiceOptions) {
    this.store = options.store;
    this.fs = options.fs;
    this.now = options.now ?? (() => new Date());
  }

  private validateInput(input: RecordInstallInput): void {
    if (!(TARGET_TYPES as readonly string[]).includes(input.tool)) {
      throw recordError('RECORD.UNKNOWN_TOOL', { detail: `tool ${JSON.stringify(input.tool)} is not a target type` });
    }
    if (!(RECORD_SOURCE_TYPES as readonly string[]).includes(input.sourceType)) {
      throw recordError('RECORD.MALFORMED', { detail: `sourceType ${JSON.stringify(input.sourceType)} is not a source type` });
    }
    if (input.sourceType !== input.source.type) {
      throw recordError('RECORD.MALFORMED', {
        detail: `sourceType ${JSON.stringify(input.sourceType)} does not match source.type ${JSON.stringify(input.source.type)}`
      });
    }
    for (const [name, value] of [['bundleId', input.bundleId], ['sourceId', input.source.sourceId], ['version', input.version]] as const) {
      if (typeof value !== 'string' || value === '' || FORBIDDEN_KEYS.has(value)) {
        throw recordError('RECORD.MALFORMED', { detail: `${name} ${JSON.stringify(value)} cannot be recorded` });
      }
    }
  }

  /**
   * A written path relative to the root; falls back to real paths when the root is behind a symlink.
   * @param root - Level root.
   * @param written - Absolute path from the writer.
   */
  private async toRelative(root: string, written: string): Promise<string> {
    const absolute = path.resolve(root, written);
    const direct = relativeInside(root, absolute);
    if (direct !== undefined) {
      return direct;
    }
    try {
      const realRoot = await this.fs.realpath(root);
      const realParent = await this.fs.realpath(path.dirname(absolute));
      const real = relativeInside(realRoot, path.join(realParent, path.basename(absolute)));
      if (real !== undefined) {
        return real;
      }
    } catch {
      // Reported below as outside the root.
    }
    throw recordError('RECORD.PATH_OUTSIDE_ROOT', { file: written, detail: 'the written file is outside the repository root' });
  }

  /**
   * The workspace root relative to the record root; `''` when the same or not below it.
   * @param root - Level root.
   * @param workspaceRoot - Workspace root the writer installed into.
   */
  private async workspacePrefix(root: string, workspaceRoot: string | undefined): Promise<string> {
    if (workspaceRoot === undefined || path.resolve(workspaceRoot) === path.resolve(root)) {
      return '';
    }
    try {
      return await this.toRelative(root, workspaceRoot);
    } catch {
      return '';
    }
  }

  /**
   * Recorded files for the writer's `written` list: confined, checksummed, merged MCP configs left out.
   * @param root - Level root.
   * @param writtenPaths - Absolute paths from the writer.
   * @param workspaceRoot - Workspace root the writer installed into.
   */
  private async toRecordedFiles(root: string, writtenPaths: readonly string[], workspaceRoot?: string): Promise<RecordedFile[]> {
    const workspacePrefix = await this.workspacePrefix(root, workspaceRoot);
    const files = new Map<string, RecordedFile>();
    for (const written of writtenPaths) {
      const relative = await confinePath(this.fs, root, await this.toRelative(root, written));
      if (files.has(relative) || isMergedMcpConfigPath(relative, workspacePrefix)) {
        continue;
      }
      files.set(relative, await hashRecordedFile(this.fs, root, relative));
    }
    return [...files.values()];
  }

  // Also removes the bundle when no tool is left.
  private removeEntry(record: InstallRecord, bundleId: string, tool: string): ToolEntry | undefined {
    const bundle = Object.hasOwn(record.bundles, bundleId) ? record.bundles[bundleId] : undefined;
    if (bundle === undefined || !Object.hasOwn(bundle.tools, tool)) {
      return undefined;
    }
    const entry = bundle.tools[tool];
    delete bundle.tools[tool];
    if (Object.keys(bundle.tools).length === 0) {
      delete record.bundles[bundleId];
    }
    return entry;
  }

  /**
   * Remove the tool's entries keyed by the bundle id or by another id with the same identity.
   * @param record - Record file to change.
   * @param bundleId - Key of the new entry.
   * @param identity - Identity of the new entry.
   * @param tool - The target's type.
   */
  private removeSameIdentity(record: InstallRecord, bundleId: string, identity: string, tool: string): ToolEntry[] {
    const removed: ToolEntry[] = [];
    for (const [key, bundle] of Object.entries(record.bundles)) {
      if (Object.hasOwn(bundle.tools, tool) && (key === bundleId || recordIdentityOf(key, bundle.tools[tool].version) === identity)) {
        removed.push(this.removeEntry(record, key, tool) as ToolEntry);
      }
    }
    return removed;
  }

  private dropUnusedSource(record: InstallRecord, sourceId: string): void {
    if (!Object.hasOwn(record.sources, sourceId)) {
      return;
    }
    const used = Object.values(record.bundles)
      .some((bundle) => Object.values(bundle.tools).some((entry) => entry.sourceId === sourceId));
    if (!used) {
      delete record.sources[sourceId];
    }
  }

  // Clears the `unknown` entries of the same identity and the sources only they used; `true` when there was one.
  private clearUnknown(record: InstallRecord, bundleId: string, identity: string): boolean {
    const removed = this.removeSameIdentity(record, bundleId, identity, UNKNOWN_TOOL_NAME);
    for (const entry of removed) {
      this.dropUnusedSource(record, entry.sourceId);
    }
    return removed.length > 0;
  }

  /**
   * Save a changed record file, or remove a repository file with no bundles left.
   * An empty user record is kept so its import marker survives.
   * @param other - The loaded, changed file.
   */
  private async saveOther(other: LoadedRecord): Promise<string[]> {
    if (other.location.level !== 'repository' || Object.keys(other.record.bundles).length > 0) {
      return (await this.store.save(other.location, other.record)).warnings;
    }
    const name = path.basename(other.location.path);
    try {
      await this.fs.unlink(other.location.path);
    } catch (error) {
      // Keep the record true to disk: save it empty, so it lists no file the caller then deletes.
      const saved = await this.store.save(other.location, other.record);
      return [`Could not remove the empty record ${name}: ${error instanceof Error ? error.message : String(error)}`, ...saved.warnings];
    }
    if (other.location.commitMode === 'local-only') {
      const excluded = await removeExcluded(this.fs, other.location.root, name);
      return excluded.warning === undefined ? [] : [excluded.warning];
    }
    return [];
  }

  /**
   * Bring sibling entries that share the installed tool's files to its version, in memory.
   * A sibling held under another key of the same identity moves to the installed key.
   * @param loaded - The target file, then the other repository file.
   * @param change - What the installed tool wrote.
   * @param change.bundleId - Bundle id.
   * @param change.identity - Its bundle identity.
   * @param change.tool - The installed tool.
   * @param change.version - Its new version.
   * @param change.files - Its new recorded files.
   * @param change.previousPaths - Paths its previous entry listed.
   * @param change.accepts - Which sibling tools to sync.
   * @returns The siblings found, sorted by tool, and the files changed.
   */
  private syncSiblingEntries(
    loaded: readonly LoadedRecord[],
    change: {
      bundleId: string;
      identity: string;
      tool: string;
      version: string;
      files: readonly RecordedFile[];
      previousPaths: ReadonlySet<string>;
      accepts: (tool: string) => boolean;
    }
  ): { siblings: SiblingSync[]; changed: Set<LoadedRecord> } {
    const newByPath = new Map(change.files.map((file) => [file.path, file]));
    const isShared = (recorded: RecordedFile): boolean => change.previousPaths.has(recorded.path) || newByPath.has(recorded.path);
    const siblings: SiblingSync[] = [];
    const changed = new Set<LoadedRecord>();
    for (const file of loaded) {
      const { bundles } = file.record;
      const holdsTool = (tool: string): boolean => Object.hasOwn(bundles, change.bundleId) && Object.hasOwn(bundles[change.bundleId].tools, tool);
      const handled = new Set<string>();
      for (const [key, bundle] of Object.entries(bundles)) {
        for (const [tool, entry] of Object.entries(bundle.tools)) {
          const sameBundle = key === change.bundleId || recordIdentityOf(key, entry.version) === change.identity;
          if (!sameBundle || handled.has(tool) || tool === change.tool || tool === UNKNOWN_TOOL_NAME
            || !entry.files.some((recorded) => isShared(recorded)) || (key !== change.bundleId && holdsTool(tool))) {
            continue;
          }
          handled.add(tool);
          if (!change.accepts(tool)) {
            siblings.push({ tool, version: entry.version, location: file.location, synced: false });
            continue;
          }
          entry.files = entry.files.flatMap((recorded) => {
            if (!isShared(recorded)) {
              return [recorded];
            }
            const written = newByPath.get(recorded.path);
            return written === undefined ? [] : [copyRecordedFile(written)];
          });
          entry.version = change.version;
          entry.installedAt = this.now().toISOString();
          if (key !== change.bundleId) {
            this.removeEntry(file.record, key, tool);
            if (!Object.hasOwn(bundles, change.bundleId)) {
              bundles[change.bundleId] = createBundle();
            }
            bundles[change.bundleId].tools[tool] = entry;
          }
          siblings.push({ tool, version: change.version, location: file.location, synced: true });
          changed.add(file);
        }
      }
    }
    return { siblings: siblings.toSorted((left, right) => compareCodeUnits(left.tool, right.tool)), changed };
  }

  /**
   * Tool entries of the given record files, one per level, root, bundle and
   * tool; an entry in both repository files at one root comes from the committed file.
   * @param locations - Record files to read.
   * @param bundleId - Only this bundle's entries, when given.
   * @param tool - Only this tool's entries, when given.
   */
  private async locateEntries(locations: readonly RecordLocation[], bundleId?: string, tool?: string): Promise<LocatedToolEntry[]> {
    const found = new Map<string, LocatedToolEntry>();
    for (const location of locations) {
      const { record } = await this.store.load(location);
      const bundles = Object.entries(record.bundles).filter(([id]) => bundleId === undefined || id === bundleId);
      for (const [id, bundle] of bundles) {
        for (const [key, entry] of Object.entries(bundle.tools).filter(([name]) => tool === undefined || name === tool)) {
          const dedupeKey = JSON.stringify([location.level, location.root, id, key]);
          const existing = found.get(dedupeKey);
          if (existing !== undefined && (existing.location.commitMode !== 'local-only' || location.commitMode === 'local-only')) {
            continue;
          }
          found.set(dedupeKey, { location, bundleId: id, tool: key, entry });
        }
      }
    }
    return [...found.values()];
  }

  /**
   * Record that a tool installed a bundle, moving the entry out of the other
   * repository file, syncing siblings and clearing the bundle's `unknown` entry.
   * The tool's entries with the same bundle identity in either file are
   * replaced. Saves the target file first; deletes nothing.
   * @param input - Install to record.
   * @returns The change, with the superseded files to delete after the save and the siblings found.
   * @throws {RegistryError} A `RECORD.*` error; the record is unchanged when the target save fails.
   */
  public recordInstall(input: RecordInstallInput): Promise<RecordInstallResult> {
    return serializeByRoot(input.location.root, () => this.applyInstall(input));
  }

  // eslint-disable-next-line @typescript-eslint/member-ordering -- kept next to the public method that serializes it
  private async applyInstall(input: RecordInstallInput): Promise<RecordInstallResult> {
    this.validateInput(input);
    const source: SourceRecord = sanitizeSource(input.source);
    const { location, bundleId, tool } = input;
    const target = await this.store.load(location);
    const otherLocation = otherRepositoryLocation(location);
    const other = otherLocation === undefined ? undefined : await this.store.load(otherLocation);
    const written = await this.toRecordedFiles(location.root, input.writtenPaths, input.workspaceRoot);

    const identity = recordIdentityOf(bundleId, input.version);
    const previous = this.removeSameIdentity(target.record, bundleId, identity, tool);
    const moved = other === undefined ? [] : this.removeSameIdentity(other.record, bundleId, identity, tool);
    previous.push(...moved);
    if (other !== undefined) {
      for (const prior of moved) {
        this.dropUnusedSource(other.record, prior.sourceId);
      }
    }

    const { files } = putToolEntry(target.record, bundleId, tool, {
      version: input.version,
      sourceId: input.source.sourceId,
      sourceType: input.sourceType,
      installedAt: this.now().toISOString(),
      files: written
    });
    target.record.sources[input.source.sourceId] = source;

    const loaded = other === undefined ? [target] : [target, other];
    const sync = input.syncSiblings === false
      ? { siblings: [], changed: new Set<LoadedRecord>() }
      : this.syncSiblingEntries(loaded, {
        bundleId,
        identity,
        tool,
        version: input.version,
        files,
        previousPaths: new Set(previous.flatMap((prior) => prior.files.map((file) => file.path))),
        accepts: typeof input.syncSiblings === 'function' ? input.syncSiblings : () => true
      });

    const newPaths = new Set(files.map((file) => file.path));
    const stillListed = listedPaths(loaded.map((file) => file.record));
    const deletedFiles: string[] = [];
    const keptSharedFiles: string[] = [];
    for (const old of previous.flatMap((prior) => prior.files)) {
      const oldPath = old.path;
      if (newPaths.has(oldPath) || deletedFiles.includes(oldPath) || keptSharedFiles.includes(oldPath)) {
        continue;
      }
      (stillListed.has(oldPath) ? keptSharedFiles : deletedFiles).push(oldPath);
    }

    // A reinstall clears the bundle's `unknown` entries of any version; their files are only no longer listed.
    const clearedOther = other !== undefined && this.clearUnknown(other.record, bundleId, identity);
    this.clearUnknown(target.record, bundleId, identity);

    const warnings = [...(await this.store.save(location, target.record)).warnings];
    if (other !== undefined && (moved.length > 0 || clearedOther || sync.changed.has(other))) {
      warnings.push(...(await this.saveOther(other)));
    }
    const synced = sync.siblings.filter((sibling) => sibling.synced);
    return {
      changedEntries: [{ bundleId, tool }, ...synced.map((sibling) => ({ bundleId, tool: sibling.tool }))],
      deletedFiles: deletedFiles.toSorted(compareCodeUnits),
      keptSharedFiles: keptSharedFiles.toSorted(compareCodeUnits),
      location,
      warnings,
      siblings: sync.siblings
    };
  }

  /**
   * Record that a tool's install of a bundle was removed, from whichever
   * repository file holds it. Paths another entry still lists go to
   * `keptSharedFiles`. Deletes no installed file.
   * @param input - Location, bundle id and tool.
   * @param input.location - Either repository record location; both files at its root are read.
   * @param input.bundleId - Bundle id.
   * @param input.tool - The target's type.
   * @throws {RegistryError} `RECORD.ENTRY_NOT_FOUND` when neither file has the entry.
   */
  public recordUninstall(input: { location: RecordLocation; bundleId: string; tool: string }): Promise<RecordInstallResult> {
    return serializeByRoot(input.location.root, () => this.applyUninstall(input));
  }

  // eslint-disable-next-line @typescript-eslint/member-ordering -- kept next to the public method that serializes it
  private async applyUninstall(input: { location: RecordLocation; bundleId: string; tool: string }): Promise<RecordInstallResult> {
    const { location, bundleId, tool } = input;
    const first = await this.store.load(location);
    const otherLocation = otherRepositoryLocation(location);
    const loaded = otherLocation === undefined ? [first] : [first, await this.store.load(otherLocation)];

    const changed: { file: LoadedRecord; entry: ToolEntry }[] = [];
    for (const file of loaded) {
      const entry = this.removeEntry(file.record, bundleId, tool);
      if (entry !== undefined) {
        changed.push({ file, entry });
      }
    }
    if (changed.length === 0) {
      throw recordError('RECORD.ENTRY_NOT_FOUND', {
        file: path.basename(location.path),
        detail: `no entry for bundle ${JSON.stringify(bundleId)} and tool ${JSON.stringify(tool)}`,
        context: { bundleId, tool }
      });
    }

    const stillListed = listedPaths(loaded.map((file) => file.record));
    const deletedFiles = new Set<string>();
    const keptSharedFiles = new Set<string>();
    for (const { file, entry } of changed) {
      for (const recorded of entry.files) {
        (stillListed.has(recorded.path) ? keptSharedFiles : deletedFiles).add(recorded.path);
      }
      this.dropUnusedSource(file.record, entry.sourceId);
    }

    const warnings: string[] = [];
    for (const { file } of changed) {
      warnings.push(...(await this.saveOther(file)));
    }
    return {
      changedEntries: [{ bundleId, tool }],
      deletedFiles: [...deletedFiles].toSorted(compareCodeUnits),
      keptSharedFiles: [...keptSharedFiles].toSorted(compareCodeUnits),
      location: changed[0].file.location,
      warnings,
      siblings: []
    };
  }

  /**
   * Uninstall one tool's entry and delete its files, keeping files another
   * entry lists, files changed or missing since the install, and `keep`.
   * @param input - The file holding the entry, the bundle id, the tool and extra paths to keep.
   * @throws {RegistryError} `RECORD.ENTRY_NOT_FOUND`, or any `RECORD.*` load or save error.
   */
  public async uninstallEntry(input: UninstallEntryInput): Promise<UninstallEntryResult> {
    const { location, bundleId, tool } = input;
    const other = otherRepositoryLocation(location);
    const recorded: RecordedFile[] = [];
    for (const file of other === undefined ? [location] : [location, other]) {
      const { record } = await this.store.load(file);
      const bundle = Object.hasOwn(record.bundles, bundleId) ? record.bundles[bundleId] : undefined;
      recorded.push(...(bundle !== undefined && Object.hasOwn(bundle.tools, tool) ? bundle.tools[tool].files : []));
    }
    const changedOrMissing = new Set(await findModifiedFiles(this.fs, location.root, recorded));
    const change = await this.recordUninstall({ location, bundleId, tool });
    const isKept = (recordedPath: string): boolean => changedOrMissing.has(recordedPath) || input.keep?.has(recordedPath) === true;
    const removal = await this.deleteSuperseded({
      location: change.location,
      deletedFiles: change.deletedFiles.filter((recordedPath) => !isKept(recordedPath))
    });
    const keptOwn = change.deletedFiles.filter((recordedPath) => isKept(recordedPath));
    const modified: string[] = [];
    for (const recordedPath of keptOwn.filter((candidate) => changedOrMissing.has(candidate))) {
      const stat = await this.fs.lstat(path.join(change.location.root, ...recordedPath.split('/'))).catch(() => undefined);
      if (stat !== undefined) {
        modified.push(recordedPath);
      }
    }
    return {
      change,
      deleted: removal.deleted,
      kept: [...change.keptSharedFiles, ...keptOwn],
      modified,
      warnings: [...change.warnings, ...removal.warnings]
    };
  }

  /**
   * Bundles whose only entries across the given record files, under any key
   * of the same identity, are `unknown`, each with its entry.
   * @param locations - Record files of one level, committed first.
   * @throws {RegistryError} Any `RECORD.*` error from loading a file.
   */
  public async findLoneUnknown(locations: readonly RecordLocation[]): Promise<Map<string, LocatedToolEntry>> {
    const byIdentity = new Map<string, LocatedToolEntry[]>();
    for (const located of await this.listToolEntries(locations)) {
      const identity = recordIdentityOf(located.bundleId, located.entry.version);
      byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), located]);
    }
    return new Map([...byIdentity.values()]
      .filter((entries) => isLoneUnknown(entries.map((located) => located.tool)))
      .flatMap((entries) => entries.map((located): [string, LocatedToolEntry] => [located.bundleId, located])));
  }

  /**
   * Remove a bundle's `unknown` entry, and those of the same identity under
   * other keys, keeping every file they list, since no tool is known to own them.
   * @param location - A record file of the level.
   * @param bundleId - Bundle id.
   * @throws {RegistryError} `RECORD.ENTRY_NOT_FOUND` when no file has the entry, or another `RECORD.*` error.
   */
  public async removeUnknownEntry(location: RecordLocation, bundleId: string): Promise<UninstallEntryResult> {
    const other = otherRepositoryLocation(location);
    const files = other === undefined ? [location] : [location, other];
    const unknown: LocatedToolEntry[] = [];
    // Each file on its own: an interrupted move can leave two copies with different files.
    for (const file of files) {
      unknown.push(...(await this.locateEntries([file], undefined, UNKNOWN_TOOL_NAME)));
    }
    const identities = new Set(unknown.filter((located) => located.bundleId === bundleId)
      .map((located) => recordIdentityOf(bundleId, located.entry.version)));
    const sameIdentity = unknown.filter((located) => identities.has(recordIdentityOf(located.bundleId, located.entry.version)));
    const keep = new Set(sameIdentity.flatMap((located) => located.entry.files.map((recorded) => recorded.path)));
    const result = await this.uninstallEntry({ location, bundleId, tool: UNKNOWN_TOOL_NAME, keep });
    const warnings = [...result.warnings];
    for (const otherKey of new Set(sameIdentity.map((located) => located.bundleId).filter((key) => key !== bundleId))) {
      warnings.push(...(await this.recordUninstall({ location, bundleId: otherKey, tool: UNKNOWN_TOOL_NAME })).warnings);
    }
    return { ...result, kept: [...new Set([...result.kept, ...keep])].toSorted(compareCodeUnits), warnings };
  }

  /**
   * Move one tool's entry, unchanged, between the committed and the local-only
   * repository file. The tool's entries with the same bundle identity in the
   * target are replaced, so its copy from an interrupted move is too. The
   * target is saved first; deletes nothing.
   * @param input - The file holding the entry, the bundle id and the tool.
   * @returns Both files, with the replaced entries' files to delete after the save.
   * @throws {RegistryError} `RECORD.ENTRY_NOT_FOUND` or `RECORD.MALFORMED`, or any `RECORD.*` load or save error.
   */
  public moveEntry(input: MoveEntryInput): Promise<MoveEntryResult> {
    return serializeByRoot(input.location.root, () => this.applyMove(input));
  }

  // eslint-disable-next-line @typescript-eslint/member-ordering -- kept next to the public method that serializes it
  private async applyMove(input: MoveEntryInput): Promise<MoveEntryResult> {
    const { location, bundleId, tool } = input;
    const targetLocation = otherRepositoryLocation(location);
    if (targetLocation === undefined) {
      throw recordError('RECORD.MALFORMED', { file: path.basename(location.path), detail: 'only a repository entry can change commit mode' });
    }
    const from = await this.store.load(location);
    const to = await this.store.load(targetLocation);
    const entry = this.removeEntry(from.record, bundleId, tool);
    if (entry === undefined) {
      throw recordError('RECORD.ENTRY_NOT_FOUND', {
        file: path.basename(location.path),
        detail: `no entry for bundle ${JSON.stringify(bundleId)} and tool ${JSON.stringify(tool)}`,
        context: { bundleId, tool }
      });
    }
    // The store's load checked that the source exists.
    const source = from.record.sources[entry.sourceId];
    this.dropUnusedSource(from.record, entry.sourceId);
    const replaced = this.removeSameIdentity(to.record, bundleId, recordIdentityOf(bundleId, entry.version), tool);
    putToolEntry(to.record, bundleId, tool, entry);
    to.record.sources[entry.sourceId] = source;
    for (const prior of replaced) {
      this.dropUnusedSource(to.record, prior.sourceId);
    }

    const movedPaths = new Set(entry.files.map((file) => file.path));
    const stillListed = listedPaths([to.record, from.record]);
    const deletedFiles = new Set<string>();
    const keptSharedFiles = new Set<string>();
    for (const old of replaced.flatMap((prior) => prior.files)) {
      if (!movedPaths.has(old.path)) {
        (stillListed.has(old.path) ? keptSharedFiles : deletedFiles).add(old.path);
      }
    }

    const saved = await this.store.save(targetLocation, to.record);
    const warnings = [...saved.warnings, ...(await this.saveOther(from))];
    return {
      from: location,
      to: targetLocation,
      deletedFiles: [...deletedFiles].toSorted(compareCodeUnits),
      keptSharedFiles: [...keptSharedFiles].toSorted(compareCodeUnits),
      warnings
    };
  }

  /**
   * Rewrite a source id, and the matching entries' `sourceType`, in both
   * repository files at a root. Both files load before anything is saved, and
   * running it again is a no-op.
   * @param input - Root, the two ids and the source fields for `to`.
   * @throws {RegistryError} `RECORD.MALFORMED` for a bad id or source, or any `RECORD.*` load or save error.
   */
  public async remapSource(input: RemapSourceInput): Promise<RemapSourceResult> {
    const { root, from, to } = input;
    for (const [name, value] of [['from', from], ['to', to]] as const) {
      if (typeof value !== 'string' || value === '' || FORBIDDEN_KEYS.has(value)) {
        throw recordError('RECORD.MALFORMED', { detail: `source id ${name} ${JSON.stringify(value)} cannot be recorded` });
      }
    }
    if (!(RECORD_SOURCE_TYPES as readonly string[]).includes(input.descriptor.type)) {
      throw recordError('RECORD.MALFORMED', { detail: `source type ${JSON.stringify(input.descriptor.type)} is not a source type` });
    }
    const source = sanitizeSource(input.descriptor);
    const [committedLocation, localOnlyLocation] = repositoryLocations(root);
    const committedFile = await this.store.load(committedLocation);
    const loaded = [committedFile, await this.store.load(localOnlyLocation)];

    const changed = loaded.filter((file) => remapInRecord(file.record, from, to, source));
    const warnings: string[] = [];
    for (const file of changed) {
      warnings.push(...(await this.store.save(file.location, file.record)).warnings);
    }
    return { changed: changed.map((file) => file.location), warnings };
  }

  /**
   * One status row per (bundle, tool) entry of the given record files, sorted.
   * An entry in both repository files at one root is listed once.
   * @param locations - Record files to list.
   * @throws {RegistryError} Any `RECORD.*` error from loading a file.
   */
  public async listEntries(locations: readonly RecordLocation[]): Promise<StatusRow[]> {
    const rows: StatusRow[] = (await this.listToolEntries(locations)).map(({ location, bundleId, tool, entry }) => ({
      bundleId,
      tool,
      level: location.level,
      version: entry.version,
      record: location.path,
      needsReinstall: tool === UNKNOWN_TOOL_NAME || entry.needsReinstall === true
    }));
    return rows.toSorted((left, right) =>
      compareCodeUnits(left.bundleId, right.bundleId) || compareCodeUnits(left.tool, right.tool) || compareCodeUnits(left.record, right.record));
  }

  /**
   * A bundle's tool entries in the given record files, in file order.
   * @param locations - Record files to search, committed first.
   * @param bundleId - Bundle id.
   * @param tool - Only this tool's entry, when given.
   * @throws {RegistryError} Any `RECORD.*` error from loading a file.
   */
  public findEntries(locations: readonly RecordLocation[], bundleId: string, tool?: string): Promise<LocatedToolEntry[]> {
    return this.locateEntries(locations, bundleId, tool);
  }

  /**
   * Every tool entry of every bundle in the given record files, in file order.
   * @param locations - Record files to list.
   * @throws {RegistryError} Any `RECORD.*` error from loading a file.
   */
  public listToolEntries(locations: readonly RecordLocation[]): Promise<LocatedToolEntry[]> {
    return this.locateEntries(locations);
  }

  /**
   * The record file that holds the entry, so a re-record keeps its commit mode.
   * @param locations - Record files to search, committed first.
   * @param bundleId - Bundle id.
   * @param tool - Tool key.
   * @returns The file holding the entry, the committed one when both do.
   * @throws {RegistryError} Any `RECORD.*` error from loading a file.
   */
  public async holdingLocation(locations: readonly RecordLocation[], bundleId: string, tool: string): Promise<RecordLocation | undefined> {
    return (await this.findEntries(locations, bundleId, tool))[0]?.location;
  }

  /**
   * Recorded paths by bundle id for every bundle with an entry for `tool`, merged across the files.
   * @param locations - Record files to read.
   * @param tool - Tool key.
   * @throws {RegistryError} Any `RECORD.*` error from loading a file.
   */
  public async entriesForTool(locations: readonly RecordLocation[], tool: string): Promise<Map<string, string[]>> {
    const entries = new Map<string, string[]>();
    for (const location of locations) {
      const { record } = await this.store.load(location);
      for (const [bundleId, bundle] of Object.entries(record.bundles)) {
        if (Object.hasOwn(bundle.tools, tool)) {
          const paths = bundle.tools[tool].files.map((file) => file.path);
          entries.set(bundleId, [...new Set([...(entries.get(bundleId) ?? []), ...paths])]);
        }
      }
    }
    return new Map([...entries].toSorted(([left], [right]) => compareCodeUnits(left, right)));
  }

  /**
   * Delete the files of a saved change. Only regular files and symlinks are
   * removed; anything refused or failing becomes a warning.
   * @param change - The saved change.
   */
  public async deleteSuperseded(change: Pick<RecordChange, 'deletedFiles' | 'location'>): Promise<DeleteSupersededResult> {
    const deleted: string[] = [];
    const warnings: string[] = [];
    for (const recordedPath of change.deletedFiles) {
      const decision = await resolveDeleteTarget(this.fs, change.location.root, recordedPath);
      if (decision.status === 'missing') {
        continue;
      }
      if (decision.status === 'skip') {
        warnings.push(`Did not remove ${recordedPath}: ${decision.reason}.`);
        continue;
      }
      try {
        await this.fs.unlink(decision.absolute);
        deleted.push(recordedPath);
      } catch (error) {
        warnings.push(`Could not remove ${recordedPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { deleted, warnings };
  }

  /**
   * Delete the superseded files of several changes saved in one run, keeping
   * any path a later change listed again.
   * @param changes - The saved changes, in order.
   * @throws {RegistryError} Any `RECORD.*` error from loading a file.
   */
  public async deleteSupersededAfterAll(changes: readonly Pick<RecordChange, 'deletedFiles' | 'location'>[]): Promise<DeleteSupersededResult> {
    const listedByRecord = new Map<string, Set<string>>();
    const handled = new Set<string>();
    const result: DeleteSupersededResult = { deleted: [], warnings: [] };
    for (const change of changes) {
      let listed = listedByRecord.get(change.location.path);
      if (listed === undefined) {
        const other = otherRepositoryLocation(change.location);
        const locations = other === undefined ? [change.location] : [change.location, other];
        const records: InstallRecord[] = [];
        for (const location of locations) {
          records.push((await this.store.load(location)).record);
        }
        listed = listedPaths(records);
        listedByRecord.set(change.location.path, listed);
      }
      const still = listed;
      const deletedFiles = change.deletedFiles.filter((recordedPath) => {
        const key = `${change.location.root}\u0000${recordedPath}`;
        if (still.has(recordedPath) || handled.has(key)) {
          return false;
        }
        handled.add(key);
        return true;
      });
      const removal = await this.deleteSuperseded({ deletedFiles, location: change.location });
      result.deleted.push(...removal.deleted);
      result.warnings.push(...removal.warnings);
    }
    return result;
  }
}
