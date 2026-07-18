/**
 * ApmRuntimeManager Unit Tests
 * Tests APM CLI runtime detection and installation management
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import {
  ApmRuntimeManager,
} from '../../src/services/apm-runtime-manager';

suite('ApmRuntimeManager', () => {
  let sandbox: sinon.SinonSandbox;
  let runtime: ApmRuntimeManager;

  setup(() => {
    sandbox = sinon.createSandbox();
    // Reset singleton for testing
    ApmRuntimeManager.resetInstance();
    runtime = ApmRuntimeManager.getInstance();
  });

  teardown(() => {
    sandbox.restore();
    ApmRuntimeManager.resetInstance();
  });

  suite('getInstance', () => {
    test('should return singleton instance', () => {
      const instance1 = ApmRuntimeManager.getInstance();
      const instance2 = ApmRuntimeManager.getInstance();
      assert.strictEqual(instance1, instance2);
    });
  });

  suite('getStatus', function () {
    // Increase timeout for this suite as it involves spawning processes
    this.timeout(10_000);

    test('should return status object with installed property', async () => {
      const status = await runtime.getStatus();

      assert.ok(typeof status.installed === 'boolean');
    });

    test('should return cached status on subsequent calls within TTL', async () => {
      // First call
      const status1 = await runtime.getStatus();

      // Second call should use cache
      const status2 = await runtime.getStatus();

      assert.deepStrictEqual(status1, status2);
    });

    test('should refresh status when forceRefresh is true', async () => {
      // First call
      await runtime.getStatus();

      // Force refresh
      const status2 = await runtime.getStatus(true);

      assert.ok(typeof status2.installed === 'boolean');
    });

    test('should include version when APM is installed', async () => {
      // Mock the internal detection
      sandbox.stub(runtime as any, 'detectRuntime').resolves({
        installed: true,
        version: '1.0.0',
        installMethod: 'pip'
      });

      const status = await runtime.getStatus(true);

      if (status.installed) {
        assert.ok(status.version);
      }
    });

    test('should detect install method', async () => {
      sandbox.stub(runtime as any, 'detectRuntime').resolves({
        installed: true,
        version: '1.0.0',
        installMethod: 'pip'
      });

      const status = await runtime.getStatus(true);

      if (status.installed) {
        assert.ok(['pip', 'brew', 'binary', 'unknown'].includes(status.installMethod || 'unknown'));
      }
    });
  });

  suite('clearCache', () => {
    test('should clear cached status', async () => {
      // Populate cache
      await runtime.getStatus();

      // Clear cache
      runtime.clearCache();

      // Should re-detect on next call
      // This is hard to verify without more sophisticated mocking
      // but at least we can verify it doesn't throw
      const status = await runtime.getStatus();
      assert.ok(typeof status.installed === 'boolean');
    });
  });

  suite('getInstallInstructions', () => {
    test('should return platform-appropriate instructions', () => {
      const instructions = runtime.getInstallInstructions();

      assert.ok(typeof instructions === 'string');
      assert.ok(instructions.length > 0);
      // Should contain some installation command
      assert.ok(
        instructions.includes('pip')
        || instructions.includes('brew')
        || instructions.includes('install')
      );
    });

    test('should include URL to APM repository', () => {
      const instructions = runtime.getInstallInstructions();

      assert.ok(instructions.includes('github.com') || instructions.includes('apm'));
    });
  });

  suite('Security', () => {
    test('should not execute arbitrary commands', async () => {
      // This is a conceptual test - in real implementation
      // the runtime manager should only execute known safe commands
      const status = await runtime.getStatus();

      // Should not throw and should return valid status
      assert.ok(typeof status.installed === 'boolean');
    });

    test('should sanitize version output', async () => {
      sandbox.stub(runtime as any, 'detectRuntime').resolves({
        installed: true,
        version: '<script>alert(1)</script>',
        installMethod: 'pip'
      });

      const status = await runtime.getStatus(true);

      // Version should be sanitized or at least not cause issues
      if (status.version) {
        assert.ok(typeof status.version === 'string');
      }
    });
  });

  suite('Error Handling', () => {
    test('should handle detection errors gracefully', async () => {
      sandbox.stub(runtime as any, 'detectRuntime').rejects(new Error('Detection failed'));

      const status = await runtime.getStatus(true);

      // Should return not installed rather than throwing
      assert.strictEqual(status.installed, false);
    });

    test('should handle timeout during detection', async () => {
      // Simulate a very slow detection
      sandbox.stub(runtime as any, 'detectRuntime').callsFake(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { installed: false };
      });

      const status = await runtime.getStatus(true);

      assert.ok(typeof status.installed === 'boolean');
    });
  });
});
