/**
 * Generic log event emitted by the update use cases, so their host
 * (the extension's `Logger`, a future CLI's console output, ...) can
 * record the exact same messages the original `src/services/{update-
 * checker,auto-update-service}.ts` logged directly, without `app`
 * depending on any host-specific logging implementation.
 * @module update/log-event
 */

export interface LogEvent {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  error?: Error;
}

export type OnLogEvent = (event: LogEvent) => void;
