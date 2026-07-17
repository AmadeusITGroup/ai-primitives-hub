/**
 * Shared HubManager factory for CLI commands.
 *
 * Centralizes HubManager creation logic to reduce duplication across
 * commands. Adapted for three differences from the reference branch:
 * `EnvTokenProvider` is a class here (not the reference's
 * `envTokenProvider` factory function — matches this package's
 * established `TokenProvider` pattern); `NodeHttpClient` takes no
 * constructor options (no `{ env }` proxy-awareness config exists on
 * this port's implementation); and `HubManager`'s constructor takes a
 * single `HubManagerDeps` options object (not the reference's three
 * positional args), which also requires a `favoritesStore` and a
 * `validateConfig` function — supplied here via `FavoritesStore` and
 * `infra`'s `validateHubConfig` (sync, wrapped to the async shape
 * `HubManagerDeps` expects).
 * @module framework/hub-manager
 */
import * as path from 'node:path';
import {
  HubManager,
  resolveUserConfigPaths,
} from '@ai-primitives-hub/app';
import type {
  HttpClient,
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  ActiveHubStore,
  CompositeHubResolver,
  EnvTokenProvider,
  FavoritesStore,
  GitHubHubResolver,
  HubStore,
  LocalHubResolver,
  NodeHttpClient,
  UrlHubResolver,
  validateHubConfig,
} from '@ai-primitives-hub/infra';
import {
  type Context,
} from './context';

/**
 * Create HTTP client and token provider with defaults.
 * @param http Optional HTTP client (for testing).
 * @param ctx CLI context.
 * @param tokens Optional token provider (for testing).
 * @returns Tuple of [httpClient, tokenProvider].
 */
export const createHttpClientAndTokens = (
  http: HttpClient | undefined,
  ctx: Context,
  tokens: TokenProvider | undefined
): [HttpClient, TokenProvider] => {
  const httpClient = http ?? new NodeHttpClient();
  const tokenProvider = tokens ?? new EnvTokenProvider(ctx.env);
  return [httpClient, tokenProvider];
};

export interface CreateHubManagerOptions {
  ctx: Context;
  http?: HttpClient;
  tokens?: TokenProvider;
}

/**
 * Create a HubManager with default HTTP client and token provider.
 * @param opts Options for creating HubManager.
 * @returns Configured HubManager instance.
 */
export const createHubManager = (opts: CreateHubManagerOptions): HubManager => {
  const { ctx, http, tokens } = opts;
  const paths = resolveUserConfigPaths(ctx.env);
  const [httpClient, tokenProvider] = createHttpClientAndTokens(http, ctx, tokens);
  const resolver = new CompositeHubResolver(
    new GitHubHubResolver(httpClient, tokenProvider),
    new LocalHubResolver(ctx.fs),
    new UrlHubResolver(httpClient, tokenProvider)
  );
  return new HubManager({
    store: new HubStore(paths.hubs, ctx.fs),
    activeStore: new ActiveHubStore(paths.activeHub, ctx.fs),
    resolver,
    favoritesStore: new FavoritesStore(path.join(paths.hubs, 'favorites.json'), ctx.fs),
    validateConfig: (config) => Promise.resolve(validateHubConfig(config))
  });
};
