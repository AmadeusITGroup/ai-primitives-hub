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
}

/**
 * Writes (and removes) bundle files in a target directory.
 */
export interface TargetWriter {
  /**
   * Write the bundle into the target.
   * @param target Target chosen via `--target <name>`.
   * @param files Extracted bundle files.
   * @returns TargetWriteResult.
   */
  write(target: Target, files: ExtractedFiles): Promise<TargetWriteResult>;

  /**
   * Remove a single file from the target.
   * @param target Target chosen via `--target <name>`.
   * @param filePath Relative file path to remove.
   */
  remove(target: Target, filePath: string): Promise<void>;
}
