/**
 * Shared HubManager factory for CLI commands.
 *
 * Centralizes HubManager creation logic to reduce duplication across commands.
 * @module cli/framework/hub-manager
 */

import {
  HubManager,
  resolveUserConfigPaths,
} from '@prompt-registry/app';
import {
  type HttpClient,
} from '@prompt-registry/core';
import {
  envTokenProvider,
  type TokenProvider,
} from '@prompt-registry/infra';
import {
  ActiveHubStore,
  CompositeHubResolver,
  GitHubHubResolver,
  HubStore,
  LocalHubResolver,
  NodeHttpClient,
  UrlHubResolver,
} from '@prompt-registry/infra';
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
  const tokenProvider = tokens ?? envTokenProvider(ctx.env);
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
  return new HubManager(
    new HubStore(paths.hubs, ctx.fs),
    new ActiveHubStore(paths.activeHub, ctx.fs),
    resolver
  );
};
