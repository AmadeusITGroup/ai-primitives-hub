import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  normalizeRepoRelativePath,
} from '@ai-primitives-hub/core';

/**
 * Resolve a repository-relative path, including missing descendants, without
 * following existing or dangling symlinks outside the workspace.
 * @param workspaceRoot Workspace directory (it may itself be an OS path alias).
 * @param relativePath Repository-relative path.
 */
export function resolveWorkspacePath(workspaceRoot: string, relativePath: string): string {
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || /[:\0]/.test(relativePath)) {
    throw new Error(`Invalid workspace-relative path '${relativePath}'.`);
  }
  const normalized = normalizeRepoRelativePath(relativePath);
  if (normalized === '.') {
    throw new Error('Workspace path must refer to a descendant, not the workspace itself.');
  }
  const root = fs.realpathSync.native(workspaceRoot);
  let resolved = root;
  for (const segment of normalized.split('/')) {
    const candidate = path.join(resolved, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolved = candidate;
        continue;
      }
      throw error;
    }
    try {
      resolved = fs.realpathSync.native(candidate);
    } catch (error) {
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing unresolved symlink in workspace path '${relativePath}'.`, { cause: error });
      }
      throw error;
    }
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Refusing path '${relativePath}': symlink points outside the workspace.`);
    }
  }
  return resolved;
}
