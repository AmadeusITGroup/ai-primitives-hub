/**
 * Update subsystem barrel export.
 * @module update
 */
export * from './auto-update';
export * from './check-updates';

/**
 * `LogEvent`/`OnLogEvent` are core's log-sink port
 * (`@ai-primitives-hub/core`'s `ports/log-sink.ts`), re-exported here
 * for backward compatibility: this module used to define its own copy
 * (see git history), and every `registry/*`/`update/*` use case, plus
 * this package's public surface, still refers to them via `app`.
 */
export type {
  LogEvent,
  OnLogEvent,
} from '@ai-primitives-hub/core';
