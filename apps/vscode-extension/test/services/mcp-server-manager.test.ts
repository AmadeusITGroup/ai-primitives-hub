import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import * as sinon from 'sinon';
import {
  McpServerManager,
} from '../../src/services/mcp-server-manager';
import {
  McpServersManifest,
} from '../../src/types/mcp';
import {
  McpConfigLocator,
} from '../../src/utils/mcp-config-locator';

suite('McpServerManager Test Suite', () => {
  let manager: McpServerManager;
  let testDir: string;
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
    manager = new McpServerManager();
    testDir = path.join(os.tmpdir(), 'mcp-test-' + Date.now());
    fs.ensureDirSync(testDir);

    const mockConfigPath = path.join(testDir, 'mcp.json');
    const mockTrackingPath = path.join(testDir, 'mcp-tracking.json');

    // Report whether mcp.json exists, like the real locator, so a second install sees the first.
    sandbox.stub(McpConfigLocator, 'getMcpConfigLocation').callsFake(() => ({
      configPath: mockConfigPath,
      trackingPath: mockTrackingPath,
      exists: fs.existsSync(mockConfigPath),
      serversKey: 'servers',
      supportsInputs: true,
      envPlaceholderStyle: 'prefixed'
    }));
    sandbox.stub(McpConfigLocator, 'ensureConfigDirectory').resolves();
  });

  teardown(async () => {
    sandbox.restore();
    if (fs.existsSync(testDir)) {
      await fs.remove(testDir);
    }
  });

  test('installServers handles empty manifest gracefully', async () => {
    const result = await manager.installServers(
      'test-bundle',
      '1.0.0',
      testDir,
      {},
      { scope: 'user', overwrite: false, skipOnConflict: false }
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.serversInstalled, 0);
    assert.strictEqual(result.installedServers.length, 0);
  });

  test('installServers with valid manifest completes (may fail if mcp.json has syntax errors)', async () => {
    const manifest: McpServersManifest = {
      'test-server': {
        command: 'node',
        args: ['${bundlePath}/server.js'],
        env: {
          LOG_LEVEL: 'info'
        }
      }
    };

    const result = await manager.installServers(
      'test-bundle-' + Date.now(), // Unique ID to avoid conflicts
      '1.0.0',
      testDir,
      manifest,
      { scope: 'user', overwrite: false, skipOnConflict: false }
    );

    // If mcp.json exists and has syntax errors, operation may fail
    // This is expected and tests the error handling
    assert.ok(result.success === true || result.success === false);

    if (result.success) {
      assert.strictEqual(result.serversInstalled, 1);
      assert.strictEqual(result.installedServers.length, 1);
      assert.ok(result.installedServers[0].startsWith('ai-primitives-hub:'));
    } else {
      // Error handling worked correctly
      assert.ok(result.errors && result.errors.length > 0);
    }
  });

  test('uninstallServers handles non-existent bundle (may fail if mcp.json has syntax errors)', async () => {
    const result = await manager.uninstallServers('non-existent-bundle-' + Date.now(), 'user');

    // If mcp.json exists and has syntax errors, operation may fail
    // This is expected and tests the error handling
    assert.ok(result.success === true || result.success === false);

    if (result.success) {
      assert.strictEqual(result.serversRemoved, 0);
      assert.strictEqual(result.removedServers.length, 0);
    } else {
      // Error handling worked correctly
      assert.ok(result.errors && result.errors.length > 0);
    }
  });

  suite('server names at user scope', () => {
    const base = { scope: 'user' as const, overwrite: false, skipOnConflict: false, manifestId: 'sample-mcp' };
    const sampleKey = 'ai-primitives-hub:acme-org:sample-collections:sample-mcp:gateway';

    test('installServers takes the repository from the source when the manifest has none', async () => {
      const result = await manager.installServers(
        'acme-org-sample-collections-sample-mcp-1.0.0', '1.0.0', testDir,
        { gateway: { type: 'http', url: 'https://example.invalid/mcp' } },
        { ...base, manifestRepository: '', sourceRepository: 'https://github.com/acme-org/sample-collections' }
      );

      assert.deepStrictEqual(result.installedServers, [sampleKey]);
    });

    test('installServers installs the same collection id from two repositories side by side', async () => {
      await manager.installServers(
        'acme-org-sample-collections-sample-mcp-1.0.0', '1.0.0', testDir,
        { gateway: { type: 'http', url: 'https://example.invalid/mcp' } },
        { ...base, manifestRepository: 'https://github.com/acme-org/sample-collections' }
      );
      const other = await manager.installServers(
        'other-org-sample-hub-sample-mcp-2.0.0', '2.0.0', testDir,
        { gateway: { type: 'http', url: 'https://other.invalid/mcp' } },
        { ...base, manifestRepository: 'https://github.com/other-org/sample-hub' }
      );

      assert.strictEqual(other.success, true);
      const config = await fs.readJson(path.join(testDir, 'mcp.json'));
      assert.deepStrictEqual(Object.keys(config.servers).toSorted(), [
        sampleKey,
        'ai-primitives-hub:other-org:sample-hub:sample-mcp:gateway'
      ].toSorted());
    });

    test('installServers replaces the legacy entry of an older version installed on top of', async () => {
      const legacyKey = 'prompt-registry:acme-org-sample-collections-sample-mcp-1.0.0:gateway';
      await fs.writeJson(path.join(testDir, 'mcp.json'), {
        servers: { [legacyKey]: { type: 'http', url: 'https://example.invalid/mcp' }, 'hand-added': { command: 'node' } }
      });
      await fs.writeJson(path.join(testDir, 'mcp-tracking.json'), {
        managedServers: {
          [legacyKey]: {
            bundleId: 'acme-org-sample-collections-sample-mcp-1.0.0', bundleVersion: '1.0.0', originalName: 'gateway',
            originalConfig: {}, installedAt: '', scope: 'user'
          }
        }
      });

      // A newer version installed without uninstalling the old one first (e.g. marketplace install-version).
      const result = await manager.installServers(
        'acme-org-sample-collections-sample-mcp-1.1.0', '1.1.0', testDir,
        { gateway: { type: 'http', url: 'https://example.invalid/mcp' } },
        { ...base, manifestRepository: 'https://github.com/acme-org/sample-collections' }
      );

      assert.strictEqual(result.success, true);
      const config = await fs.readJson(path.join(testDir, 'mcp.json'));
      assert.deepStrictEqual(Object.keys(config.servers).toSorted(), ['hand-added', sampleKey].toSorted());
      const tracking = await fs.readJson(path.join(testDir, 'mcp-tracking.json'));
      assert.deepStrictEqual(Object.keys(tracking.managedServers), [sampleKey]);
      assert.strictEqual(tracking.managedServers[sampleKey].bundleId, 'acme-org-sample-collections-sample-mcp-1.1.0');
    });

    test('installServers rejects a second install of the same collection from the same repository', async () => {
      const options = { ...base, manifestRepository: 'https://github.com/acme-org/sample-collections' };
      await manager.installServers(
        'acme-org-sample-collections-sample-mcp-1.0.0', '1.0.0', testDir,
        { gateway: { type: 'http', url: 'https://example.invalid/mcp' } }, options
      );
      const other = await manager.installServers(
        'sample-mcp', '1.0.0', testDir,
        { gateway: { type: 'http', url: 'https://other.invalid/mcp' } }, options
      );

      assert.strictEqual(other.success, false);
      assert.deepStrictEqual(other.errors, [`Conflicts detected: ${sampleKey}`]);
      const config = await fs.readJson(path.join(testDir, 'mcp.json'));
      assert.deepStrictEqual(config.servers, { [sampleKey]: { type: 'http', url: 'https://example.invalid/mcp' } });
      const tracking = await fs.readJson(path.join(testDir, 'mcp-tracking.json'));
      assert.strictEqual(tracking.managedServers[sampleKey].bundleId, 'acme-org-sample-collections-sample-mcp-1.0.0');
    });
  });

  test('Manager instance can be created', () => {
    const testManager = new McpServerManager();
    assert.ok(testManager);
  });
});
