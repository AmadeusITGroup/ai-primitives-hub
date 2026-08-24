/**
 * `TokenProvider` backed by the `gh` CLI's `gh auth token` command.
 *
 * Ported from the "gh CLI" step of `src/adapters/github-adapter.ts`'s
 * three-strategy authentication chain (explicit token -> VS Code session
 * -> `gh` CLI). Only this step lands in infra: it's the one strategy that
 * is genuinely environment-agnostic (works identically for the CLI and,
 * later, the extension - it just shells out). An explicit
 * `RegistrySource.token` needs no provider at all (the caller can use it
 * directly); a VS Code session-backed provider belongs in
 * `apps/vscode-extension` (Phase 4/6), since only that delivery context
 * may import `vscode`.
 *
 * Host-aware since `TokenProvider` (Phase 3b) is: skips the `gh` shell-out
 * entirely for a non-GitHub host, both to stay cheap when called against
 * arbitrary URLs and to avoid ever handing a GitHub token to an unrelated
 * host.
 *
 * Every failure still resolves `undefined`, but no longer silently: the
 * four distinct ways `gh` can decline (absent, logged out, too slow, or
 * inexplicably quiet) are classified and reported through `onAuthEvent`.
 * Telling "gh is not installed" apart from "gh is installed but you are
 * logged out" is the single most common question when a private source
 * fails, and this used to be one bare `catch {}`.
 * @module auth/gh-cli-token-provider
 */
import {
  exec,
} from 'node:child_process';
import {
  promisify,
} from 'node:util';
import type {
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  isGitHubHost,
} from '../http/github-host';
import type {
  AuthEventHandler,
  AuthSkipReason,
  TokenOrigin,
} from './auth-event';
import {
  describeGitHubTokenType,
} from './auth-event';

export type ExecFn = (command: string) => Promise<{ stdout: string }>;

const GH_CLI_TIMEOUT_MS = 3000;

/**
 * The subset of Node's `exec` rejection shape that carries a diagnosis.
 *
 * `exec` runs through a shell, so a missing executable surfaces as exit
 * code 127 with a "command not found" message rather than as `ENOENT`;
 * a timeout surfaces as `killed` with a termination signal.
 */
interface ExecFailure {
  readonly code?: number | string;
  readonly killed?: boolean;
  readonly signal?: string;
  readonly message?: string;
}

/**
 * Work out why `gh auth token` did not produce a token.
 * @param error - The value `exec` rejected with.
 * @returns The matching skip reason for an auth event.
 */
function classifyGhFailure(error: unknown): AuthSkipReason {
  if (typeof error !== 'object' || error === null) {
    return 'unknown';
  }

  const { code, killed, signal, message } = error as ExecFailure;

  if (killed === true || code === 'ETIMEDOUT' || signal === 'SIGTERM' || signal === 'SIGKILL') {
    return 'gh-timeout';
  }
  // 127 is the shell's "command not found"; ENOENT covers a non-shell runner.
  if (code === 127 || code === 'ENOENT' || (message !== undefined && /not found|not recognized/i.test(message))) {
    return 'gh-not-installed';
  }
  if (typeof code === 'number') {
    return 'gh-not-authenticated';
  }
  return 'unknown';
}

export class GhCliTokenProvider implements TokenProvider {
  public readonly origin: TokenOrigin = 'gh-cli';

  /**
   * Create a provider that shells out to the GitHub CLI.
   * @param execFn - Command runner. Defaults to `exec` with a 3s timeout.
   * @param onAuthEvent - Optional observability sink; see `auth-event.ts`.
   */
  public constructor(
    private readonly execFn: ExecFn = (cmd) => promisify(exec)(cmd, { timeout: GH_CLI_TIMEOUT_MS }),
    private readonly onAuthEvent?: AuthEventHandler
  ) {}

  public async getToken(host: string): Promise<string | undefined> {
    if (!isGitHubHost(host)) {
      this.onAuthEvent?.({ kind: 'skipped', origin: this.origin, host, reason: 'non-github-host' });
      return undefined;
    }

    this.onAuthEvent?.({ kind: 'attempt', origin: this.origin, host });
    const startedAt = Date.now();

    try {
      const { stdout } = await this.execFn('gh auth token');
      const token = stdout.trim();
      if (token.length === 0) {
        this.onAuthEvent?.({
          kind: 'skipped',
          origin: this.origin,
          host,
          reason: 'gh-empty-output',
          durationMs: Date.now() - startedAt
        });
        return undefined;
      }
      this.onAuthEvent?.({
        kind: 'resolved',
        origin: this.origin,
        host,
        tokenType: describeGitHubTokenType(token),
        durationMs: Date.now() - startedAt
      });
      return token;
    } catch (error) {
      // gh not installed, not authenticated, or the command otherwise
      // failed - no token available via this strategy. Resolution is
      // unchanged; only the narration is new.
      this.onAuthEvent?.({
        kind: 'failed',
        origin: this.origin,
        host,
        reason: classifyGhFailure(error),
        message: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt
      });
      return undefined;
    }
  }
}
