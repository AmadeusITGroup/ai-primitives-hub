/**
 * FileSystem port — IO abstraction for all file-system operations.
 *
 * The contract every feature layer uses for filesystem access — mirrors
 * the operations `src/services/*` already perform via `fs/promises`
 * today (read/write text and JSON, existence checks, directory
 * creation/listing, removal). Concrete adapters live in
 * `@ai-primitives-hub/infra` (Phase 3); tests supply hand-written
 * in-memory doubles. Keeps `core`/`app` free of direct `node:fs` imports.
 * @module ports/filesystem
 */

/**
 * Subset of `fs.Stats` that source adapters/install pipeline code actually
 * uses (file size for bundle sizing, mtime for `lastUpdated`, directory
 * detection). Extended here, rather than in a later commit, because the
 * first concrete adapter (`infra`'s `LocalAdapter`, Phase 3a) needs it
 * immediately.
 */
export interface FileStat {
  isDirectory: boolean;
  isFile: boolean;
  /** Bytes; 0 for directories. */
  size: number;
  /** Last-modified time, epoch milliseconds. */
  mtimeMs: number;
}

/**
 * A directory entry as returned by `readDirEntries` — name plus type, so
 * callers don't need a follow-up `stat` just to tell files from
 * directories while scanning.
 */
export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface FileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  readJson<T = unknown>(path: string): Promise<T>;
  writeJson(path: string, value: unknown): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  readDir(path: string): Promise<string[]>;
  /** Like `readDir`, but with type information — avoids a stat-per-entry scan. */
  readDirEntries(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<FileStat>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
}
