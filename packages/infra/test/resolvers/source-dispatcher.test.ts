import type {
  FileSystem,
  GitHubApi,
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  SourceDispatcher,
} from '../../src/resolvers/resolver-registry';

const fs = {} as FileSystem;
const api = {} as GitHubApi;

const source: RegistrySource = {
  id: 'source',
  name: 'Source',
  type: 'github',
  url: 'https://github.com/owner/repo',
  enabled: true,
  priority: 0
};

describe('SourceDispatcher', () => {
  it('uses a source-bound API factory for remote resolvers', () => {
    const seen: RegistrySource[] = [];
    const dispatcher = new SourceDispatcher({
      githubApi: api,
      fs,
      githubApiFactory: (configuredSource) => {
        seen.push(configuredSource);
        return api;
      }
    });

    expect(dispatcher.resolverFor(source)).not.toBeNull();
    expect(seen).toEqual([source]);
  });
});
