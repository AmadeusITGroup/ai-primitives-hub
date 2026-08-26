import * as assert from 'node:assert';
import * as sinon from 'sinon';
import {
  TrailingThrottle,
} from '../../src/utils/leading-trailing-throttle';

suite('SourceSyncBatchThrottle', () => {
  let sandbox: sinon.SinonSandbox;
  let clock: sinon.SinonFakeTimers;

  setup(() => {
    sandbox = sinon.createSandbox();
    clock = sandbox.useFakeTimers();
  });

  teardown(() => {
    sandbox.restore();
  });

  test('refreshes once after a sustained source-sync batch settles', () => {
    const refresh = sandbox.spy();
    const throttle = new TrailingThrottle(refresh, 5_000);

    for (let source = 0; source < 59; source++) {
      throttle.trigger();
      clock.tick(1_000);
    }

    assert.strictEqual(refresh.callCount, 0, 'the in-progress batch must not refresh the views');

    clock.tick(4_000);
    assert.strictEqual(refresh.callCount, 1, 'the settled batch must refresh the views once');
  });
});