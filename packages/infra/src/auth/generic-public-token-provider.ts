/**
 * Generic public-read credentials for sources already proven public by
 * preflight.
 *
 * This provider is intentionally separate from the repository-scoped App
 * provider. It prefers CI credentials (`GH_TOKEN`, then `GITHUB_TOKEN`) and
 * may use the local personal `gh auth token` lookup only outside CI.
 * @module auth/generic-public-token-provider
 */
import type {
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  isGitHubHost,
} from '../http/github-host';
import {
  GhCliTokenProvider,
} from './gh-cli-token-provider';

export interface GenericPublicTokenProviderOptions {
  env: Readonly<Record<string, string | undefined>>;
  /** Injectable local `gh auth token` provider. */
  ghCli?: TokenProvider;
  /** Override automatic CI detection for controlled callers/tests. */
  allowGhCli?: boolean;
}

const isCi = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env.CI === 'true' || env.CI === '1';

export class GenericPublicTokenProvider implements TokenProvider {
  private readonly ghCli: TokenProvider;
  private readonly allowGhCli: boolean;
  private readonly cachedTokens = new Map<string, string | undefined>();
  private readonly inFlight = new Map<string, Promise<string | undefined>>();

  public constructor(private readonly options: GenericPublicTokenProviderOptions) {
    this.ghCli = options.ghCli ?? new GhCliTokenProvider();
    this.allowGhCli = options.allowGhCli ?? !isCi(options.env);
  }

  public async getToken(host: string): Promise<string | undefined> {
    const normalizedHost = host.toLowerCase();
    if (!isGitHubHost(normalizedHost)) {
      return undefined;
    }
    const fromGhToken = this.options.env.GH_TOKEN;
    if (fromGhToken !== undefined && fromGhToken.length > 0) {
      return fromGhToken;
    }
    const fromGitHubToken = this.options.env.GITHUB_TOKEN;
    if (fromGitHubToken !== undefined && fromGitHubToken.length > 0) {
      return fromGitHubToken;
    }
    if (!this.allowGhCli) {
      return undefined;
    }
    if (this.cachedTokens.has(normalizedHost)) {
      return this.cachedTokens.get(normalizedHost);
    }
    const existing = this.inFlight.get(normalizedHost);
    if (existing !== undefined) {
      return existing;
    }
    const lookup = this.ghCli.getToken(normalizedHost).then((token) => {
      this.cachedTokens.set(normalizedHost, token);
      return token;
    });
    this.inFlight.set(normalizedHost, lookup);
    try {
      return await lookup;
    } finally {
      if (this.inFlight.get(normalizedHost) === lookup) {
        this.inFlight.delete(normalizedHost);
      }
    }
  }
}
