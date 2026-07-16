/**
 * Maps a `RegistrySource` to its concrete `infra` `SourceAdapter`,
 * building whatever adapter-specific dependencies (a `GitHubApi` for the
 * four GitHub-hosted source types, nothing extra for the four fs-only
 * ones) each constructor needs.
 *
 * This is the "wire it up" half of the migration plan's
 * adapter-unification cutover (§7.5 Phase 4 item 3, decision #10): the
 * eight `infra` adapters already exist and are field-identical to the
 * extension's own `src/adapters/*` (see `core`'s `domain/bundle/types.ts`
 * module doc), but nothing had ever constructed one outside of `infra`'s
 * own tests. Delivery-context-specific pieces - which `TokenProvider`s to
 * fall back to (a VS Code auth session bridge for the extension, none for
 * the CLI today), and the four Node port implementations - are supplied
 * by the caller via `SourceAdapterFactoryDeps`, not hardcoded here, so
 * this stays usable from both `apps/vscode-extension` and `packages/cli`.
 *
 * A source's own explicit `source.token` (if set) always wins over the
 * caller-supplied fallback chain, mirroring every one of the extension's
 * four hand-rolled auth chains today (explicit token checked first).
 * @module registry/create-source-adapter
 */
import type {
  Clock,
  FileSystem,
  GitHubApi,
  HttpClient,
  ProcessRunner,
  RegistrySource,
  SourceAdapter,
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  ApmAdapter,
  AwesomeCopilotAdapter,
  CompositeTokenProvider,
  GitHubAdapter,
  GitHubApiClient,
  LocalAdapter,
  LocalApmAdapter,
  LocalAwesomeCopilotAdapter,
  LocalSkillsAdapter,
  SkillsAdapter,
  StaticTokenProvider,
} from '@ai-primitives-hub/infra';

export interface SourceAdapterFactoryDeps {
  fs: FileSystem;
  clock: Clock;
  httpClient: HttpClient;
  processRunner: ProcessRunner;
  /**
   * Tried, in order, for any GitHub-hosted source that doesn't have its
   * own explicit `source.token` - e.g. a VS Code auth session bridge
   * followed by the `gh` CLI for the extension, or just the `gh` CLI for
   * the CLI itself.
   */
  fallbackTokenProviders: readonly TokenProvider[];
}

function buildSourceTokenProvider(source: RegistrySource, deps: SourceAdapterFactoryDeps): TokenProvider {
  const providers: TokenProvider[] = [];
  if (source.token) {
    providers.push(new StaticTokenProvider(source.token));
  }
  providers.push(...deps.fallbackTokenProviders);
  return new CompositeTokenProvider(providers);
}

function buildGitHubApi(tokenProvider: TokenProvider, deps: SourceAdapterFactoryDeps): GitHubApi {
  return new GitHubApiClient(deps.httpClient, { tokenProvider });
}

/**
 * Build the `infra` `SourceAdapter` for a `RegistrySource`.
 * @param source - The source to build an adapter for.
 * @param deps - Shared, delivery-context-specific dependencies (Node port implementations + auth fallback chain).
 */
export function createSourceAdapter(source: RegistrySource, deps: SourceAdapterFactoryDeps): SourceAdapter {
  switch (source.type) {
    case 'local': {
      return new LocalAdapter(source, deps.fs);
    }
    case 'local-apm': {
      return new LocalApmAdapter(source, deps.fs, deps.clock);
    }
    case 'local-awesome-copilot': {
      return new LocalAwesomeCopilotAdapter(source, deps.fs);
    }
    case 'local-skills': {
      return new LocalSkillsAdapter(source, deps.fs, deps.clock);
    }
    case 'github': {
      return new GitHubAdapter(source, buildGitHubApi(buildSourceTokenProvider(source, deps), deps));
    }
    case 'skills': {
      return new SkillsAdapter(source, buildGitHubApi(buildSourceTokenProvider(source, deps), deps), deps.clock);
    }
    case 'awesome-copilot': {
      return new AwesomeCopilotAdapter(source, buildGitHubApi(buildSourceTokenProvider(source, deps), deps), deps.clock);
    }
    case 'apm': {
      const tokenProvider = buildSourceTokenProvider(source, deps);
      return new ApmAdapter(source, buildGitHubApi(tokenProvider, deps), deps.processRunner, deps.fs, deps.clock, tokenProvider);
    }
    default: {
      throw new Error(`No adapter for source type: ${String(source.type)}`);
    }
  }
}
