/** Compose source governance with the existing adapter factory and auth routing. */
import type {
  FileSystem,
  HubCollectionIndex,
  RegistrySource,
  ReleaseLookup,
} from '@ai-primitives-hub/core';
import {
  canonicalHubCollectionId,
} from '@ai-primitives-hub/core';
import {
  GitHubReleaseLookup,
  HubSourceCollectionIndex,
  type HubSourceCollectionIndexOptions,
  parseGitHubRepositoryTarget,
  parseHubConfigYaml,
} from '@ai-primitives-hub/infra';
import {
  createSourceAdapter,
  createSourceGitHubApi,
  type SourceAdapterFactoryDeps,
} from '../registry/create-source-adapter';
import {
  toRegistrySource,
} from '../registry/validate-hub-config-file';

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
 * Compose strict source inventories and release evidence for one Hub config.
 * @param fs
 * @param configPath
 * @param deps
 * @param onProgress
 * @param indexOptions Which sources to read in full, concurrency and the overall time limit.
 */
export function createHubGovernanceSourceChecks(
  fs: FileSystem, configPath: string, deps: SourceAdapterFactoryDeps,
  onProgress?: ConstructorParameters<typeof HubSourceCollectionIndex>[3],
  indexOptions?: HubSourceCollectionIndexOptions
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
        const config = parseHubConfigYaml(await fs.readFile(configPath)) as {
          sources: Record<string, unknown>[]; profiles?: { bundles?: { id: string; source: string }[] }[];
        };
        sources = config.sources.map((entry) => {
          const source = toRegistrySource(entry);
          if (!source) {
            throw new Error('Invalid collection source.');
          }
          return source;
        });
        const inventory = await new HubSourceCollectionIndex(sources, (source) => createSourceAdapter(source, deps), releases, onProgress, indexOptions).read();
        const candidates = new Map(inventory.collections.map((collection) => [`${collection.sourceId}\u0000${collection.id}`, collection]));
        for (const profile of config.profiles ?? []) {
          for (const reference of profile.bundles ?? []) {
            const source = sources.find((candidate) => candidate.id === reference.source && candidate.enabled);
            if (source?.type !== 'github' && source?.type !== 'awesome-copilot') {
              continue;
            }
            const target = parseGitHubRepositoryTarget(source.url);
            const id = source.type === 'github' ? canonicalHubCollectionId(reference.id, `${target.owner}/${target.repository}`) : reference.id;
            candidates.set(`${source.id}\u0000${id}`, { id, sourceId: source.id, repository: source.url, file: configPath });
          }
        }
        return { ...inventory, releaseCandidates: [...candidates.values()] };
      }
    }
  };
}
