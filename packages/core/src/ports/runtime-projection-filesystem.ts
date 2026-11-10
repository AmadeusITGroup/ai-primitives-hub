/**
 * RuntimeProjectionFileSystem port — FileSystem plus the lstat/realpath and
 * permission capabilities required for containment checks and rollback.
 * @module ports/runtime-projection-filesystem
 */
import type {
  FileSystem,
} from './filesystem';

export interface RuntimeLstat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode?: number;
}

/** 'posix' = full mode bits; 'readonly' = only owner-write bit 0o200 is representable. */
export type RuntimeModeSemantics = 'posix' | 'readonly';

export interface RuntimeProjectionFileSystem extends FileSystem {
  readonly modeSemantics?: RuntimeModeSemantics;
  /** lstat: reports symlinks themselves rather than their targets. */
  lstat(path: string): Promise<RuntimeLstat>;
  /** Canonical absolute path resolving all symlinks; rejects when absent. */
  realpath(path: string): Promise<string>;
  /** Apply permission intent within modeSemantics, including rollback restoration. */
  chmod(path: string, mode: number): Promise<void>;
}
