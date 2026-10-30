/** Resolve filesystem paths before reading untrusted primitive content. */
import * as path from 'node:path';
import type {
  FileSystem,
} from '@ai-primitives-hub/core';

const inside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/**
 * Reject lexical escapes, broken links and resolved targets outside the root.
 * @param fs
 * @param root
 * @param input
 */
export async function resolvePrimitivePath(fs: FileSystem, root: string, input: string): Promise<string> {
  if (!inside(path.resolve(root), path.resolve(root, input))) {
    throw new Error('Path is outside the repository root.');
  }
  if (!fs.realpath) {
    throw new Error('Filesystem cannot verify symbolic-link containment.');
  }
  let canonicalRoot: string;
  let canonical: string;
  try {
    canonicalRoot = await fs.realpath(root);
    canonical = await fs.realpath(path.resolve(root, input));
  } catch {
    throw new Error('Path is missing, unreadable, or contains a broken symbolic link.');
  }
  if (!inside(canonicalRoot, canonical)) {
    throw new Error('Path resolves outside the repository root through a symbolic link.');
  }
  return canonical;
}
