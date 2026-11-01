/** Collection PR scope: validate only files affected by the change. */
import type {
  ArgvProcessRunner,
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
