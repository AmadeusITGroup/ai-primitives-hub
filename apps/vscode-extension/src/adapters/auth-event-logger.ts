/**
 * Renders `infra`'s `AuthEvent` stream to the extension's output channel,
 * reporting each distinct authentication outcome once.
 *
 * This is the delivery-side half of the token-resolution observability
 * added alongside `@ai-primitives-hub/infra`'s `auth/auth-event.ts`.
 * Before it, a failed private-source sync produced one ambiguous line
 * that named neither the winning origin nor the token's scopes.
 *
 * Volume is the design constraint. `Logger` defaults to DEBUG in normal
 * operation, so "demote it to DEBUG" hides nothing from a real user - the
 * only way to stay readable is to not emit at all. Three facts shape what
 * survives:
 *
 *   - One editor session serves every source, and the extension builds one
 *     logger per source (55+ in a large hub), so a per-source line repeats
 *     the same fact dozens of times.
 *   - `VsCodeSessionTokenProvider` caches for 30s and dedupes in-flight
 *     requests, so a single real sign-in is observed hundreds of times.
 *   - A cache hit is not an authentication decision. It re-states the
 *     previous outcome with `0ms` elapsed.
 *
 * So a *distinct* outcome - host plus origin plus token type plus scopes -
 * is reported once process-wide, and a repeat is silent until one of those
 * facts changes (a re-auth, a different account, a narrowed scope set).
 * Failures are never deduplicated: every occurrence is a real event.
 * @module adapters/auth-event-logger
 */
import type {
  AuthAttemptSummary,
  AuthEvent,
  AuthEventHandler,
  AuthSkipReason,
  TokenOrigin,
} from '@ai-primitives-hub/infra';
import {
  formatScopes,
  formatTriedOrigins,
} from '@ai-primitives-hub/infra';
import {
  Logger,
} from '../utils/logger';

const PREFIX = '[Auth]';

/**
 * Outcomes already reported, process-wide.
 *
 * Shared rather than per-logger because the fact being reported - which
 * credential reached a host - belongs to the editor session, not to any
 * one source.
 */
const reportedOutcomes = new Set<string>();

/**
 * Forget every reported outcome so the next resolution reports again.
 *
 * Intended for tests and for an explicit authentication reset, where the
 * user has asked to re-authenticate and should see the result.
 */
export function resetAuthReportingState(): void {
  reportedOutcomes.clear();
}

/**
 * Build an `AuthEventHandler` that narrates authentication to the output
 * channel.
 * @param sourceId - Registry source this chain resolves for, when known.
 * Used on failures, where knowing which source could not authenticate is
 * the point. Omitted from success summaries, since the credential is
 * shared across sources and naming one of them would mislead.
 * @returns A handler to pass to the token providers and their chain.
 */
export function createAuthEventLogger(sourceId?: string): AuthEventHandler {
  const logger = Logger.getInstance();
  const reasons = new Map<TokenOrigin, AuthSkipReason>();

  const withSource = (host: string): string => (sourceId === undefined
    ? `host=${host}`
    : `source=${sourceId} host=${host}`);

  const summarize = (triedOrigins: readonly TokenOrigin[]): readonly AuthAttemptSummary[] =>
    triedOrigins.map((origin) => ({ origin, reason: reasons.get(origin) ?? 'unknown' }));

  return (event: AuthEvent): void => {
    switch (event.kind) {
      case 'chain-start': {
        // The planned order is static configuration, identical on every
        // resolution; only the outcome is worth a line. Reset the reason
        // ledger so a stale failure cannot leak into the next chain.
        reasons.clear();
        break;
      }
      case 'attempt': {
        // Nothing has happened yet, and a cached attempt has nothing to say.
        break;
      }
      case 'resolved': {
        if (event.cached === true) {
          // Re-states an outcome already reported, with 0ms elapsed.
          break;
        }
        const scopes = formatScopes(event.scopes);
        const outcome = `host=${event.host} via=${event.origin} type=${event.tokenType} scopes=${scopes}`;
        if (reportedOutcomes.has(outcome)) {
          break;
        }
        reportedOutcomes.add(outcome);
        logger.info(`${PREFIX} ${outcome} (${event.durationMs}ms)`);
        break;
      }
      case 'skipped': {
        reasons.set(event.origin, event.reason);
        // Individually unremarkable - an origin declining is normal. The
        // reason is retained for the chain summary below.
        break;
      }
      case 'failed': {
        reasons.set(event.origin, event.reason);
        logger.warn(
          `${PREFIX} ${withSource(event.host)} via=${event.origin} reason=${event.reason}: ${event.message}`
        );
        break;
      }
      case 'chain-exhausted': {
        // Never deduplicated: being unable to authenticate is the problem
        // the user is trying to diagnose, every time it happens.
        logger.info(
          `${PREFIX} ${withSource(event.host)} no token — tried: ${formatTriedOrigins(summarize(event.triedOrigins))}`
        );
        break;
      }
      default: {
        break;
      }
    }
  };
}
