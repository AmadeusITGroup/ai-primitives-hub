/**
 * Leading + trailing edge throttle with a periodic max-wait flush.
 *
 * Runs the action immediately on the first trigger of a burst (leading edge),
 * then once more after `delayMs` of quiet following the last trigger (trailing
 * edge). Resetting the trailing timer on every trigger means the trailing edge
 * always fires after the last event settles — important when the action reads a
 * file that is still being written during the burst.
 *
 * A dense, sustained burst never lets the quiet window elapse, so leading +
 * trailing alone would collapse the whole burst into just two runs — the UI
 * appears frozen throughout. To avoid that, a periodic max-wait flush fires the
 * action every `maxWaitMs` for as long as the burst stays active, then stops
 * once the burst goes quiet (at the trailing edge).
 *
 * Used by the tree and marketplace views to rate-limit refreshes while a source
 * streams many partial sync events.
 */
export class LeadingTrailingThrottle {
  private timer?: NodeJS.Timeout;
  private maxWaitTimer?: NodeJS.Timeout;
  private readonly maxWaitMs: number;

  constructor(
    private readonly action: () => void,
    private readonly delayMs: number,
    maxWaitMs?: number
  ) {
    // Default the max-wait to twice the quiet window so a sustained burst still
    // refreshes periodically without callers needing to opt in.
    this.maxWaitMs = maxWaitMs ?? delayMs * 2;
  }

  private clearMaxWaitTimer(): void {
    if (this.maxWaitTimer) {
      clearInterval(this.maxWaitTimer);
      this.maxWaitTimer = undefined;
    }
  }

  /**
   * Signal an event. Fires the action on the leading edge of a burst, schedules
   * a single trailing-edge run after the burst goes quiet, and — while the burst
   * remains active — flushes the action periodically every `maxWaitMs`.
   */
  public trigger(): void {
    const isFirstEvent = !this.timer;

    if (this.timer) {
      clearTimeout(this.timer);
    }

    if (isFirstEvent) {
      this.action(); // leading edge
    }

    // Keep a periodic flush running for the duration of the burst so a dense
    // stream of triggers produces intermediate refreshes, not just leading +
    // trailing. Cleared at the trailing edge (below) once the burst goes quiet.
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setInterval(() => {
        this.action(); // periodic max-wait flush
      }, this.maxWaitMs);
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.clearMaxWaitTimer();
      this.action(); // trailing edge — fires after the last event settles
    }, this.delayMs);
  }

  /** Cancel any pending trailing-edge and periodic-flush runs. */
  public dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.clearMaxWaitTimer();
  }
}
