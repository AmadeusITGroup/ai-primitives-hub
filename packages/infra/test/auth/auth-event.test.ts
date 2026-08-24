import type {
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import type {
  GitHubTokenType,
} from '../../src/auth/auth-event';
import {
  describeGitHubTokenType,
  isOriginAware,
} from '../../src/auth/auth-event';

const SECRET = 'SuperSecretMaterialThatMustNeverBeLogged';

describe('describeGitHubTokenType', () => {
  it.each([
    ['gho_', 'gho_'],
    ['ghp_', 'ghp_'],
    ['ghu_', 'ghu_'],
    ['ghs_', 'ghs_'],
    ['ghr_', 'ghr_'],
    ['github_pat_', 'github_pat_']
  ])('classifies a %s token as %s', (prefix, expected) => {
    expect(describeGitHubTokenType(`${prefix}${SECRET}`)).toBe(expected);
  });

  it('reports opaque for an unrecognised token shape', () => {
    expect(describeGitHubTokenType('0123456789abcdef0123456789abcdef01234567')).toBe('opaque');
  });

  it('reports opaque for an empty token', () => {
    expect(describeGitHubTokenType('')).toBe('opaque');
  });

  it('prefers the longer github_pat_ prefix over any shorter match', () => {
    // A fine-grained PAT must not be mistaken for a `ghp_` classic PAT.
    expect(describeGitHubTokenType('github_pat_11ABCDE')).toBe('github_pat_');
  });

  it('never reveals token material beyond the type prefix', () => {
    for (const prefix of ['gho_', 'ghp_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', '']) {
      const described: string = describeGitHubTokenType(`${prefix}${SECRET}`);
      expect(described).not.toContain(SECRET);
      expect(SECRET).not.toContain(described);
    }
  });

  it('only ever returns a value from the closed GitHubTokenType set', () => {
    const allowed: readonly GitHubTokenType[] = ['gho_', 'ghp_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'opaque'];
    const samples = ['gho_x', 'ghp_x', 'ghu_x', 'ghs_x', 'ghr_x', 'github_pat_x', 'x', '', 'gh_x', 'GHO_X'];

    for (const sample of samples) {
      expect(allowed).toContain(describeGitHubTokenType(sample));
    }
  });

  it('is case-sensitive, treating an uppercased prefix as opaque', () => {
    expect(describeGitHubTokenType('GHO_ABC')).toBe('opaque');
  });
});

describe('isOriginAware', () => {
  it('accepts a provider that declares an origin', () => {
    const provider = { origin: 'gh-cli', getToken: async () => undefined } satisfies TokenProvider & { origin: string };
    expect(isOriginAware(provider)).toBe(true);
  });

  it('rejects a bare provider with no origin', () => {
    const provider: TokenProvider = { getToken: async () => undefined };
    expect(isOriginAware(provider)).toBe(false);
  });
});
