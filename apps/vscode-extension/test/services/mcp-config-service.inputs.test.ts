/**
 * McpConfigService - Input Merging Tests
 *
 * Tests for mergeInputs() and the inputs propagation through mergeServers().
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
  McpInputDefinition,
} from '../../src/types/mcp';

suite('McpConfigService - Input Merging', () => {
  let sandbox: sinon.SinonSandbox;
  let configService: McpConfigService;
  let testDir: string;
  let mockConfigPath: string;

  const writeTestConfig = async (config: McpConfiguration): Promise<void> => {
    await fs.writeFile(mockConfigPath, JSON.stringify(config, null, 2));
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    configService = new McpConfigService();
    testDir = path.join(os.tmpdir(), 'mcp-inputs-test-' + Date.now());
    fs.ensureDirSync(testDir);
    mockConfigPath = path.join(testDir, 'mcp.json');
  });

  teardown(async () => {
    sandbox.restore();
    if (fs.existsSync(testDir)) {
      await fs.remove(testDir);
    }
  });

  suite('mergeInputs()', () => {
    test('should return undefined when both existing and incoming are undefined', () => {
      const result = configService.mergeInputs(undefined, undefined);
      assert.strictEqual(result, undefined);
    });

    test('should return undefined when incoming is empty', () => {
      const result = configService.mergeInputs(undefined, []);
      assert.strictEqual(result, undefined);
    });

    test('should return existing unchanged when incoming is empty', () => {
      const existing: McpInputDefinition[] = [{ id: 'token', type: 'promptString' }];
      const result = configService.mergeInputs(existing, []);
      assert.deepStrictEqual(result, existing);
    });

    test('should add new inputs when existing is undefined', () => {
      const incoming: McpInputDefinition[] = [
        { id: 'ocToken', type: 'promptString', description: 'OpenShift token', password: true }
      ];
      const result = configService.mergeInputs(undefined, incoming);
      assert.deepStrictEqual(result, incoming);
    });

    test('should add new inputs that do not conflict with existing ones', () => {
      const existing: McpInputDefinition[] = [
        { id: 'existingToken', type: 'promptString' }
      ];
      const incoming: McpInputDefinition[] = [
        { id: 'newToken', type: 'promptString', password: true }
      ];

      const result = configService.mergeInputs(existing, incoming);

      assert.strictEqual(result?.length, 2);
      assert.ok(result?.some((i) => i.id === 'existingToken'));
      assert.ok(result?.some((i) => i.id === 'newToken'));
    });

    test('should deduplicate inputs by id, preserving the existing definition', () => {
      const existing: McpInputDefinition[] = [
        { id: 'sharedToken', type: 'promptString', description: 'Original description' }
      ];
      const incoming: McpInputDefinition[] = [
        { id: 'sharedToken', type: 'promptString', description: 'New description' }
      ];

      const result = configService.mergeInputs(existing, incoming);

      assert.strictEqual(result?.length, 1);
      assert.strictEqual(result?.[0].description, 'Original description');
    });

    test('should merge multiple inputs handling duplicates and new ones together', () => {
      const existing: McpInputDefinition[] = [
        { id: 'bbUser', type: 'promptString' },
        { id: 'bbPassword', type: 'promptString', password: true }
      ];
      const incoming: McpInputDefinition[] = [
        { id: 'bbUser', type: 'promptString', description: 'Should be ignored (duplicate)' },
        { id: 'ocToken', type: 'promptString', password: true }
      ];

      const result = configService.mergeInputs(existing, incoming);

      assert.strictEqual(result?.length, 3);
      assert.ok(result?.some((i) => i.id === 'bbUser' && !i.description));
      assert.ok(result?.some((i) => i.id === 'bbPassword'));
      assert.ok(result?.some((i) => i.id === 'ocToken'));
    });
  });

  suite('removeOrphanedInputs()', () => {
    test('should return config unchanged when no inputs are defined', () => {
      const config: McpConfiguration = {
        servers: { 'my-server': { command: 'node', args: ['--token', '${input:token}'] } }
      };
      const result = configService.removeOrphanedInputs(config);
      assert.strictEqual(result.inputs, undefined);
    });

    test('should keep inputs still referenced by a remaining server', () => {
      const config: McpConfiguration = {
        servers: { 'my-server': { command: 'node', args: ['-e', 'BB_USER=${input:bbUser}'] } },
        inputs: [
          { id: 'bbUser', type: 'promptString' },
          { id: 'bbPassword', type: 'promptString', password: true }
        ]
      };
      const result = configService.removeOrphanedInputs(config);
      assert.strictEqual(result.inputs?.length, 1);
      assert.strictEqual(result.inputs?.[0].id, 'bbUser');
    });

    test('should remove all inputs when no servers reference any input', () => {
      const config: McpConfiguration = {
        servers: { 'plain-server': { command: 'node', args: ['server.js'] } },
        inputs: [{ id: 'orphaned', type: 'promptString' }]
      };
      const result = configService.removeOrphanedInputs(config);
      assert.strictEqual(result.inputs, undefined);
    });

    test('should remove all inputs when no servers remain', () => {
      const config: McpConfiguration = {
        servers: {},
        inputs: [{ id: 'ocToken', type: 'promptString', password: true }]
      };
      const result = configService.removeOrphanedInputs(config);
      assert.strictEqual(result.inputs, undefined);
    });

    test('should keep input referenced in headers of a remote server', () => {
      const config: McpConfiguration = {
        servers: {
          'remote-server': {
            type: 'http',
            url: 'https://api.example.com/mcp',
            headers: { Authorization: 'Bearer ${input:apiToken}' }
          }
        },
        inputs: [
          { id: 'apiToken', type: 'promptString', password: true },
          { id: 'unused', type: 'promptString' }
        ]
      };
      const result = configService.removeOrphanedInputs(config);
      assert.strictEqual(result.inputs?.length, 1);
      assert.strictEqual(result.inputs?.[0].id, 'apiToken');
    });

    test('should keep shared input if still referenced by at least one remaining server', () => {
      const config: McpConfiguration = {
        servers: {
          'bundle-a:bitbucket': { command: 'podman', args: ['-e', 'BB_USER=${input:bbUser}'] }
        },
        inputs: [
          { id: 'bbUser', type: 'promptString' },
          { id: 'bbPassword', type: 'promptString', password: true }
        ]
      };
      const result = configService.removeOrphanedInputs(config);
      assert.strictEqual(result.inputs?.length, 1);
      assert.strictEqual(result.inputs?.[0].id, 'bbUser');
    });
  });

  suite('mergeServers() with inputs', () => {
    test('should propagate new inputs into the merged config', async () => {
      const existingConfig: McpConfiguration = {
        servers: {},
        inputs: [{ id: 'existingInput', type: 'promptString' }]
      };

      const newInputs: McpInputDefinition[] = [
        { id: 'ocToken', type: 'promptString', password: true }
      ];

      const { config } = await configService.mergeServers(existingConfig, {}, { scope: 'user', overwrite: false, skipOnConflict: false }, newInputs);

      assert.strictEqual(config.inputs?.length, 2);
      assert.ok(config.inputs?.some((i) => i.id === 'existingInput'));
      assert.ok(config.inputs?.some((i) => i.id === 'ocToken'));
    });

    test('should produce no inputs field when none are provided', async () => {
      const existingConfig: McpConfiguration = { servers: {} };

      const { config } = await configService.mergeServers(existingConfig, {}, { scope: 'user', overwrite: false, skipOnConflict: false });

      assert.strictEqual(config.inputs, undefined);
    });

    test('should write inputs to mcp.json via writeMcpConfig', async () => {
      const initialConfig: McpConfiguration = { servers: {} };
      await writeTestConfig(initialConfig);

      // Stub McpConfigLocator to point at our test dir
      const { McpConfigLocator } = await import('../../src/utils/mcp-config-locator');
      sandbox.stub(McpConfigLocator, 'getMcpConfigLocation').returns({
        configPath: mockConfigPath,
        trackingPath: path.join(testDir, 'mcp-tracking.json'),
        exists: true
      });
      sandbox.stub(McpConfigLocator, 'ensureConfigDirectory').resolves();

      const inputs: McpInputDefinition[] = [
        { id: 'bbUser', type: 'promptString', description: 'Bitbucket username' },
        { id: 'bbPassword', type: 'promptString', password: true }
      ];

      const existingConfig = await configService.readMcpConfig('user');
      const { config } = await configService.mergeServers(existingConfig, {}, { scope: 'user', overwrite: false, skipOnConflict: false }, inputs);
      await configService.writeMcpConfig(config, 'user', false);

      const written = JSON.parse(await fs.readFile(mockConfigPath, 'utf8')) as McpConfiguration;
      assert.strictEqual(written.inputs?.length, 2);
      assert.strictEqual(written.inputs?.[0].id, 'bbUser');
      assert.strictEqual(written.inputs?.[1].id, 'bbPassword');
      assert.strictEqual(written.inputs?.[1].password, true);
    });
  });
});
