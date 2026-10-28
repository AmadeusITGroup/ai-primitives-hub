/**
 * RecordFs port — the only filesystem access install-record code uses.
 *
 * Separate from `FileSystem` because record handling needs `lstat`,
 * `realpath`, capped reads, streamed hashing, exclusive create and `rename`
 * for its file gate, path confinement and atomic writes (NFR1.3, NFR4.1,
 * NFR7.1). The Node implementation is `NodeRecordFs` in `infra`; it never
 * spawns a process (NFR4.7). Tests use an in-memory fake for error paths.
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
  /**
   * Stat a path without following a final symlink.
   * @returns The stat, or `undefined` when nothing exists at the path.
   */
  lstat(path: string): Promise<RecordFileStat | undefined>;
  /** Resolve every symlink in a path. Rejects when the path does not exist. */
  realpath(path: string): Promise<string>;
  /**
   * Read at most `maxBytes` bytes, in chunks, stopping at the cap whatever size
   * the file reports. Callers pass one byte more than they accept and refuse a
   * result that long.
   */
  readCapped(path: string, maxBytes: number): Promise<Uint8Array>;
  /** Streamed SHA-256 of a file's bytes, as `sha256:` plus 64 lowercase hex digits. */
  hashFile(path: string): Promise<string>;
  /**
   * Create a file exclusively and write UTF-8 text to it; rejects when the path
   * already exists. No mode is set, so the process umask applies.
   */
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
