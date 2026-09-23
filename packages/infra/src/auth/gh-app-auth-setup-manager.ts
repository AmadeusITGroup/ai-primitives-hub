/**
 * Explicit bootstrap boundary for `gh app-auth setup`.
 *
 * Runtime token lookup never calls this manager. A caller must deliberately
 * provide routes and the private-key input before invoking setup.
 * @module auth/gh-app-auth-setup-manager
 */
import type {
  ProcessExecutor,
} from '@ai-primitives-hub/core';
import {
  NodeProcessExecutor,
} from '../process/node-process-executor';

export type GhAppAuthSetupErrorCode =
  | 'GH_APP_AUTH_SETUP_SELECTOR_INVALID'
  | 'GH_APP_AUTH_SETUP_CONFIG_MISSING'
  | 'GH_APP_AUTH_SETUP_ROUTES_MISSING'
  | 'GH_APP_AUTH_SETUP_KEY_MISSING'
  | 'GH_APP_AUTH_SETUP_FAILED'
  | 'GH_APP_AUTH_SETUP_TIMEOUT';

export class GhAppAuthSetupError extends Error {
  public constructor(
    public readonly code: GhAppAuthSetupErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'GhAppAuthSetupError';
  }
}

export interface GhAppAuthSetupManagerOptions {
  appId?: string | number;
  clientId?: string;
  keyFile?: string;
  configPath: string;
  routes: readonly string[];
  installationId?: string | number;
  processExecutor?: ProcessExecutor;
  executable?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const hasControlCharacters = (input: string): boolean => {
  for (const character of input) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7F) {
      return true;
    }
  }
  return false;
};

function validateSelector(options: GhAppAuthSetupManagerOptions): { flag: '--app-id' | '--client-id'; value: string } {
  const hasAppId = options.appId !== undefined;
  const hasClientId = options.clientId !== undefined && options.clientId.length > 0;
  if (hasAppId === hasClientId) {
    throw new GhAppAuthSetupError(
      'GH_APP_AUTH_SETUP_SELECTOR_INVALID',
      'Exactly one of GitHub App ID or Client ID is required for setup.'
    );
  }
  if (hasAppId) {
    const appIdValue = String(options.appId);
    if (!/^\d+$/u.test(appIdValue) || Number(appIdValue) <= 0 || !Number.isSafeInteger(Number(appIdValue))) {
      throw new GhAppAuthSetupError('GH_APP_AUTH_SETUP_SELECTOR_INVALID', 'GitHub App ID must be a positive integer.');
    }
    return { flag: '--app-id', value: appIdValue };
  }
  const clientIdValue = options.clientId!;
  if (clientIdValue.trim() !== clientIdValue || hasControlCharacters(clientIdValue)) {
    throw new GhAppAuthSetupError('GH_APP_AUTH_SETUP_SELECTOR_INVALID', 'GitHub App Client ID is invalid.');
  }
  return { flag: '--client-id', value: clientIdValue };
}

function validateNonEmpty(input: string, code: GhAppAuthSetupErrorCode, message: string): string {
  if (input.length === 0 || input.trim() !== input || hasControlCharacters(input)) {
    throw new GhAppAuthSetupError(code, message);
  }
  return input;
}

function validatePositive(value: string | number | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = String(value);
  if (!/^\d+$/u.test(normalized) || Number(normalized) <= 0 || !Number.isSafeInteger(Number(normalized))) {
    throw new GhAppAuthSetupError('GH_APP_AUTH_SETUP_SELECTOR_INVALID', 'Installation ID must be a positive integer.');
  }
  return normalized;
}

function validateTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) {
    throw new GhAppAuthSetupError('GH_APP_AUTH_SETUP_SELECTOR_INVALID', 'Setup timeout is invalid.');
  }
  return timeout;
}

export class GhAppAuthSetupManager {
  private readonly options: GhAppAuthSetupManagerOptions;

  public constructor(options: GhAppAuthSetupManagerOptions) {
    this.options = options;
  }

  public async setup(): Promise<void> {
    const selector = validateSelector(this.options);
    const configPath = validateNonEmpty(
      this.options.configPath,
      'GH_APP_AUTH_SETUP_CONFIG_MISSING',
      'An isolated GitHub App auth config path is required for setup.'
    );
    if (this.options.routes.length === 0) {
      throw new GhAppAuthSetupError(
        'GH_APP_AUTH_SETUP_ROUTES_MISSING',
        'At least one GitHub App route is required for setup.'
      );
    }
    const routes = this.options.routes.map((route) => validateNonEmpty(
      route,
      'GH_APP_AUTH_SETUP_ROUTES_MISSING',
      'GitHub App routes must be non-empty.'
    )).toSorted((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
    const keyFile = validateNonEmpty(
      this.options.keyFile ?? '',
      'GH_APP_AUTH_SETUP_KEY_MISSING',
      'A private-key file is required for explicit GitHub App setup.'
    );
    const installationId = validatePositive(this.options.installationId);
    const timeoutMs = validateTimeout(this.options.timeoutMs);
    const args = [
      'app-auth', 'setup',
      selector.flag, selector.value,
      '--key-file', keyFile,
      '--patterns', routes.join(','),
      '--use-filesystem'
    ];
    if (installationId !== undefined) {
      args.push('--installation-id', installationId);
    }
    try {
      await (this.options.processExecutor ?? new NodeProcessExecutor()).execFile(
        this.options.executable ?? 'gh',
        args,
        { env: { GH_APP_AUTH_CONFIG: configPath }, timeoutMs }
      );
    } catch (error) {
      const candidate = error as { code?: unknown; message?: unknown; signal?: unknown };
      const code = candidate.code === 'ETIMEDOUT' || candidate.signal === 'SIGTERM'
        ? 'GH_APP_AUTH_SETUP_TIMEOUT'
        : 'GH_APP_AUTH_SETUP_FAILED';
      throw new GhAppAuthSetupError(code, 'GitHub App setup failed.');
    }
  }
}
