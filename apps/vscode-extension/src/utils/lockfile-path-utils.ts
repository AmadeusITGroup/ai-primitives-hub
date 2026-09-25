import * as path from 'node:path';
import type {
  Lockfile,
} from '../types/lockfile';

/**
 * Normalize a repository-relative lockfile path to its portable on-disk form.
 * Lockfiles are shared across operating systems, so their separators must be
 * POSIX-style regardless of the host that created them.
 * @param filePath - Repository-relative path from a lockfile or filesystem API.
 * @returns The path with forward slashes.
 */
export function normalizeLockfilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * Resolve a lockfile path against the repository root, accepting paths written
 * by older versions on Windows as well as the canonical forward-slash form.
 * @param repositoryRoot - Absolute repository root.
 * @param filePath - Repository-relative path from a lockfile.
 * @returns An absolute path using the current platform's path conventions.
 */
export function resolveLockfilePath(repositoryRoot: string, filePath: string): string {
  const resolvedRoot = path.resolve(repositoryRoot);
  const resolvedPath = path.resolve(
    resolvedRoot,
    ...normalizeLockfilePath(filePath).split('/')
  );
  const relativePath = path.relative(resolvedRoot, resolvedPath);

  if (
    relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    throw new Error(`Lockfile path escapes repository root: ${filePath}`);
  }

  return resolvedPath;
}

/**
 * Return a lockfile copy whose tracked file paths use portable separators.
 * @param lockfile - Lockfile about to be persisted.
 * @returns A copy with all bundle file paths normalized.
 */
export function normalizeLockfilePaths(lockfile: Lockfile): Lockfile {
  return {
    ...lockfile,
    bundles: Object.fromEntries(
      Object.entries(lockfile.bundles ?? {}).map(([bundleId, bundle]) => [
        bundleId,
        {
          ...bundle,
          files: (bundle.files ?? []).map((file) => ({
            ...file,
            path: normalizeLockfilePath(file.path)
          }))
        }
      ])
    )
  };
}
