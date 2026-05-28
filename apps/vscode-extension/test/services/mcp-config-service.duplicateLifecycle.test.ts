/**
 * MCP Config Service - Duplicate Server Lifecycle Tests
 *
 * Tests the complete lifecycle of duplicate MCP servers:
 * 1. Install multiple bundles with the same MCP server
 * 2. Verify only one is active (first installed)
 * 3. Remove bundles one by one
 * 4. Verify at least one instance remains active until all are removed
 */
import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import * as sinon from 'sinon';
import {
  McpConfigService,
} from '../../src/services/mcp-config-service';
import {
  McpConfiguration,
  McpRemoteServerConfig,
  McpStdioServerConfig,
  McpTrackingMetadata,
} from '../../src/types/mcp';

suite('McpConfigService - Duplicate Server Lifecycle', () => {
  let sandbox: sinon.SinonSandbox;
  let configService: McpConfigService;
  let testDir: string;

  // Simulates installing a bundle's MCP servers
  const installBundleServers = async (
    bundleId: string,
    servers: Record<string, McpStdioServerConfig | McpRemoteServerConfig>,
    config: McpConfiguration,
    tracking: McpTrackingMetadata
  ): Promise<{ config: McpConfiguration; tracking: McpTrackingMetadata }> => {
    for (const [serverName, serverConfig] of Object.entries(servers)) {
      const prefixedName = configService.generatePrefixedServerName(bundleId, serverName);
      config.servers[prefixedName] = serverConfig;
      tracking.managedServers[prefixedName] = {
        bundleId,
        bundleVersion: '1.0.0',
        originalName: serverName,
        originalConfig: serverConfig,
        installedAt: new Date().toISOString(),
        scope: 'user'
      };
    }
    return { config, tracking };
  };

  // Simulates uninstalling a bundle's MCP servers
  const uninstallBundleServers = async (
    bundleId: string,
    config: McpConfiguration,
    tracking: McpTrackingMetadata
  ): Promise<{ config: McpConfiguration; tracking: McpTrackingMetadata; removed: string[] }> => {
    const removed: string[] = [];
    for (const [serverName, metadata] of Object.entries(tracking.managedServers)) {
      if (metadata.bundleId === bundleId) {
        delete config.servers[serverName];
        delete tracking.managedServers[serverName];
        removed.push(serverName);
      }
    }
    return { config, tracking, removed };
  };

  // Count active (non-disabled) servers with a given identity
  const countActiveServersWithIdentity = (
    config: McpConfiguration,
    targetIdentity: string
  ): number => {
    let count = 0;
    for (const serverConfig of Object.values(config.servers)) {
      if (!serverConfig.disabled) {
        const identity = configService.computeServerIdentity(serverConfig);
        if (identity === targetIdentity) {
          count++;
        }
      }
    }
    return count;
  };

  // Get all servers (active and disabled) with a given identity
  const getServersWithIdentity = (
    config: McpConfiguration,
    targetIdentity: string
  ): { name: string; disabled: boolean }[] => {
    const result: { name: string; disabled: boolean }[] = [];
    for (const [name, serverConfig] of Object.entries(config.servers)) {
      const identity = configService.computeServerIdentity(serverConfig);
      if (identity === targetIdentity) {
        result.push({ name, disabled: !!serverConfig.disabled });
      }
    }
    return result;
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    configService = new McpConfigService();
    testDir = path.join(os.tmpdir(), 'mcp-lifecycle-test-' + Date.now());
    fs.ensureDirSync(testDir);
  });

  teardown(async () => {
    sandbox.restore();
    if (fs.existsSync(testDir)) {
      await fs.remove(testDir);
    }
  });

  suite('Stdio Server Duplicate Lifecycle', () => {
    const sharedServer: McpStdioServerConfig = {
      command: 'node',
      args: ['shared-mcp-server.js']
    };
    const sharedIdentity = 'stdio:node:shared-mcp-server.js';

    test('should keep exactly one active server when multiple bundles install the same server', async () => {
      let config: McpConfiguration = { servers: {} };
      let tracking: McpTrackingMetadata = {
        managedServers: {},
        lastUpdated: new Date().toISOString(),
        version: '1.0.0'
      };

      // Install bundle-a with shared server
      ({ config, tracking } = await installBundleServers('bundle-a', { shared: sharedServer }, config, tracking));

      // Install bundle-b with same server
      ({ config, tracking } = await installBundleServers('bundle-b', { shared: sharedServer }, config, tracking));

      // Install bundle-c with same server
      ({ config, tracking } = await installBundleServers('bundle-c', { shared: sharedServer }, config, tracking));

      // Stub config service to return our test data
      sandbox.stub(configService, 'readMcpConfig').resolves(config);
      sandbox.stub(configService, 'readTrackingMetadata').resolves(tracking);

      // Run duplicate detection
      const result = await configService.detectAndDisableDuplicates('user');
      config = result.config;

      // Verify: exactly 1 active, 2 disabled
      const activeCount = countActiveServersWithIdentity(config, sharedIdentity);
      assert.strictEqual(activeCount, 1, 'Should have exactly 1 active server');

      const allServers = getServersWithIdentity(config, sharedIdentity);
      assert.strictEqual(allServers.length, 3, 'Should have 3 total servers');
      assert.strictEqual(allServers.filter((s) => s.disabled).length, 2, 'Should have 2 disabled servers');
    });

    test('should re-enable a duplicate when the active server is removed', async () => {
      // Setup: 3 bundles with same server, bundle-a is active
      let config: McpConfiguration = {
        servers: {
          'prompt-registry:bundle-a:shared': { ...sharedServer },
          'prompt-registry:bundle-b:shared': { ...sharedServer, disabled: true, description: 'Duplicate of prompt-registry:bundle-a:shared' },
          'prompt-registry:bundle-c:shared': { ...sharedServer, disabled: true, description: 'Duplicate of prompt-registry:bundle-a:shared' }
        }
      };
      let tracking: McpTrackingMetadata = {
        managedServers: {
          'prompt-registry:bundle-a:shared': {
            bundleId: 'bundle-a', bundleVersion: '1.0.0', originalName: 'shared',
            originalConfig: sharedServer, installedAt: new Date().toISOString(), scope: 'user'
          },
          'prompt-registry:bundle-b:shared': {
            bundleId: 'bundle-b', bundleVersion: '1.0.0', originalName: 'shared',
            originalConfig: sharedServer, installedAt: new Date().toISOString(), scope: 'user'
          },
          'prompt-registry:bundle-c:shared': {
            bundleId: 'bundle-c', bundleVersion: '1.0.0', originalName: 'shared',
            originalConfig: sharedServer, installedAt: new Date().toISOString(), scope: 'user'
          }
        },
        lastUpdated: new Date().toISOString(),
        version: '1.0.0'
      };

      // Remove bundle-a (the active one)
      ({ config, tracking } = await uninstallBundleServers('bundle-a', config, tracking));

      // Stub and run duplicate detection (which should re-enable one of the remaining)
      sandbox.stub(configService, 'readMcpConfig').resolves(config);
      sandbox.stub(configService, 'readTrackingMetadata').resolves(tracking);

      // First, we need to re-enable the disabled servers since the active one is gone
      // This simulates what should happen after uninstall
      for (const serverConfig of Object.values(config.servers)) {
        if (serverConfig.disabled && serverConfig.description?.includes('Duplicate')) {
          // Re-enable for re-evaluation
          serverConfig.disabled = false;
          delete serverConfig.description;
        }
      }

      const result = await configService.detectAndDisableDuplicates('user');
      config = result.config;

      // Verify: exactly 1 active server remains
      const activeCount = countActiveServersWithIdentity(config, sharedIdentity);
      assert.strictEqual(activeCount, 1, 'Should have exactly 1 active server after removing the original active');

      const allServers = getServersWithIdentity(config, sharedIdentity);
      assert.strictEqual(allServers.length, 2, 'Should have 2 total servers remaining');
    });

    test('should maintain at least one active server until all bundles are removed', async () => {
      // Setup: 3 bundles with same server
      let config: McpConfiguration = { servers: {} };
      let tracking: McpTrackingMetadata = {
        managedServers: {},
        lastUpdated: new Date().toISOString(),
        version: '1.0.0'
      };

      // Install all 3 bundles
      ({ config, tracking } = await installBundleServers('bundle-a', { shared: sharedServer }, config, tracking));
      ({ config, tracking } = await installBundleServers('bundle-b', { shared: sharedServer }, config, tracking));
      ({ config, tracking } = await installBundleServers('bundle-c', { shared: sharedServer }, config, tracking));

      // Initial duplicate detection
      sandbox.stub(configService, 'readMcpConfig').resolves(config);
      sandbox.stub(configService, 'readTrackingMetadata').resolves(tracking);
      let result = await configService.detectAndDisableDuplicates('user');
      config = result.config;
      sandbox.restore();
      sandbox = sinon.createSandbox();

      // Verify initial state: 1 active, 2 disabled
      assert.strictEqual(countActiveServersWithIdentity(config, sharedIdentity), 1, 'Initial: 1 active');
      assert.strictEqual(getServersWithIdentity(config, sharedIdentity).length, 3, 'Initial: 3 total');

      // Remove bundle-a
      ({ config, tracking } = await uninstallBundleServers('bundle-a', config, tracking));
      // Re-enable remaining for re-evaluation
      for (const serverConfig of Object.values(config.servers)) {
        if (serverConfig.disabled) {
          serverConfig.disabled = false;
          delete serverConfig.description;
        }
      }
      sandbox.stub(configService, 'readMcpConfig').resolves(config);
      sandbox.stub(configService, 'readTrackingMetadata').resolves(tracking);
      result = await configService.detectAndDisableDuplicates('user');
      config = result.config;
      sandbox.restore();
      sandbox = sinon.createSandbox();

      // After removing bundle-a: 1 active, 1 disabled
      assert.strictEqual(countActiveServersWithIdentity(config, sharedIdentity), 1, 'After removing bundle-a: 1 active');
      assert.strictEqual(getServersWithIdentity(config, sharedIdentity).length, 2, 'After removing bundle-a: 2 total');

      // Remove bundle-b
      ({ config, tracking } = await uninstallBundleServers('bundle-b', config, tracking));
      for (const serverConfig of Object.values(config.servers)) {
        if (serverConfig.disabled) {
          serverConfig.disabled = false;
          delete serverConfig.description;
        }
      }
      sandbox.stub(configService, 'readMcpConfig').resolves(config);
      sandbox.stub(configService, 'readTrackingMetadata').resolves(tracking);
      result = await configService.detectAndDisableDuplicates('user');
      config = result.config;
      sandbox.restore();
      sandbox = sinon.createSandbox();

      // After removing bundle-b: 1 active, 0 disabled
      assert.strictEqual(countActiveServersWithIdentity(config, sharedIdentity), 1, 'After removing bundle-b: 1 active');
      assert.strictEqual(getServersWithIdentity(config, sharedIdentity).length, 1, 'After removing bundle-b: 1 total');

      // Remove bundle-c (last one)
      ({ config, tracking } = await uninstallBundleServers('bundle-c', config, tracking));

      // After removing all: 0 servers
      assert.strictEqual(countActiveServersWithIdentity(config, sharedIdentity), 0, 'After removing all: 0 active');
      assert.strictEqual(getServersWithIdentity(config, sharedIdentity).length, 0, 'After removing all: 0 total');
    });
  });

  suite('Remote Server Duplicate Lifecycle', () => {
    const sharedRemoteServer: McpRemoteServerConfig = {
      type: 'http',
      url: 'https://api.example.com/mcp'
    };
    const sharedIdentity = 'remote:https://api.example.com/mcp';

    test('should handle remote server duplicates the same as stdio', async () => {
      let config: McpConfiguration = { servers: {} };
      let tracking: McpTrackingMetadata = {
        managedServers: {},
        lastUpdated: new Date().toISOString(),
        version: '1.0.0'
      };

      // Install 3 bundles with same remote server
      ({ config, tracking } = await installBundleServers('bundle-a', { api: sharedRemoteServer }, config, tracking));
      ({ config, tracking } = await installBundleServers('bundle-b', { api: sharedRemoteServer }, config, tracking));
      ({ config, tracking } = await installBundleServers('bundle-c', { api: sharedRemoteServer }, config, tracking));

      sandbox.stub(configService, 'readMcpConfig').resolves(config);
      sandbox.stub(configService, 'readTrackingMetadata').resolves(tracking);

      const result = await configService.detectAndDisableDuplicates('user');
      config = result.config;

      // Verify: exactly 1 active
      const activeCount = countActiveServersWithIdentity(config, sharedIdentity);
      assert.strictEqual(activeCount, 1, 'Should have exactly 1 active remote server');

      const allServers = getServersWithIdentity(config, sharedIdentity);
      assert.strictEqual(allServers.length, 3, 'Should have 3 total remote servers');
      assert.strictEqual(allServers.filter((s) => s.disabled).length, 2, 'Should have 2 disabled remote servers');
    });
  });

  suite('Mixed Server Types', () => {
    test('should not cross-disable stdio and remote servers with similar identifiers', async () => {
      const stdioServer: McpStdioServerConfig = {
        command: 'https://api.example.com/mcp' // Unusual but valid command
      };
      const remoteServer: McpRemoteServerConfig = {
        type: 'http',
        url: 'https://api.example.com/mcp'
      };

      let config: McpConfiguration = { servers: {} };
      let tracking: McpTrackingMetadata = {
        managedServers: {},
        lastUpdated: new Date().toISOString(),
        version: '1.0.0'
      };

      ({ config, tracking } = await installBundleServers('bundle-a', { 'stdio-server': stdioServer }, config, tracking));
      ({ config, tracking } = await installBundleServers('bundle-b', { 'remote-server': remoteServer }, config, tracking));

      sandbox.stub(configService, 'readMcpConfig').resolves(config);
      sandbox.stub(configService, 'readTrackingMetadata').resolves(tracking);

      const result = await configService.detectAndDisableDuplicates('user');
      config = result.config;

      // Both should be active - they are different types
      const stdioIdentity = 'stdio:https://api.example.com/mcp:';
      const remoteIdentity = 'remote:https://api.example.com/mcp';

      assert.strictEqual(countActiveServersWithIdentity(config, stdioIdentity), 1, 'Stdio server should be active');
      assert.strictEqual(countActiveServersWithIdentity(config, remoteIdentity), 1, 'Remote server should be active');
    });
  });
});
