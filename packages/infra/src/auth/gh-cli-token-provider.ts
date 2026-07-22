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

export type ExecFn = (command: string) => Promise<{ stdout: string }>;

const GH_CLI_TIMEOUT_MS = 3000;

export class GhCliTokenProvider implements TokenProvider {
  public constructor(
    private readonly execFn: ExecFn = (cmd) => promisify(exec)(cmd, { timeout: GH_CLI_TIMEOUT_MS })
  ) {}

  public async getToken(host: string): Promise<string | undefined> {
    if (!isGitHubHost(host)) {
      return undefined;
    }
    try {
      const { stdout } = await this.execFn('gh auth token');
      const token = stdout.trim();
      return token.length > 0 ? token : undefined;
    } catch {
      // gh not installed, not authenticated, or the command otherwise
      // failed - no token available via this strategy.
      return undefined;
    }
  }
}
