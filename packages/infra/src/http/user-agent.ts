/**
 * Default `User-Agent` for the infra HTTP clients. The CLI overrides it at startup.
 * @module http/user-agent
 */

/** User-Agent used when no caller has set one. */
export const DEFAULT_USER_AGENT = 'ai-primitives-hub/0.2.0';

let currentUserAgent = DEFAULT_USER_AGENT;

/**
 * Set the default User-Agent.
 * @param userAgent Non-empty value, e.g. `ai-primitives-hub/0.2.0`.
 */
export function setDefaultUserAgent(userAgent: string): void {
  if (userAgent.trim().length === 0) {
    throw new Error('Default User-Agent must be a non-empty string');
  }
  currentUserAgent = userAgent;
}

/**
 * Get the default User-Agent.
 * @returns The current default User-Agent.
 */
export function getDefaultUserAgent(): string {
  return currentUserAgent;
}

/** Restore {@link DEFAULT_USER_AGENT} (for tests). */
export function resetDefaultUserAgent(): void {
  currentUserAgent = DEFAULT_USER_AGENT;
}
