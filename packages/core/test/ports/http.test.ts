import {
  describe,
  expect,
  it,
} from 'vitest';
import type {
  GitHubRepositoryTarget,
  TokenProvider,
} from '../../src';

describe('TokenProvider repository context', () => {
  it('accepts an optional repository target without changing the request host', async () => {
    const target: GitHubRepositoryTarget = {
      host: 'github.com',
      owner: 'owner',
      repository: 'repo'
    };
    let receivedHost: string | undefined;
    let receivedTarget: GitHubRepositoryTarget | undefined;
    const provider: TokenProvider = {
      getToken: async (host, repositoryTarget) => {
        receivedHost = host;
        receivedTarget = repositoryTarget;
        return undefined;
      }
    };

    await provider.getToken('raw.githubusercontent.com', target);

    expect(receivedHost).toBe('raw.githubusercontent.com');
    expect(receivedTarget).toEqual(target);
  });
});
