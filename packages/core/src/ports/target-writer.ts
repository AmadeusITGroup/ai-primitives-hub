/**
 * TargetWriter port — writes extracted bundle files into an install
 * target (VS Code, Kiro, Windsurf, etc.). Concrete adapters live in
 * `infra`/`app`. Repository-scope installations use a specialised
 * writer that handles the `.github/` layout.
 * @module ports/target-writer
 */
import type {
  RecordedFile,
  RecordedLocations,
} from '../domain/install/recorded-location';
import type {
  Target,
} from '../domain/install/target';
import type {
  ExtractedFiles,
} from './bundle-extractor';

/**
 * Result of a write operation.
 */
export interface TargetWriteResult {
  /** Absolute paths of files written. */
  written: string[];
  /** Files in the bundle that were skipped (kind not allowed). */
  skipped: string[];
  /**
   * Bundle-relative paths that were actually written.
   *
   * Optional for compatibility with external writers. Installers should use
   * this when present instead of assuming every extracted file was installed.
   */
  writtenBundlePaths?: string[];
  /**
   * Where each written bundle path landed, relative to the target's base
   * directory (`/`-separated), keyed by bundle-relative path.
   *
   * Optional: set only by writers whose output location cannot be
   * recomputed from the bundle path alone (manifest-driven placement
   * renames files and skill directories by manifest item id). Installers
   * record it in the lockfile so uninstall can find the file again.
   */
  installedPaths?: Record<string, string>;
}

/**
 * Side-effect-free assessment of a target write.
 *
 * Paths in both arrays are bundle-relative. A writer may omit this optional
 * operation when it has no capability filtering to perform; callers must
 * still inspect `TargetWriteResult.skipped` after writing.
 */
export interface TargetWritePlan {
  /** Bundle-relative files the writer can place. */
  writable: string[];
  /** Bundle-relative files the writer cannot place. */
  skipped: string[];
}

/**
 * Writes (and removes) bundle files in a target directory.
 */
export interface TargetWriter {
  /**
   * Assess the write without changing the target filesystem.
   *
   * Implementations should report unsupported or unrouted bundle content so
   * an install orchestrator can fail before any file is written.
   * @param target Target chosen via `--target <name>`.
   * @param files Extracted bundle files.
   * @returns A deterministic write plan.
   */
  preflight?(target: Target, files: ExtractedFiles): Promise<TargetWritePlan>;

  /**
   * Write the bundle into the target.
   * @param target Target chosen via `--target <name>`.
   * @param files Extracted bundle files.
   * @returns TargetWriteResult.
   */
  write(target: Target, files: ExtractedFiles): Promise<TargetWriteResult>;

  /**
   * Best-effort rollback for paths returned in `TargetWriteResult.written`.
   *
   * This is optional for compatibility with existing custom writers. Built-in
   * writers implement it so a late skipped result or write-policy failure does
   * not leave files behind without a lockfile entry.
   * @param target Target chosen via `--target <name>`.
   * @param written Absolute paths returned by a prior write.
   */
  rollback?(target: Target, written: readonly string[]): Promise<void>;

  /**
   * Locate recorded files without touching the filesystem.
   *
   * Invariant shared by `locate`, `write` and `remove`: for a file recorded
   * from a `write` (bundle path plus its `installedPaths` entry), `locate`
   * returns the path `write` wrote, and `remove` deletes exactly that path.
   * Locations follow `resolveRecordedLocation`, so a recorded path that
   * would leave the target root has no location (`null`).
   *
   * Optional for compatibility with custom writers; callers that need
   * locations (shared-file guards, superseded removal) treat a writer
   * without it as unable to locate.
   * @param target Target chosen via `--target <name>`.
   * @param files Recorded files, as stored in a lockfile entry.
   * @returns The target root and one location per file, in input order.
   */
  locate?(target: Target, files: readonly RecordedFile[]): Promise<RecordedLocations>;

  /**
   * Remove a single file from the target.
   *
   * A file with no location inside the target root (see `locate`) is a
   * no-op: nothing is deleted.
   * @param target Target chosen via `--target <name>`.
   * @param filePath Relative file path to remove.
   * @param installedPath Optional output path relative to the target's
   *   base directory, as recorded from `TargetWriteResult.installedPaths`.
   *   Writers that support it remove that file instead of recomputing the
   *   location from `filePath`; others may ignore it.
   */
  remove(target: Target, filePath: string, installedPath?: string): Promise<void>;
}
