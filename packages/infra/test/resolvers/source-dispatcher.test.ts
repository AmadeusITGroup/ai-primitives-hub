import type {
  FileSystem,
  GitHubApi,
  HttpClient,
  HttpCredentialProvider,
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
const http = {} as HttpClient;
const credentials = {} as HttpCredentialProvider;

const source: RegistrySource = {
  id: 'source',
  name: 'Source',
  type: 'github',
  url: 'https://github.com/owner/repo',
  enabled: true,
  priority: 0
};

describe('SourceDispatcher', () => {
  it('dispatches Artifactory through its HTTP client and source credential provider', () => {
    const artifactory: RegistrySource = {
      ...source,
      type: 'artifactory',
      url: 'https://artifactory.example/repo'
    };
    const dispatcher = new SourceDispatcher({
      fs,
      http,
      artifactoryCredentialProvider: () => credentials
    });

    expect(dispatcher.resolverFor(artifactory)).not.toBeNull();
    expect(dispatcher.isRemote('artifactory')).toBe(true);
  });

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
