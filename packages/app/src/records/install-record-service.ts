/**
 * Install record service: records a tool's install or uninstall of a bundle in
 * the shared record. It deletes nothing itself; superseded files come back in
 * `deletedFiles` for `deleteSuperseded` to remove after the save.
 * @module records/install-record-service
 */
import * as path from 'node:path';
import {
  type BundleRecord,
  compareCodeUnits,
  FORBIDDEN_KEYS,
  type InstallRecord,
  type RecordChange,
  type RecordedFile,
  recordError,
  type RecordFs,
  type RecordLocation,
  relativeInside,
  repositoryLocations,
  type SourceRecord,
  type SourceType,
  TARGET_TYPES,
  type ToolEntry,
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
}

/** Outcome of {@link InstallRecordService.recordInstall}. */
export interface RecordInstallResult extends RecordChange {
  /** Non-fatal problems from the saves, for the caller to log. */
  warnings: string[];
}

/** Outcome of {@link InstallRecordService.deleteSuperseded}. */
export interface DeleteSupersededResult {
  /** Root-relative paths that were removed. */
  deleted: string[];
  /** One message per path that was skipped or could not be removed. */
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

const createBundle = (): BundleRecord => {
  const bundle = Object.create(null) as BundleRecord;
  bundle.tools = Object.create(null) as BundleRecord['tools'];
  return bundle;
};

const listedPaths = (records: readonly InstallRecord[]): Set<string> => {
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

  private otherLocation(location: RecordLocation): RecordLocation | undefined {
    if (location.level !== 'repository') {
      return undefined;
    }
    const [committed, localOnly] = repositoryLocations(location.root);
    return location.commitMode === 'local-only' ? committed : localOnly;
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
      const file = Object.create(null) as RecordedFile;
      file.path = relative;
      file.checksum = await this.fs.hashFile(path.join(root, ...relative.split('/')));
      files.set(relative, file);
    }
    return [...files.values()].toSorted((a, b) => compareCodeUnits(a.path, b.path));
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

  /**
   * Save a changed repository file, or remove it when it has no bundles left.
   * Removing the local-only file also removes its `info/exclude` line.
   * @param other - The loaded, changed file.
   */
  private async saveOther(other: LoadedRecord): Promise<string[]> {
    if (Object.keys(other.record.bundles).length > 0) {
      return (await this.store.save(other.location, other.record)).warnings;
    }
    const name = path.basename(other.location.path);
    try {
      await this.fs.unlink(other.location.path);
    } catch (error) {
      return [`Could not remove the empty record ${name}: ${error instanceof Error ? error.message : String(error)}`];
    }
    if (other.location.level === 'repository' && other.location.commitMode === 'local-only') {
      const excluded = await removeExcluded(this.fs, other.location.root, name);
      return excluded.warning === undefined ? [] : [excluded.warning];
    }
    return [];
  }

  /**
   * Record that a tool installed a bundle, moving the entry out of the other
   * repository file. Saves the target file first; deletes nothing.
   * @param input - Install to record.
   * @returns The change, with the superseded files to delete after the save.
   * @throws {RegistryError} A `RECORD.*` error; the record is unchanged when the target save fails.
   */
  public async recordInstall(input: RecordInstallInput): Promise<RecordInstallResult> {
    this.validateInput(input);
    const source: SourceRecord = sanitizeSource(input.source);
    const { location, bundleId, tool } = input;
    const target = await this.store.load(location);
    const otherLocation = this.otherLocation(location);
    const other = otherLocation === undefined ? undefined : await this.store.load(otherLocation);
    const files = await this.toRecordedFiles(location.root, input.writtenPaths, input.workspaceRoot);

    const previous = [this.removeEntry(target.record, bundleId, tool)];
    const moved = other === undefined ? undefined : this.removeEntry(other.record, bundleId, tool);
    previous.push(moved);
    if (other !== undefined && moved !== undefined) {
      this.dropUnusedSource(other.record, moved.sourceId);
    }

    const entry = Object.create(null) as ToolEntry;
    entry.version = input.version;
    entry.sourceId = input.source.sourceId;
    entry.sourceType = input.sourceType;
    entry.installedAt = this.now().toISOString();
    entry.files = files;
    if (!Object.hasOwn(target.record.bundles, bundleId)) {
      target.record.bundles[bundleId] = createBundle();
    }
    target.record.bundles[bundleId].tools[tool] = entry;
    target.record.sources[input.source.sourceId] = source;

    const newPaths = new Set(files.map((file) => file.path));
    const stillListed = listedPaths(other === undefined ? [target.record] : [target.record, other.record]);
    const deletedFiles: string[] = [];
    const keptSharedFiles: string[] = [];
    for (const old of previous.flatMap((prior) => prior?.files ?? [])) {
      const oldPath = old.path;
      if (newPaths.has(oldPath) || deletedFiles.includes(oldPath) || keptSharedFiles.includes(oldPath)) {
        continue;
      }
      (stillListed.has(oldPath) ? keptSharedFiles : deletedFiles).push(oldPath);
    }

    const warnings = [...(await this.store.save(location, target.record)).warnings];
    if (other !== undefined && moved !== undefined) {
      warnings.push(...(await this.saveOther(other)));
    }
    return {
      changedEntries: [{ bundleId, tool }],
      deletedFiles: deletedFiles.toSorted(compareCodeUnits),
      keptSharedFiles: keptSharedFiles.toSorted(compareCodeUnits),
      location,
      warnings
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
  public async recordUninstall(input: { location: RecordLocation; bundleId: string; tool: string }): Promise<RecordInstallResult> {
    const { location, bundleId, tool } = input;
    const first = await this.store.load(location);
    const otherLocation = this.otherLocation(location);
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
      warnings
    };
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
}
