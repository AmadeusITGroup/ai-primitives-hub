/**
 * Observability contract for the token-resolution chain.
 *
 * Every `TokenProvider` in this package resolves silently today: a caller
 * that ends up unauthenticated has no way to tell whether an explicit
 * token was absent, the `gh` CLI was missing, or a VS Code session simply
 * had no account signed in. This module adds the vocabulary for saying so
 * out loud, following the same injected-handler shape already used by
 * `GitHubApiClient`'s `onEvent` (`http/github-api-client.ts`) and `app`'s
 * `PipelineEvent` - a plain callback, so `infra` stays free of any logger
 * dependency and each delivery layer (CLI `doctor`, the extension's
 * `Logger`) owns its own formatting.
 *
 * Emitting an event must never change token resolution. Providers keep
 * resolving `undefined` on every failure path exactly as before; the
 * events are pure narration.
 * @module auth/auth-event
 */
import type {
  TokenProvider,
} from '@ai-primitives-hub/core';

/**
 * Where a token came from, in user-facing terms.
 *
 * Deliberately named after what a *user* configured rather than after the
 * implementing class, so a log line reads as a remediation hint: seeing
 * `via=gh-cli` when you expected `via=configured-token` tells you your
 * setting never took effect.
 */
export type TokenOrigin =
  /** `promptregistry.githubToken` setting, or a source's own `token` (`StaticTokenProvider`). */
  | 'configured-token'
  /** `GITHUB_TOKEN` / `GH_TOKEN` (`EnvTokenProvider`; CLI-only wiring). */
  | 'env-var'
  /** `gh auth token` (`GhCliTokenProvider`). */
  | 'gh-cli'
  /** The editor's GitHub sign-in (the extension's `VsCodeSessionTokenProvider`). */
  | 'ide-session';

/**
 * Why an origin produced no token.
 *
 * These are the distinctions that matter when diagnosing a failure, and
 * several of them are new information: `GhCliTokenProvider` previously
 * collapsed all four of its `gh-*` outcomes into one silent `undefined`.
 */
export type AuthSkipReason =
  /** The host is not GitHub-owned, so this origin never applies. */
  | 'non-github-host'
  /** No token is configured for this origin (unset setting or env var). */
  | 'not-set'
  /** No editor GitHub session is available (and none was requested interactively). */
  | 'no-session'
  /** The `gh` executable could not be found on `PATH`. */
  | 'gh-not-installed'
  /** `gh` ran but reported no active login. */
  | 'gh-not-authenticated'
  /** `gh` exceeded its timeout budget. */
  | 'gh-timeout'
  /** `gh` exited successfully but printed nothing usable. */
  | 'gh-empty-output'
  /** The origin threw for a reason that does not fit the cases above. */
  | 'unknown';

/**
 * A token's category, derived from its prefix and never anything more.
 *
 * This is a closed set of fixed literals, not a slice of the token: it
 * satisfies the "do not log full tokens or token previews" rule in
 * `docs/contributor-guide/architecture/authentication.md` while still
 * distinguishing a token that expires in an hour from one that lasts a
 * year - which is often the whole diagnosis.
 *
 * These six are GitHub's full documented set; see
 * `GITHUB_TOKEN_TYPE_PREFIXES` below for the reference behind the list.
 * Lifespan is the useful part when reading a log: `ghs_` (1 hour) or
 * `ghu_` (8 hours) beside an intermittent 401 suggests expiry rather than
 * a missing scope.
 *
 * A non-GitHub credential - an Azure DevOps PAT reaching
 * `StaticTokenProvider`, say - correctly reports `opaque`, since this
 * taxonomy is GitHub's alone.
 */
export type GitHubTokenType =
  | 'gho_'
  | 'ghp_'
  | 'ghu_'
  | 'ghs_'
  | 'ghr_'
  | 'github_pat_'
  /**
   * No documented prefix matched. Expected for a GitHub Enterprise Server
   * token, a legacy 40-character hex token, or an Actions `GITHUB_TOKEN`
   * (which the credential reference lists with no prefix of its own).
   */
  | 'opaque';

interface AuthEventBase {
  /** Host the token was being resolved for, e.g. `api.github.com`. */
  readonly host: string;
}

/** A composite chain is about to try its providers, in the order given. */
export interface AuthChainStartEvent extends AuthEventBase {
  readonly kind: 'chain-start';
  /** Origins that will be tried, in order. Unlabelled providers are omitted. */
  readonly plannedOrigins: readonly TokenOrigin[];
}

/** A single origin is being consulted. */
export interface AuthAttemptEvent extends AuthEventBase {
  readonly kind: 'attempt';
  readonly origin: TokenOrigin;
  /** True when served from a provider-local cache or a joined in-flight request. */
  readonly cached?: boolean;
  /** Origin-specific context, e.g. `createIfNone=false`. Never token material. */
  readonly detail?: string;
}

/** An origin supplied a token. Terminates the chain. */
export interface AuthResolvedEvent extends AuthEventBase {
  readonly kind: 'resolved';
  readonly origin: TokenOrigin;
  readonly tokenType: GitHubTokenType;
  /**
   * Granted OAuth scopes, when the origin can know them locally. Only
   * `ide-session` can today; the others would need GitHub's
   * `x-oauth-scopes` response header, so they leave this `undefined`.
   */
  readonly scopes?: readonly string[];
  readonly durationMs: number;
  readonly cached?: boolean;
}

/** An origin had nothing to offer, for a known and expected reason. */
export interface AuthSkippedEvent extends AuthEventBase {
  readonly kind: 'skipped';
  readonly origin: TokenOrigin;
  readonly reason: AuthSkipReason;
  readonly durationMs?: number;
}

/** An origin threw. Resolution continues with the next origin. */
export interface AuthFailedEvent extends AuthEventBase {
  readonly kind: 'failed';
  readonly origin: TokenOrigin;
  readonly reason: AuthSkipReason;
  /** The error message. Origins must not place token material here. */
  readonly message: string;
  readonly durationMs?: number;
}

/**
 * Every origin was tried and none produced a token.
 *
 * Carries only the origins, not their reasons: each origin already
 * announced its own `skipped`/`failed` reason through the same handler
 * moments earlier, so a consumer that accumulates events can pair the two
 * without `infra` duplicating state. That keeps the split clean - `infra`
 * reports facts as they happen, the delivery layer aggregates them for
 * display.
 */
export interface AuthChainExhaustedEvent extends AuthEventBase {
  readonly kind: 'chain-exhausted';
  /** Origins consulted, in chain order. */
  readonly triedOrigins: readonly TokenOrigin[];
  readonly durationMs: number;
}

/**
 * Anything a token provider can report. Discriminated on `kind` so that
 * `tokenType` is guaranteed present exactly where it is meaningful, and
 * `reason` only appears on outcomes that actually have one.
 */
export type AuthEvent =
  | AuthChainStartEvent
  | AuthAttemptEvent
  | AuthResolvedEvent
  | AuthSkippedEvent
  | AuthFailedEvent
  | AuthChainExhaustedEvent;

/**
 * Receives auth events. Synchronous and best-effort: providers call this
 * on their resolution path, so an implementation must not throw and must
 * not block.
 */
export type AuthEventHandler = (event: AuthEvent) => void;

/**
 * A `TokenProvider` that can name the origin it speaks for, letting
 * `CompositeTokenProvider` attribute a resolved token without keeping its
 * own registry of provider classes.
 */
export interface OriginAwareTokenProvider extends TokenProvider {
  readonly origin: TokenOrigin;
}

/**
 * Narrow a provider to one that declares a `TokenOrigin`.
 * @param provider - Any token provider, labelled or not.
 * @returns True when the provider exposes a usable `origin`.
 */
export function isOriginAware(provider: TokenProvider): provider is OriginAwareTokenProvider {
  return typeof (provider as Partial<OriginAwareTokenProvider>).origin === 'string';
}

/**
 * GitHub's documented token prefixes, longest first.
 *
 * Source of truth for this list:
 * https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/github-credential-types
 *
 * No current prefix is a prefix of another (`ghp_` and `github_pat_`
 * diverge at the second character), so the order does not affect today's
 * results - it is a defensive convention that keeps first-match-wins
 * correct if GitHub ever introduces an overlapping prefix.
 */
const GITHUB_TOKEN_TYPE_PREFIXES: readonly GitHubTokenType[] = [
  'github_pat_',
  'gho_',
  'ghp_',
  'ghu_',
  'ghs_',
  'ghr_'
];

/**
 * Classify a token by its prefix, revealing nothing else about it.
 *
 * The result is always one of `GitHubTokenType`'s fixed literals, so no
 * character of the token's secret portion can reach a log. An
 * unrecognised shape - an enterprise or legacy 40-character hex token,
 * say - reports `opaque` rather than echoing any part of the value.
 * @param token - The token to classify. Never logged, never returned.
 * @returns The matching prefix literal, or `opaque` when none applies.
 */
export function describeGitHubTokenType(token: string): GitHubTokenType {
  return GITHUB_TOKEN_TYPE_PREFIXES.find((prefix) => token.startsWith(prefix)) ?? 'opaque';
}
