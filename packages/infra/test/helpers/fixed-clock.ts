/**
 * Controllable `Clock` test double — starts at a fixed epoch and only
 * moves forward when `advance()` is called explicitly.
 */
import type {
  Clock,
} from '@ai-primitives-hub/core';

export class FixedClock implements Clock {
  public constructor(private epochMs: number) {}

  public now(): number {
    return this.epochMs;
  }

  public nowIso(): string {
    return new Date(this.epochMs).toISOString();
  }

  public advance(ms: number): void {
    this.epochMs += ms;
  }
}
