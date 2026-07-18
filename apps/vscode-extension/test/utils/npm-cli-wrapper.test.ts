import * as assert from 'node:assert';
import * as sinon from 'sinon';
import {
  NpmCliWrapper,
} from '../../src/utils/npm-cli-wrapper';
import {
  createErrorProcess,
  createFailureProcess,
  createSuccessProcess,
} from '../helpers/process-test-helpers';

suite('NpmCliWrapper', () => {
  let sandbox: sinon.SinonSandbox;
  let npmWrapper: NpmCliWrapper;
  // Use require to get a stubbable reference to child_process

  const childProcess = require('node:child_process');

  setup(() => {
    sandbox = sinon.createSandbox();
    npmWrapper = NpmCliWrapper.getInstance();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('getInstance()', () => {
    test('should return singleton instance', () => {
      const instance1 = NpmCliWrapper.getInstance();
      const instance2 = NpmCliWrapper.getInstance();
      assert.strictEqual(instance1, instance2);
    });
  });

  suite('isAvailable()', () => {
    test('should return true when npm is available', async () => {
      const { process, emitEvents } = createSuccessProcess();
      sandbox.stub(childProcess, 'spawn').returns(process);

      const resultPromise = npmWrapper.isAvailable();
      emitEvents();

      const result = await resultPromise;
      assert.strictEqual(result, true);
    });

    test('should return false when npm is not available', async () => {
      const { process, emitEvents } = createFailureProcess(1);
      sandbox.stub(childProcess, 'spawn').returns(process);

      const resultPromise = npmWrapper.isAvailable();
      emitEvents();

      const result = await resultPromise;
      assert.strictEqual(result, false);
    });

    test('should return false when spawn errors', async () => {
      const { process, emitEvents } = createErrorProcess(new Error('ENOENT'));
      sandbox.stub(childProcess, 'spawn').returns(process);

      const resultPromise = npmWrapper.isAvailable();
      emitEvents();

      const result = await resultPromise;
      assert.strictEqual(result, false);
    });
  });

  suite('spawn shell option', () => {
    test('should pass shell option to spawn', async () => {
      const spawnStub = sandbox.stub(childProcess, 'spawn');
      const { process, emitEvents } = createSuccessProcess();
      spawnStub.returns(process);

      const resultPromise = npmWrapper.isAvailable();
      emitEvents();
      await resultPromise;

      assert.ok(spawnStub.calledOnce);
      const spawnOptions = spawnStub.firstCall.args[2];
      // Verify shell option is set (value depends on platform)
      assert.ok('shell' in spawnOptions);
    });
  });
});
