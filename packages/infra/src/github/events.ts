/**
 * Observability events emitted by the GitHub middleware.
 *
 * The client invokes a single `onEvent` hook on every state
 * transition. Callers can use this to drive logs, metrics, traces,
 * and (for tests) deterministic assertions about the request loop.
 *
 * Events are intentionally structural rather than free-form strings
 * so tests can match them with simple deep-equality.
 * @module github/events
 */

export type ClientEventKind =
  | 'request'
  | 'success'
  | 'cache-hit'
  | 'not-modified'
  | 'retry'
  | 'rate-limit'
  | 'give-up';

export interface ClientEvent {
  kind: ClientEventKind;
  url: string;
  attempt: number;
  status?: number;
  /** Sleep applied before the next attempt (ms). Set on `retry`/`rate-limit`. */
  sleepMs?: number;
  /** Short reason string. Set on `retry`/`rate-limit`/`give-up`. */
  reason?: string;
  /** Cache provenance. Set on `cache-hit`/`not-modified`. */
  source?: 'etag' | 'blob-cache' | 'inline';
}

export type ClientEventHandler = (event: ClientEvent) => void;

/** No-op handler used when the caller does not want observability. */
export const NOOP_EVENT_HANDLER: ClientEventHandler = (): void => undefined;
