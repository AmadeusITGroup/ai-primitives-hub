import {
  execFile,
} from 'node:child_process';
import {
  promisify,
} from 'node:util';
import type {
  ArgvProcessRunner,
  FileSystem,
  HubScopeDocument,
  ProcessRunOptions,
} from '@ai-primitives-hub/core';
import {
  assertHubScopeDocument,
} from '@ai-primitives-hub/core';
import {
  parseHubConfigYaml,
} from '../hub/validate-hub-config';

const execute = promisify(execFile);
/** No shell, hooks, checkout, fetch, or PR executable is used. */
export class NodeArgvProcessRunner implements ArgvProcessRunner {
  public async execFile(file: string, args: readonly string[], options: ProcessRunOptions = {}) {
    // Do not inherit git redirection/config injection from the caller's environment.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !['LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'].includes(key)));
    return execute(file, [...args], {
      cwd: options.cwd,
      env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
      timeout: options.timeoutMs ?? 30_000, maxBuffer: 16 * 1024 * 1024
    });
  }
}

/**
 * Parse untrusted Hub YAML and check full-context identities before projection.
 * @param content
 */
export function parseHubScopeDocument(content: string): HubScopeDocument {
  const value = parseHubConfigYaml(content);
  assertHubScopeDocument(value);
  return { ...value, profiles: value.profiles ?? [] };
}

/**
 * JSON selectors are intentionally strict and cannot silently select a misspelled ID.
 * @param content
 */
export function parseHubScopeFile(content: string): { sourceIds: string[]; profileIds: string[] } {
  const value = JSON.parse(content) as Record<string, unknown>;
  if (!value || Array.isArray(value) || value.schemaVersion !== 1 || Object.keys(value).some((key) => !['schemaVersion', 'sourceIds', 'profileIds'].includes(key))) {
    throw new Error('Scope file requires schemaVersion: 1 and sourceIds/profileIds only.');
  }
  for (const key of ['sourceIds', 'profileIds']) {
    const ids = value[key];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,50}$/.test(id)) || new Set(ids).size !== ids.length) {
      throw new Error(`Invalid ${key} in scope file.`);
    }
  }
  return { sourceIds: value.sourceIds as string[], profileIds: value.profileIds as string[] };
}

export interface GitHubScopeSnapshot { base: HubScopeDocument; head: HubScopeDocument; baseRef: string; headRef: string; mergeBase: string }
/**
 * Resolve exact commits locally and read merge-base/head blobs, not checkout/merge data.
 * @param runner
 * @param repoRoot
 * @param configPath
 * @param baseRef
 * @param headRef
 */
export async function readGitHubScope(runner: ArgvProcessRunner, repoRoot: string, configPath: string, baseRef: string, headRef: string): Promise<GitHubScopeSnapshot> {
  const commit = /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/;
  if (!commit.test(baseRef) || !commit.test(headRef)) {
    throw new Error('Scope refs must be exact 40- or 64-hex commit IDs.');
  }
  if (!configPath || configPath.startsWith('/') || configPath.includes('\\') || configPath.includes(':')
    || configPath.split('/').some((p) => !p || p === '.' || p === '..') || [...configPath].some((char) => char.codePointAt(0)! < 32)) {
    throw new Error('Scoped config must be a safe repository-relative path.');
  }
  const git = async (...args: string[]) => (await runner.execFile('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repoRoot, timeoutMs: 30_000 })).stdout.trim();
  try {
    for (const ref of [baseRef, headRef]) {
      if (await git('cat-file', '-t', ref) !== 'commit') {
        throw new Error('Not a commit.');
      }
    }
    const mergeBases = (await git('merge-base', '--all', baseRef, headRef)).split('\n');
    if (mergeBases.length !== 1 || !commit.test(mergeBases[0])) {
      throw new Error('A unique merge base is required.');
    }
    const mergeBase = mergeBases[0];
    const blob = async (ref: string) => {
      const object = `${ref}:${configPath}`;
      if (await git('cat-file', '-t', object) !== 'blob') {
        throw new Error('Hub path is not a blob.');
      }
      return parseHubScopeDocument(await git('cat-file', 'blob', object));
    };
    return { base: await blob(mergeBase), head: await blob(headRef), baseRef, headRef, mergeBase };
  } catch {
    throw new Error('Cannot read scoped Hub history or documents. Fetch complete base/head history and provide valid Hub blobs; no checkout fallback is allowed.');
  }
}

export interface GitChangedFiles { baseRef: string; headRef: string; mergeBase: string; files: string[] }

/**
 * Files added or modified between the merge base and an exact PR head (deletions excluded).
 * The checkout must be at the PR head, because collection and primitive checks read files from disk.
 * @param runner
 * @param repoRoot
 * @param baseRef Exact base commit.
 * @param headRef Exact head commit; must equal the checkout's HEAD.
 */
export async function readGitChangedFiles(runner: ArgvProcessRunner, repoRoot: string, baseRef: string, headRef: string): Promise<GitChangedFiles> {
  const commit = /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/;
  if (!commit.test(baseRef) || !commit.test(headRef)) {
    throw new Error('--base-ref and --head-ref must be exact 40- or 64-hex commit IDs.');
  }
  const git = async (...args: string[]) => (await runner.execFile('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repoRoot, timeoutMs: 30_000 })).stdout;
  let checkout: string;
  let mergeBases: string[];
  try {
    checkout = (await git('rev-parse', 'HEAD')).trim();
    mergeBases = (await git('merge-base', '--all', baseRef, headRef)).trim().split('\n');
  } catch {
    throw new Error('Cannot read PR history. Fetch complete base/head history (fetch-depth: 0) and retry.');
  }
  if (checkout.toLowerCase() !== headRef.toLowerCase()) {
    throw new Error('The checkout is not at --head-ref. Check out the PR head commit before validating.');
  }
  if (mergeBases.length !== 1 || !commit.test(mergeBases[0])) {
    throw new Error('A unique merge base is required.');
  }
  const output = await git('diff', '--name-only', '-z', '--no-renames', '--diff-filter=d', mergeBases[0], headRef);
  const files = output.split('\0').filter((file) => file.length > 0).toSorted();
  return { baseRef, headRef, mergeBase: mergeBases[0], files };
}

/**
 * Read one committed file at an exact commit, or `undefined` when the path is not a blob there.
 * Used to load governance configuration from the PR base so a PR cannot relax its own gate.
 * @param runner
 * @param repoRoot
 * @param commit Exact 40- or 64-hex commit id.
 * @param file Safe repository-relative path.
 */
export async function readGitBlob(runner: ArgvProcessRunner, repoRoot: string, commit: string, file: string): Promise<string | undefined> {
  if (!/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(commit) || file.startsWith('/') || file.split('/').some((p) => !p || p === '.' || p === '..')) {
    throw new Error('readGitBlob requires an exact commit and a safe repository-relative path.');
  }
  const git = async (...args: string[]) => (await runner.execFile('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repoRoot, timeoutMs: 30_000 })).stdout;
  let type: string;
  try {
    type = (await git('cat-file', '-t', `${commit}:${file}`)).trim();
  } catch {
    return undefined;
  }
  return type === 'blob' ? git('cat-file', 'blob', `${commit}:${file}`) : undefined;
}

/**
 * Overlay one virtual document without spreading a class instance's prototype methods.
 * @param fs
 * @param configPath
 * @param document
 */
export function hubScopeFileSystem(fs: FileSystem, configPath: string, document: unknown): FileSystem {
  return new Proxy(fs, { get: (target, key) => {
    if (key === 'readFile') {
      return async (file: string) => file === configPath ? JSON.stringify(document) : target.readFile(file);
    }
    const value: unknown = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
