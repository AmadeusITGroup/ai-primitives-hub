/**
 * Log sink port — generic log event callback shared by `infra` and `app`
 * use cases, so their host (the extension's `Logger`, a future CLI's
 * console output, ...) can record messages without either package
 * depending on a host-specific logging implementation.
 *
 * `infra` may not depend on `app`, so this lives in `core` (where port
 * interfaces belong) and `app`'s own `OnLogEvent`/`LogEvent` re-export it
 * rather than defining a second, near-identical shape.
 * @module ports/log-sink
 */

export interface LogEvent {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  error?: Error;
}

export type OnLogEvent = (event: LogEvent) => void;
