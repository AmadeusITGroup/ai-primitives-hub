/**
 * LeadingTrailingThrottle Unit Tests
 *
 * Verifies leading-edge, trailing-edge, and periodic max-wait flush behavior
 * using sinon fake timers (the harness forbids Date.now(); drive time via clock.tick).
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import {
  LeadingTrailingThrottle,
} from '../../src/utils/leading-trailing-throttle';

suite('LeadingTrailingThrottle', () => {
  let sandbox: sinon.SinonSandbox;
  let clock: sinon.SinonFakeTimers;

  setup(() => {
    sandbox = sinon.createSandbox();
    clock = sandbox.useFakeTimers();
  });

  teardown(() => {
    sandbox.restore();
  });

  test('fires the action immediately on the leading edge', () => {
    let calls = 0;
    const throttle = new LeadingTrailingThrottle(() => calls++, 500, 1000);

    throttle.trigger();

    assert.strictEqual(calls, 1, 'leading-edge action should fire synchronously on first trigger');
  });

  test('fires a trailing-edge action after the burst goes quiet', () => {
    let calls = 0;
    const throttle = new LeadingTrailingThrottle(() => calls++, 500, 1000);

    throttle.trigger(); // leading edge (1)
    throttle.trigger();
    throttle.trigger();

    clock.tick(600); // past the 500ms quiet window

    assert.strictEqual(calls, 2, 'expected leading + trailing edge = 2 calls');
  });

  test('a sustained burst spanning > maxWaitMs produces >=3 action calls', () => {
    let calls = 0;
    const throttle = new LeadingTrailingThrottle(() => calls++, 500, 1000);

    // Fire an event every 100ms for 3000ms. The quiet window (500ms) never elapses
    // mid-burst, so WITHOUT a max-wait flush we would see only the leading edge.
    for (let elapsed = 0; elapsed < 3000; elapsed += 100) {
      throttle.trigger();
      clock.tick(100);
    }
    // Let the trailing edge settle.
    clock.tick(600);

    assert.ok(
      calls >= 3,
      `expected >=3 calls (leading + >=1 periodic flush + trailing), got ${calls}`
    );
  });

  test('dispose cancels pending trailing-edge and periodic flushes', () => {
    let calls = 0;
    const throttle = new LeadingTrailingThrottle(() => calls++, 500, 1000);

    throttle.trigger(); // leading edge (1)
    throttle.trigger();
    throttle.dispose();

    clock.tick(5000);

    assert.strictEqual(calls, 1, 'no further calls should fire after dispose');
  });
});
