/**
 * Shared hub references for install records. Only a hub another machine can
 * import is recorded: never the built-in local hub or a hub on a local path,
 * and never a credential.
 * @module records/record-hub
 */
import {
  DEFAULT_LOCAL_HUB_ID,
  FORBIDDEN_KEYS,
  type RecordHub,
} from '@ai-primitives-hub/core';
import {
  sanitizeSourceUrl,
} from './sanitize-source';

/** A hub to record, with its key in `hubs`. */
export interface RecordHubInput extends RecordHub {
  id: string;
}

/** The hub reference fields read; credential fields are never copied. */
export interface HubReferenceFields {
  type: string;
  location: string;
  ref?: string;
  configFile?: string;
}

/** A configured hub, as `HubManager.listHubs` lists it. */
export interface ConfiguredHub {
  id: string;
  name: string;
  reference: HubReferenceFields;
}

/** A local path: drive letter, POSIX root, home, UNC or `./` and `../`. */
const LOCAL_PATH_PATTERN = /^(?:[a-z]:[/\\]|\/|~|\\\\|\.\.?(?:[/\\]|$))/i;

const isWebUrl = (location: string): boolean => {
  try {
    const { protocol } = new URL(location);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
};

const isShareableLocation = (type: string, location: string): boolean => {
  if (type === 'local' || LOCAL_PATH_PATTERN.test(location)) {
    return false;
  }
  return type === 'github' ? !/^[a-z][\d+.a-z-]*:/i.test(location) || isWebUrl(location) : isWebUrl(location);
};

const isConfinedPath = (value: string): boolean =>
  value !== '' && !LOCAL_PATH_PATTERN.test(value) && !value.includes('\\') && !value.split('/').includes('..');

/**
 * The record entry of a hub, or `undefined` when the hub is not shareable.
 * @param id - Hub id.
 * @param name - Hub display name; the id when empty.
 * @param reference - The hub's import reference.
 */
export const toRecordHub = (id: string, name: string, reference: HubReferenceFields): RecordHubInput | undefined => {
  const { type, location } = reference;
  if (typeof id !== 'string' || id === '' || id === DEFAULT_LOCAL_HUB_ID || FORBIDDEN_KEYS.has(id)
    || typeof type !== 'string' || type === '' || typeof location !== 'string' || !isShareableLocation(type, location)) {
    return undefined;
  }
  const hub = Object.create(null) as RecordHubInput;
  hub.id = id;
  hub.name = typeof name === 'string' && name !== '' ? name : id;
  hub.type = type;
  hub.location = sanitizeSourceUrl(location);
  if (typeof reference.ref === 'string' && reference.ref !== '') {
    hub.ref = reference.ref;
  }
  if (typeof reference.configFile === 'string' && isConfinedPath(reference.configFile)) {
    hub.configFile = reference.configFile;
  }
  return hub;
};

/**
 * The shareable hubs among the configured ones, by id.
 * @param hubs - Configured hubs.
 */
export const recordHubsOf = (hubs: readonly ConfiguredHub[]): Map<string, RecordHubInput> => {
  const byId = new Map<string, RecordHubInput>();
  for (const { id, name, reference } of hubs) {
    const hub = toRecordHub(id, name, reference);
    if (hub !== undefined) {
      byId.set(id, hub);
    }
  }
  return byId;
};

/**
 * The `hubs` entry of a record hub: its fields without the id, prototype-free.
 * @param hub - Hub to record.
 */
export const hubEntryOf = (hub: RecordHubInput): RecordHub => {
  const entry = Object.create(null) as RecordHub;
  for (const [key, value] of Object.entries(hub)) {
    if (key !== 'id') {
      entry[key] = value;
    }
  }
  return entry;
};
