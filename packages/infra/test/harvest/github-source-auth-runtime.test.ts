import type {
  GitHubRepositoryTarget,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  createGitHubSourceAuthRuntime,
  isGitHubAppAuthEnabled,
  parseGitHubAppAuthEnabled,
} from '../../src/harvest/github-source-auth-runtime';

const target: GitHubRepositoryTarget = {
  host: 'github.com',
  owner: 'owner',
  repository: 'repo'
};

describe('GitHub source auth runtime', () => {
  it('recognizes only explicit true opt-in values', () => {
    expect(isGitHubAppAuthEnabled({})).toBe(false);
    expect(isGitHubAppAuthEnabled({ AI_PRIMITIVES_HUB_GH_APP_AUTH_ENABLED: 'true' })).toBe(true);
    expect(isGitHubAppAuthEnabled({ AI_PRIMITIVES_HUB_GH_APP_AUTH_ENABLED: 'YES' })).toBe(true);
    expect(isGitHubAppAuthEnabled({ AI_PRIMITIVES_HUB_GH_APP_AUTH_ENABLED: '0' })).toBe(false);
    expect(() => parseGitHubAppAuthEnabled({ AI_PRIMITIVES_HUB_GH_APP_AUTH_ENABLED: 'enabled' })).toThrow();
  });

  it('rejects anonymous clients in source-aware mode', () => {
    const runtime = createGitHubSourceAuthRuntime({
      env: {},
      http: {} as never
    });

    expect(() => runtime.clientFor(target, 'public-anonymous'))
      .toThrowError(expect.objectContaining({ code: 'GH_PUBLIC_ANONYMOUS_DISABLED' }));
  });

  it('uses an App client only when the App environment is complete', () => {
    const runtime = createGitHubSourceAuthRuntime({
      env: {
        AI_PRIMITIVES_HUB_GH_APP_AUTH_APP_ID: '123',
        AI_PRIMITIVES_HUB_GH_APP_AUTH_CONFIG: '/tmp/isolated.yml'
      },
      http: {} as never,
      processExecutor: {
        execFile: async () => ({ stdout: 'token', stderr: '' })
      }
    });

    const client = runtime.clientFor(target, 'app-authenticated');
    expect(client).toBeDefined();
  });

  it('does not use the App client for public-generic category', () => {
    const runtime = createGitHubSourceAuthRuntime({
      env: { GH_TOKEN: 'generic-token' },
      http: {} as never
    });

    const client = runtime.clientFor(target, 'public-generic');
    expect(client).toBeDefined();
  });
});
