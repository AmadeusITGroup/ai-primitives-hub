/**
 * SourceDispatcher.
 *
 * Centralizes source resolution by mapping RegistrySourceType to resolver instances.
 * This unifies the resolver selection logic that was previously scattered
 * across ProfileActivator and the extension's RepositoryAdapterFactory.
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
 */

import type {
  RegistrySource,
} from '@prompt-registry/core';
import type {
  FileSystem,
} from '@prompt-registry/core';
import type {
  HttpClient,
  TokenProvider,
} from '@prompt-registry/core';
import type {
  BundleResolver,
} from '@prompt-registry/core';
import {
  AwesomeCopilotBundleResolver,
} from '@prompt-registry/infra';
import {
  GitHubBundleResolver,
} from '@prompt-registry/infra';
import {
  LocalAwesomeCopilotBundleResolver,
  LocalSkillsBundleResolver,
  SkillsBundleResolver,
} from '@prompt-registry/infra';

export interface SourceDispatcherOptions {
  /** HTTP client for network requests. */
  http: HttpClient;
  /** Token provider for authenticated requests. */
  tokens: TokenProvider;
  /** Filesystem abstraction for local sources. */
  fs: FileSystem;
}

/**
 * Dispatcher that selects the appropriate resolver based on source type.
 */
export class SourceDispatcher {
  private readonly http: HttpClient;
  private readonly tokens: TokenProvider;
  private readonly fs: FileSystem;

  public constructor(opts: SourceDispatcherOptions) {
    this.http = opts.http;
    this.tokens = opts.tokens;
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
          http: this.http,
          tokens: this.tokens
        });
      }
      case 'awesome-copilot': {
        const config = (source as { config?: { branch?: string; collectionsPath?: string } }).config ?? {};
        return new AwesomeCopilotBundleResolver({
          repoSlug: this.repoSlug(source.url),
          branch: config.branch,
          collectionsPath: config.collectionsPath,
          http: this.http,
          tokens: this.tokens
        });
      }
      case 'skills': {
        return new SkillsBundleResolver({
          repoSlug: this.repoSlug(source.url),
          ref: (source as { ref?: string }).ref,
          http: this.http,
          tokens: this.tokens
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
