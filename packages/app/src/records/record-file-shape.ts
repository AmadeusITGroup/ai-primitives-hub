/**
 * The install record as stored on disk, and the record the services work on.
 *
 * On disk (#688): sources are keyed by a readable id that is the same on every
 * machine, bundles by `<sourceId>/<name>` with no version, and an entry names
 * no source, since its key does. An entry keeps the hub's bundle id as
 * `bundleId` when it differs from the name, so commands can still look the
 * bundle up, and carries a stable `installationId`.
 *
 * In memory: bundles are keyed by the hub's bundle id and every entry has its
 * `sourceId`, so the services and the commands keep one id per bundle. Records
 * written before this layout are read as they are; the next save rewrites them.
 * @module records/record-file-shape
 */
import {
  createHash,
} from 'node:crypto';
import {
  type BundleRecord,
  type InstallRecord,
  isJsonObject,
  type SourceRecord,
  type ToolEntry,
} from '@ai-primitives-hub/core';
import {
  recordIdentityOf,
} from './record-identity';

/** Prefix of a readable source id. */
export const RECORD_SOURCE_ID_PREFIX = 'src:';

/** Source fields the readable id is made of. */
export interface RecordSourceIdFields {
  type: string;
  url: string;
  branch?: string;
  collectionsPath?: string;
  indexFile?: string;
}

/** scp-style SSH address: `user@host:path`. */
const SCP_PATTERN = /^[^\s/:@]+@([^\s/:@]+):(.*)$/;

const trimSlashes = (value: string): string => value.replaceAll('\\', '/').replace(/^\.?\/+/, '').replace(/\/+$/, '');

// `host/path` of a URL, without scheme, credentials, query, trailing slash or `.git`; a local path as written.
const locationOf = (url: string): string => {
  const scp = SCP_PATTERN.exec(url);
  if (scp !== null) {
    return `${scp[1].toLowerCase()}/${trimSlashes(scp[2]).replace(/\.git$/, '')}`;
  }
  try {
    const parsed = new URL(url);
    if (parsed.host !== '') {
      return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '').replace(/\.git$/, '')}`;
    }
  } catch {
    // Not a URL: a local folder.
  }
  return url.replaceAll('\\', '/').replace(/\/+$/, '');
};

/**
 * Readable source id `src:<type>:<host/path>#<branch>:<path>`, the same on every
 * machine. `<path>` is the collections folder, or the index file of an Artifactory source.
 * @param source - Recorded source fields.
 */
export const recordSourceIdOf = (source: RecordSourceIdFields): string =>
  `${RECORD_SOURCE_ID_PREFIX}${source.type}:${locationOf(source.url)}#${source.branch ?? ''}:${trimSlashes(source.collectionsPath ?? source.indexFile ?? '')}`;

/**
 * Whether an id is a readable source id.
 * @param id - Source id.
 */
export const isRecordSourceId = (id: string): boolean => id.startsWith(RECORD_SOURCE_ID_PREFIX);

/**
 * On-disk bundle key: the source id and the bundle name, no version.
 * @param sourceId - Readable source id.
 * @param name - Bundle name.
 */
export const recordBundleKeyOf = (sourceId: string, name: string): string => `${sourceId}/${name}`;

/**
 * Bundle name: the collection, manifest or index id without its version.
 * @param bundleId - Hub bundle id or manifest id.
 * @param version - Installed version.
 */
export const recordBundleNameOf = (bundleId: string, version: string): string => recordIdentityOf(bundleId, version);

/**
 * Stable id of one install: the same for a bundle, tool and level on every machine.
 * @param level - Record level.
 * @param bundleKey - On-disk bundle key.
 * @param tool - Tool key.
 */
export const installationIdOf = (level: string, bundleKey: string, tool: string): string =>
  `inst-${createHash('sha256').update(`${level}\u0000${bundleKey}\u0000${tool}`).digest('hex').slice(0, 16)}`;

const nullObject = <T>(): T => Object.create(null) as T;

// Of two entries for the same key and tool, the later install wins.
const later = (current: ToolEntry | undefined, candidate: ToolEntry): ToolEntry =>
  current === undefined || Date.parse(candidate.installedAt) >= Date.parse(current.installedAt) ? candidate : current;

/**
 * The record as stored on disk: readable source ids, `<sourceId>/<name>` bundle keys.
 * @param record - In-memory record; left unchanged.
 */
export const toRecordFile = (record: InstallRecord): InstallRecord => {
  const { bundles, sources, ...rest } = record;
  const file = Object.assign(nullObject<InstallRecord>(), rest);
  const idOf = new Map<string, string>();
  file.sources = nullObject<InstallRecord['sources']>();
  // A source under its readable id is the current copy; an older id of the same source only fills a gap.
  const current = new Set<string>();
  const ordered = Object.entries(sources).toSorted(([left], [right]) => Number(isRecordSourceId(right)) - Number(isRecordSourceId(left)));
  for (const [key, source] of ordered) {
    const id = isRecordSourceId(key) ? key : recordSourceIdOf(source);
    idOf.set(key, id);
    const kept = Object.hasOwn(file.sources, id) ? file.sources[id] : undefined;
    // Of two older ids of one source, the copy that names its hub.
    if (kept === undefined || (!current.has(id) && kept.hubId === undefined && source.hubId !== undefined)) {
      file.sources[id] = Object.assign(nullObject<SourceRecord>(), source);
    }
    if (isRecordSourceId(key)) {
      current.add(id);
    }
  }
  file.bundles = nullObject<InstallRecord['bundles']>();
  for (const [bundleId, bundle] of Object.entries(bundles)) {
    const { tools, name: recordedName, ...extra } = bundle;
    for (const [tool, entry] of Object.entries(tools)) {
      const sourceId = idOf.get(entry.sourceId) ?? entry.sourceId;
      const name = typeof recordedName === 'string' && recordedName !== '' ? recordedName : recordBundleNameOf(bundleId, entry.version);
      const key = recordBundleKeyOf(sourceId, name);
      if (!Object.hasOwn(file.bundles, key)) {
        file.bundles[key] = Object.assign(nullObject<BundleRecord>(), extra, { name, tools: nullObject<BundleRecord['tools']>() });
      }
      const { sourceId: _sourceId, ...fields } = entry;
      const stored = Object.assign(nullObject<ToolEntry>(), fields);
      if (bundleId !== name) {
        stored.bundleId = bundleId;
      }
      stored.installationId = installationIdOf(record.level, key, tool);
      const target = file.bundles[key].tools;
      target[tool] = later(Object.hasOwn(target, tool) ? target[tool] : undefined, stored);
    }
  }
  return file;
};

/**
 * The record the services work on, from the record as stored on disk.
 * @param file - Record read from disk and checked against the schema; left unchanged.
 */
export const fromRecordFile = (file: InstallRecord): InstallRecord => {
  const { bundles, ...rest } = file;
  const record = Object.assign(nullObject<InstallRecord>(), rest);
  record.bundles = nullObject<InstallRecord['bundles']>();
  for (const [key, bundle] of Object.entries(bundles)) {
    const slash = key.lastIndexOf('/');
    const keyed = isRecordSourceId(key) && slash > 0;
    if (!isJsonObject(bundle.tools)) {
      // Not a record bundle (another format): kept as it is.
      record.bundles[key] = bundle;
      continue;
    }
    const { tools, ...extra } = bundle;
    for (const [tool, stored] of Object.entries(tools)) {
      const entry = Object.assign(nullObject<ToolEntry>(), stored);
      // Written on every save; derived, so the services never carry it.
      delete entry.installationId;
      let bundleId = key;
      if (keyed) {
        entry.sourceId = key.slice(0, slash);
        bundleId = typeof stored.bundleId === 'string' && stored.bundleId !== '' ? stored.bundleId : key.slice(slash + 1);
        delete entry.bundleId;
      }
      if (!Object.hasOwn(record.bundles, bundleId)) {
        record.bundles[bundleId] = Object.assign(nullObject<BundleRecord>(), extra, { tools: nullObject<BundleRecord['tools']>() });
      }
      // A name the bundle id gives anyway is not kept, so a save derives it again.
      if (record.bundles[bundleId].name === recordBundleNameOf(bundleId, entry.version)) {
        delete record.bundles[bundleId].name;
      }
      const target = record.bundles[bundleId].tools;
      target[tool] = later(Object.hasOwn(target, tool) ? target[tool] : undefined, entry);
    }
  }
  return record;
};
