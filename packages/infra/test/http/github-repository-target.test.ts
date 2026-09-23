import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  parseGitHubRepositoryTarget,
} from '../../src/http/github-repository-target';

describe('parseGitHubRepositoryTarget', () => {
  it.each([
    'https://github.com/owner/repository',
    'https://github.com/owner/repository.git',
    'https://github.com/owner/repository/',
    'git@github.com:owner/repository.git',
    'owner/repository',
    'github.com/owner/repository',
    'github.com/owner/repository/'
  ])('normalizes %s', (value) => {
    expect(parseGitHubRepositoryTarget(value)).toEqual({
      host: 'github.com',
      owner: 'owner',
      repository: 'repository'
    });
  });

  it('preserves a supported GitHub host from an HTTPS URL', () => {
    expect(parseGitHubRepositoryTarget('https://api.github.com/owner/repository')).toEqual({
      host: 'api.github.com',
      owner: 'owner',
      repository: 'repository'
    });
  });

  it.each([
    'http://github.com/owner/repository',
    'https://user:password@github.com/owner/repository',
    'https://github.com/owner/repository?ref=main',
    'https://github.com/owner/repository?',
    'https://github.com/owner/repository#fragment',
    'https://github.com/owner/repository#',
    'https://github.com/owner/repository/extra',
    'https://github.com/owner',
    'https://example.com/owner/repository',
    'git@github.com:owner/repository/extra.git',
    'owner/repository/extra',
    'owner/repo name'
  ])('rejects unsafe or malformed repository input %s', (value) => {
    expect(() => parseGitHubRepositoryTarget(value)).toThrow();
  });
});
