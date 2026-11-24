import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Check whether a path is equal to or nested beneath a base directory.
 * @param baseDir
 * @param targetPath
 * @param allowBase
 */
export function isPathInside(baseDir: string, targetPath: string, allowBase = false): boolean {
  const relativePath = path.relative(baseDir, targetPath);
  return (allowBase || relativePath !== '')
    && relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);
}

/**
 * Resolve a relative path beneath a base directory or throw if it escapes.
 * @param baseDir
 * @param relativePath
 * @param description
 */
export function resolveContainedPath(baseDir: string, relativePath: string, description: string): string {
  const segments = relativePath.split(/[\\/]/);
  if (
    !relativePath
    || relativePath.includes('\0')
    || path.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
    || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes(':'))
  ) {
    throw new Error(`Invalid ${description}: ${relativePath}`);
  }

  const resolvedBase = path.resolve(baseDir);
  const resolvedPath = path.resolve(resolvedBase, relativePath);
  if (!isPathInside(resolvedBase, resolvedPath)) {
    throw new Error(`Invalid ${description}: ${relativePath}`);
  }

  return resolvedPath;
}

/**
 * Resolve an existing relative path and reject lexical or symlink escapes.
 * @param baseDir
 * @param relativePath
 * @param allowBase
 */
export async function resolveExistingPathInside(
  baseDir: string,
  relativePath: string,
  allowBase = false
): Promise<string | undefined> {
  if (
    !relativePath
    || relativePath.includes('\0')
    || path.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
    || relativePath.split(/[\\/]/).some((segment) => segment === '..' || segment.includes(':'))
  ) {
    return undefined;
  }

  let realBase: string;
  let realPath: string;
  try {
    realBase = await fs.promises.realpath(baseDir);
    const candidatePath = path.resolve(realBase, relativePath);
    if (!isPathInside(realBase, candidatePath, allowBase)) {
      return undefined;
    }

    realPath = await fs.promises.realpath(candidatePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }

  return isPathInside(realBase, realPath, allowBase) ? realPath : undefined;
}
