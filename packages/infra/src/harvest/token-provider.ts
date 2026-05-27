/**
 * GitHub token resolution for the hub harvester.
 *
 * Purpose: decouple "where does the token come from" from every caller so
 * the same engine runs under the VS Code extension (explicit token from the
 * extension host), a plain shell (env vars) or a developer machine logged
 * into `gh` CLI.
 *
 * Design notes:
 *   - Pure function + injectable resolver => trivially unit-testable without
 *     touching the real environment or spawning processes.
 *   - The real (default) resolver shells out to `gh auth token` lazily and
 *     only when earlier stages returned nothing, to keep the fast path cheap.
 *   - Tokens are *never* returned in their raw form from logs; call
 *     `redactToken(...)` before writing anywhere persistent.
 */

import {
  exec,
} from 'node:child_process';

export type TokenSource =
  | 'explicit'
  | 'env:GITHUB_TOKEN'
  | 'env:GH_TOKEN'
  | 'gh-cli'
  | 'none';

export interface TokenResolver {
  readEnv(name: string): string | undefined;
  readGhCli(): Promise<string | undefined>;
}

export interface ResolvedToken {
  token: string | undefined;
  source: TokenSource;
}

/**
 * Default resolver that reads from process.env and shells out to `gh auth token`.
 * The child_process invocation is kept inside the resolver (not the pure
 * resolve function) so unit tests never need to mock exec.
 */
export const defaultResolver: TokenResolver = {
  readEnv: (name: string): string | undefined => {
    const v = process.env[name];
    return v && v.length > 0 ? v : undefined;
  },
  readGhCli: (): Promise<string | undefined> => {
    return new Promise((resolve) => {
      // Short timeout: if gh is missing or hangs we fall through to "none".
      exec('gh auth token', { timeout: 5000 }, (err, stdout) => {
        if (err) {
          resolve(undefined);
          return;
        }
        const out = stdout.trim();
        resolve(out.length > 0 ? out : undefined);
      });
    });
  }
};

/**
 * Resolve a GitHub token via explicit -> env -> gh CLI, short-circuiting as
 * soon as a non-empty value is found.
 * @param opts - `explicit` forwards a token from the extension host; takes highest precedence.
 * @param opts.explicit
 * @param resolver - Injectable resolver (defaults to `defaultResolver`).
 */
export async function resolveGithubToken(
  opts: { explicit?: string },
  resolver: TokenResolver = defaultResolver
): Promise<ResolvedToken> {
  if (opts.explicit && opts.explicit.length > 0) {
    return { token: opts.explicit, source: 'explicit' };
  }
  const ghTokenEnv = resolver.readEnv('GITHUB_TOKEN');
  if (ghTokenEnv) {
    return { token: ghTokenEnv, source: 'env:GITHUB_TOKEN' };
  }
  const ghEnv = resolver.readEnv('GH_TOKEN');
  if (ghEnv) {
    return { token: ghEnv, source: 'env:GH_TOKEN' };
  }
  const fromCli = await resolver.readGhCli();
  if (fromCli) {
    return { token: fromCli, source: 'gh-cli' };
  }
  return { token: undefined, source: 'none' };
}

/**
 * Log-safe representation of a token. Retains length + last four chars so a
 * developer can spot "wrong token" vs "missing token" without ever seeing
 * the full secret.
 * @param token - Token string to redact; may be undefined or empty.
 */
export function redactToken(token: string | undefined): string {
  if (token === undefined) {
    return '***<missing>';
  }
  if (token.length === 0) {
    return '***<empty>';
  }
  const tail = token.slice(-4);
  return `***<len=${token.length},tail=${tail}>`;
}
