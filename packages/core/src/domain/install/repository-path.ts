import * as path from 'node:path';

/** Removal must stop rather than treating an unverified lockfile path as missing. */
export class UnsafeRepositoryPathError extends Error {
  public constructor(filePath: string, reason = 'escapes repository root') {
    super(`Lockfile path ${reason}: ${filePath}. Check the lockfile and repository symlinks before retrying.`);
    this.name = 'UnsafeRepositoryPathError';
  }
}

const isWithinRoot = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const checkedRealpath = async (
  realpath: (filePath: string) => Promise<string>,
  filePath: string,
  candidate: string
): Promise<string> => {
  try {
    return path.resolve(await realpath(filePath));
  } catch {
    throw new UnsafeRepositoryPathError(candidate, 'cannot be checked against repository root');
  }
};

/**
 * Check both lexical containment and the filesystem-resolved parent before
 * deleting a repository file. Never resolve the final component: it may be a
 * symlink which should be removed as a link, not followed to its target.
 * Missing parents are climbed until the nearest existing ancestor is found,
 * so a symlink before a missing child is still detected.
 *
 * This is a pre-removal check, not an atomic defense against concurrent
 * replacement of a directory between the check and the filesystem operation.
 * @param repositoryRoot - Repository path (which may itself be a symlink).
 * @param candidate - Absolute path to the file or directory to remove.
 * @param realpath - Filesystem adapter's symlink-resolving realpath operation.
 */
export async function assertSafeRepositoryRemovalPath(
  repositoryRoot: string,
  candidate: string,
  realpath: (filePath: string) => Promise<string>
): Promise<void> {
  const lexicalRoot = path.resolve(repositoryRoot);
  const lexicalCandidate = path.resolve(candidate);
  if (lexicalCandidate === lexicalRoot || !isWithinRoot(lexicalRoot, lexicalCandidate)) {
    throw new UnsafeRepositoryPathError(candidate);
  }

  const physicalRoot = await checkedRealpath(realpath, lexicalRoot, candidate);
  let parent = path.dirname(lexicalCandidate);
  while (true) {
    let physicalParent: string;
    try {
      physicalParent = path.resolve(await realpath(parent));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(parent) === parent) {
        throw new UnsafeRepositoryPathError(candidate, 'cannot be checked against repository root');
      }
      parent = path.dirname(parent);
      continue;
    }
    if (!isWithinRoot(physicalRoot, physicalParent)) {
      throw new UnsafeRepositoryPathError(candidate);
    }
    return;
  }
}

/**
 * Unlike deletion, traversing a managed directory follows the final symlink.
 * Validate that target too before reading or cleaning any children.
 * @param repositoryRoot - Repository path.
 * @param directory - Directory that will be traversed.
 * @param realpath - Filesystem adapter's realpath operation.
 */
export async function assertSafeRepositoryDirectoryPath(
  repositoryRoot: string,
  directory: string,
  realpath: (filePath: string) => Promise<string>
): Promise<void> {
  const lexicalRoot = path.resolve(repositoryRoot);
  const lexicalDirectory = path.resolve(directory);
  if (lexicalDirectory === lexicalRoot || !isWithinRoot(lexicalRoot, lexicalDirectory)) {
    throw new UnsafeRepositoryPathError(directory);
  }

  const physicalRoot = await checkedRealpath(realpath, lexicalRoot, directory);
  const physicalDirectory = await checkedRealpath(realpath, lexicalDirectory, directory);
  if (!isWithinRoot(physicalRoot, physicalDirectory)) {
    throw new UnsafeRepositoryPathError(directory);
  }
}
