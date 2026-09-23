/**
 * Runtime wiring for the opt-in GitHub source authentication model.
 *
 * This module owns environment parsing, category-specific client
 * construction, and the explicit ephemeral setup session. It never combines
 * App tokens with generic or personal fallback credentials.
 * @module harvest/github-source-auth-runtime
 */
import {
  mkdtemp,
  rm,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  GitHubApi,
  GitHubRepositoryTarget,
  GitHubSourceAuthCategory,
  HttpClient,
  ProcessExecutor,
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  GenericPublicTokenProvider,
  GhAppAuthSetupManager,
  GhAppTokenProvider,
  type GhAppTokenProviderOptions,
} from '../auth';
import {
  GitHubApiClient,
  type GitHubApiClientOptions,
} from '../http';
import {
  type GitHubPublicAuthMode,
  GitHubSourceAuthPolicyError,
  type GitHubSourcePreflightOptions,
  type GitHubSourcePreflightReport,
  preflightGitHubSources,
} from './github-source-preflight';

export const GITHUB_APP_AUTH_ENABLED = 'AI_PRIMITIVES_HUB_GH_APP_AUTH_ENABLED';
export const GITHUB_PUBLIC_AUTH_MODE = 'AI_PRIMITIVES_HUB_GH_PUBLIC_AUTH_MODE';
export const GITHUB_APP_ID = 'AI_PRIMITIVES_HUB_GH_APP_AUTH_APP_ID';
export const GITHUB_APP_CLIENT_ID = 'AI_PRIMITIVES_HUB_GH_APP_AUTH_CLIENT_ID';
export const GITHUB_APP_CONFIG = 'AI_PRIMITIVES_HUB_GH_APP_AUTH_CONFIG';
export const GITHUB_APP_AUTH_KEY_FILE = 'AI_PRIMITIVES_HUB_GH_APP_AUTH_KEY_FILE';
export const GITHUB_APP_INSTALLATION_ID = 'AI_PRIMITIVES_HUB_GH_APP_AUTH_INSTALLATION_ID';
export const GITHUB_APP_TIMEOUT_MS = 'AI_PRIMITIVES_HUB_GH_APP_AUTH_TIMEOUT_MS';
export const GITHUB_APP_CACHE_TTL_MS = 'AI_PRIMITIVES_HUB_GH_APP_AUTH_TOKEN_CACHE_TTL_MS';

export interface GitHubSourceAuthRuntimeOptions {
  env: Readonly<Record<string, string | undefined>>;
  http: HttpClient;
  processExecutor?: ProcessExecutor;
  now?: () => number;
  appTokenProvider?: TokenProvider;
  genericTokenProvider?: TokenProvider;
  publicAuthMode?: GitHubPublicAuthMode;
  /** Retry count for preflight-only clients. Defaults to zero to fail promptly. */
  preflightMaxRetries?: number;
}

export interface GitHubSourceAuthRuntime {
  readonly genericTokenProvider: TokenProvider;
  readonly appTokenProvider: TokenProvider | undefined;
  tokenProviderFor(category: Exclude<GitHubSourceAuthCategory, 'unresolved'>): TokenProvider | undefined;
  clientFor(target: GitHubRepositoryTarget, category: GitHubSourceAuthCategory): GitHubApi;
  preflight(
    sources: Parameters<typeof preflightGitHubSources>[0],
    overrides?: Partial<Omit<GitHubSourcePreflightOptions, 'clientFactory' | 'genericTokenProvider' | 'appTokenProvider' | 'publicAuthMode'>>
  ): Promise<GitHubSourcePreflightReport>;
}

export interface GitHubSourceAuthSessionOptions extends Omit<GitHubSourceAuthRuntimeOptions, 'appTokenProvider'> {
  /** GitHub App numeric ID. Mutually exclusive with `clientId`. */
  appId?: string | number;
  /** GitHub App Client ID. Mutually exclusive with `appId`. */
  clientId?: string;
  /** Private-key PEM path used only by the explicit setup step. */
  keyFile: string;
  /** Optional installation ID forwarded to setup and token minting. */
  installationId?: string | number;
  /** Optional root directory for the ephemeral setup workspace. */
  tempRoot?: string;
  /** Timeout for the explicit setup process. */
  setupTimeoutMs?: number;
}

export interface GitHubSourceAuthSession extends GitHubSourceAuthRuntime {
  /** Ephemeral filesystem config used by `gh app-auth setup` and `token`. */
  readonly configPath: string;
  /** Remove the ephemeral setup workspace. Safe to call more than once. */
  cleanup(): Promise<void>;
}

/**
 * Parse the explicit source-aware GitHub authentication switch.
 * @param env
 */
export function parseGitHubAppAuthEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[GITHUB_APP_AUTH_ENABLED];
  if (value === undefined || value.length === 0 || value === '0' || value.toLowerCase() === 'false' || value.toLowerCase() === 'no') {
    return false;
  }
  if (value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes') {
    return true;
  }
  throw new Error(`Invalid ${GITHUB_APP_AUTH_ENABLED}: expected 1, true, yes, 0, false, or no.`);
}

/**
 * Return whether source-aware GitHub authentication is explicitly enabled.
 * @param env
 */
export function isGitHubAppAuthEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return parseGitHubAppAuthEnabled(env);
}

function publicAuthModeFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  override: GitHubPublicAuthMode | undefined
): GitHubPublicAuthMode {
  const value = override ?? env[GITHUB_PUBLIC_AUTH_MODE] ?? 'generic';
  if (value !== 'auto' && value !== 'anonymous' && value !== 'generic') {
    throw new Error(`Invalid ${GITHUB_PUBLIC_AUTH_MODE}: expected auto, anonymous, or generic.`);
  }
  if (value === 'anonymous') {
    throw new GitHubSourceAuthPolicyError();
  }
  return value;
}

function positiveEnvNumber(
  env: Readonly<Record<string, string | undefined>>,
  name: string
): number | undefined {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  if (!/^\d+$/u.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Invalid ${name}: expected a positive integer.`);
  }
  return Number(value);
}

function buildAppTokenProvider(
  options: GitHubSourceAuthRuntimeOptions
): TokenProvider | undefined {
  const appId = options.env[GITHUB_APP_ID];
  const clientId = options.env[GITHUB_APP_CLIENT_ID];
  const configPath = options.env[GITHUB_APP_CONFIG];
  // App settings are conditional: a fully public requested scope must not
  // fail merely because a caller supplied only a partial, unused App
  // configuration. A source that actually requires App auth will fail closed
  // during preflight when the provider is still unavailable.
  if ((appId === undefined && clientId === undefined) || configPath === undefined) {
    return undefined;
  }
  const providerOptions: GhAppTokenProviderOptions = {
    appId,
    clientId,
    configPath,
    installationId: options.env[GITHUB_APP_INSTALLATION_ID],
    processExecutor: options.processExecutor,
    timeoutMs: positiveEnvNumber(options.env, GITHUB_APP_TIMEOUT_MS),
    cacheTtlMs: positiveEnvNumber(options.env, GITHUB_APP_CACHE_TTL_MS),
    now: options.now
  };
  return new GhAppTokenProvider(providerOptions);
}

/**
 * Create category-specific GitHub clients for an opt-in source-aware run.
 * @param options Environment and injected external boundaries.
 * @returns Runtime wiring; setup remains an explicit caller responsibility
 * unless the session factory below is used.
 */
export function createGitHubSourceAuthRuntime(
  options: GitHubSourceAuthRuntimeOptions
): GitHubSourceAuthRuntime {
  const mode = publicAuthModeFromEnv(options.env, options.publicAuthMode);
  const genericTokenProvider = options.genericTokenProvider
    ?? new GenericPublicTokenProvider({ env: options.env });
  const appTokenProvider = options.appTokenProvider ?? buildAppTokenProvider(options);
  const preflightMaxRetries = options.preflightMaxRetries ?? 0;

  const tokenProviderFor = (category: Exclude<GitHubSourceAuthCategory, 'unresolved'>): TokenProvider | undefined => {
    if (category === 'app-authenticated') {
      return appTokenProvider;
    }
    if (category === 'public-generic') {
      return genericTokenProvider;
    }
    return undefined;
  };

  const buildClient = (
    target: GitHubRepositoryTarget,
    category: GitHubSourceAuthCategory,
    clientOptions: Partial<Pick<GitHubApiClientOptions, 'maxRetries'>> = {}
  ): GitHubApi => {
    if (category === 'public-anonymous') {
      throw new GitHubSourceAuthPolicyError();
    }
    if (category === 'unresolved') {
      throw new Error('Cannot build a GitHub client for an unresolved source.');
    }
    const tokenProvider = tokenProviderFor(category);
    if (category === 'app-authenticated' && tokenProvider === undefined) {
      throw new Error('GitHub App authentication is not configured.');
    }
    return new GitHubApiClient(options.http, {
      tokenProvider,
      repositoryTarget: target,
      authenticationCategory: category,
      ...clientOptions
    });
  };
  const clientFor = (target: GitHubRepositoryTarget, category: GitHubSourceAuthCategory): GitHubApi =>
    buildClient(target, category);

  return {
    genericTokenProvider,
    appTokenProvider,
    tokenProviderFor,
    clientFor,
    preflight: (sources, overrides = {}) => preflightGitHubSources(sources, {
      ...overrides,
      clientFactory: (target, category, _tokenProvider) => buildClient(target, category, {
        maxRetries: preflightMaxRetries
      }),
      genericTokenProvider,
      appTokenProvider,
      publicAuthMode: mode
    })
  };
}

/**
 * Create a source-aware runtime whose App configuration is provisioned on
 * demand from a caller-supplied App selector and private-key path.
 *
 * The temporary configuration is deliberately created here rather than in
 * the token provider: setup is a bootstrap operation and must happen only
 * after preflight has derived the actual organization routes. The private
 * key is never read by this process; it is passed as a validated argv value
 * to `gh app-auth setup`.
 * @param options App setup inputs and runtime boundaries.
 * @returns Runtime plus the ephemeral config path and cleanup operation.
 */
export async function createGitHubSourceAuthSession(
  options: GitHubSourceAuthSessionOptions
): Promise<GitHubSourceAuthSession> {
  const appId = options.appId ?? options.env[GITHUB_APP_ID];
  const clientId = options.clientId ?? options.env[GITHUB_APP_CLIENT_ID];
  const installationId = options.installationId ?? options.env[GITHUB_APP_INSTALLATION_ID];
  const tempRoot = options.tempRoot ?? os.tmpdir();
  const tempDirectory = await mkdtemp(path.join(tempRoot, 'ai-primitives-hub-gh-app-'));
  const configPath = path.join(tempDirectory, 'config.yml');
  try {
    const runtimeEnv: Record<string, string | undefined> = {
      ...options.env,
      [GITHUB_APP_ID]: appId === undefined ? undefined : String(appId),
      [GITHUB_APP_CLIENT_ID]: clientId,
      [GITHUB_APP_CONFIG]: configPath,
      [GITHUB_APP_INSTALLATION_ID]: installationId === undefined ? undefined : String(installationId)
    };
    const runtime = createGitHubSourceAuthRuntime({
      ...options,
      env: runtimeEnv,
      appTokenProvider: undefined
    });
    const prepareAppAuthentication = async (
      routes: readonly string[],
      _targets: readonly GitHubRepositoryTarget[]
    ): Promise<void> => {
      await new GhAppAuthSetupManager({
        appId,
        clientId,
        keyFile: options.keyFile,
        configPath,
        routes,
        installationId,
        processExecutor: options.processExecutor,
        timeoutMs: options.setupTimeoutMs
      }).setup();
    };
    let cleaned = false;
    return {
      ...runtime,
      configPath,
      preflight: (sources, overrides = {}) => runtime.preflight(sources, {
        ...overrides,
        prepareAppAuthentication
      }),
      cleanup: async (): Promise<void> => {
        if (cleaned) {
          return;
        }
        cleaned = true;
        await rm(tempDirectory, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }
}
