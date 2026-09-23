/**
 * Update subsystem barrel export.
 * @module update
 */
export * from './auto-update';
export * from './check-updates';
/**
 * `LogEvent`/`OnLogEvent` now live in `core` (`ports/log-sink`) because
 * `infra` needs them too and may not depend on `app`. Re-exported here so
 * the `app` public surface stays unchanged for delivery layers.
 */
export type {
  LogEvent,
  OnLogEvent,
} from '@ai-primitives-hub/core';
