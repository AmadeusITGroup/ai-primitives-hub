/**
 * Leading + trailing edge throttle.
 *
 * Runs the action immediately on the first trigger of a burst (leading edge),
 * then once more after `delayMs` of quiet following the last trigger (trailing
 * edge). Resetting the timer on every trigger means the trailing edge always
 * fires after the last event settles — important when the action reads a file
 * that is still being written during the burst.
 *
 * Used by the tree and marketplace views to rate-limit refreshes while a source
 * streams many partial sync events.
 */
export class LeadingTrailingThrottle {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly action: () => void,
    private readonly delayMs: number
  ) {}

  /**
   * Signal an event. Fires the action on the leading edge of a burst and
   * schedules a single trailing-edge run after the burst goes quiet.
   */
  public trigger(): void {
    const isFirstEvent = !this.timer;

    if (this.timer) {
      clearTimeout(this.timer);
    }

    if (isFirstEvent) {
      this.action(); // leading edge
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.action(); // trailing edge — fires after the last event settles
    }, this.delayMs);
  }

  /** Cancel any pending trailing-edge run. */
  public dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
