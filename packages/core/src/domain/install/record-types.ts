/**
 * Install record format 3.0.0: shared types and constants.
 *
 * One record file holds every bundle installed at one level, keyed by bundle id
 * and then by tool, so the CLI and the extension share it. The JSON Schema ships
 * as `public/schemas/install-record.schema.json`. Unknown fields are kept.
 * @module domain/install/record-types
 */
import * as path from 'node:path';
import type {
  TargetType,
} from './target';
import type {
  RepositoryCommitMode,
} from './types';

/** Record format version written by this release. */
export const RECORD_FORMAT_VERSION = '3.0.0';

/** Major version this release reads and writes. */
export const RECORD_FORMAT_MAJOR = 3;

/** `$schema` URL written into every record. */
export const RECORD_SCHEMA_URL = 'https://github.com/AmadeusITGroup/ai-primitives-hub/schemas/lockfile.schema.json';

/** Committed repository record, at the git root. */
export const RECORD_FILE_NAME = 'ai-primitives-hub.lock.json';

/** Local-only repository record, at the git root and listed in `.git/info/exclude`. */
export const LOCAL_RECORD_FILE_NAME = 'ai-primitives-hub.local.lock.json';

/** Both repository record file names, committed first. */
export const RECORD_FILE_NAMES = [RECORD_FILE_NAME, LOCAL_RECORD_FILE_NAME] as const;

/** Largest record file accepted, in bytes. */
export const RECORD_MAX_BYTES = 10 * 1024 * 1024;

/** Keys refused at any depth because they could change an object's prototype. */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Pattern every tool key and `sourceType` must match to be read. */
export const RECORD_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Tool key for migrated entries whose tool could not be identified. */
export const UNKNOWN_TOOL_NAME = 'unknown';

/** Level a record belongs to. */
export type RecordLevel = 'repository' | 'user';

/**
 * Tool key of a {@link ToolEntry}. Readers keep any key matching
 * {@link RECORD_NAME_PATTERN}, so other values can appear on read.
 */
export type RecordToolName = TargetType | typeof UNKNOWN_TOOL_NAME;

/** One file a tool entry wrote. */
export interface RecordedFile {
  /** Path relative to the level root, with forward slashes. */
  path: string;
  /** `sha256:` plus 64 lowercase hex digits of the bytes on disk. */
  checksum: string;
  [key: string]: unknown;
}

/** What one tool has installed for one bundle. */
export interface ToolEntry {
  version: string;
  /** Key of the entry's source in {@link InstallRecord.sources}. */
  sourceId: string;
  sourceType: string;
  /** ISO 8601 UTC time the entry was written. */
  installedAt: string;
  /** Present, and `true`, only under the `'unknown'` tool key. */
  needsReinstall?: true;
  /** Files this entry owns, sorted by `path`. */
  files: RecordedFile[];
  [key: string]: unknown;
}

/** All tool entries for one bundle at one level; never empty. */
export interface BundleRecord {
  tools: Record<string, ToolEntry>;
  [key: string]: unknown;
}

/** Where bundles came from. Same shape as format 2.0.0. */
export interface SourceRecord {
  type: string;
  /** Source URL with credentials removed. */
  url: string;
  branch?: string;
  collectionsPath?: string;
  indexFile?: string;
  authMode?: string;
  /** A reference to a credential, never a secret value. */
  credentialRef?: string;
  [key: string]: unknown;
}

/** One install record file (format 3.0.0). */
export interface InstallRecord {
  $schema: string;
  version: string;
  level: RecordLevel;
  generatedAt: string;
  /** `ai-primitives-hub-cli@<version>` or `ai-primitives-hub-extension@<version>`. */
  generatedBy: string;
  bundles: Record<string, BundleRecord>;
  sources: Record<string, SourceRecord>;
  hubs?: Record<string, unknown>;
  profiles?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Where a record file lives. Not stored in the file. */
export interface RecordLocation {
  level: RecordLevel;
  /** Absolute level root; the git root at repository level. */
  root: string;
  /** Absolute path of the record file. */
  path: string;
  /** Repository level only: which of the two files this is. */
  commitMode?: RepositoryCommitMode;
}

/**
 * Both repository record locations at a root, committed first.
 * @param root - Absolute git root.
 */
export const repositoryLocations = (root: string): [RecordLocation, RecordLocation] => [
  { level: 'repository', root, path: path.join(root, RECORD_FILE_NAME), commitMode: 'commit' },
  { level: 'repository', root, path: path.join(root, LOCAL_RECORD_FILE_NAME), commitMode: 'local-only' }
];

/**
 * The other repository record file at the same root.
 * @param location - A record location.
 * @returns `undefined` when the location is not a repository file.
 */
export const otherRepositoryLocation = (location: RecordLocation): RecordLocation | undefined => {
  if (location.level !== 'repository') {
    return undefined;
  }
  const [committed, localOnly] = repositoryLocations(location.root);
  return location.commitMode === 'local-only' ? committed : localOnly;
};

/** Identifies one tool entry of one bundle. */
export interface RecordEntryKey {
  bundleId: string;
  tool: string;
}

/** Outcome of a record update. */
export interface RecordChange {
  /** Entries added, replaced or moved. */
  changedEntries: RecordEntryKey[];
  /** Root-relative paths the caller deletes after the save. */
  deletedFiles: string[];
  /** Root-relative paths kept because another entry still lists them. */
  keptSharedFiles: string[];
  /** The file the change was recorded in. */
  location: RecordLocation;
}
