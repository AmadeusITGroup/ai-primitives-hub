import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  redactToken,
  resolveGithubToken,
  type TokenResolver,
} from '../../src/harvest/token-provider';

describe('token-provider', () => {
  it('prefers an explicit token over env + gh CLI', async () => {
    const resolver: TokenResolver = {
      readEnv: (_k) => 'env-token',
      readGhCli: async () => 'gh-token'
    };
    const r = await resolveGithubToken({ explicit: 'explicit-token' }, resolver);
    expect(r.token).toBe('explicit-token');
    expect(r.source).toBe('explicit');
  });

  it('falls through to GITHUB_TOKEN then GH_TOKEN then gh CLI', async () => {
    const r1 = await resolveGithubToken({}, {
      readEnv: (k) => (k === 'GITHUB_TOKEN' ? 'gh-a' : undefined),
      readGhCli: async () => 'gh-b'
    });
    expect([r1.token, r1.source]).toStrictEqual(['gh-a', 'env:GITHUB_TOKEN']);

    const r2 = await resolveGithubToken({}, {
      readEnv: (k) => (k === 'GH_TOKEN' ? 'gh-c' : undefined),
      readGhCli: async () => 'gh-d'
    });
    expect([r2.token, r2.source]).toStrictEqual(['gh-c', 'env:GH_TOKEN']);

    const r3 = await resolveGithubToken({}, {
      readEnv: () => undefined,
      readGhCli: async () => 'gh-e'
    });
    expect([r3.token, r3.source]).toStrictEqual(['gh-e', 'gh-cli']);
  });

  it('returns undefined + source=none when every stage is empty', async () => {
    const r = await resolveGithubToken({}, {
      readEnv: () => undefined,
      readGhCli: async () => undefined
    });
    expect(r.token).toBe(undefined);
    expect(r.source).toBe('none');
  });

  it('does not call gh CLI when an earlier stage yielded a token', async () => {
    let ghCalled = 0;
    await resolveGithubToken({ explicit: 'x' }, {
      readEnv: () => undefined,
      readGhCli: async () => {
        ghCalled += 1;
        return 'y';
      }
    });
    expect(ghCalled).toBe(0);
  });

  it('redactToken shows length + last four chars, preserving secrecy', () => {
    expect(redactToken('ghp_abcdefghij')).toBe('***<len=14,tail=ghij>');
    expect(redactToken('')).toBe('***<empty>');
    expect(redactToken(undefined)).toBe('***<missing>');
  });
});
