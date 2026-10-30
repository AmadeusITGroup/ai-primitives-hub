/**
 * PR scoping for collection and primitive runs: validate only what a PR changed.
 * @module app/governance/pr-scope
 */
import type {
  ArgvProcessRunner,
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
