/**
 * Turn transport and GitHub errors into a plain reason and a fix for governance reports.
 * Raw error text is never forwarded: it can contain URLs, signed queries or response bodies.
 * @module governance/failure-reasons
 */

export interface FailureReason {
  reason: string;
  hint: string;
}

/**
 * Classify an error thrown by the HTTP client or the GitHub API client.
 * @param error Anything thrown.
 */
export function describeFailure(error: unknown): FailureReason {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  const status = /GitHub API error: (\d{3})/.exec(message)?.[1];
  switch (status) {
    case '401': {
      return { reason: 'Source token was rejected (HTTP 401)', hint: 'Check that the source token is valid and not expired.' };
    }
    case '403': {
      return /rate limit/i.test(message)
        ? { reason: 'GitHub rate limit exceeded (HTTP 403)', hint: 'Retry later, or run with a token that has a higher rate limit.' }
        : { reason: 'No access to the source repository (HTTP 403)', hint: 'Give the source token read access to this repository.' };
    }
    case '404': {
      return { reason: 'Source repository not found, or no access (HTTP 404)',
        hint: 'Check the source url in hub-config.yml, and that the token has read access to the repository.' };
    }
    case '429': {
      return { reason: 'GitHub rate limit exceeded (HTTP 429)', hint: 'Retry later, or run with a token that has a higher rate limit.' };
    }
    case undefined: {
      break;
    }
    default: {
      return { reason: `GitHub returned an error (HTTP ${status})`, hint: 'Usually temporary on GitHub\'s side; retry the check.' };
    }
  }
  if (code === 'HTTP_REQUEST_TIMEOUT' || message.includes('timed out after')) {
    return { reason: 'Request to GitHub timed out', hint: 'Retry the check; if it keeps happening, GitHub or the network is slow.' };
  }
  if (message.startsWith('Failed to parse GitHub response as JSON')) {
    return { reason: 'GitHub returned an invalid response', hint: 'Usually temporary; retry the check.' };
  }
  return { reason: 'Could not reach GitHub (network error)', hint: 'Check network access from the runner and retry.' };
}

/**
 * Join several reasons for one source into one finding, keeping each distinct reason once.
 * @param reasons
 */
export function combineFailures(reasons: readonly FailureReason[]): FailureReason {
  const unique = [...new Map(reasons.map((entry) => [`${entry.reason}\u0000${entry.hint}`, entry])).values()];
  return {
    reason: unique.map((entry) => entry.reason.replace(/\.$/, '')).join('; '),
    hint: [...new Set(unique.map((entry) => entry.hint))].join(' ')
  };
}
