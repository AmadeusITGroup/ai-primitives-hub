/**
 * Safe target-write orchestration.
 *
 * A writer may know that a target cannot accept part of a bundle. Keep that
 * decision before the first filesystem mutation whenever the writer exposes
 * `preflight`; retain the result check as a compatibility guard for older or
 * external writers that only implement `write`.
 * @module install/target-write
 */
import type {
  ExtractedFiles,
  Target,
  TargetWriter,
  TargetWriteResult,
} from '@ai-primitives-hub/core';

/**
 * Raised when a target cannot install every routed bundle file.
 */
export class TargetWriteRejectedError extends Error {
  public readonly code = 'BUNDLE.UNSUPPORTED_CONTENT';

  public constructor(public readonly skipped: readonly string[]) {
    super(`target cannot install bundle content: ${[...skipped].toSorted().join(', ')}`);
    this.name = 'TargetWriteRejectedError';
  }
}

/**
 * Preflight and execute a target write without accepting partial content.
 * @param writer Target writer.
 * @param target Target configuration.
 * @param files Extracted bundle files.
 * @returns The successful writer result.
 * @throws {TargetWriteRejectedError} When content is skipped.
 */
export async function writeTargetSafely(
  writer: TargetWriter,
  target: Target,
  files: ExtractedFiles
): Promise<TargetWriteResult> {
  if (writer.preflight !== undefined) {
    const plan = await writer.preflight(target, files);
    if (plan.skipped.length > 0) {
      throw new TargetWriteRejectedError(plan.skipped);
    }
  }

  const result = await writer.write(target, files);
  if (result.skipped.length > 0) {
    if (writer.rollback !== undefined && result.written.length > 0) {
      try {
        await writer.rollback(target, result.written);
      } catch {
        // Preserve the policy failure; rollback is explicitly best effort.
      }
    }
    throw new TargetWriteRejectedError(result.skipped);
  }
  return result;
}
