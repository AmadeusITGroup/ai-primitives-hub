/**
 * Accumulates an `AuthEvent` stream into the one answer a caller
 * actually wants: which origin supplied the token, or - failing that -
 * what was tried and why each declined.
 *
 * Lives here rather than in a delivery layer because both consumers need
 * the identical derivation: the CLI's `doctor` check and the extension's
 * output-channel formatter differ only in wording, not in how they pair a
 * `chain-exhausted` event with the `skipped`/`failed` reasons that
 * preceded it. `AuthEvent` deliberately reports facts as they happen and
 * leaves this correlation to a consumer (see `auth-event.ts`); this is
 * that consumer, written once.
 *
 * Pure and synchronous - it holds no I/O and no logger, so it stays
 * usable from either delivery context.
 * @module auth/auth-chain-recorder
 */
import type {
  AuthEvent,
  AuthEventHandler,
  AuthSkipReason,
  GitHubTokenType,
  TokenOrigin,
} from './auth-event';

/** Why one origin declined, paired back up for reporting. */
export interface AuthAttemptSummary {
  readonly origin: TokenOrigin;
  readonly reason: AuthSkipReason;
}

/** An origin supplied a token. */
export interface AuthResolvedOutcome {
  readonly kind: 'resolved';
  readonly origin: TokenOrigin;
  readonly tokenType: GitHubTokenType;
  /** Present only for origins that can know their scopes locally. */
  readonly scopes?: readonly string[];
  readonly durationMs: number;
  readonly cached: boolean;
}

/** Every origin declined. */
export interface AuthExhaustedOutcome {
  readonly kind: 'exhausted';
  /** What was tried and why it declined, in chain order. */
  readonly tried: readonly AuthAttemptSummary[];
  readonly durationMs: number;
}

/** The end state of a resolution attempt. */
export type AuthChainOutcome = AuthResolvedOutcome | AuthExhaustedOutcome;

/**
 * Collects auth events and reports the resulting outcome.
 */
export interface AuthChainRecorder {
  /** Hand this to the providers and to `CompositeTokenProvider`. */
  readonly onAuthEvent: AuthEventHandler;
  /** Every event seen, in order. Useful for DEBUG-level rendering. */
  events(): readonly AuthEvent[];
  /** The outcome, or `undefined` if resolution never concluded. */
  outcome(): AuthChainOutcome | undefined;
}

/**
 * Create a recorder for a single token-resolution attempt.
 *
 * A recorder is cheap and single-use: create one per `getToken` call you
 * want to narrate, rather than sharing one across a long-lived provider.
 * @returns A recorder plus the handler to inject into providers.
 */
export function createAuthChainRecorder(): AuthChainRecorder {
  const events: AuthEvent[] = [];
  const reasons = new Map<TokenOrigin, AuthSkipReason>();
  let outcome: AuthChainOutcome | undefined;

  const onAuthEvent: AuthEventHandler = (event) => {
    events.push(event);

    switch (event.kind) {
      case 'skipped':
      case 'failed': {
        reasons.set(event.origin, event.reason);
        break;
      }
      case 'resolved': {
        outcome = {
          kind: 'resolved',
          origin: event.origin,
          tokenType: event.tokenType,
          scopes: event.scopes,
          durationMs: event.durationMs,
          cached: event.cached ?? false
        };
        break;
      }
      case 'chain-exhausted': {
        outcome = {
          kind: 'exhausted',
          tried: event.triedOrigins.map((origin) => ({
            origin,
            reason: reasons.get(origin) ?? 'unknown'
          })),
          durationMs: event.durationMs
        };
        break;
      }
      default: {
        // `chain-start` and `attempt` carry no outcome of their own.
        break;
      }
    }
  };

  /**
   * Synthesise an exhausted outcome from the reasons seen so far.
   *
   * A chain of one - `defaultTokenProvider` returns a bare
   * `EnvTokenProvider` when `AI_PRIMITIVES_HUB_DISABLE_GH_CLI=1` - has no
   * `CompositeTokenProvider` to announce `chain-exhausted`, but a caller
   * still deserves to be told what declined and why.
   * @returns An exhausted outcome, or `undefined` if nothing declined.
   */
  const inferExhausted = (): AuthExhaustedOutcome | undefined => {
    if (reasons.size === 0) {
      return undefined;
    }
    return {
      kind: 'exhausted',
      // `Map` preserves insertion order, which is resolution order.
      tried: [...reasons].map(([origin, reason]) => ({ origin, reason })),
      durationMs: 0
    };
  };

  return {
    onAuthEvent,
    events: () => events,
    outcome: () => outcome ?? inferExhausted()
  };
}

/**
 * Render attempted origins as `origin(reason)`, comma separated.
 *
 * Shared by both delivery layers because this fragment reads identically
 * in an output-channel line and in a `doctor` remediation hint.
 * @param tried - Attempt summaries, already in chain order.
 * @returns A human-readable list, or `none` when nothing was attempted.
 */
export function formatTriedOrigins(tried: readonly AuthAttemptSummary[]): string {
  if (tried.length === 0) {
    return 'none';
  }
  return tried.map(({ origin, reason }) => `${origin}(${reason})`).join(', ');
}

/**
 * Render a scope list for a log line, making "we cannot know" explicit.
 *
 * Only the editor-session origin can report scopes locally; the others
 * would need GitHub's `x-oauth-scopes` response header. Printing
 * `unknown` rather than omitting the field keeps that gap visible instead
 * of looking like a token with no scopes at all.
 * @param scopes - Scopes reported by the origin, if any.
 * @returns Comma-separated scopes, `unknown`, or `none`.
 */
export function formatScopes(scopes: readonly string[] | undefined): string {
  if (scopes === undefined) {
    return 'unknown';
  }
  return scopes.length === 0 ? 'none' : scopes.join(',');
}

/**
 * Render a single event as one compact, secret-free line.
 *
 * Suited to per-step DEBUG output in either delivery layer. Summary
 * reporting - the one line naming the winning origin - is left to each
 * layer, since the wording differs between an output channel and a
 * `doctor` remediation hint.
 * @param event - The event to describe.
 * @returns A single line, never containing token material.
 */
export function describeAuthEvent(event: AuthEvent): string {
  switch (event.kind) {
    case 'chain-start': {
      const planned = event.plannedOrigins.length === 0 ? 'none' : event.plannedOrigins.join(' -> ');
      return `chain-start host=${event.host} order=${planned}`;
    }
    case 'attempt': {
      const cached = event.cached === true ? ' cached=true' : '';
      const detail = event.detail === undefined ? '' : ` detail=${event.detail}`;
      return `attempt via=${event.origin} host=${event.host}${cached}${detail}`;
    }
    case 'resolved': {
      const cached = event.cached === true ? ' cached=true' : '';
      return `resolved via=${event.origin} host=${event.host} type=${event.tokenType} `
        + `scopes=${formatScopes(event.scopes)} (${event.durationMs}ms)${cached}`;
    }
    case 'skipped': {
      return `skipped via=${event.origin} host=${event.host} reason=${event.reason}`;
    }
    case 'failed': {
      return `failed via=${event.origin} host=${event.host} reason=${event.reason}: ${event.message}`;
    }
    case 'chain-exhausted': {
      const order = event.triedOrigins.length === 0 ? 'none' : event.triedOrigins.join(' -> ');
      return `chain-exhausted host=${event.host} tried=${order} (${event.durationMs}ms)`;
    }
    default: {
      // Exhaustive today; keeps a future event kind from silently vanishing.
      return `unrecognized auth event: ${JSON.stringify(event)}`;
    }
  }
}
