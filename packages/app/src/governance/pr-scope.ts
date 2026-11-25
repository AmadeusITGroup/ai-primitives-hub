/**
 * PR scoping for collection and primitive runs: validate only what a PR changed.
 * @module app/governance/pr-scope
 */
import * as path from 'node:path';
import type {
  ArgvProcessRunner,
  FileSystem,
  GovernedPrimitiveKind,
} from '@ai-primitives-hub/core';
import {
  detectPrimitiveKind,
  isPrimitiveFileOfKind,
} from '@ai-primitives-hub/core';
import {
  readGitChangedFiles,
} from '@ai-primitives-hub/infra/governance';

export interface PrScopeRequest {
  baseRef?: string;
  headRef?: string;
  processRunner?: ArgvProcessRunner;
}

/** Report the exact comparison and collections covered by the run. */
export interface PrScope {
  baseRef: string;
  headRef: string;
  mergeBase: string;
  changedFiles: string[];
  validated: string[];
  sources?: string[];
}

/**
 * Read changed files when both exact refs are supplied.
 * @param request
 * @param repoRoot
 */
export async function readPrChanges(request: PrScopeRequest, repoRoot: string) {
  if (request.baseRef === undefined && request.headRef === undefined) {
    return undefined;
  }
  if (request.baseRef === undefined || request.headRef === undefined) {
    throw new Error('Both --base-ref and --head-ref are required for PR validation.');
  }
  if (!request.processRunner) {
    throw new Error('PR validation requires a process runner for Git.');
  }
  return readGitChangedFiles(request.processRunner, repoRoot, request.baseRef, request.headRef);
}

const isInside = (file: string, roots: readonly string[]): boolean =>
  roots.some((root) => root === '.' || file === root || file.startsWith(`${root}/`));

const repositoryRelativeRoot = (repoRoot: string, root: string): string => {
  const relative = path.relative(path.resolve(repoRoot), path.resolve(repoRoot, root));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Primitive path '${root}' is outside the repository.`);
  }
  return relative === '' ? '.' : relative.split(path.sep).join('/');
};

/**
 * Changed primitive files under the given roots. A change anywhere in a skill folder selects its SKILL.md.
 * @param fs
 * @param repoRoot
 * @param changedFiles Repository-relative changed paths.
 * @param roots Files or directories, relative to the repository or absolute inside it, to limit the scope; `.` for everything.
 * @param kind Forced kind; selects changed explicit file roots of any name, and changed files of that kind under directory roots.
 * @throws {Error} When a root is outside the repository.
 */
export async function changedPrimitiveFiles(
  fs: FileSystem, repoRoot: string, changedFiles: readonly string[], roots: readonly string[], kind?: GovernedPrimitiveKind
): Promise<string[]> {
  const normalizedRoots = roots.map((root) => repositoryRelativeRoot(repoRoot, root));
  const selected = new Set<string>();
  for (const file of changedFiles.filter((candidate) => isInside(candidate, normalizedRoots))) {
    const governed = kind === undefined
      ? detectPrimitiveKind(file) !== undefined
      : normalizedRoots.includes(file) || isPrimitiveFileOfKind(file, kind);
    if (governed && await fs.exists(path.join(repoRoot, file))) {
      selected.add(file);
      continue;
    }
    if (kind !== undefined && kind !== 'skill') {
      continue;
    }
    // Asset changes inside a skill folder re-validate the nearest skill, up to the repository root.
    for (let dir = path.posix.dirname(file); ; dir = path.posix.dirname(dir)) {
      const skill = dir === '.' ? 'SKILL.md' : `${dir}/SKILL.md`;
      if (await fs.exists(path.join(repoRoot, skill))) {
        selected.add(skill);
        break;
      }
      if (dir === '.' || dir === '/') {
        break;
      }
    }
  }
  return [...selected].toSorted();
}
