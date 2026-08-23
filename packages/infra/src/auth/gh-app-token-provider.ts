/**
 * Repository-scoped GitHub App installation-token provider.
 *
 * The provider delegates JWT/configuration work to the installed
 * `gh app-auth token` extension. It deliberately accepts the request host
 * separately from the repository target because GitHub API, raw-content,
 * and codeload requests use different hosts for the same repository.
 * @module auth/gh-app-token-provider
 */
import type {
  GitHubRepositoryTarget,
  ProcessExecutor,
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  isGitHubHost,
} from '../http/github-host';
import {
  canonicalizeGitHubRepositoryTarget as canonicalizeRepositoryTarget,
} from '../http/github-repository-target';
import {
  NodeProcessExecutor,
} from '../process/node-process-executor';

export type GhAppAuthErrorCode =
  | 'GH_APP_AUTH_SELECTOR_INVALID'
  | 'GH_APP_AUTH_CONFIG_MISSING'
  | 'GH_APP_AUTH_REPOSITORY_CONTEXT_MISSING'
  | 'GH_APP_AUTH_REPOSITORY_INVALID'
  | 'GH_APP_AUTH_CLI_UNAVAILABLE'
  | 'GH_APP_AUTH_TIMEOUT'
  | 'GH_APP_AUTH_ROUTE_MISMATCH'
  | 'GH_APP_AUTH_INSTALLATION_MISSING'
  | 'GH_APP_AUTH_MINT_FAILED'
  | 'GH_APP_AUTH_OUTPUT_INVALID';

/** Error with a stable, log-safe code for App-authentication failures. */
export class GhAppAuthError extends Error {
  public constructor(
    public readonly code: GhAppAuthErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'GhAppAuthError';
  }
}

export interface GhAppTokenProviderOptions {
  /** Positive numeric GitHub App ID. Mutually exclusive with `clientId`. */
  appId?: string | number;
  /** GitHub App Client ID. Mutually exclusive with `appId`. */
  clientId?: string;
  /** Isolated `gh-app-auth` configuration path. */
  configPath?: string;
  /** Optional repository installation ID override. */
  installationId?: string | number;
  /** Injectable argv-safe process executor. */
  processExecutor?: ProcessExecutor;
  /** Executable name, primarily useful for controlled tests. Defaults to `gh`. */
  executable?: string;
  /** Maximum token-command duration. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Local cache lifetime. Defaults to 50 minutes. */
  cacheTtlMs?: number;
  /** Injectable clock returning epoch milliseconds. */
  now?: () => number;
}

interface NormalizedOptions {
  selectorFlag: '--app-id' | '--client-id';
  selectorValue: string;
  configPath: string;
  installationId: string | undefined;
  processExecutor: ProcessExecutor;
  executable: string;
  timeoutMs: number;
  cacheTtlMs: number;
  now: () => number;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_TTL_MS = 50 * 60 * 1000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_CACHE_TTL_MS = 60 * 60 * 1000;
const hasControlCharacters = (input: string): boolean => {
  for (const character of input) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7F) {
      return true;
    }
  }
  return false;
};

function positiveInteger(value: string | number | undefined, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const stringValue = String(value);
  if (!/^\d+$/u.test(stringValue) || Number(stringValue) <= 0 || !Number.isSafeInteger(Number(stringValue))) {
    throw new GhAppAuthError(
      'GH_APP_AUTH_SELECTOR_INVALID',
      `GitHub App ${field} must be a positive integer.`
    );
  }
  return stringValue;
}

function validateDuration(value: number | undefined, fallback: number, field: string, maximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new GhAppAuthError(
      'GH_APP_AUTH_SELECTOR_INVALID',
      `GitHub App ${field} must be a positive integer no greater than ${String(maximum)}.`
    );
  }
  return resolved;
}

function validateConfigPath(configPath: string | undefined): string {
  if (configPath === undefined || configPath.length === 0 || configPath.trim() !== configPath || hasControlCharacters(configPath)) {
    throw new GhAppAuthError(
      'GH_APP_AUTH_CONFIG_MISSING',
      'An isolated GitHub App auth config path is required.'
    );
  }
  return configPath;
}

function validateClientId(clientId: string | undefined): string | undefined {
  if (clientId === undefined) {
    return undefined;
  }
  if (clientId.length === 0 || clientId.trim() !== clientId || hasControlCharacters(clientId)) {
    throw new GhAppAuthError(
      'GH_APP_AUTH_SELECTOR_INVALID',
      'GitHub App Client ID is invalid.'
    );
  }
  return clientId;
}

function normalizeOptions(options: GhAppTokenProviderOptions): NormalizedOptions {
  const appId = positiveInteger(options.appId, 'App ID');
  const clientId = validateClientId(options.clientId);
  if ((appId === undefined) === (clientId === undefined)) {
    throw new GhAppAuthError(
      'GH_APP_AUTH_SELECTOR_INVALID',
      'Exactly one of GitHub App ID or Client ID is required.'
    );
  }
  const executable = options.executable ?? 'gh';
  if (executable.length === 0 || executable.trim() !== executable || hasControlCharacters(executable)) {
    throw new GhAppAuthError(
      'GH_APP_AUTH_SELECTOR_INVALID',
      'GitHub App auth executable is invalid.'
    );
  }
  return {
    selectorFlag: appId === undefined ? '--client-id' : '--app-id',
    selectorValue: appId ?? clientId!,
    configPath: validateConfigPath(options.configPath),
    installationId: positiveInteger(options.installationId, 'installation ID'),
    processExecutor: options.processExecutor ?? createDefaultProcessExecutor(),
    executable,
    timeoutMs: validateDuration(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeout', MAX_TIMEOUT_MS),
    cacheTtlMs: validateDuration(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 'cache TTL', MAX_CACHE_TTL_MS),
    now: options.now ?? Date.now
  };
}

function createDefaultProcessExecutor(): ProcessExecutor {
  return new NodeProcessExecutor();
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; killed?: unknown; signal?: unknown; message?: unknown };
  return candidate.code === 'ETIMEDOUT'
    || candidate.killed === true
    || candidate.signal === 'SIGTERM'
    || (typeof candidate.message === 'string' && /timed? ?out|timeout/i.test(candidate.message));
}

function classifyProcessFailure(error: unknown): GhAppAuthErrorCode {
  if (isTimeoutError(error)) {
    return 'GH_APP_AUTH_TIMEOUT';
  }
  if (typeof error !== 'object' || error === null) {
    return 'GH_APP_AUTH_MINT_FAILED';
  }
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code === 'ENOENT') {
    return 'GH_APP_AUTH_CLI_UNAVAILABLE';
  }
  const message = typeof candidate.message === 'string' ? candidate.message.toLowerCase() : '';
  if (message.includes('route')) {
    return 'GH_APP_AUTH_ROUTE_MISMATCH';
  }
  if (message.includes('installation')) {
    return 'GH_APP_AUTH_INSTALLATION_MISSING';
  }
  if (message.includes('not found') && message.includes('gh')) {
    return 'GH_APP_AUTH_CLI_UNAVAILABLE';
  }
  return 'GH_APP_AUTH_MINT_FAILED';
}

function parseTokenOutput(stdout: string): string {
  if (stdout.includes('\r')) {
    throw new GhAppAuthError(
      'GH_APP_AUTH_OUTPUT_INVALID',
      'GitHub App auth command returned invalid token output.'
    );
  }
  const withoutTrailingNewline = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  const token = withoutTrailingNewline.trim();
  if (token.length === 0 || withoutTrailingNewline.includes('\n') || hasControlCharacters(withoutTrailingNewline)) {
    throw new GhAppAuthError(
      'GH_APP_AUTH_OUTPUT_INVALID',
      'GitHub App auth command returned invalid token output.'
    );
  }
  return token;
}

/* eslint-disable @typescript-eslint/member-ordering -- public API first */
export class GhAppTokenProvider implements TokenProvider {
  private readonly options: NormalizedOptions;
  private readonly cache = new Map<string, CachedToken>();
  private readonly inFlight = new Map<string, Promise<string>>();

  public constructor(options: GhAppTokenProviderOptions) {
    this.options = normalizeOptions(options);
  }

  public async getToken(host: string, target?: GitHubRepositoryTarget): Promise<string | undefined> {
    if (!isGitHubHost(host.toLowerCase())) {
      return undefined;
    }
    if (target === undefined) {
      throw new GhAppAuthError(
        'GH_APP_AUTH_REPOSITORY_CONTEXT_MISSING',
        'A repository target is required for GitHub App authentication.'
      );
    }
    let repositoryTarget: string;
    try {
      repositoryTarget = canonicalizeRepositoryTarget(target);
    } catch (error) {
      if (error instanceof GhAppAuthError) {
        throw error;
      }
      throw new GhAppAuthError(
        'GH_APP_AUTH_REPOSITORY_INVALID',
        'GitHub App repository target is invalid.'
      );
    }

    const cacheKey = `${this.options.selectorFlag}=${this.options.selectorValue}|config=${this.options.configPath}|installation=${this.options.installationId ?? ''}|repo=${repositoryTarget}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > this.options.now()) {
      return cached.token;
    }

    const existing = this.inFlight.get(cacheKey);
    if (existing !== undefined) {
      return existing;
    }

    const refresh = this.mintToken(repositoryTarget, cacheKey);
    this.inFlight.set(cacheKey, refresh);
    try {
      return await refresh;
    } finally {
      if (this.inFlight.get(cacheKey) === refresh) {
        this.inFlight.delete(cacheKey);
      }
    }
  }

  /** Clear in-memory installation-token state. */
  public clearCache(): void {
    this.cache.clear();
  }

  private async mintToken(repositoryTarget: string, cacheKey: string): Promise<string> {
    const args = [
      'app-auth', 'token',
      this.options.selectorFlag, this.options.selectorValue,
      '--repo', repositoryTarget
    ];
    if (this.options.installationId !== undefined) {
      args.push('--installation-id', this.options.installationId);
    }

    let result;
    try {
      result = await this.options.processExecutor.execFile(this.options.executable, args, {
        env: { GH_APP_AUTH_CONFIG: this.options.configPath },
        timeoutMs: this.options.timeoutMs
      });
    } catch (error) {
      const code = classifyProcessFailure(error);
      throw new GhAppAuthError(code, `GitHub App token command failed for ${repositoryTarget}.`);
    }

    const token = parseTokenOutput(result.stdout);
    this.cache.set(cacheKey, {
      token,
      expiresAt: this.options.now() + this.options.cacheTtlMs
    });
    return token;
  }
}
/* eslint-enable @typescript-eslint/member-ordering */
