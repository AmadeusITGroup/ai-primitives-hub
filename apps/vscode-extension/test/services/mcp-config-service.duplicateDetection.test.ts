/**
 * MCP Config Service - Duplicate Detection Tests
 *
 * TDD tests for detecting and disabling duplicate MCP servers across bundles.
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

suite('McpConfigService - Duplicate Detection', () => {
  let sandbox: sinon.SinonSandbox;
  let configService: McpConfigService;
  let testDir: string;
  let mockConfigPath: string;
  let mockTrackingPath: string;

  // Helper to create test config files
  const writeTestConfig = async (config: McpConfiguration): Promise<void> => {
    await fs.writeFile(mockConfigPath, JSON.stringify(config, null, 2));
  };

  const writeTestTracking = async (tracking: McpTrackingMetadata): Promise<void> => {
    await fs.writeFile(mockTrackingPath, JSON.stringify(tracking, null, 2));
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    configService = new McpConfigService();
    testDir = path.join(os.tmpdir(), 'mcp-duplicate-test-' + Date.now());
    fs.ensureDirSync(testDir);
    mockConfigPath = path.join(testDir, 'mcp.json');
    mockTrackingPath = path.join(testDir, 'mcp-tracking.json');
  });

  teardown(async () => {
    sandbox.restore();
    if (fs.existsSync(testDir)) {
      await fs.remove(testDir);
    }
  });

  suite('computeServerIdentity()', () => {
    test('should compute identity for stdio server with command and args', () => {
      const config: McpStdioServerConfig = {
        command: 'node',
        args: ['server.js', '--port', '3000']
      };

      const identity = configService.computeServerIdentity(config);

      assert.strictEqual(identity, 'stdio:node:server.js|--port|3000');
    });

    test('should compute identity for stdio server without args', () => {
      const config: McpStdioServerConfig = {
        command: 'my-mcp-server'
      };

      const identity = configService.computeServerIdentity(config);

      assert.strictEqual(identity, 'stdio:my-mcp-server:');
    });

    test('should compute identity for HTTP remote server', () => {
      const config: McpRemoteServerConfig = {
        type: 'http',
        url: 'https://api.example.com/mcp'
      };

      const identity = configService.computeServerIdentity(config);

      assert.strictEqual(identity, 'remote:https://api.example.com/mcp');
    });

    test('should compute identity for SSE remote server', () => {
      const config: McpRemoteServerConfig = {
        type: 'sse',
        url: 'https://api.example.com/mcp/events'
      };

      const identity = configService.computeServerIdentity(config);

      assert.strictEqual(identity, 'remote:https://api.example.com/mcp/events');
    });

    test('should not consider headers in remote server identity', () => {
      const config1: McpRemoteServerConfig = {
        type: 'http',
        url: 'https://api.example.com/mcp',
        headers: { Authorization: 'Bearer token1' }
      };

      const config2: McpRemoteServerConfig = {
        type: 'http',
        url: 'https://api.example.com/mcp',
        headers: { Authorization: 'Bearer token2' }
      };

      const identity1 = configService.computeServerIdentity(config1);
      const identity2 = configService.computeServerIdentity(config2);

      assert.strictEqual(identity1, identity2, 'Same URL should have same identity regardless of headers');
    });

    test('should not consider env in stdio server identity', () => {
      const config1: McpStdioServerConfig = {
        command: 'node',
        args: ['server.js'],
        env: { LOG_LEVEL: 'debug' }
      };

      const config2: McpStdioServerConfig = {
        command: 'node',
        args: ['server.js'],
        env: { LOG_LEVEL: 'info' }
      };

      const identity1 = configService.computeServerIdentity(config1);
      const identity2 = configService.computeServerIdentity(config2);

      assert.strictEqual(identity1, identity2, 'Same command+args should have same identity regardless of env');
    });

    test('should differentiate stdio and remote servers with similar names', () => {
      const stdioConfig: McpStdioServerConfig = {
        command: 'https://api.example.com/mcp' // Unusual but valid command
      };

      const remoteConfig: McpRemoteServerConfig = {
        type: 'http',
        url: 'https://api.example.com/mcp'
      };

      const stdioIdentity = configService.computeServerIdentity(stdioConfig);
      const remoteIdentity = configService.computeServerIdentity(remoteConfig);

      assert.notStrictEqual(stdioIdentity, remoteIdentity, 'Stdio and remote should have different identities');
      assert.ok(stdioIdentity.startsWith('stdio:'));
      assert.ok(remoteIdentity.startsWith('remote:'));
    });
  });

  suite('detectAndDisableDuplicates()', () => {
    test('should detect duplicate stdio servers with same command and args', async () => {
      // Setup: Two servers from different bundles with same command+args
      const config: McpConfiguration = {
        servers: {
          'prompt-registry:bundle-a:server1': {
            command: 'node',
            args: ['mcp-server.js']
          },
          'prompt-registry:bundle-b:server1': {
            command: 'node',
            args: ['mcp-server.js']
          }
        }
      };

      const tracking: McpTrackingMetadata = {
        managedServers: {
          'prompt-registry:bundle-a:server1': {
            bundleId: 'bundle-a',
            bundleVersion: '1.0.0',
            originalName: 'server1',
            originalConfig: { command: 'node', args: ['mcp-server.js'] },
            installedAt: new Date().toISOString(),
            scope: 'user'
          },
          'prompt-registry:bundle-b:server1': {
            bundleId: 'bundle-b',
            bundleVersion: '1.0.0',
            originalName: 'server1',
            originalConfig: { command: 'node', args: ['mcp-server.js'] },
            installedAt: new Date().toISOString(),
            scope: 'user'
          }
        },
        lastUpdated: new Date().toISOString(),
        version: '1.0.0'
      };

      await writeTestConfig(config);
      await writeTestTracking(tracking);

      // Stub the config service to use our test files
      sandbox.stub(configService, 'readMcpConfig').resolves(config);
      sandbox.stub(configService, 'readTrackingMetadata').resolves(tracking);

      const result = await configService.detectAndDisableDuplicates('user');

      assert.strictEqual(result.duplicatesDisabled.length, 1);
      assert.strictEqual(result.duplicatesDisabled[0].serverName, 'prompt-registry:bundle-b:server1');
      assert.strictEqual(result.duplicatesDisabled[0].duplicateOf, 'prompt-registry:bundle-a:server1');
      assert.strictEqual(result.duplicatesDisabled[0].originalBundleId, 'bundle-a');

      // Check that the duplicate is disabled in the returned config
      const duplicateServer = result.config.servers['prompt-registry:bundle-b:server1'];
      assert.strictEqual(duplicateServer.disabled, true);
      assert.ok(duplicateServer.description?.includes('Duplicate'));
    });

    test('should detect duplicate remote servers with same URL', async () => {
      const config: McpConfiguration = {
        servers: {
          'prompt-registry:bundle-a:api-server': {
            type: 'http',
            url: 'https://api.example.com/mcp'
          },
          'prompt-registry:bundle-b:api-server': {
            type: 'http',
            url: 'https://api.example.com/mcp'
          }
        }
      };

      const tracking: McpTrackingMetadata = {
        managedServers: {
          'prompt-registry:bundle-a:api-server': {
            bundleId: 'bundle-a',
            bundleVersion: '1.0.0',
            originalName: 'api-server',
            originalConfig: { type: 'http', url: 'https://api.example.com/mcp' } as any,
            installedAt: new Date().toISOString(),
            scope: 'user'
          },
          'prompt-registry:bundle-b:api-server': {
            bundleId: 'bundle-b',
            bundleVersion: '1.0.0',
            originalName: 'api-server',
            originalConfig: { type: 'http', url: 'https://api.example.com/mcp' } as any,
            installedAt: new Date().toISOString(),
            scope: 'user'
          }
        },
        lastUpdated: new Date().toISOString(),
        version: '1.0.0'
      };

      sandbox.stub(configService, 'readMcpConfig').resolves(config);
      sandbox.stub(configService, 'readTrackingMetadata').resolves(tracking);

      const result = await configService.detectAndDisableDuplicates('user');

      assert.strictEqual(result.duplicatesDisabled.length, 1);
      const duplicateServer = result.config.servers['prompt-registry:bundle-b:api-server'] as McpRemoteServerConfig;
      assert.strictEqual(duplicateServer.disabled, true);
    });

    test('should keep first server enabled and disable subsequent duplicates', async () => {
      // Three servers with same identity - only first should remain enabled
      const config: McpConfiguration = {
        servers: {
          'prompt-registry:bundle-a:server': {
            command: 'shared-server'
          },
          'prompt-registry:bundle-b:server': {
            command: 'shared-server'
          },
          'prompt-registry:bundle-c:server': {
            command: 'shared-server'
          }
        }
      };

      const tracking: McpTrackingMetadata = {
        managedServers: {
          'prompt-registry:bundle-a:server': {
            bundleId: 'bundle-a', bundleVersion: '1.0.0', originalName: 'server',
            originalConfig: { command: 'shared-server' },
            installedAt: new Date().toISOString(), scope: 'user'
          },
          'prompt-registry:bundle-b:server': {
            bundleId: 'bundle-b', bundleVersion: '1.0.0', originalName: 'server',
            originalConfig: { command: 'shared-server' },
            installedAt: new Date().toISOString(), scope: 'user'
          },
          'prompt-registry:bundle-c:server': {
            bundleId: 'bundle-c', bundleVersion: '1.0.0', originalName: 'server',
            originalConfig: { command: 'shared-server' },
            installedAt: new Date().toISOString(), scope: 'user'
          }
        },
        lastUpdated: new Date().toISOString(),
        version: '1.0.0'
      };

      sandbox.stub(configService, 'readMcpConfig').resolves(config);
      sandbox.stub(configService, 'readTrackingMetadata').resolves(tracking);

      const result = await configService.detectAndDisableDuplicates('user');

      assert.strictEqual(result.duplicatesDisabled.length, 2);

      // First server should remain enabled
      assert.strictEqual(result.config.servers['prompt-registry:bundle-a:server'].disabled, undefined);

      // Second and third should be disabled
      assert.strictEqual(result.config.servers['prompt-registry:bundle-b:server'].disabled, true);
      assert.strictEqual(result.config.servers['prompt-registry:bundle-c:server'].disabled, true);
    });

    test('should not flag different servers as duplicates', async () => {
      const config: McpConfiguration = {
        servers: {
          'prompt-registry:bundle-a:server1': {
            command: 'server-a'
          },
          'prompt-registry:bundle-b:server2': {
            command: 'server-b'
          },
          'prompt-registry:bundle-c:api': {
            type: 'http',
            url: 'https://api.example.com/mcp'
          }
        }
      };

      const tracking: McpTrackingMetadata = {
        managedServers: {
          'prompt-registry:bundle-a:server1': {
            bundleId: 'bundle-a', bundleVersion: '1.0.0', originalName: 'server1',
            originalConfig: { command: 'server-a' },
            installedAt: new Date().toISOString(), scope: 'user'
          },
          'prompt-registry:bundle-b:server2': {
            bundleId: 'bundle-b', bundleVersion: '1.0.0', originalName: 'server2',
            originalConfig: { command: 'server-b' },
            installedAt: new Date().toISOString(), scope: 'user'
          },
          'prompt-registry:bundle-c:api': {
            bundleId: 'bundle-c', bundleVersion: '1.0.0', originalName: 'api',
            originalConfig: { type: 'http', url: 'https://api.example.com/mcp' } as any,
            installedAt: new Date().toISOString(), scope: 'user'
          }
        },
        lastUpdated: new Date().toISOString(),
        version: '1.0.0'
      };

      sandbox.stub(configService, 'readMcpConfig').resolves(config);
      sandbox.stub(configService, 'readTrackingMetadata').resolves(tracking);

      const result = await configService.detectAndDisableDuplicates('user');

      assert.strictEqual(result.duplicatesDisabled.length, 0);
    });

    test('should not flag already disabled servers as duplicates', async () => {
      const config: McpConfiguration = {
        servers: {
          'prompt-registry:bundle-a:server': {
            command: 'shared-server',
            disabled: true // Already disabled
          },
          'prompt-registry:bundle-b:server': {
            command: 'shared-server'
          }
        }
      };

      const tracking: McpTrackingMetadata = {
        managedServers: {
          'prompt-registry:bundle-a:server': {
            bundleId: 'bundle-a', bundleVersion: '1.0.0', originalName: 'server',
            originalConfig: { command: 'shared-server' },
            installedAt: new Date().toISOString(), scope: 'user'
          },
          'prompt-registry:bundle-b:server': {
            bundleId: 'bundle-b', bundleVersion: '1.0.0', originalName: 'server',
            originalConfig: { command: 'shared-server' },
            installedAt: new Date().toISOString(), scope: 'user'
          }
        },
        lastUpdated: new Date().toISOString(),
        version: '1.0.0'
      };

      sandbox.stub(configService, 'readMcpConfig').resolves(config);
      sandbox.stub(configService, 'readTrackingMetadata').resolves(tracking);

      const result = await configService.detectAndDisableDuplicates('user');

      // bundle-b:server should NOT be flagged as duplicate because bundle-a:server is disabled
      // bundle-b:server becomes the "first" enabled one
      assert.strictEqual(result.duplicatesDisabled.length, 0);
    });

    test('should handle empty server list', async () => {
      const config: McpConfiguration = { servers: {} };
      const tracking: McpTrackingMetadata = {
        managedServers: {},
        lastUpdated: new Date().toISOString(),
        version: '1.0.0'
      };

      sandbox.stub(configService, 'readMcpConfig').resolves(config);
      sandbox.stub(configService, 'readTrackingMetadata').resolves(tracking);

      const result = await configService.detectAndDisableDuplicates('user');

      assert.strictEqual(result.duplicatesDisabled.length, 0);
      assert.deepStrictEqual(result.config.servers, {});
    });

    test('should handle servers not in tracking metadata', async () => {
      const config: McpConfiguration = {
        servers: {
          'untracked-server': {
            command: 'some-server'
          },
          'prompt-registry:bundle-a:server': {
            command: 'some-server'
          }
        }
      };

      const tracking: McpTrackingMetadata = {
        managedServers: {
          'prompt-registry:bundle-a:server': {
            bundleId: 'bundle-a', bundleVersion: '1.0.0', originalName: 'server',
            originalConfig: { command: 'some-server' },
            installedAt: new Date().toISOString(), scope: 'user'
          }
        },
        lastUpdated: new Date().toISOString(),
        version: '1.0.0'
      };

      sandbox.stub(configService, 'readMcpConfig').resolves(config);
      sandbox.stub(configService, 'readTrackingMetadata').resolves(tracking);

      const result = await configService.detectAndDisableDuplicates('user');

      // The tracked server should be flagged as duplicate of the untracked one
      // (untracked comes first in iteration)
      assert.strictEqual(result.duplicatesDisabled.length, 1);
      assert.strictEqual(result.duplicatesDisabled[0].bundleId, 'bundle-a');
    });

    test('should not cross-detect stdio and remote as duplicates', async () => {
      // Even if URL looks like a command, they should not be considered duplicates
      const config: McpConfiguration = {
        servers: {
          'prompt-registry:bundle-a:stdio': {
            command: 'https://api.example.com/mcp'
          },
          'prompt-registry:bundle-b:remote': {
            type: 'http',
            url: 'https://api.example.com/mcp'
          }
        }
      };

      const tracking: McpTrackingMetadata = {
        managedServers: {
          'prompt-registry:bundle-a:stdio': {
            bundleId: 'bundle-a', bundleVersion: '1.0.0', originalName: 'stdio',
            originalConfig: { command: 'https://api.example.com/mcp' },
            installedAt: new Date().toISOString(), scope: 'user'
          },
          'prompt-registry:bundle-b:remote': {
            bundleId: 'bundle-b', bundleVersion: '1.0.0', originalName: 'remote',
            originalConfig: { type: 'http', url: 'https://api.example.com/mcp' } as any,
            installedAt: new Date().toISOString(), scope: 'user'
          }
        },
        lastUpdated: new Date().toISOString(),
        version: '1.0.0'
      };

      sandbox.stub(configService, 'readMcpConfig').resolves(config);
      sandbox.stub(configService, 'readTrackingMetadata').resolves(tracking);

      const result = await configService.detectAndDisableDuplicates('user');

      assert.strictEqual(result.duplicatesDisabled.length, 0,
        'Stdio and remote servers should not be considered duplicates');
    });
  });

  suite('Duplicate Description Format', () => {
    test('should include original server name in duplicate description', async () => {
      const config: McpConfiguration = {
        servers: {
          'prompt-registry:bundle-a:my-server': {
            command: 'shared'
          },
          'prompt-registry:bundle-b:my-server': {
            command: 'shared'
          }
        }
      };

      const tracking: McpTrackingMetadata = {
        managedServers: {
          'prompt-registry:bundle-a:my-server': {
            bundleId: 'bundle-a', bundleVersion: '1.0.0', originalName: 'my-server',
            originalConfig: { command: 'shared' },
            installedAt: new Date().toISOString(), scope: 'user'
          },
          'prompt-registry:bundle-b:my-server': {
            bundleId: 'bundle-b', bundleVersion: '1.0.0', originalName: 'my-server',
            originalConfig: { command: 'shared' },
            installedAt: new Date().toISOString(), scope: 'user'
          }
        },
        lastUpdated: new Date().toISOString(),
        version: '1.0.0'
      };

      sandbox.stub(configService, 'readMcpConfig').resolves(config);
      sandbox.stub(configService, 'readTrackingMetadata').resolves(tracking);

      const result = await configService.detectAndDisableDuplicates('user');

      const duplicateServer = result.config.servers['prompt-registry:bundle-b:my-server'];
      assert.ok(duplicateServer.description?.includes('prompt-registry:bundle-a:my-server'));
      assert.ok(duplicateServer.description?.includes('bundle-a'));
    });
  });
});
