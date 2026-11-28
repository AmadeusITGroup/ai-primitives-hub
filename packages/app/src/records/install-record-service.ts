/**
 * Install record service: records a tool's install or uninstall of a bundle in
 * the shared record and keeps sibling tools that share its files in step. It
 * also moves entries between the two repository files and remaps source ids.
 * It deletes nothing itself; superseded files come back in `deletedFiles` for
 * `deleteSuperseded` to remove after the save.
 * @module records/install-record-service
 */
import {
  createHash,
} from 'node:crypto';
import * as path from 'node:path';
import {
  compareCodeUnits,
  FORBIDDEN_KEYS,
  type InstallRecord,
  isJsonObject,
  otherRepositoryLocation,
  type RecordChange,
  type RecordedFile,
  type RecordedMcpServer,
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
  checkMcpServers,
  type McpConfigFile,
  mcpServerChecksumOf,
  mcpServerKeyOf,
  type McpServerToWrite,
  readMcpConfig,
  removeMcpServers,
  writeMcpServers,
} from './mcp-servers';
import {
  findModifiedFiles,
} from './modified-files';
import {
  createBundle,
  hashRecordedFile,
  putToolEntry,
} from './record-entry';
import {
  isRecordHubId,
  isRecordSourceId,
  recordBundleKeyOf,
  recordBundleNameOf,
  recordHubIdOf,
  recordHubKeyIn,
  recordSourceIdOf,
} from './record-file-shape';
import {
  hubEntryOf,
  type RecordHubInput,
  toRecordHub,
} from './record-hub';
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
  /** The hub named by `source.hubId`, recorded under `hubs`; a hub that is not shareable is ignored. */
  hub?: RecordHubInput;
  /** A `SourceType` value equal to `source.type`. */
  sourceType: string;
  /** The writer's `written` list, as absolute paths. */
  writtenPaths: readonly string[];
  /** Workspace root the writer installed into, where merged MCP configs sit; defaults to the record's root. */
  workspaceRoot?: string;
  /** Collection, manifest or index id of the bundle, recorded as the bundle `name` without its version. */
  name?: string;
  /** The downloaded bundle's files by bundle path: give the entry its `integrity` and each file its `sourcePath`. */
  bundleFiles?: ReadonlyMap<string, Uint8Array>;
  /**
   * MCP servers the install wrote, `config` relative to the record's root. A
   * server the replaced entry had and this list lacks is removed after the save;
   * absent keeps the replaced entry's servers.
   */
  mcpServers?: readonly RecordedMcpServer[];
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
  /** The shared hub the entry's source came from, when recorded. */
  hubId?: string;
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
  /** MCP servers removed from their files. */
  mcpServersRemoved: RecordedMcpServer[];
  /** MCP servers kept because their definition changed since the install. */
  mcpServersModified: RecordedMcpServer[];
  warnings: string[];
}

/** Outcome of {@link InstallRecordService.deleteSuperseded}. */
export interface DeleteSupersededResult {
  /** Root-relative paths that were removed. */
  deleted: string[];
  /** MCP servers removed from their files. */
  mcpServersRemoved: RecordedMcpServer[];
  /** MCP servers kept because their definition changed since the install. */
  mcpServersModified: RecordedMcpServer[];
  /** One message per path or server that was skipped or could not be removed. */
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
  /** Fields recorded under `sources.<to>`; a missing `hubId` keeps the one recorded for `from`. */
  descriptor: RecordSourceDescriptor;
  /** Fields of the retired source, for records that name it by its readable id. */
  fromDescriptor?: RecordSourceDescriptor;
  /** The hub named by the source's `hubId`, recorded under `hubs`. */
  hub?: RecordHubInput;
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

/**
 * Every MCP server any entry of the records lists, as {@link mcpServerKeyOf} keys.
 * @param records - Records of one level.
 */
export const listedMcpServers = (records: readonly InstallRecord[]): Set<string> => new Set(records.flatMap((record) =>
  Object.values(record.bundles).flatMap((bundle) => Object.values(bundle.tools).flatMap((entry) => (entry.mcpServers ?? []).map((server) => mcpServerKeyOf(server))))));

// `config` of an MCP file: relative to the level root, `/`-separated.
const mcpConfigPathOf = (root: string, file: string): string => {
  const relative = path.relative(root, path.resolve(file));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw recordError('RECORD.PATH_OUTSIDE_ROOT', { file: path.basename(file), detail: `the MCP file ${file} is outside ${root}` });
  }
  return relative.split(path.sep).join('/');
};

/**
 * `config` of an MCP file, checked on disk: its folders, and a symlinked file's
 * target, must resolve inside the level root.
 * @param fs - Filesystem port.
 * @param root - Level root.
 * @param file - Absolute MCP file path.
 * @throws {RegistryError} `RECORD.PATH_OUTSIDE_ROOT`.
 */
const confineMcpConfig = async (fs: RecordFs, root: string, file: string): Promise<string> => {
  const config = mcpConfigPathOf(root, file);
  await confinePath(fs, root, config, config);
  if ((await fs.lstat(file))?.kind === 'symlink') {
    const target = await fs.realpath(file).catch(() => undefined);
    if (target === undefined || relativeInside(await fs.realpath(root), target) === undefined) {
      throw recordError('RECORD.PATH_OUTSIDE_ROOT', { file: config, detail: `the MCP file ${config} links outside ${root}` });
    }
  }
  return config;
};

// Names of the servers any entry of the level records for one MCP file.
const recordedMcpServerNames = async (store: RecordStore, location: RecordLocation, config: string): Promise<Set<string>> => {
  const otherLocation = otherRepositoryLocation(location);
  const records: InstallRecord[] = [];
  for (const file of otherLocation === undefined ? [location] : [location, otherLocation]) {
    records.push((await store.load(file)).record);
  }
  return new Set(records.flatMap((record) => Object.values(record.bundles).flatMap((bundle) => Object.values(bundle.tools)
    .flatMap((entry) => (entry.mcpServers ?? []).filter((server) => server.config === config).map((server) => server.name)))));
};

// One server per file and name, sorted, as prototype-free copies.
const uniqueMcpServers = (servers: readonly RecordedMcpServer[]): RecordedMcpServer[] => {
  const byKey = new Map<string, RecordedMcpServer>();
  for (const server of servers) {
    byKey.set(mcpServerKeyOf(server), Object.assign(Object.create(null) as RecordedMcpServer, server));
  }
  return [...byKey.entries()].toSorted(([left], [right]) => compareCodeUnits(left, right)).map(([, server]) => server);
};

/**
 * The bundle id a key names: the name after the source id of a source-qualified `<sourceId>/<name>` key, else the key.
 * @param key - In-memory bundle key.
 */
const logicalBundleIdOf = (key: string): string => (isRecordSourceId(key) && key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key);

/**
 * The readable id of an entry's source; a configured id an older record keeps is built from its `sources` entry.
 * @param record - Record holding the entry.
 * @param sourceId - The entry's `sourceId`.
 */
const readableSourceIdIn = (record: InstallRecord, sourceId: string): string => {
  if (isRecordSourceId(sourceId) || !Object.hasOwn(record.sources, sourceId)) {
    return sourceId;
  }
  return recordSourceIdOf(record.sources[sourceId]);
};

const isSameSource = (left: SourceRecord, right: SourceRecord): boolean => {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => left[key] === right[key]);
};

/**
 * The record's `hubs` entry for a hub id, when it is an object.
 * @param record - Record to read.
 * @param hubId - Hub id.
 */
const hubEntryIn = (record: InstallRecord | undefined, hubId: string): Record<string, unknown> | undefined => {
  const hubs = record?.hubs;
  if (!isJsonObject(hubs) || !Object.hasOwn(hubs, hubId)) {
    return undefined;
  }
  const entry = hubs[hubId];
  return isJsonObject(entry) ? entry : undefined;
};

/**
 * Record the hub a source names: the given hub, else the entry already in the
 * record or in `fallback`. A `hubId` with no hub entry is removed from the source.
 * @param record - Record to change.
 * @param source - The recorded source; its `hubId` may be removed.
 * @param hub - The source's hub, already checked by `toRecordHub`.
 * @param fallback - Another record that may hold the entry.
 * @returns Whether `hubs` changed.
 */
/**
 * The hub to record, under its readable id; the source's `hubId` is changed to
 * that id when it names this hub. A hub that cannot be recorded gives `undefined`.
 * @param source - Sanitized source; changed in place.
 * @param input - The hub named by the source's `hubId`.
 */
const recordedHubOf = (source: SourceRecord, input: RecordHubInput | undefined): RecordHubInput | undefined => {
  const hub = input === undefined ? undefined : toRecordHub(input.id, input.name, input);
  if (hub === undefined) {
    return undefined;
  }
  const id = recordHubIdOf(hub);
  if (source.hubId === hub.id) {
    source.hubId = id;
  }
  hub.id = id;
  return hub;
};

/**
 * Refuse a source already recorded from another hub. Hubs are compared by
 * readable id, so one hub imported under two configured ids is the same hub.
 * @param files - Loaded record files of the level.
 * @param sourceId - Readable source id.
 * @param hubId - The install's hub: a readable id when its hub is known.
 * @throws {RegistryError} `RECORD.HUB_CONFLICT` naming the file and both hubs.
 */
const assertOneHub = (files: readonly LoadedRecord[], sourceId: string, hubId: string | undefined): void => {
  if (hubId === undefined || !isRecordHubId(hubId)) {
    return;
  }
  for (const file of files) {
    for (const [key, recorded] of Object.entries(file.record.sources)) {
      const sameSource = (isRecordSourceId(key) ? key : recordSourceIdOf(recorded)) === sourceId;
      const recordedHubId = typeof recorded.hubId === 'string' ? recordHubKeyIn(file.record.hubs, recorded.hubId) : undefined;
      if (sameSource && recordedHubId !== undefined && recordedHubId !== hubId) {
        throw recordError('RECORD.HUB_CONFLICT', {
          file: path.basename(file.location.path),
          detail: `source ${JSON.stringify(sourceId)} is recorded from hub ${JSON.stringify(recordedHubId)}, not ${JSON.stringify(hubId)}`,
          context: { sourceId, recordedHubId, hubId }
        });
      }
    }
  }
};

const attachHub = (record: InstallRecord, source: SourceRecord, hub: RecordHubInput | undefined, fallback?: InstallRecord): boolean => {
  const { hubId } = source;
  if (hubId === undefined) {
    return false;
  }
  const current = hubEntryIn(record, hubId);
  const entry = hub?.id === hubId ? hubEntryOf(hub) : current ?? hubEntryIn(fallback, hubId);
  if (entry === undefined) {
    delete source.hubId;
    return false;
  }
  if (current !== undefined && isSameSource(current as SourceRecord, entry as SourceRecord)) {
    return false;
  }
  if (!isJsonObject(record.hubs)) {
    record.hubs = Object.create(null) as Record<string, unknown>;
  }
  (record.hubs)[hubId] = Object.assign(Object.create(null) as Record<string, unknown>, entry);
  return true;
};

/**
 * Drop every `hubs` entry no recorded source names, and `hubs` itself once empty.
 * @param record - Record to change.
 */
const dropUnusedHubs = (record: InstallRecord): void => {
  const { hubs } = record;
  if (!isJsonObject(hubs)) {
    return;
  }
  const used = new Set(Object.values(record.sources).map((source) => source.hubId));
  for (const hubId of Object.keys(hubs)) {
    if (!used.has(hubId)) {
      delete hubs[hubId];
    }
  }
  if (Object.keys(hubs).length === 0) {
    delete record.hubs;
  }
};

const remapInRecord = (record: InstallRecord, from: string, to: string, descriptor: SourceRecord, hub: RecordHubInput | undefined): boolean => {
  if (!Object.hasOwn(record.sources, from)) {
    return false;
  }
  const source: SourceRecord = Object.assign(Object.create(null) as SourceRecord, descriptor);
  const recordedHubId = record.sources[from].hubId;
  if (source.hubId === undefined && typeof recordedHubId === 'string') {
    source.hubId = recordedHubId;
  }
  let changed = attachHub(record, source, hub);
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

/** A bundle file's path and the `sha256:` of its bytes. */
interface BundleFileHash {
  path: string;
  checksum: string;
}

const sha256Hex = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

// Every bundle file with the hash of its bytes, sorted by path.
const indexBundleFiles = (files: ReadonlyMap<string, Uint8Array>): BundleFileHash[] =>
  [...files].map(([filePath, bytes]) => ({ path: filePath.replaceAll('\\', '/'), checksum: `sha256:${sha256Hex(bytes)}` }))
    .toSorted((left, right) => compareCodeUnits(left.path, right.path));

/**
 * `sha256:` of the downloaded bundle: each bundle path with its file's hash, sorted.
 * The same content gives the same value however the archive was packed.
 * @param index - From {@link indexBundleFiles}.
 */
const integrityOf = (index: readonly BundleFileHash[]): string =>
  `sha256:${sha256Hex(index.map((file) => `${file.path}\u0000${file.checksum}\n`).join(''))}`;

// Any execute bit set, as `mode & 0o111` would tell, without bitwise operators.
const isExecutable = (mode: number): boolean => [mode % 8, Math.floor(mode / 8) % 8, Math.floor(mode / 64) % 8].some((bits) => bits % 2 === 1);

const stemOf = (filePath: string): string => path.posix.basename(filePath).split('.')[0];

/**
 * Path inside the bundle of a written file: the bundle file with the same bytes,
 * else the same file name, else the same name stem, as when a tool renames or converts a file.
 * @param recorded - The written file, hashed.
 * @param index - The bundle's files.
 */
const sourcePathOf = (recorded: RecordedFile, index: readonly BundleFileHash[]): string | undefined => {
  const base = path.posix.basename(recorded.path);
  const sameBytes = index.filter((file) => file.checksum === recorded.checksum);
  return (sameBytes.find((file) => path.posix.basename(file.path) === base) ?? sameBytes[0]
    ?? index.find((file) => path.posix.basename(file.path) === base)
    ?? index.find((file) => stemOf(file.path) === stemOf(recorded.path)))?.path;
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

  /**
   * Take out of `deletedFiles` the superseded files changed since the install,
   * so a reinstall keeps local edits as uninstall does. Missing files stay in
   * `deletedFiles`; their removal is a no-op.
   * @param root - Level root the paths are relative to.
   * @param deletedFiles - Superseded paths, changed in place.
   * @param recorded - The replaced entries' files, with their checksums.
   * @returns The kept paths, sorted.
   */
  private async keepModified(root: string, deletedFiles: string[], recorded: readonly RecordedFile[]): Promise<string[]> {
    const candidates = new Set(deletedFiles);
    const changedOrMissing = await findModifiedFiles(this.fs, root, recorded.filter((file) => candidates.has(file.path)));
    const kept: string[] = [];
    for (const recordedPath of changedOrMissing) {
      // Only a path known to be missing stays for removal; one that cannot be checked is kept.
      const missing = await this.fs.lstat(path.join(root, ...recordedPath.split('/'))).then((stat) => stat === undefined, () => false);
      if (!missing) {
        deletedFiles.splice(deletedFiles.indexOf(recordedPath), 1);
        kept.push(recordedPath);
      }
    }
    return kept.toSorted(compareCodeUnits);
  }

  /**
   * The paths to delete that another entry lists through an aliased parent
   * folder: both name the same file, so it is still owned. Parent folders are
   * resolved and the leaf name kept; an unresolvable parent compares as written.
   * @param root - Level root.
   * @param deleted - Paths to delete.
   * @param listed - Paths the level's entries still list.
   */
  private async aliasedListedPaths(root: string, deleted: readonly string[], listed: ReadonlySet<string>): Promise<string[]> {
    if (deleted.length === 0 || listed.size === 0) {
      return [];
    }
    const parents = new Map<string, Promise<string>>();
    const keyOf = async (recordedPath: string): Promise<string> => {
      const segments = recordedPath.split(/[/\\]/);
      const leaf = segments.pop() as string;
      const parent = segments.join('/');
      let resolved = parents.get(parent);
      if (resolved === undefined) {
        resolved = this.fs.realpath(path.join(root, ...segments)).catch(() => path.join(root, ...segments));
        parents.set(parent, resolved);
      }
      return path.join(await resolved, leaf);
    };
    const listedKeys = new Set(await Promise.all([...listed].map((listedPath) => keyOf(listedPath))));
    const aliased: string[] = [];
    for (const recordedPath of deleted) {
      if (listedKeys.has(await keyOf(recordedPath))) {
        aliased.push(recordedPath);
      }
    }
    return aliased;
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
   * @param bundleIndex - The downloaded bundle's files, to give each file its `sourcePath`.
   */
  private async toRecordedFiles(
    root: string,
    writtenPaths: readonly string[],
    workspaceRoot?: string,
    bundleIndex?: readonly BundleFileHash[]
  ): Promise<RecordedFile[]> {
    const workspacePrefix = await this.workspacePrefix(root, workspaceRoot);
    const files = new Map<string, RecordedFile>();
    for (const written of writtenPaths) {
      const relative = await confinePath(this.fs, root, await this.toRelative(root, written));
      if (files.has(relative) || isMergedMcpConfigPath(relative, workspacePrefix)) {
        continue;
      }
      const recorded = await hashRecordedFile(this.fs, root, relative);
      const sourcePath = bundleIndex === undefined ? undefined : sourcePathOf(recorded, bundleIndex);
      if (sourcePath !== undefined) {
        recorded.sourcePath = sourcePath;
      }
      // Only a regular file's mode means something; a symlink's is always 777.
      const stat = await this.fs.lstat(path.join(root, ...relative.split('/')));
      if (stat?.kind === 'file' && stat.mode !== undefined && isExecutable(stat.mode)) {
        recorded.mode = `0${stat.mode.toString(8).padStart(3, '0')}`;
      }
      files.set(relative, recorded);
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
   * Save a record file, without the `hubs` entries no source names.
   * @param location - Record file.
   * @param record - Its content.
   */
  private save(location: RecordLocation, record: InstallRecord): ReturnType<RecordStore['save']> {
    dropUnusedHubs(record);
    return this.store.save(location, record);
  }

  /**
   * Save a changed record file, or remove a repository file with no bundles left.
   * An empty user record is kept so its import marker survives.
   * @param other - The loaded, changed file.
   */
  private async saveOther(other: LoadedRecord): Promise<string[]> {
    if (other.location.level !== 'repository' || Object.keys(other.record.bundles).length > 0) {
      return (await this.save(other.location, other.record)).warnings;
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
   * @param change.sourceId - Readable id of its source; another source's entry is not a sibling.
   * @param change.version - Its new version.
   * @param change.integrity - The new version's bundle integrity, when known.
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
      sourceId: string;
      version: string;
      integrity?: string;
      files: readonly RecordedFile[];
      previousPaths: ReadonlySet<string>;
      accepts: (tool: string) => boolean;
    }
  ): { siblings: SiblingSync[]; changed: Set<LoadedRecord> } {
    const newByPath = new Map(change.files.map((file) => [file.path, file]));
    const isShared = (recorded: RecordedFile): boolean => change.previousPaths.has(recorded.path) || newByPath.has(recorded.path);
    const siblings: SiblingSync[] = [];
    const changed = new Set<LoadedRecord>();
    const logicalIdentity = recordIdentityOf(logicalBundleIdOf(change.bundleId), change.version);
    for (const file of loaded) {
      const { bundles } = file.record;
      const holdsTool = (tool: string): boolean => Object.hasOwn(bundles, change.bundleId) && Object.hasOwn(bundles[change.bundleId].tools, tool);
      const handled = new Set<string>();
      for (const [key, bundle] of Object.entries(bundles)) {
        for (const [tool, entry] of Object.entries(bundle.tools)) {
          // Compared by logical name: a source-qualified key holds the same bundle as the plain one.
          const sameBundle = (key === change.bundleId || recordIdentityOf(logicalBundleIdOf(key), entry.version) === logicalIdentity)
            && readableSourceIdIn(file.record, entry.sourceId) === change.sourceId;
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
          // The sibling now holds the new version's content; an unknown one leaves no stale value.
          if (change.integrity === undefined) {
            delete entry.integrity;
          } else {
            entry.integrity = change.integrity;
          }
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

  /**
   * Refuse, before any file is written, an install of a source the record holds from another hub.
   * @param location - Record file the install will change.
   * @param source - Source to record.
   * @param hub - The hub named by `source.hubId`.
   * @throws {RegistryError} `RECORD.HUB_CONFLICT`, or any `RECORD.*` load error.
   */
  public async checkSourceHub(location: RecordLocation, source: RecordSourceInput, hub?: RecordHubInput): Promise<void> {
    const sanitized = sanitizeSource(source);
    recordedHubOf(sanitized, hub);
    const otherLocation = otherRepositoryLocation(location);
    const files = [await this.store.load(location), ...(otherLocation === undefined ? [] : [await this.store.load(otherLocation)])];
    assertOneHub(files, recordSourceIdOf(sanitized), sanitized.hubId);
  }

  // eslint-disable-next-line @typescript-eslint/member-ordering -- kept next to the public method that serializes it
  private async applyInstall(input: RecordInstallInput): Promise<RecordInstallResult> {
    this.validateInput(input);
    const source: SourceRecord = sanitizeSource(input.source);
    // Recorded under its readable id, the same on every machine, whatever the configured id.
    const sourceId = recordSourceIdOf(source);
    const hub = recordedHubOf(source, input.hub);
    const { location, tool } = input;
    const target = await this.store.load(location);
    const otherLocation = otherRepositoryLocation(location);
    const other = otherLocation === undefined ? undefined : await this.store.load(otherLocation);
    // Another source's entry of the same name keeps the plain key, and this source's entry its own key
    // (see `fromRecordFile`): a reinstall from this source updates its own entry, not the other one.
    const ownKey = recordBundleKeyOf(sourceId, recordBundleNameOf(input.name ?? input.bundleId, input.version));
    const hasOwnKey = ownKey !== input.bundleId && [target, other].some((file) => file !== undefined
      && Object.hasOwn(file.record.bundles, ownKey) && Object.hasOwn(file.record.bundles[ownKey].tools, tool));
    const bundleId = hasOwnKey ? ownKey : input.bundleId;
    assertOneHub(other === undefined ? [target] : [target, other], sourceId, source.hubId);
    // Without the hub's details, a configured hub id keeps the hub the source is recorded from.
    if (hub === undefined && source.hubId !== undefined && !isRecordHubId(source.hubId)) {
      const recordedHubId = [target, other]
        .map((file) => file !== undefined && Object.hasOwn(file.record.sources, sourceId) ? file.record.sources[sourceId].hubId : undefined)
        .find((id) => id !== undefined && isRecordHubId(id));
      if (recordedHubId !== undefined) {
        source.hubId = recordedHubId;
      }
    }
    const bundleIndex = input.bundleFiles === undefined ? undefined : indexBundleFiles(input.bundleFiles);
    const written = await this.toRecordedFiles(location.root, input.writtenPaths, input.workspaceRoot, bundleIndex);

    const identity = recordIdentityOf(bundleId, input.version);
    const previous = this.removeSameIdentity(target.record, bundleId, identity, tool);
    const moved = other === undefined ? [] : this.removeSameIdentity(other.record, bundleId, identity, tool);
    previous.push(...moved);
    if (other !== undefined) {
      for (const prior of moved) {
        this.dropUnusedSource(other.record, prior.sourceId);
      }
    }

    const previousMcp = previous.flatMap((prior) => prior.mcpServers ?? []);
    const mcpServers = input.mcpServers === undefined ? uniqueMcpServers(previousMcp) : uniqueMcpServers(input.mcpServers);
    const entry = putToolEntry(target.record, bundleId, tool, {
      version: input.version,
      sourceId,
      sourceType: input.sourceType,
      installedAt: this.now().toISOString(),
      ...(bundleIndex === undefined ? {} : { integrity: integrityOf(bundleIndex) }),
      files: written
    });
    const { files } = entry;
    if (mcpServers.length > 0) {
      entry.mcpServers = mcpServers;
    }
    if (input.name !== undefined && input.name !== '') {
      target.record.bundles[bundleId].name = recordBundleNameOf(input.name, input.version);
    }
    target.record.sources[sourceId] = source;
    attachHub(target.record, source, hub, other?.record);

    const loaded = other === undefined ? [target] : [target, other];
    const sync = input.syncSiblings === false
      ? { siblings: [], changed: new Set<LoadedRecord>() }
      : this.syncSiblingEntries(loaded, {
        bundleId,
        identity,
        tool,
        sourceId,
        version: input.version,
        ...(entry.integrity === undefined ? {} : { integrity: entry.integrity }),
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
    for (const aliased of await this.aliasedListedPaths(location.root, deletedFiles, stillListed)) {
      deletedFiles.splice(deletedFiles.indexOf(aliased), 1);
      keptSharedFiles.push(aliased);
    }
    const keptModifiedFiles = await this.keepModified(location.root, deletedFiles, previous.flatMap((prior) => prior.files));

    const stillListedMcp = listedMcpServers(loaded.map((file) => file.record));
    const removedMcpServers = uniqueMcpServers(previousMcp.filter((server) => !stillListedMcp.has(mcpServerKeyOf(server))));

    // A reinstall clears the bundle's `unknown` entries of any version; their files are only no longer listed.
    const clearedOther = other !== undefined && this.clearUnknown(other.record, bundleId, identity);
    this.clearUnknown(target.record, bundleId, identity);

    const warnings = [
      ...(await this.save(location, target.record)).warnings,
      ...keptModifiedFiles.map((file) => `Did not remove ${file}: it was changed after install.`)
    ];
    if (other !== undefined && (moved.length > 0 || clearedOther || sync.changed.has(other))) {
      warnings.push(...(await this.saveOther(other)));
    }
    const synced = sync.siblings.filter((sibling) => sibling.synced);
    return {
      changedEntries: [{ bundleId, tool }, ...synced.map((sibling) => ({ bundleId, tool: sibling.tool }))],
      deletedFiles: deletedFiles.toSorted(compareCodeUnits),
      keptSharedFiles: keptSharedFiles.toSorted(compareCodeUnits),
      ...(keptModifiedFiles.length > 0 ? { keptModifiedFiles } : {}),
      ...(removedMcpServers.length > 0 ? { removedMcpServers } : {}),
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
    for (const aliased of await this.aliasedListedPaths(location.root, [...deletedFiles], stillListed)) {
      deletedFiles.delete(aliased);
      keptSharedFiles.add(aliased);
    }

    // A server another entry lists, such as a sibling tool sharing the MCP file, stays.
    const stillListedMcp = listedMcpServers(loaded.map((file) => file.record));
    const removedMcpServers = uniqueMcpServers(changed.flatMap(({ entry }) => entry.mcpServers ?? [])
      .filter((server) => !stillListedMcp.has(mcpServerKeyOf(server))));

    const warnings: string[] = [];
    for (const { file } of changed) {
      warnings.push(...(await this.saveOther(file)));
    }
    return {
      changedEntries: [{ bundleId, tool }],
      deletedFiles: [...deletedFiles].toSorted(compareCodeUnits),
      keptSharedFiles: [...keptSharedFiles].toSorted(compareCodeUnits),
      ...(removedMcpServers.length > 0 ? { removedMcpServers } : {}),
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
      deletedFiles: change.deletedFiles.filter((recordedPath) => !isKept(recordedPath)),
      ...(change.removedMcpServers === undefined ? {} : { removedMcpServers: change.removedMcpServers })
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
      mcpServersRemoved: removal.mcpServersRemoved,
      mcpServersModified: removal.mcpServersModified,
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
    const source: SourceRecord = Object.assign(Object.create(null) as SourceRecord, from.record.sources[entry.sourceId]);
    this.dropUnusedSource(from.record, entry.sourceId);
    const replaced = this.removeSameIdentity(to.record, bundleId, recordIdentityOf(bundleId, entry.version), tool);
    putToolEntry(to.record, bundleId, tool, entry);
    to.record.sources[entry.sourceId] = source;
    attachHub(to.record, source, undefined, from.record);
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

    const saved = await this.save(targetLocation, to.record);
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

    const hub = recordedHubOf(source, input.hub);
    // Records name a source by its readable id; older ones by the configured id.
    const toId = recordSourceIdOf(source);
    const fromIds = [from, ...(input.fromDescriptor === undefined ? [] : [recordSourceIdOf(sanitizeSource(input.fromDescriptor))])];
    const changed = loaded.filter((file) => fromIds.map((fromId) => remapInRecord(file.record, fromId, toId, source, hub)).includes(true));
    const warnings: string[] = [];
    for (const file of changed) {
      warnings.push(...(await this.save(file.location, file.record)).warnings);
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
    const sources = new Map<string, InstallRecord['sources']>();
    for (const location of locations) {
      sources.set(location.path, (await this.store.load(location)).record.sources);
    }
    const rows: StatusRow[] = (await this.listToolEntries(locations)).map(({ location, bundleId, tool, entry }) => {
      const recorded = sources.get(location.path);
      const hubId = recorded !== undefined && Object.hasOwn(recorded, entry.sourceId) ? recorded[entry.sourceId].hubId : undefined;
      return {
        bundleId,
        tool,
        level: location.level,
        version: entry.version,
        record: location.path,
        needsReinstall: tool === UNKNOWN_TOOL_NAME || entry.needsReinstall === true,
        ...(typeof hubId === 'string' && hubId !== '' ? { hubId } : {})
      };
    });
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
  public async deleteSuperseded(change: Pick<RecordChange, 'deletedFiles' | 'location' | 'removedMcpServers'>): Promise<DeleteSupersededResult> {
    const deleted: string[] = [];
    const warnings: string[] = [];
    const mcp = await this.removeRecordedMcpServers(change.location.root, change.removedMcpServers ?? []);
    warnings.push(...mcp.warnings);
    for (const recordedPath of change.deletedFiles) {
      try {
        const decision = await resolveDeleteTarget(this.fs, change.location.root, recordedPath);
        if (decision.status === 'missing') {
          continue;
        }
        if (decision.status === 'skip') {
          warnings.push(`Did not remove ${recordedPath}: ${decision.reason}.`);
          continue;
        }
        await this.fs.unlink(decision.absolute);
        deleted.push(recordedPath);
      } catch (error) {
        warnings.push(`Could not remove ${recordedPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { deleted, mcpServersRemoved: mcp.removed, mcpServersModified: mcp.modified, warnings };
  }

  /**
   * Write a bundle's MCP servers into a tool's MCP file under the level root. A
   * name the file has is replaced only when an entry of the level records it.
   * @param input - The level's record file, the MCP file and the servers.
   * @param input.location - Record file the install is recorded in.
   * @param input.file - The tool's MCP file; it must be inside the level root.
   * @param input.servers - Servers to write.
   * @returns The servers as recorded, `config` relative to the level root.
   * @throws {RegistryError} `RECORD.PATH_OUTSIDE_ROOT`, `RECORD.MCP_CONFLICT` or `RECORD.MCP_CONFIG_UNREADABLE`; the file is then unchanged.
   */
  public writeMcpServers(input: {
    location: RecordLocation;
    file: McpConfigFile;
    servers: readonly McpServerToWrite[];
  }): Promise<RecordedMcpServer[]> {
    // The read-merge-write of the MCP file runs on the root's queue, as record changes do.
    return serializeByRoot(input.location.root, async () => {
      const config = await confineMcpConfig(this.fs, input.location.root, input.file.path);
      const listed = await recordedMcpServerNames(this.store, input.location, config);
      const written = await writeMcpServers(this.fs, input.file, input.servers, { isRecorded: (name) => listed.has(name), label: config });
      return written.map((server): RecordedMcpServer => ({ config, ...server }));
    });
  }

  /**
   * Check that servers can be written into a tool's MCP file, writing nothing, so
   * an install can refuse before it writes its other files.
   * @param input - The level's record file, the MCP file and the servers.
   * @param input.location - Record file the install is recorded in.
   * @param input.file - The tool's MCP file; it must be inside the level root.
   * @param input.servers - Servers to write.
   * @throws {RegistryError} `RECORD.PATH_OUTSIDE_ROOT`, `RECORD.MCP_CONFLICT` or `RECORD.MCP_CONFIG_UNREADABLE`.
   */
  public async checkMcpServers(input: {
    location: RecordLocation;
    file: McpConfigFile;
    servers: readonly McpServerToWrite[];
  }): Promise<void> {
    const config = await confineMcpConfig(this.fs, input.location.root, input.file.path);
    const listed = await recordedMcpServerNames(this.store, input.location, config);
    await checkMcpServers(this.fs, input.file, input.servers, { isRecorded: (name) => listed.has(name), label: config });
  }

  /**
   * Add MCP servers to an entry that already exists, as a migration from another
   * store of them does. Servers the entry lists are left as they are.
   * @param input - Record file, bundle id, tool and servers.
   * @param input.location - Either record file of the level; both repository files are searched.
   * @param input.bundleId - Bundle id.
   * @param input.tool - Tool key.
   * @param input.servers - Servers to add, `config` relative to the level root.
   * @returns `true` when an entry took the servers.
   * @throws {RegistryError} Any `RECORD.*` load or save error.
   */
  public addMcpServers(input: {
    location: RecordLocation;
    bundleId: string;
    tool: string;
    servers: readonly RecordedMcpServer[];
  }): Promise<boolean> {
    return serializeByRoot(input.location.root, async () => {
      const otherLocation = otherRepositoryLocation(input.location);
      for (const location of otherLocation === undefined ? [input.location] : [input.location, otherLocation]) {
        const file = await this.store.load(location);
        const bundle = Object.hasOwn(file.record.bundles, input.bundleId) ? file.record.bundles[input.bundleId] : undefined;
        const entry = bundle !== undefined && Object.hasOwn(bundle.tools, input.tool) ? bundle.tools[input.tool] : undefined;
        if (entry === undefined) {
          continue;
        }
        const merged = uniqueMcpServers([...(entry.mcpServers ?? []), ...input.servers.filter((server) =>
          !(entry.mcpServers ?? []).some((recorded) => mcpServerKeyOf(recorded) === mcpServerKeyOf(server)))]);
        if (merged.length !== (entry.mcpServers ?? []).length) {
          entry.mcpServers = merged;
          await this.save(location, file.record);
        }
        return true;
      }
      return false;
    });
  }

  /**
   * Every MCP server the entries of a level list for one MCP file, by name, with
   * the bundle id of an entry listing it.
   * @param location - Either record file of the level.
   * @param file - The tool's MCP file; a file outside the level root has none.
   * @throws {RegistryError} Any `RECORD.*` load error.
   */
  public async recordedMcpServersIn(location: RecordLocation, file: string): Promise<Map<string, string>> {
    let config: string;
    try {
      config = mcpConfigPathOf(location.root, file);
    } catch {
      return new Map();
    }
    const otherLocation = otherRepositoryLocation(location);
    const owners = new Map<string, string>();
    for (const recordFile of otherLocation === undefined ? [location] : [location, otherLocation]) {
      const { record } = await this.store.load(recordFile);
      for (const [bundleId, bundle] of Object.entries(record.bundles)) {
        for (const entry of Object.values(bundle.tools)) {
          for (const server of entry.mcpServers ?? []) {
            if (server.config === config && !owners.has(server.name)) {
              owners.set(server.name, bundleId);
            }
          }
        }
      }
    }
    return owners;
  }

  /**
   * Describe servers another writer put in a tool's MCP file, as an entry records them.
   * Names the file does not have are left out.
   * @param root - Level root.
   * @param file - The tool's MCP file; it must be inside the level root.
   * @param servers - Server names with the bundle item each came from.
   * @throws {RegistryError} `RECORD.PATH_OUTSIDE_ROOT` or `RECORD.MCP_CONFIG_UNREADABLE`.
   */
  public async describeMcpServers(root: string, file: McpConfigFile, servers: readonly { name: string; item?: string }[]): Promise<RecordedMcpServer[]> {
    const config = await confineMcpConfig(this.fs, root, file.path);
    const current = await readMcpConfig(this.fs, file, config);
    const map = isJsonObject(current[file.serversKey]) ? current[file.serversKey] as Record<string, unknown> : {};
    return servers.filter((server) => Object.hasOwn(map, server.name)).map((server) => ({
      config,
      name: server.name,
      ...(server.item === undefined ? {} : { item: server.item }),
      checksum: mcpServerChecksumOf(map[server.name])
    }));
  }

  /**
   * Remove recorded MCP servers from their files under a level root, keeping
   * those whose definition changed; a file outside the root is never touched.
   * @param root - Level root the `config` paths are relative to.
   * @param servers - Servers to remove.
   */
  public async removeRecordedMcpServers(
    root: string,
    servers: readonly RecordedMcpServer[]
  ): Promise<{ removed: RecordedMcpServer[]; modified: RecordedMcpServer[]; warnings: string[] }> {
    const result = { removed: [] as RecordedMcpServer[], modified: [] as RecordedMcpServer[], warnings: [] as string[] };
    const byConfig = new Map<string, RecordedMcpServer[]>();
    for (const server of servers) {
      byConfig.set(server.config, [...(byConfig.get(server.config) ?? []), server]);
    }
    for (const [config, ofConfig] of byConfig) {
      const absolute = path.resolve(root, ...config.split('/'));
      const confined = await confineMcpConfig(this.fs, root, absolute).then(() => true, () => false);
      if (!confined) {
        result.warnings.push(`Did not change ${config}: it is outside ${root}.`);
        continue;
      }
      for (const serversKey of ['servers', 'mcpServers'] as const) {
        try {
          const removal = await removeMcpServers(this.fs, { path: absolute, serversKey }, ofConfig, config);
          const named = (names: string[]): RecordedMcpServer[] => ofConfig.filter((server) => names.includes(server.name));
          result.removed.push(...named(removal.removed));
          result.modified.push(...named(removal.modified));
        } catch (error) {
          result.warnings.push(`Did not remove the MCP servers of ${config}: ${error instanceof Error ? error.message : String(error)}`);
          break;
        }
      }
    }
    for (const server of result.modified) {
      result.warnings.push(`Kept MCP server ${server.name} in ${server.config}: it was changed since the install.`);
    }
    return result;
  }

  /**
   * Delete the superseded files of several changes saved in one run, keeping
   * any path a later change listed again.
   * @param changes - The saved changes, in order.
   * @throws {RegistryError} Any `RECORD.*` error from loading a file.
   */
  public async deleteSupersededAfterAll(
    changes: readonly Pick<RecordChange, 'deletedFiles' | 'location' | 'removedMcpServers'>[]
  ): Promise<DeleteSupersededResult> {
    const listedByRecord = new Map<string, Set<string>>();
    const listedMcpByRecord = new Map<string, Set<string>>();
    const handled = new Set<string>();
    const result: DeleteSupersededResult = { deleted: [], mcpServersRemoved: [], mcpServersModified: [], warnings: [] };
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
        listedMcpByRecord.set(change.location.path, listedMcpServers(records));
      }
      const stillMcp = listedMcpByRecord.get(change.location.path) ?? new Set<string>();
      const removedMcpServers = (change.removedMcpServers ?? []).filter((server) => {
        const key = `${change.location.root}\u0000mcp\u0000${mcpServerKeyOf(server)}`;
        if (stillMcp.has(mcpServerKeyOf(server)) || handled.has(key)) {
          return false;
        }
        handled.add(key);
        return true;
      });
      const still = listed;
      const deletedFiles = change.deletedFiles.filter((recordedPath) => {
        const key = `${change.location.root}\u0000${recordedPath}`;
        if (still.has(recordedPath) || handled.has(key)) {
          return false;
        }
        handled.add(key);
        return true;
      });
      const removal = await this.deleteSuperseded({ deletedFiles, location: change.location, removedMcpServers });
      result.deleted.push(...removal.deleted);
      result.mcpServersRemoved.push(...removal.mcpServersRemoved);
      result.mcpServersModified.push(...removal.mcpServersModified);
      result.warnings.push(...removal.warnings);
    }
    return result;
  }
}
