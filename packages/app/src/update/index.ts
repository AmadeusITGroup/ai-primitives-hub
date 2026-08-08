/**
 * Update subsystem barrel export.
 * @module update
 */
export * from './auto-update';
export * from './check-updates';

/**
 * `LogEvent`/`OnLogEvent` are core's log-sink port
 * (`@ai-primitives-hub/core`'s `ports/log-sink.ts`). This module used to
 * define its own copy; the re-export stays only so `app`'s published SDK
 * surface keeps the names it has always exported. New code — inside this
 * package or out — should import them from `core` directly.
 */
export type {
  LogEvent,
  OnLogEvent,
} from '@ai-primitives-hub/core';
