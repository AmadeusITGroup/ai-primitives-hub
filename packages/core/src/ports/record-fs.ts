/**
 * RecordFs port: the only filesystem access install-record code uses. It is
 * separate from `FileSystem` because records need `lstat`, `realpath`, capped
 * reads, hashing and atomic renames. Implemented by `NodeRecordFs` in `infra`.
 * @module ports/record-fs
 */

/** File type as seen by `lstat`, without following a final symlink. */
export type RecordFileKind = 'file' | 'directory' | 'symlink' | 'other';

/** Subset of `lstat` results the record code needs. */
export interface RecordFileStat {
  kind: RecordFileKind;
  /** Reported size in bytes. Never trusted to bound a read. */
  size: number;
}

/** Filesystem operations for install records. All paths are absolute. */
export interface RecordFs {
  /** Stat a path without following a final symlink; `undefined` when nothing exists. */
  lstat(path: string): Promise<RecordFileStat | undefined>;
  /** Resolve every symlink in a path. Rejects when the path does not exist. */
  realpath(path: string): Promise<string>;
  /** Read at most `maxBytes` bytes, whatever size the file reports. */
  readCapped(path: string, maxBytes: number): Promise<Uint8Array>;
  /** Streamed SHA-256 of a file's bytes, as `sha256:` plus 64 lowercase hex digits. */
  hashFile(path: string): Promise<string>;
  /** Create a file exclusively and write UTF-8 text; rejects when the path exists. */
  writeFile(path: string, contents: string): Promise<void>;
  /** Rename a file, replacing the destination atomically. */
  rename(from: string, to: string): Promise<void>;
  /** Remove a file or a symlink (never followed). Rejects for a directory. */
  unlink(path: string): Promise<void>;
  /** Create a directory. */
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  /** List the entry names of a directory. */
  readdir(path: string): Promise<string[]>;
  /** Whether anything exists at the path, without following a final symlink. */
  exists(path: string): Promise<boolean>;
  /** Append UTF-8 text to a file, creating it when missing. */
  appendFile(path: string, contents: string): Promise<void>;
}
