/** Compose source governance with the existing adapter factory and auth routing. */
import type {
  FileSystem,
  HubCollectionIndex,
  RegistrySource,
  ReleaseLookup,
} from '@ai-primitives-hub/core';
import {
  downloadGitHubRepository,
  FileCollectionIndex,
  GitHubReleaseLookup,
  hubScopeFileSystem,
  type HubSourceCollectionIndex,
  type HubSourceCollectionIndexOptions,
  parseGitHubRepositoryTarget,
  parseHubConfigYaml,
} from '@ai-primitives-hub/infra';
import {
  createSourceGitHubApi,
  type SourceAdapterFactoryDeps,
} from '../registry/create-source-adapter';
import {
  toRegistrySource,
} from '../registry/validate-hub-config-file';
import type {
  HubSourceAccess,
} from './validate-collection-governance';

/**
 * Download hub sources from their configured branch with each source's own authentication.
 * @param deps
 */
export function createHubSourceAccess(deps: SourceAdapterFactoryDeps): HubSourceAccess {
  return {
    checkout: async (entity) => {
      const source = toRegistrySource(entity);
      if (!source) {
        throw new Error('Invalid collection source.');
      }
      const branch = typeof source.config?.branch === 'string' ? source.config.branch : undefined;
      const snapshot = await downloadGitHubRepository(createSourceGitHubApi(source, deps), parseGitHubRepositoryTarget(source.url), branch);
      return { ...snapshot, repository: source.url, releaseLookup: new GitHubReleaseLookup(() => createSourceGitHubApi(source, deps)) };
    }
  };
}

/**
 * Compose publication lookup using the existing repository-scoped auth chain.
 * @param repository
 * @param deps
 */
export function createCollectionReleaseLookup(repository: string, deps: SourceAdapterFactoryDeps): ReleaseLookup {
  const source: RegistrySource = { id: 'repository', name: 'Repository', type: 'github', url: repository, enabled: true, priority: 0 };
  return new GitHubReleaseLookup(() => createSourceGitHubApi(source, deps));
}

/**
 * Compose authoritative registrations and release evidence for one Hub config.
 * @param fs
 * @param configPath
 * @param deps
 * @param _onProgress Legacy inventory progress callback; local registration reads do not emit source progress.
 * @param _indexOptions Legacy remote inventory options; central registry reads do not scan sources.
 */
export function createHubGovernanceSourceChecks(
  fs: FileSystem, configPath: string, deps: SourceAdapterFactoryDeps,
  _onProgress?: ConstructorParameters<typeof HubSourceCollectionIndex>[3],
  _indexOptions?: HubSourceCollectionIndexOptions
): { collectionIndex: HubCollectionIndex; releaseLookup: ReleaseLookup } {
  let sources: RegistrySource[] = [];
  const releases = new GitHubReleaseLookup((repository) => {
    const target = parseGitHubRepositoryTarget(repository);
    const source = sources.find((candidate) => {
      try {
        const configured = parseGitHubRepositoryTarget(candidate.url);
        return configured.host === target.host && configured.owner.toLowerCase() === target.owner.toLowerCase()
          && configured.repository.toLowerCase() === target.repository.toLowerCase();
      } catch {
        return false;
      }
    });
    if (!source) {
      throw new Error('No configured source authentication for repository.');
    }
    return createSourceGitHubApi(source, deps);
  });
  return {
    releaseLookup: releases,
    collectionIndex: {
      read: async () => {
        const config = parseHubConfigYaml(await fs.readFile(configPath)) as { sources: Record<string, unknown>[] };
        sources = config.sources.map((entry) => {
          const source = toRegistrySource(entry);
          if (!source) {
            throw new Error('Invalid collection source.');
          }
          return source;
        });
        // Reuse the exact parsed config for auth routing and ownership; read the sibling index once.
        return new FileCollectionIndex(hubScopeFileSystem(fs, configPath, config), configPath).read();
      }
    }
  };
}
