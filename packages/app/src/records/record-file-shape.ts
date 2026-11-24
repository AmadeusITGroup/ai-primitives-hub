/**
 * The install record as stored on disk, and the record the services work on.
 *
 * On disk (#688): sources and hubs are keyed by a readable id that is the same
 * on every machine, bundles by `<sourceId>/<name>` with no version, and an entry names
 * no source, since its key does. An entry keeps the hub's bundle id as
 * `bundleId` when it differs from the name, so commands can still look the
 * bundle up.
 *
 * In memory: bundles are keyed by the hub's bundle id and every entry has its
 * `sourceId`, so the services and the commands keep one id per bundle. Readable
 * ids of an earlier form are rewritten on read; records keyed by configured ids
 * are read as they are, and the next save rewrites them.
 * @module records/record-file-shape
 */
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

/** Prefix of a readable hub id. */
export const RECORD_HUB_ID_PREFIX = 'hub:';

/** Hub fields the readable id is made of. */
export interface RecordHubIdFields {
  type: string;
  location: string;
  ref?: string;
  configFile?: string;
}

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

// `#<ref>` and `:<path>`, each left out when empty and nothing follows it.
const suffixOf = (ref: string | undefined, subPath: string): string => {
  if (subPath !== '') {
    return `#${ref ?? ''}:${subPath}`;
  }
  return ref === undefined || ref === '' ? '' : `#${ref}`;
};

/**
 * Readable source id `src:<type>:<host/path>[#<branch>][:<path>]`, the same on
 * every machine. `<path>` is the collections folder, or the index file of an
 * Artifactory source; an empty branch or path is left out.
 * @param source - Recorded source fields.
 */
export const recordSourceIdOf = (source: RecordSourceIdFields): string =>
  `${RECORD_SOURCE_ID_PREFIX}${source.type}:${locationOf(source.url)}${suffixOf(source.branch, trimSlashes(source.collectionsPath ?? source.indexFile ?? ''))}`;

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

/** A GitHub `owner/repo` location, without a host. */
const GITHUB_SHORTHAND_PATTERN = /^[\w.-]+\/[\w.-]+\/?$/;

/**
 * Readable hub id `hub:<type>:<host/path>[#<ref>][:<configFile>]`, the same on
 * every machine and in every tool, unlike a configured hub id. A GitHub
 * `owner/repo` location gets its `github.com` host; an empty ref or config
 * file is left out.
 * @param hub - Recorded hub fields.
 */
export const recordHubIdOf = (hub: RecordHubIdFields): string => {
  const location = hub.type === 'github' && GITHUB_SHORTHAND_PATTERN.test(hub.location)
    ? `github.com/${trimSlashes(hub.location).replace(/\.git$/, '')}`
    : locationOf(hub.location);
  return `${RECORD_HUB_ID_PREFIX}${hub.type}:${location}${suffixOf(hub.ref, trimSlashes(hub.configFile ?? ''))}`;
};

/**
 * Whether an id is a readable hub id.
 * @param id - Hub id.
 */
export const isRecordHubId = (id: string): boolean => id.startsWith(RECORD_HUB_ID_PREFIX);

/**
 * The readable id of a recorded hub, built from its `hubs` entry; a readable
 * key with no such entry is kept, anything else gives `undefined`.
 * @param hubs - The record's `hubs`.
 * @param hubId - A source's `hubId`.
 */
export const recordHubKeyIn = (hubs: unknown, hubId: string): string | undefined => {
  const entry = isJsonObject(hubs) && Object.hasOwn(hubs, hubId) ? hubs[hubId] : undefined;
  if (isJsonObject(entry) && typeof entry.type === 'string' && typeof entry.location === 'string') {
    return recordHubIdOf({
      type: entry.type,
      location: entry.location,
      ...(typeof entry.ref === 'string' ? { ref: entry.ref } : {}),
      ...(typeof entry.configFile === 'string' ? { configFile: entry.configFile } : {})
    });
  }
  return isRecordHubId(hubId) ? hubId : undefined;
};

// The current readable id for a key of the earlier form, which always had `#<ref>:<path>`
// and kept a GitHub hub's `owner/repo` without a host; any other key is kept.
const currentSourceIdOf = (key: string, source: unknown): string => {
  if (!isJsonObject(source) || typeof source.type !== 'string' || typeof source.url !== 'string') {
    return key;
  }
  const fields = source as unknown as RecordSourceIdFields;
  const earlier = `${RECORD_SOURCE_ID_PREFIX}${fields.type}:${locationOf(fields.url)}#${fields.branch ?? ''}:${trimSlashes(fields.collectionsPath ?? fields.indexFile ?? '')}`;
  return key === earlier ? recordSourceIdOf(fields) : key;
};

const currentHubIdOf = (key: string, hub: unknown): string => {
  if (!isJsonObject(hub) || typeof hub.type !== 'string' || typeof hub.location !== 'string') {
    return key;
  }
  const ref = typeof hub.ref === 'string' ? hub.ref : '';
  const configFile = typeof hub.configFile === 'string' ? hub.configFile : '';
  const earlier = `${RECORD_HUB_ID_PREFIX}${hub.type}:${locationOf(hub.location)}#${ref}:${trimSlashes(configFile)}`;
  return key === earlier ? recordHubKeyIn({ [key]: hub }, key) ?? key : key;
};

const nullObject = <T>(): T => Object.create(null) as T;

// Of two entries for the same key and tool, the later install wins.
const later = (current: ToolEntry | undefined, candidate: ToolEntry): ToolEntry =>
  current === undefined || Date.parse(candidate.installedAt) >= Date.parse(current.installedAt) ? candidate : current;

/**
 * The record as stored on disk: readable source and hub ids, `<sourceId>/<name>` bundle keys.
 * @param record - In-memory record; left unchanged.
 */
export const toRecordFile = (record: InstallRecord): InstallRecord => {
  const { bundles, sources, ...rest } = record;
  const file = Object.assign(nullObject<InstallRecord>(), rest);
  // A hub under its readable id is the current copy; an older id of the same hub only fills a gap.
  const hubIdOf = new Map<string, string>();
  if (isJsonObject(rest.hubs)) {
    const hubs = nullObject<Record<string, unknown>>();
    const orderedHubs = Object.entries(rest.hubs).toSorted(([left], [right]) => Number(isRecordHubId(right)) - Number(isRecordHubId(left)));
    for (const [key, hub] of orderedHubs) {
      const id = isRecordHubId(key) ? key : recordHubKeyIn(rest.hubs, key) ?? key;
      hubIdOf.set(key, id);
      if (!Object.hasOwn(hubs, id)) {
        hubs[id] = isJsonObject(hub) ? Object.assign(nullObject<Record<string, unknown>>(), hub) : hub;
      }
    }
    file.hubs = hubs;
  }
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
      const copy = Object.assign(nullObject<SourceRecord>(), source);
      if (copy.hubId !== undefined && hubIdOf.has(copy.hubId)) {
        copy.hubId = hubIdOf.get(copy.hubId);
      }
      file.sources[id] = copy;
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
  // Readable hub and source ids of an earlier form are built again from their fields.
  const hubIdOf = new Map<string, string>();
  if (isJsonObject(rest.hubs)) {
    const hubs = nullObject<Record<string, unknown>>();
    for (const [key, hub] of Object.entries(rest.hubs)) {
      const id = currentHubIdOf(key, hub);
      hubIdOf.set(key, id);
      if (!Object.hasOwn(hubs, id) || id === key) {
        hubs[id] = hub;
      }
    }
    record.hubs = hubs;
  }
  const sourceIdOf = new Map<string, string>();
  if (isJsonObject(rest.sources)) {
    record.sources = nullObject<InstallRecord['sources']>();
    for (const [key, source] of Object.entries(rest.sources)) {
      const id = currentSourceIdOf(key, source);
      sourceIdOf.set(key, id);
      if (!Object.hasOwn(record.sources, id) || id === key) {
        const copy = Object.assign(nullObject<SourceRecord>(), source);
        if (copy.hubId !== undefined && hubIdOf.has(copy.hubId)) {
          copy.hubId = hubIdOf.get(copy.hubId);
        }
        record.sources[id] = copy;
      }
    }
  }
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
      // Written by earlier builds; derived from the key, so it is dropped.
      delete (entry as Partial<Record<string, unknown>>).installationId;
      let bundleId = key;
      if (keyed) {
        const recordedId = key.slice(0, slash);
        entry.sourceId = sourceIdOf.get(recordedId) ?? recordedId;
        bundleId = typeof stored.bundleId === 'string' && stored.bundleId !== '' ? stored.bundleId : key.slice(slash + 1);
        delete entry.bundleId;
      } else if (typeof entry.sourceId === 'string' && sourceIdOf.has(entry.sourceId)) {
        entry.sourceId = sourceIdOf.get(entry.sourceId) as string;
      }
      if (!Object.hasOwn(record.bundles, bundleId)) {
        record.bundles[bundleId] = Object.assign(nullObject<BundleRecord>(), extra, { tools: nullObject<BundleRecord['tools']>() });
      }
      const sameKey = record.bundles[bundleId].tools;
      if (keyed && Object.hasOwn(sameKey, tool) && sameKey[tool].sourceId !== entry.sourceId) {
        // Another source's entry of the same bundle and tool, as a merge of two branches leaves it:
        // kept under its own key, so neither entry nor its files are dropped.
        record.bundles[key] ??= Object.assign(nullObject<BundleRecord>(), extra, { name: key.slice(slash + 1), tools: nullObject<BundleRecord['tools']>() });
        record.bundles[key].tools[tool] = entry;
        continue;
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
