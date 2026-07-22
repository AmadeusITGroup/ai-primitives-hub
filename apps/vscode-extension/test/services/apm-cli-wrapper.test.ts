/**
 * ApmCliWrapper Unit Tests
 * Tests APM CLI command execution wrapper
 */

import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import {
  ApmCliWrapper,
} from '../../src/services/apm-cli-wrapper';
import {
  ApmRuntimeManager,
} from '../../src/services/apm-runtime-manager';
import {
  createTempTestPath,
} from '../helpers/bundle-test-helpers';

suite('ApmCliWrapper', () => {
  let sandbox: sinon.SinonSandbox;
  let wrapper: ApmCliWrapper;
  let mockRuntime: sinon.SinonStubbedInstance<ApmRuntimeManager>;

  setup(() => {
    sandbox = sinon.createSandbox();

    // Mock runtime manager
    ApmRuntimeManager.resetInstance();
    mockRuntime = sandbox.createStubInstance(ApmRuntimeManager);
    mockRuntime.getStatus.resolves({ installed: true, version: '1.0.0' });

    // Replace getInstance to return mock
    sandbox.stub(ApmRuntimeManager, 'getInstance').returns(mockRuntime);

    wrapper = new ApmCliWrapper();
  });

  teardown(() => {
    sandbox.restore();
    ApmRuntimeManager.resetInstance();
  });

  suite('Constructor', () => {
    test('should create instance', () => {
      assert.ok(wrapper);
    });
  });

  suite('isRuntimeAvailable', () => {
    test('should return true when APM is installed', async () => {
      mockRuntime.getStatus.resolves({ installed: true, uvxAvailable: false });

      const available = await wrapper.isRuntimeAvailable();

      assert.strictEqual(available, true);
    });

    test('should return true when uvx is available even if APM is not installed', async () => {
      mockRuntime.getStatus.resolves({ installed: false, uvxAvailable: true });

      const available = await wrapper.isRuntimeAvailable();

      assert.strictEqual(available, true);
    });

    test('should return false when neither is available', async () => {
      mockRuntime.getStatus.resolves({ installed: false, uvxAvailable: false });

      const available = await wrapper.isRuntimeAvailable();

      assert.strictEqual(available, false);
    });
  });

  suite('validatePackageRef', () => {
    test('should accept valid owner/repo format', () => {
      assert.ok(wrapper.validatePackageRef('owner/repo'));
    });

    test('should accept owner/repo/path format', () => {
      assert.ok(wrapper.validatePackageRef('owner/repo/some/path'));
    });

    test('should reject empty string', () => {
      assert.strictEqual(wrapper.validatePackageRef(''), false);
    });

    test('should reject strings with spaces', () => {
      assert.strictEqual(wrapper.validatePackageRef('owner /repo'), false);
    });

    test('should reject strings without slash', () => {
      assert.strictEqual(wrapper.validatePackageRef('ownerrepo'), false);
    });

    test('should reject strings starting with slash', () => {
      assert.strictEqual(wrapper.validatePackageRef('/owner/repo'), false);
    });

    test('should reject strings ending with slash', () => {
      assert.strictEqual(wrapper.validatePackageRef('owner/repo/'), false);
    });

    test('should reject strings with special characters', () => {
      assert.strictEqual(wrapper.validatePackageRef('owner/repo;rm -rf'), false);
    });

    test('should reject strings with shell metacharacters', () => {
      assert.strictEqual(wrapper.validatePackageRef('owner/repo$(whoami)'), false);
    });
  });

  suite('install', () => {
    test('should return error when runtime not available', async () => {
      mockRuntime.getStatus.resolves({ installed: false, uvxAvailable: false });

      const result = await wrapper.install('owner/repo', createTempTestPath('target'));

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('not installed'));
    });

    test('should reject invalid package reference', async () => {
      const result = await wrapper.install('invalid', createTempTestPath('target'));

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('Invalid package reference'));
    });

    test('should reject path traversal in target directory', async () => {
      const targetPath = `${os.tmpdir()}${path.sep}..${path.sep}etc${path.sep}target`;
      const result = await wrapper.install('owner/repo', targetPath);

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('Invalid') || result.error?.includes('path'));
    });
  });

  suite('Security', () => {
    test('should sanitize package references', () => {
      // Should reject anything with shell metacharacters
      const dangerous = [
        'owner/repo; rm -rf /',
        'owner/repo | cat /etc/passwd',
        'owner/repo && whoami',
        'owner/repo`id`',
        '$(cat /etc/passwd)',
        'owner/repo\nmalicious'
      ];

      for (const ref of dangerous) {
        assert.strictEqual(
          wrapper.validatePackageRef(ref),
          false,
          `Should reject: ${ref}`
        );
      }
    });

    test('should not allow absolute paths as package refs', () => {
      assert.strictEqual(wrapper.validatePackageRef('/etc/passwd'), false);
      assert.strictEqual(wrapper.validatePackageRef('C:\\Windows\\System32'), false);
    });

    test('should not allow URLs as package refs', () => {
      assert.strictEqual(wrapper.validatePackageRef('http://evil.com/malware'), false);
      assert.strictEqual(wrapper.validatePackageRef('https://evil.com/malware'), false);
    });
  });

  suite('Error Handling', () => {
    test('should handle runtime errors gracefully', async () => {
      mockRuntime.getStatus.rejects(new Error('Runtime error'));

      const result = await wrapper.install('owner/repo', createTempTestPath('target'));

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });

    test('should provide meaningful error messages', async () => {
      mockRuntime.getStatus.resolves({ installed: false, uvxAvailable: false });

      const result = await wrapper.install('owner/repo', createTempTestPath('target'));

      assert.ok(result.error);
      assert.ok(result.error.length > 10); // Not just "error"
    });
  });
});
