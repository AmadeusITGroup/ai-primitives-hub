/**
 * MCP Config Service - Remote Server Support Tests
 *
 * TDD tests for remote MCP server (HTTP/SSE) handling and type discrimination.
 * These tests verify the refactored type system and processing logic.
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
  isRemoteServerConfig,
  isStdioServerConfig,
  McpRemoteServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
} from '../../src/types/mcp';

suite('McpConfigService - Remote Server Support', () => {
  let sandbox: sinon.SinonSandbox;
  let configService: McpConfigService;
  let testDir: string;

  setup(() => {
    sandbox = sinon.createSandbox();
    configService = new McpConfigService();
    testDir = path.join(os.tmpdir(), 'mcp-remote-test-' + Date.now());
    fs.ensureDirSync(testDir);
  });

  teardown(async () => {
    sandbox.restore();
    if (fs.existsSync(testDir)) {
      await fs.remove(testDir);
    }
  });

  suite('Type Guards', () => {
    suite('isStdioServerConfig()', () => {
      test('should return true for explicit stdio type', () => {
        const config: McpServerConfig = {
          type: 'stdio',
          command: 'node',
          args: ['server.js']
        };
        assert.strictEqual(isStdioServerConfig(config), true);
      });

      test('should return true for config without type (backward compatibility)', () => {
        const config: McpServerConfig = {
          command: 'node',
          args: ['server.js']
        };
        assert.strictEqual(isStdioServerConfig(config), true);
      });

      test('should return false for http type', () => {
        const config: McpServerConfig = {
          type: 'http',
          url: 'https://api.example.com/mcp'
        };
        assert.strictEqual(isStdioServerConfig(config), false);
      });

      test('should return false for sse type', () => {
        const config: McpServerConfig = {
          type: 'sse',
          url: 'https://api.example.com/mcp/sse'
        };
        assert.strictEqual(isStdioServerConfig(config), false);
      });
    });

    suite('isRemoteServerConfig()', () => {
      test('should return true for http type with url', () => {
        const config: McpServerConfig = {
          type: 'http',
          url: 'https://api.example.com/mcp'
        };
        assert.strictEqual(isRemoteServerConfig(config), true);
      });

      test('should return true for sse type with url', () => {
        const config: McpServerConfig = {
          type: 'sse',
          url: 'https://api.example.com/mcp/sse'
        };
        assert.strictEqual(isRemoteServerConfig(config), true);
      });

      test('should return false for stdio type', () => {
        const config: McpServerConfig = {
          type: 'stdio',
          command: 'node',
          args: ['server.js']
        };
        assert.strictEqual(isRemoteServerConfig(config), false);
      });

      test('should return false for config without type (defaults to stdio)', () => {
        const config: McpServerConfig = {
          command: 'node',
          args: ['server.js']
        };
        assert.strictEqual(isRemoteServerConfig(config), false);
      });

      test('should return true for http type with headers', () => {
        const config: McpServerConfig = {
          type: 'http',
          url: 'https://api.example.com/mcp',
          headers: {
            Authorization: 'Bearer token123'
          }
        };
        assert.strictEqual(isRemoteServerConfig(config), true);
      });
    });
  });

  suite('processServerDefinition() - Remote Servers', () => {
    const bundleId = 'test-bundle';
    const bundleVersion = '1.0.0';

    test('should process HTTP server with URL', () => {
      const definition: McpRemoteServerConfig = {
        type: 'http',
        url: 'https://api.example.com/mcp'
      };

      const result = configService.processServerDefinition(
        'http-server',
        definition,
        bundleId,
        bundleVersion,
        testDir
      );

      assert.strictEqual(isRemoteServerConfig(result), true);
      const remoteResult = result as McpRemoteServerConfig;
      assert.strictEqual(remoteResult.type, 'http');
      assert.strictEqual(remoteResult.url, 'https://api.example.com/mcp');
    });

    test('should process SSE server with URL', () => {
      const definition: McpRemoteServerConfig = {
        type: 'sse',
        url: 'https://api.example.com/mcp/events'
      };

      const result = configService.processServerDefinition(
        'sse-server',
        definition,
        bundleId,
        bundleVersion,
        testDir
      );

      assert.strictEqual(isRemoteServerConfig(result), true);
      const remoteResult = result as McpRemoteServerConfig;
      assert.strictEqual(remoteResult.type, 'sse');
      assert.strictEqual(remoteResult.url, 'https://api.example.com/mcp/events');
    });

    test('should substitute bundlePath variable in URL', () => {
      const definition: McpRemoteServerConfig = {
        type: 'http',
        url: 'file://${bundlePath}/local-server'
      };

      const result = configService.processServerDefinition(
        'local-http-server',
        definition,
        bundleId,
        bundleVersion,
        testDir
      );

      assert.strictEqual(isRemoteServerConfig(result), true);
      const remoteResult = result as McpRemoteServerConfig;
      assert.strictEqual(remoteResult.url, `file://${testDir}/local-server`);
    });

    test('should substitute environment variables in URL', () => {
      const originalEnv = process.env.TEST_MCP_HOST;
      process.env.TEST_MCP_HOST = 'mcp.example.com';

      try {
        const definition: McpRemoteServerConfig = {
          type: 'http',
          url: 'https://${env:TEST_MCP_HOST}/api/mcp'
        };

        const result = configService.processServerDefinition(
          'env-http-server',
          definition,
          bundleId,
          bundleVersion,
          testDir
        );

        assert.strictEqual(isRemoteServerConfig(result), true);
        const remoteResult = result as McpRemoteServerConfig;
        assert.strictEqual(remoteResult.url, 'https://mcp.example.com/api/mcp');
      } finally {
        if (originalEnv === undefined) {
          delete process.env.TEST_MCP_HOST;
        } else {
          process.env.TEST_MCP_HOST = originalEnv;
        }
      }
    });

    test('should process headers with variable substitution', () => {
      const originalEnv = process.env.TEST_API_TOKEN;
      process.env.TEST_API_TOKEN = 'secret-token-123';

      try {
        const definition: McpRemoteServerConfig = {
          type: 'http',
          url: 'https://api.example.com/mcp',
          headers: {
            Authorization: 'Bearer ${env:TEST_API_TOKEN}',
            'X-Bundle-Id': '${bundleId}'
          }
        };

        const result = configService.processServerDefinition(
          'auth-http-server',
          definition,
          bundleId,
          bundleVersion,
          testDir
        );

        assert.strictEqual(isRemoteServerConfig(result), true);
        const remoteResult = result as McpRemoteServerConfig;
        assert.strictEqual(remoteResult.headers?.Authorization, 'Bearer secret-token-123');
        assert.strictEqual(remoteResult.headers?.['X-Bundle-Id'], bundleId);
      } finally {
        if (originalEnv === undefined) {
          delete process.env.TEST_API_TOKEN;
        } else {
          process.env.TEST_API_TOKEN = originalEnv;
        }
      }
    });

    test('should preserve disabled field for remote servers', () => {
      const definition: McpRemoteServerConfig = {
        type: 'http',
        url: 'https://api.example.com/mcp',
        disabled: true
      };

      const result = configService.processServerDefinition(
        'disabled-http-server',
        definition,
        bundleId,
        bundleVersion,
        testDir
      );

      assert.strictEqual(result.disabled, true);
    });

    test('should preserve description field for remote servers', () => {
      const definition: McpRemoteServerConfig = {
        type: 'sse',
        url: 'https://api.example.com/mcp/sse',
        description: 'My SSE MCP server'
      };

      const result = configService.processServerDefinition(
        'described-sse-server',
        definition,
        bundleId,
        bundleVersion,
        testDir
      );

      assert.strictEqual(result.description, 'My SSE MCP server');
    });

    test('should handle Unix socket URL', () => {
      const definition: McpRemoteServerConfig = {
        type: 'http',
        url: 'unix:///tmp/mcp.sock'
      };

      const result = configService.processServerDefinition(
        'unix-socket-server',
        definition,
        bundleId,
        bundleVersion,
        testDir
      );

      assert.strictEqual(isRemoteServerConfig(result), true);
      const remoteResult = result as McpRemoteServerConfig;
      assert.strictEqual(remoteResult.url, 'unix:///tmp/mcp.sock');
    });

    test('should handle Windows named pipe URL', () => {
      const definition: McpRemoteServerConfig = {
        type: 'http',
        url: 'pipe:///pipe/mcp-server'
      };

      const result = configService.processServerDefinition(
        'pipe-server',
        definition,
        bundleId,
        bundleVersion,
        testDir
      );

      assert.strictEqual(isRemoteServerConfig(result), true);
      const remoteResult = result as McpRemoteServerConfig;
      assert.strictEqual(remoteResult.url, 'pipe:///pipe/mcp-server');
    });
  });

  suite('processServerDefinition() - Stdio Servers (Enhanced)', () => {
    const bundleId = 'test-bundle';
    const bundleVersion = '1.0.0';

    test('should preserve explicit stdio type', () => {
      const definition: McpStdioServerConfig = {
        type: 'stdio',
        command: 'node',
        args: ['server.js']
      };

      const result = configService.processServerDefinition(
        'stdio-server',
        definition,
        bundleId,
        bundleVersion,
        testDir
      );

      assert.strictEqual(isStdioServerConfig(result), true);
      const stdioResult = result as McpStdioServerConfig;
      assert.strictEqual(stdioResult.type, 'stdio');
    });

    test('should handle config without type (backward compatibility)', () => {
      const definition: McpStdioServerConfig = {
        command: 'python',
        args: ['mcp_server.py']
      };

      const result = configService.processServerDefinition(
        'legacy-server',
        definition,
        bundleId,
        bundleVersion,
        testDir
      );

      assert.strictEqual(isStdioServerConfig(result), true);
      const stdioResult = result as McpStdioServerConfig;
      assert.strictEqual(stdioResult.command, 'python');
    });

    test('should substitute envFile path', () => {
      const definition: McpStdioServerConfig = {
        command: 'node',
        args: ['server.js'],
        envFile: '${bundlePath}/.env'
      };

      const result = configService.processServerDefinition(
        'envfile-server',
        definition,
        bundleId,
        bundleVersion,
        testDir
      );

      assert.strictEqual(isStdioServerConfig(result), true);
      const stdioResult = result as McpStdioServerConfig;
      assert.strictEqual(stdioResult.envFile, `${testDir}/.env`);
    });
  });

  suite('Mixed Server Types', () => {
    test('should correctly discriminate between stdio and remote in same manifest', () => {
      const stdioConfig: McpStdioServerConfig = {
        command: 'node',
        args: ['local-server.js']
      };

      const httpConfig: McpRemoteServerConfig = {
        type: 'http',
        url: 'https://api.example.com/mcp'
      };

      const sseConfig: McpRemoteServerConfig = {
        type: 'sse',
        url: 'https://api.example.com/mcp/events'
      };

      assert.strictEqual(isStdioServerConfig(stdioConfig), true);
      assert.strictEqual(isRemoteServerConfig(stdioConfig), false);

      assert.strictEqual(isStdioServerConfig(httpConfig), false);
      assert.strictEqual(isRemoteServerConfig(httpConfig), true);

      assert.strictEqual(isStdioServerConfig(sseConfig), false);
      assert.strictEqual(isRemoteServerConfig(sseConfig), true);
    });
  });
});
