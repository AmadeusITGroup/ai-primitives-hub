/**
 * Production `Clock` implementation, backed by the real `Date`.
 * @module clock/system-clock
 */
import type {
  Clock,
} from '@ai-primitives-hub/core';

export class SystemClock implements Clock {
  public now(): number {
    return Date.now();
  }

  public nowIso(): string {
    return new Date().toISOString();
  }
}
