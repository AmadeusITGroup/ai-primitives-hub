/**
 * Domain layer — helpers shared by every executor of a `TargetWritePlan`.
 *
 * Two delivery paths execute the same plan today: `FileTreeTargetWriter`
 * (`app/writers/file-tree-writer.ts`, used by the CLI and the extension's
 * repository scope) and `UserScopeService.executeTargetPlan`
 * (`apps/vscode-extension`, which additionally prefers symlinks and prompts
 * before replacing a skill). They must agree on the details that determine
 * observable results — the installed checksum and which skill directories
 * become removable — so those rules live here rather than being reimplemented
 * on each side.
 *
 * Pure domain logic: `node:crypto` and `node:path` are used only for
 * computation, never for IO.
 * @module domain/install/installed-records
 */
import {
  createHash,
} from 'node:crypto';
import * as path from 'node:path';
import type {
  InstalledFileRecord,
} from '../../ports/target-writer';
import {
  normalizePromptId,
} from './copilot-file-type';

/**
 * Compute the canonical `sha256:`-prefixed checksum recorded for an installed
 * file. Every writer and lockfile entry uses this exact form, so comparisons
 * never have to normalize a bare hex digest.
 * @param bytes - The exact bytes written to the destination.
 * @returns Checksum string of the form `sha256:<hex>`.
 */
export function installedChecksum(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * Directories that may be removed after the given skill files are gone,
 * deepest first.
 *
 * Only directories at or below the owning skill's root are returned, and the
 * root is identified by the item id rather than by a `skills/` path segment, so
 * a layout override that renames the route does not disable pruning. Removal
 * itself must remain conditional on the directory being empty — this function
 * only decides candidacy, never that a directory is safe to delete.
 * @param files - Installed records being removed or rolled back.
 * @returns Candidate directories ordered deepest-first.
 */
export function prunableSkillDirectories(files: readonly InstalledFileRecord[]): string[] {
  const candidates = new Set<string>();
  for (const file of files) {
    const root = file.kind === 'skill' ? skillRootDirectory(file) : null;
    if (root === null) {
      continue;
    }
    let current = path.dirname(file.destinationPath);
    while (current === root || current.startsWith(`${root}${path.sep}`)) {
      candidates.add(current);
      if (current === root) {
        break;
      }
      current = path.dirname(current);
    }
  }
  return [...candidates].toSorted((left, right) =>
    right.split(path.sep).length - left.split(path.sep).length);
}

/**
 * Locate the installed root directory of the skill that owns a file.
 * @param file - Installed record whose `kind` is `skill`.
 * @returns The skill's root directory, or `null` when the item id does not
 *   appear as an ancestor directory name.
 */
export function skillRootDirectory(file: InstalledFileRecord): string | null {
  const directoryName = normalizePromptId(file.itemId);
  let current = path.dirname(file.destinationPath);
  while (path.dirname(current) !== current) {
    if (path.basename(current) === directoryName) {
      return current;
    }
    current = path.dirname(current);
  }
  return null;
}
