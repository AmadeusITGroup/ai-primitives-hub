/**
 * Maps a configured registry source to the native primitive-harvest provider.
 *
 * Catalog adapters and primitive harvesters have different responsibilities:
 * catalog adapters discover installable bundles, while these providers walk
 * repository trees and extract primitive files. Keeping this mapping in infra
 * lets CLI and VS Code share the same primitive discovery semantics.
 * @module harvest/bundle-providers/registry-source-bundle-provider
 */
import type {
  BundleProvider,
  GitHubApi,
  HubSourceSpec,
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  BlobCache,
} from '../blob-cache';
import {
  AwesomeCopilotBundleProvider,
} from './awesome-copilot-bundle-provider';
import {
  GitHubSingleBundleProvider,
} from './github-bundle-provider';

export interface RegistrySourceBundleProviderOptions {
  source: RegistrySource;
  client: GitHubApi;
  cache: BlobCache;
}

/**
 * Create the native provider for a GitHub-backed registry source.
 *
 * Local and non-GitHub sources return `undefined` and continue through the
 * existing SourceAdapter bridge. Plugin sources are handled by the CLI's
 * native hub-config parser; the extension's public source union does not yet
 * expose that source type.
 * @param options - Source and shared GitHub dependencies.
 */
export function createRegistrySourceBundleProvider(
  options: RegistrySourceBundleProviderOptions
): BundleProvider | undefined {
  if (options.source.type !== 'github' && options.source.type !== 'awesome-copilot') {
    return undefined;
  }

  const repo = parseGitHubRepo(options.source.url);
  if (!repo) {
    return undefined;
  }

  const config = options.source.config ?? {};
  const spec: HubSourceSpec = {
    id: options.source.id,
    name: options.source.name,
    type: options.source.type,
    url: options.source.url,
    owner: repo.owner,
    repo: repo.repo,
    branch: typeof config.branch === 'string' ? config.branch : 'main',
    ...(options.source.type === 'awesome-copilot'
      ? { collectionsPath: typeof config.collectionsPath === 'string' ? config.collectionsPath : 'collections' }
      : {}),
    rawConfig: config
  };

  if (options.source.type === 'awesome-copilot') {
    return new AwesomeCopilotBundleProvider({ spec, client: options.client, cache: options.cache });
  }
  return new GitHubSingleBundleProvider({ spec, client: options.client, cache: options.cache });
}

function parseGitHubRepo(value: string): { owner: string; repo: string } | undefined {
  try {
    const url = new URL(value);
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
      return undefined;
    }
    const [owner, repoValue] = url.pathname.split('/').filter(Boolean);
    const repo = repoValue?.replace(/\.git$/u, '');
    return owner && repo ? { owner, repo } : undefined;
  } catch {
    const match = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(value);
    return match?.[1] && match[2] ? { owner: match[1], repo: match[2] } : undefined;
  }
}
