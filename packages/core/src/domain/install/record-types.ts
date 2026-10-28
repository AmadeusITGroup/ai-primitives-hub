/**
 * Install record format 3.0.0 — shared types and constants (contract C1).
 *
 * One record file holds every bundle installed at one level, keyed by bundle
 * id and then by tool (target type), so the CLI and the extension read and
 * write the same file. These types are the single description both delivery
 * layers use (BR1.12); the matching JSON Schema ships beside them as
 * `public/schemas/install-record.schema.json`.
 *
 * Every map is an open object: fields this release does not know are kept and
 * written back unchanged (BR1.10). Records are held in prototype-free objects
 * (see `record-parse.ts`), so a hostile key can never reach `Object.prototype`.
 * @module domain/install/record-types
 */
import type {
  TargetType,
} from './target';
import type {
  RepositoryCommitMode,
} from './types';

/** Record format version written by this release. */
export const RECORD_FORMAT_VERSION = '3.0.0';

/** Major version this release reads and writes (BR1.8). */
export const RECORD_FORMAT_MAJOR = 3;

/** Canonical `$schema` URL written into every record (BR1.11). */
export const RECORD_SCHEMA_URL = 'https://github.com/AmadeusITGroup/ai-primitives-hub/schemas/lockfile.schema.json';

/** Committed repository record, at the git root (BR2.2). */
export const RECORD_FILE_NAME = 'ai-primitives-hub.lock.json';

/** Local-only repository record, at the git root and kept in `.git/info/exclude` (BR2.2, BR2.3). */
export const LOCAL_RECORD_FILE_NAME = 'ai-primitives-hub.local.lock.json';

/** Both repository record file names, committed first. */
export const RECORD_FILE_NAMES = [RECORD_FILE_NAME, LOCAL_RECORD_FILE_NAME] as const;

/** Largest record file accepted, in bytes (NFR1.3). Reads stop one byte past it. */
export const RECORD_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Keys refused at any depth of a record (NFR4.4): any of them could change an
 * object's prototype when a record is merged or copied.
 */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Pattern every tool key and `sourceType` must match to be read (BR1.3). */
export const RECORD_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Tool key for entries whose tool could not be identified during migration (written from U5). */
export const UNKNOWN_TOOL_NAME = 'unknown';

/** Level a record belongs to. U1 writes the repository level only. */
export type RecordLevel = 'repository' | 'user';

/**
 * Tool key of a {@link ToolEntry}: a target type, or `'unknown'` for migrated
 * entries that need a reinstall. Readers keep any key matching
 * {@link RECORD_NAME_PATTERN}, so values outside this union can appear on read.
 */
export type RecordToolName = TargetType | typeof UNKNOWN_TOOL_NAME;

/** One file a tool entry wrote. */
export interface RecordedFile {
  /** Path relative to the level root, forward slashes, never escaping the root (BR1.5). */
  path: string;
  /** `sha256:` followed by 64 lowercase hex digits of the bytes on disk after writing (BR1.6). */
  checksum: string;
  /** Unknown fields, kept unchanged (BR1.10). */
  [key: string]: unknown;
}

/** What one tool has installed for one bundle. */
export interface ToolEntry {
  /** Installed bundle version. */
  version: string;
  /** Key of the entry's source in {@link InstallRecord.sources}. */
  sourceId: string;
  /** Source type; written only as a `SourceType` value (BR1.4). */
  sourceType: string;
  /** ISO 8601 UTC time the entry was written (BR3.7). */
  installedAt: string;
  /** Present, and `true`, only under the `'unknown'` tool key. */
  needsReinstall?: true;
  /** Files this entry owns, sorted by `path`. */
  files: RecordedFile[];
  /** Unknown fields, kept unchanged (BR1.10). */
  [key: string]: unknown;
}

/** All tool entries for one bundle at one level. */
export interface BundleRecord {
  /** Entries keyed by tool name; never empty (an empty bundle is removed). */
  tools: Record<string, ToolEntry>;
  /** Unknown fields, kept unchanged (BR1.10). */
  [key: string]: unknown;
}

/** Where bundles came from. Same shape as format 2.0.0. */
export interface SourceRecord {
  type: string;
  /** Source URL with credentials removed before it is recorded (NFR4.5). */
  url: string;
  branch?: string;
  collectionsPath?: string;
  indexFile?: string;
  authMode?: string;
  /** A reference to a credential, never a secret value. */
  credentialRef?: string;
  /** Unknown fields, kept unchanged (BR1.10). */
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
  /** Bundles keyed by bundle id. */
  bundles: Record<string, BundleRecord>;
  /** Sources keyed by source id. */
  sources: Record<string, SourceRecord>;
  /** Carried through unchanged. */
  hubs?: Record<string, unknown>;
  /** Carried through unchanged. */
  profiles?: Record<string, unknown>;
  /** Unknown fields, kept unchanged (BR1.10). */
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

/** Identifies one tool entry of one bundle. */
export interface RecordEntryKey {
  bundleId: string;
  tool: string;
}

/** Outcome of a record update (contract C3). */
export interface RecordChange {
  /** Entries added, replaced or moved. */
  changedEntries: RecordEntryKey[];
  /** Root-relative paths the caller deletes after the save (BR3.4). */
  deletedFiles: string[];
  /** Root-relative paths kept because another entry still lists them. */
  keptSharedFiles: string[];
  /** The file the change was recorded in. */
  location: RecordLocation;
}
