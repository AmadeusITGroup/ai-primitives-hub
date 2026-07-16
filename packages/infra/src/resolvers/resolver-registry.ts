/**
 * SourceDispatcher.
 *
 * Centralizes source resolution by mapping a source type to resolver
 * instances. This unifies the resolver selection logic that would
 * otherwise be scattered across callers.
 *
 * Supported source types:
 * - github → GitHubBundleResolver
 * - awesome-copilot → AwesomeCopilotBundleResolver
 * - skills → SkillsBundleResolver
 * - local-skills → LocalSkillsBundleResolver
 * - local-awesome-copilot → LocalAwesomeCopilotBundleResolver
 * - local → handled separately (no resolver, uses readLocalBundle)
 *
 * Future additions:
 * - apm, local-apm
 * - awesome-copilot-plugin, local-awesome-copilot-plugin
 *
 * Overlap with `RepositoryAdapterFactory`/`adapters/*` source-type
 * dispatch is intentional and stays (list-all-bundles vs resolve-one-spec
 * are different consumer needs — see `github-resolver.ts`'s module doc).
 * What *was* consolidated: every GitHub-backed resolver constructed here
 * now shares the one `GitHubApi` instance passed in, instead of each
 * resolver rebuilding its own raw-HTTP auth/error handling.
 * @module resolvers/resolver-registry
 */

import type {
  BundleResolver,
  FileSystem,
  GitHubApi,
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  AwesomeCopilotBundleResolver,
} from './awesome-copilot-resolver';
import {
  GitHubBundleResolver,
} from './github-resolver';
import {
  LocalAwesomeCopilotBundleResolver,
  LocalSkillsBundleResolver,
  SkillsBundleResolver,
} from './skills-resolver';

export interface SourceDispatcherOptions {
  /** Shared GitHub API client, reused across every GitHub-backed resolver. */
  githubApi: GitHubApi;
  /** Filesystem abstraction for local sources. */
  fs: FileSystem;
}

/**
 * Dispatcher that selects the appropriate resolver based on source type.
 */
export class SourceDispatcher {
  private readonly githubApi: GitHubApi;
  private readonly fs: FileSystem;

  public constructor(opts: SourceDispatcherOptions) {
    this.githubApi = opts.githubApi;
    this.fs = opts.fs;
  }

  /**
   * Strip `https://github.com/` and trailing slashes from a source URL.
   * @param url - Source URL.
   * @returns Repo slug (e.g., "owner/repo").
   */
  private repoSlug(url: string): string {
    return url
      .replace(/^https?:\/\/github\.com\//, '')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '');
  }

  /**
   * Get a resolver for the given source type.
   * @param source - Registry source configuration.
   * @returns BundleResolver instance or null if type has no resolver (e.g., local).
   */
  public resolverFor(source: RegistrySource): BundleResolver | null {
    switch (source.type) {
      case 'github': {
        return new GitHubBundleResolver({
          repoSlug: this.repoSlug(source.url),
          githubApi: this.githubApi
        });
      }
      case 'awesome-copilot': {
        const config = (source as { config?: { branch?: string; collectionsPath?: string } }).config ?? {};
        return new AwesomeCopilotBundleResolver({
          repoSlug: this.repoSlug(source.url),
          branch: config.branch,
          collectionsPath: config.collectionsPath,
          githubApi: this.githubApi
        });
      }
      case 'skills': {
        return new SkillsBundleResolver({
          repoSlug: this.repoSlug(source.url),
          ref: (source as { ref?: string }).ref,
          githubApi: this.githubApi
        });
      }
      case 'local-skills': {
        return new LocalSkillsBundleResolver({
          rootPath: source.url,
          fs: this.fs
        });
      }
      case 'local-awesome-copilot': {
        const config = (source as { config?: { collectionsPath?: string } }).config ?? {};
        return new LocalAwesomeCopilotBundleResolver({
          rootPath: source.url,
          collectionsPath: config.collectionsPath,
          fs: this.fs
        });
      }
      case 'local': {
        // Local sources have no resolver - they use readLocalBundle directly
        return null;
      }
      default: {
        // Unsupported source type
        return null;
      }
    }
  }

  /**
   * Check if a source type requires a resolver (remote) or is local-only.
   * @param sourceType - Source type to check.
   * @returns true if the source type is remote and requires a resolver.
   */
  public isRemote(sourceType: string): boolean {
    const remoteTypes = ['github', 'awesome-copilot', 'skills', 'apm'];
    return remoteTypes.includes(sourceType);
  }
}
