/**
 * TargetWriter port — writes extracted bundle files into an install
 * target (VS Code, Kiro, Windsurf, etc.). Concrete adapters live in
 * `infra`/`app`. Repository-scope installations use a specialised
 * writer that handles the `.github/` layout.
 * @module ports/target-writer
 */
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
   * Remove a single file from the target.
   * @param target Target chosen via `--target <name>`.
   * @param filePath Relative file path to remove.
   */
  remove(target: Target, filePath: string): Promise<void>;
}
