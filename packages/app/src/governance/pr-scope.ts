/**
 * PR scoping for collection and primitive runs: validate only what a PR changed.
 * @module app/governance/pr-scope
 */
import * as path from 'node:path';
import type {
  ArgvProcessRunner,
  FileSystem,
} from '@ai-primitives-hub/core';
import {
  detectPrimitiveKind,
} from '@ai-primitives-hub/core';
import {
  readGitChangedFiles,
} from '@ai-primitives-hub/infra/governance';

/** Optional on collection and primitive requests; both refs together turn on PR mode. */
export interface PrScopeRequest {
  baseRef?: string;
  headRef?: string;
  processRunner?: ArgvProcessRunner;
}

/** Shown in the report so readers can see what the PR run covered. */
export interface PrScope {
  baseRef: string;
  headRef: string;
  mergeBase: string;
  changedFiles: string[];
  /** Collection files or primitive files that were validated because of the change. */
  validated: string[];
  /** Hub sources the PR added or modified, downloaded to validate their collections. */
  sources?: string[];
}

/**
 * Read the PR's changed files, or `undefined` when no refs were given.
 * @param request
 * @param repoRoot
 * @throws {Error} When only one ref is given, no process runner is supplied, or Git history is unusable.
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
  roots.some((root) => root === '.' || file === root || file.startsWith(`${root.replace(/\/+$/, '')}/`));

/**
 * Changed primitive files under the given roots. A change anywhere in a skill folder selects its SKILL.md.
 * @param fs
 * @param repoRoot
 * @param changedFiles Repository-relative changed paths.
 * @param roots Repository-relative files or directories to limit the scope; `.` for everything.
 */
export async function changedPrimitiveFiles(fs: FileSystem, repoRoot: string, changedFiles: readonly string[], roots: readonly string[]): Promise<string[]> {
  const normalizedRoots = roots.map((root) => path.posix.normalize(root.replaceAll('\\', '/')));
  const selected = new Set<string>();
  for (const file of changedFiles.filter((candidate) => isInside(candidate, normalizedRoots))) {
    if (detectPrimitiveKind(file) !== undefined) {
      selected.add(file);
      continue;
    }
    // Asset changes inside a skill folder re-validate that skill.
    for (let dir = path.posix.dirname(file); dir !== '.' && dir !== '/'; dir = path.posix.dirname(dir)) {
      const skill = `${dir}/SKILL.md`;
      if (await fs.exists(path.join(repoRoot, skill))) {
        selected.add(skill);
        break;
      }
    }
  }
  return [...selected].toSorted();
}
