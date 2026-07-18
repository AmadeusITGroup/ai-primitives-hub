import * as assert from 'node:assert';
import * as sinon from 'sinon';
import {
  OutputChannelTransport,
} from '../../src/services/output-channel-transport';
import {
  Logger,
} from '../../src/utils/logger';

suite('OutputChannelTransport', () => {
  let sandbox: sinon.SinonSandbox;
  let transport: OutputChannelTransport;
  let loggerStub: sinon.SinonStubbedInstance<Logger>;

  setup(() => {
    sandbox = sinon.createSandbox();

    const loggerInstance = Logger.getInstance();
    loggerStub = sandbox.stub(loggerInstance);
    loggerStub.info.returns();
    loggerStub.error.returns();

    transport = new OutputChannelTransport();
  });

  teardown(() => {
    transport.dispose();
    sandbox.restore();
  });

  test('should log usage events via Logger.info', () => {
    transport.send({
      timestamp: '2026-01-01T00:00:00Z',
      eventName: 'bundle.installed',
      data: { bundleId: 'test-bundle' }
    });

    assert.strictEqual(loggerStub.info.callCount, 1);
    const message = loggerStub.info.firstCall.args[0];
    assert.ok(message.includes('bundle.installed'));
    assert.ok(message.includes('test-bundle'));
  });

  test('should log error events via Logger.error', () => {
    transport.send({
      timestamp: '2026-01-01T00:00:00Z',
      error: { message: 'something broke', stack: 'stack trace' },
      data: { context: 'test' }
    });

    assert.strictEqual(loggerStub.error.callCount, 1);
    const message = loggerStub.error.firstCall.args[0];
    assert.ok(message.includes('something broke'));
  });

  test('should handle events with no data', () => {
    transport.send({
      timestamp: '2026-01-01T00:00:00Z',
      eventName: 'telemetryService.started'
    });

    assert.strictEqual(loggerStub.info.callCount, 1);
  });

  test('should handle events with no eventName', () => {
    transport.send({
      timestamp: '2026-01-01T00:00:00Z'
    });

    assert.strictEqual(loggerStub.info.callCount, 1);
    const message = loggerStub.info.firstCall.args[0];
    assert.ok(message.includes('unknown'));
  });
});
