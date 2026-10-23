/**
 * Process-wide default `User-Agent` for the infra HTTP clients.
 *
 * `NodeHttpClient` and `GitHubApiClient` send this value whenever a request
 * (or, for `GitHubApiClient`, its `options.userAgent`) doesn't set one. A
 * delivery surface that knows its own released version - the CLI - calls
 * {@link setDefaultUserAgent} once at startup so every outgoing request
 * identifies that version. Callers that never set it (the VS Code extension,
 * the library SDK) keep {@link DEFAULT_USER_AGENT}.
 * @module http/user-agent
 */

/** User-Agent sent when no delivery surface has configured one. */
export const DEFAULT_USER_AGENT = 'ai-primitives-hub/1.0';

let currentUserAgent: string = DEFAULT_USER_AGENT;

/**
 * Set the process-wide default User-Agent used by the infra HTTP clients.
 * @param userAgent Non-empty User-Agent value, e.g. `ai-primitives-hub/0.2.0`.
 * @throws {Error} When `userAgent` is empty or whitespace-only.
 */
export function setDefaultUserAgent(userAgent: string): void {
  if (typeof userAgent !== 'string' || userAgent.trim().length === 0) {
    throw new Error('Default User-Agent must be a non-empty string');
  }
  currentUserAgent = userAgent;
}

/**
 * Current process-wide default User-Agent.
 * @returns The value set by {@link setDefaultUserAgent}, or {@link DEFAULT_USER_AGENT}.
 */
export function getDefaultUserAgent(): string {
  return currentUserAgent;
}

/**
 * Restore {@link DEFAULT_USER_AGENT}. Intended for tests, because the default
 * is module-level state shared across a test file.
 */
export function resetDefaultUserAgent(): void {
  currentUserAgent = DEFAULT_USER_AGENT;
}
