/**
 * GitHub repository URL parsing and canonicalization shared by source-aware
 * clients and authentication providers.
 * @module http/github-repository-target
 */
import type {
  GitHubRepositoryTarget,
} from '@ai-primitives-hub/core';
import {
  isGitHubHost,
} from './github-host';

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const SAFE_HOST_PATTERN = /^[A-Za-z0-9.-]+$/u;
const hasControlCharacters = (input: string): boolean => {
  for (const character of input) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7F) {
      return true;
    }
  }
  return false;
};

/**
 * Parse an HTTPS URL, SSH URL, or canonical `owner/repository` slug.
 * @param value Repository URL or slug.
 * @returns Normalized repository target.
 * @throws {Error} When the input is not a safe GitHub repository reference.
 */
export function parseGitHubRepositoryTarget(value: string): GitHubRepositoryTarget {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error('GitHub repository reference must be a non-empty trimmed string.');
  }

  if (value.startsWith('git@')) {
    const match = /^git@([^:]+):(.+)$/u.exec(value);
    if (match === null) {
      throw new Error('Invalid GitHub SSH repository reference.');
    }
    return createTarget(match[1], match[2]);
  }

  if (value.includes('://')) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('Invalid GitHub repository URL.');
    }
    const hasForbiddenUrlParts = url.protocol !== 'https:'
      || url.port.length > 0
      || url.username.length > 0
      || url.password.length > 0
      || url.search.length > 0
      || url.hash.length > 0
      || value.includes('?')
      || value.includes('#');
    if (hasForbiddenUrlParts) {
      throw new Error('GitHub repository URL must be HTTPS without credentials, query, or fragment.');
    }
    return createTarget(url.hostname, url.pathname);
  }

  const canonicalValue = value.replace(/\/+$/u, '');
  const segments = canonicalValue.split('/');
  if (segments.length === 3 && isGitHubHost(segments[0].toLowerCase())) {
    return createTarget(segments[0], `${segments[1]}/${segments[2]}`);
  }
  return createTarget('github.com', value);
}

/**
 * Canonicalize a repository target for `gh app-auth token --repo`.
 * @param target Repository target.
 * @returns `host/owner/repository`.
 */
export function canonicalizeGitHubRepositoryTarget(target: GitHubRepositoryTarget): string {
  const normalized = createTarget(target.host, `${target.owner}/${target.repository}`);
  return `${normalized.host}/${normalized.owner}/${normalized.repository}`;
}

function createTarget(hostValue: string, pathValue: string): GitHubRepositoryTarget {
  if (hostValue.length === 0 || hostValue.trim() !== hostValue || !SAFE_HOST_PATTERN.test(hostValue)) {
    throw new Error('GitHub repository host is invalid.');
  }
  const host = hostValue.toLowerCase();
  if (!isGitHubHost(host)) {
    throw new Error('GitHub repository host is not GitHub-owned.');
  }
  if (pathValue.includes('?') || pathValue.includes('#') || hasControlCharacters(pathValue)) {
    throw new Error('GitHub repository path is invalid.');
  }
  const pathWithoutLeadingSlash = pathValue.startsWith('/') ? pathValue.slice(1) : pathValue;
  const segments = pathWithoutLeadingSlash.split('/');
  while (segments.at(-1) === '') {
    segments.pop();
  }
  if (segments.length !== 2) {
    throw new Error('GitHub repository reference must contain exactly owner/repository.');
  }
  const owner = segments[0];
  const repository = segments[1].endsWith('.git') ? segments[1].slice(0, -4) : segments[1];
  if (owner.length === 0 || repository.length === 0 || !SAFE_ID_PATTERN.test(owner) || !SAFE_ID_PATTERN.test(repository)) {
    throw new Error('GitHub repository owner or repository is invalid.');
  }
  return { host, owner, repository };
}
