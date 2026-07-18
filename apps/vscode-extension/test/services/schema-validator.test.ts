/**
 * SchemaValidator Unit Tests
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  SchemaValidator,
} from '../../src/services/schema-validator';

suite('SchemaValidator', () => {
  let validator: SchemaValidator;
  let tempDir: string;
  let testSchemaPath: string;
  let testCollectionSchemaPath: string;

  // Test data
  const validCollection = {
    id: 'test-collection',
    name: 'Test Collection',
    description: 'A test collection for validation',
    version: '1.0.0',
    author: 'Test Author',
    items: [
      { path: 'prompts/test.txt', kind: 'prompt' },
      { path: 'instructions/guide.md', kind: 'instruction' }
    ]
  };

  const minimalCollection = {
    id: 'minimal',
    name: 'Minimal',
    description: 'Minimal collection',
    items: []
  };

  setup(() => {
    validator = new SchemaValidator(process.cwd());
    tempDir = path.join(__dirname, '..', '..', 'test-temp-schema');

    // Create temp directory
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Create a test schema
    testSchemaPath = path.join(tempDir, 'test.schema.json');
    const testSchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1 },
        age: { type: 'number', minimum: 0 }
      }
    };
    fs.writeFileSync(testSchemaPath, JSON.stringify(testSchema, null, 2));

    // Path to actual collection schema (should exist after previous implementation)
    testCollectionSchemaPath = path.join(process.cwd(), 'schemas', 'collection.schema.json');
  });

  teardown(() => {
    // Cleanup temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  suite('Schema Loading', () => {
    test('should load and compile a valid schema', async () => {
      const result = await validator.validate({ name: 'Test' }, testSchemaPath);
      assert.ok(result);
      assert.strictEqual(result.valid, true);
    });

    test('should cache loaded schemas', async () => {
      // First load
      await validator.validate({ name: 'Test1' }, testSchemaPath);

      // Second load (should use cache)
      const result = await validator.validate({ name: 'Test2' }, testSchemaPath);
      assert.strictEqual(result.valid, true);
    });

    test('should throw error for non-existent schema', async () => {
      const badPath = path.join(tempDir, 'nonexistent.schema.json');
      const result = await validator.validate({ name: 'Test' }, badPath);

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length > 0);
      assert.ok(result.errors[0].includes('Validation error'));
    });

    test('should throw error for invalid JSON schema', async () => {
      const invalidSchemaPath = path.join(tempDir, 'invalid.schema.json');
      fs.writeFileSync(invalidSchemaPath, 'not valid json');

      const result = await validator.validate({ name: 'Test' }, invalidSchemaPath);

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length > 0);
    });
  });

  suite('Basic Validation', () => {
    test('should validate valid data', async () => {
      const validData = { name: 'John', age: 30 };
      const result = await validator.validate(validData, testSchemaPath);

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    test('should detect missing required field', async () => {
      const invalidData = { age: 30 };
      const result = await validator.validate(invalidData, testSchemaPath);

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length > 0);
      assert.ok(result.errors[0].includes('Missing required field'));
      assert.ok(result.errors[0].includes('name'));
    });

    test('should detect wrong type', async () => {
      const invalidData = { name: 'John', age: 'thirty' };
      const result = await validator.validate(invalidData, testSchemaPath);

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('must be number')));
    });

    test('should detect value below minimum', async () => {
      const invalidData = { name: 'John', age: -5 };
      const result = await validator.validate(invalidData, testSchemaPath);

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length > 0);
    });
  });

  suite('Collection Validation', () => {
    test('should validate valid collection', async function () {
      // Skip if schema doesn't exist yet
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const result = await validator.validateCollection(validCollection);

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    test('should validate minimal valid collection', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const result = await validator.validateCollection(minimalCollection);

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    test('should detect missing required fields in collection', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const invalidCollection = {
        id: 'test',
        name: 'Test'
        // missing description and items
      };

      const result = await validator.validateCollection(invalidCollection);

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('description')));
    });

    test('should detect invalid id format', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const invalidCollection = {
        id: 'Invalid_ID_With_Caps',
        name: 'Test',
        description: 'Test description',
        items: []
      };

      const result = await validator.validateCollection(invalidCollection);

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('pattern') || e.includes('id')));
    });

    test('should detect invalid item kind', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const invalidCollection = {
        id: 'test-collection',
        name: 'Test',
        description: 'Test description',
        items: [
          { path: 'test.txt', kind: 'invalid-kind' }
        ]
      };

      const result = await validator.validateCollection(invalidCollection);

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('allowed values') || e.includes('enum')));
    });

    test('should detect description too long', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const invalidCollection = {
        id: 'test-collection',
        name: 'Test',
        description: 'x'.repeat(600), // Over 500 limit
        items: []
      };

      const result = await validator.validateCollection(invalidCollection);

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('maximum') || e.includes('500')));
    });
  });

  test('should validate collection with valid MCP configuration', async function () {
    if (!fs.existsSync(testCollectionSchemaPath)) {
      this.skip();
      return;
    }

    const collectionWithMcp = {
      id: 'test-mcp-collection',
      name: 'Test MCP Collection',
      description: 'Collection with MCP servers',
      items: [
        { path: 'prompts/test.md', kind: 'prompt' }
      ],
      mcp: {
        items: {
          'time-server': {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-sequential-thinking']
          },
          'custom-server': {
            type: 'stdio',
            command: 'node',
            args: ['${bundlePath}/server.js'],
            env: {
              LOG_LEVEL: 'debug'
            },
            disabled: false
          }
        }
      }
    };

    const result = await validator.validateCollection(collectionWithMcp);

    assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
    assert.strictEqual(result.errors.length, 0);
  });
  test('should validate MCP with environment variables', async function () {
    if (!fs.existsSync(testCollectionSchemaPath)) {
      this.skip();
      return;
    }

    const mcpWithEnv = {
      id: 'test-mcp-env',
      name: 'MCP with Environment',
      description: 'Collection with MCP env variables',
      items: [],
      mcp: {
        items: {
          'github-server': {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: {
              GITHUB_TOKEN: '${env:GITHUB_TOKEN}',
              LOG_LEVEL: 'info'
            }
          }
        }
      }
    };

    const result = await validator.validateCollection(mcpWithEnv);

    assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
  });

  test('should validate MCP with variable substitution in args', async function () {
    if (!fs.existsSync(testCollectionSchemaPath)) {
      this.skip();
      return;
    }

    const mcpWithVariables = {
      id: 'test-mcp-vars',
      name: 'MCP with Variables',
      description: 'Collection with variable substitution',
      items: [],
      mcp: {
        items: {
          custom: {
            type: 'stdio',
            command: 'node',
            args: [
              '${bundlePath}/server.js',
              '--id',
              '${bundleId}',
              '--version',
              '${bundleVersion}'
            ]
          }
        }
      }
    };

    const result = await validator.validateCollection(mcpWithVariables);

    assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
  });

  test('should detect stdio MCP server missing required command', async function () {
    if (!fs.existsSync(testCollectionSchemaPath)) {
      this.skip();
      return;
    }

    const invalidStdioMcp = {
      id: 'test-invalid-stdio',
      name: 'Invalid Stdio MCP',
      description: 'Stdio MCP missing command',
      items: [],
      mcp: {
        items: {
          'invalid-stdio': {
            type: 'stdio',
            // Missing required 'command' field for stdio type
            args: ['some-arg']
          }
        }
      }
    };

    const result = await validator.validateCollection(invalidStdioMcp);

    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('command')));
  });

  test('should detect http MCP server missing required url', async function () {
    if (!fs.existsSync(testCollectionSchemaPath)) {
      this.skip();
      return;
    }

    const invalidHttpMcp = {
      id: 'test-invalid-http',
      name: 'Invalid HTTP MCP',
      description: 'HTTP MCP missing url',
      items: [],
      mcp: {
        items: {
          'invalid-http': {
            type: 'http',
            // Missing required 'url' field for http type
            env: { API_KEY: 'test' }
          }
        }
      }
    };

    const result = await validator.validateCollection(invalidHttpMcp);

    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('url')));
  });

  test('should validate http MCP server with url', async function () {
    if (!fs.existsSync(testCollectionSchemaPath)) {
      this.skip();
      return;
    }

    const httpMcpCollection = {
      id: 'test-http-mcp',
      name: 'HTTP MCP Collection',
      description: 'Collection with HTTP MCP server',
      items: [],
      mcp: {
        items: {
          'remote-server': {
            type: 'http',
            url: 'https://api.example.com/mcp',
            env: {
              API_KEY: 'test-key'
            }
          }
        }
      }
    };

    const result = await validator.validateCollection(httpMcpCollection);

    assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
    assert.strictEqual(result.errors.length, 0);
  });

  test('should allow collection without MCP (optional)', async function () {
    if (!fs.existsSync(testCollectionSchemaPath)) {
      this.skip();
      return;
    }

    const collectionWithoutMcp = {
      id: 'test-no-mcp',
      name: 'No MCP Collection',
      description: 'Collection without MCP servers',
      items: [
        { path: 'prompts/test.md', kind: 'prompt' }
      ]
    };

    const result = await validator.validateCollection(collectionWithoutMcp);

    assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
  });

  test('should validate collection with valid MCP configuration', async function () {
    if (!fs.existsSync(testCollectionSchemaPath)) {
      this.skip();
      return;
    }

    const collectionWithMcp = {
      id: 'test-mcp-collection',
      name: 'Test MCP Collection',
      description: 'Collection with MCP servers',
      items: [
        { path: 'prompts/test.md', kind: 'prompt' }
      ],
      mcp: {
        items: {
          'time-server': {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-sequential-thinking']
          },
          'custom-server': {
            type: 'stdio',
            command: 'node',
            args: ['${bundlePath}/server.js'],
            env: {
              LOG_LEVEL: 'debug'
            },
            disabled: false
          }
        }
      }
    };

    const result = await validator.validateCollection(collectionWithMcp);

    assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
    assert.strictEqual(result.errors.length, 0);
  });
  test('should validate MCP with environment variables', async function () {
    if (!fs.existsSync(testCollectionSchemaPath)) {
      this.skip();
      return;
    }

    const mcpWithEnv = {
      id: 'test-mcp-env',
      name: 'MCP with Environment',
      description: 'Collection with MCP env variables',
      items: [],
      mcp: {
        items: {
          'github-server': {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: {
              GITHUB_TOKEN: '${env:GITHUB_TOKEN}',
              LOG_LEVEL: 'info'
            }
          }
        }
      }
    };

    const result = await validator.validateCollection(mcpWithEnv);

    assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
  });

  test('should validate MCP with variable substitution in args', async function () {
    if (!fs.existsSync(testCollectionSchemaPath)) {
      this.skip();
      return;
    }

    const mcpWithVariables = {
      id: 'test-mcp-vars',
      name: 'MCP with Variables',
      description: 'Collection with variable substitution',
      items: [],
      mcp: {
        items: {
          custom: {
            type: 'stdio',
            command: 'node',
            args: [
              '${bundlePath}/server.js',
              '--id',
              '${bundleId}',
              '--version',
              '${bundleVersion}'
            ]
          }
        }
      }
    };

    const result = await validator.validateCollection(mcpWithVariables);

    assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
  });

  test('should allow collection without MCP (optional)', async function () {
    if (!fs.existsSync(testCollectionSchemaPath)) {
      this.skip();
      return;
    }

    const collectionWithoutMcp = {
      id: 'test-no-mcp',
      name: 'No MCP Collection',
      description: 'Collection without MCP servers',
      items: [
        { path: 'prompts/test.md', kind: 'prompt' }
      ]
    };

    const result = await validator.validateCollection(collectionWithoutMcp);

    assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
  });

  test('should validate collection with valid MCP configuration', async function () {
    if (!fs.existsSync(testCollectionSchemaPath)) {
      this.skip();
      return;
    }

    const collectionWithMcp = {
      id: 'test-mcp-collection',
      name: 'Test MCP Collection',
      description: 'Collection with MCP servers',
      items: [
        { path: 'prompts/test.md', kind: 'prompt' }
      ],
      mcp: {
        items: {
          'time-server': {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-sequential-thinking']
          },
          'custom-server': {
            type: 'stdio',
            command: 'node',
            args: ['${bundlePath}/server.js'],
            env: {
              LOG_LEVEL: 'debug'
            },
            disabled: false
          }
        }
      }
    };

    const result = await validator.validateCollection(collectionWithMcp);

    assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
    assert.strictEqual(result.errors.length, 0);
  });
  test('should validate MCP with environment variables', async function () {
    if (!fs.existsSync(testCollectionSchemaPath)) {
      this.skip();
      return;
    }

    const mcpWithEnv = {
      id: 'test-mcp-env',
      name: 'MCP with Environment',
      description: 'Collection with MCP env variables',
      items: [],
      mcp: {
        items: {
          'github-server': {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: {
              GITHUB_TOKEN: '${env:GITHUB_TOKEN}',
              LOG_LEVEL: 'info'
            }
          }
        }
      }
    };

    const result = await validator.validateCollection(mcpWithEnv);

    assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
  });

  test('should validate MCP with variable substitution in args', async function () {
    if (!fs.existsSync(testCollectionSchemaPath)) {
      this.skip();
      return;
    }

    const mcpWithVariables = {
      id: 'test-mcp-vars',
      name: 'MCP with Variables',
      description: 'Collection with variable substitution',
      items: [],
      mcp: {
        items: {
          custom: {
            type: 'stdio',
            command: 'node',
            args: [
              '${bundlePath}/server.js',
              '--id',
              '${bundleId}',
              '--version',
              '${bundleVersion}'
            ]
          }
        }
      }
    };

    const result = await validator.validateCollection(mcpWithVariables);

    assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
  });

  test('should allow collection without MCP (optional)', async function () {
    if (!fs.existsSync(testCollectionSchemaPath)) {
      this.skip();
      return;
    }

    const collectionWithoutMcp = {
      id: 'test-no-mcp',
      name: 'No MCP Collection',
      description: 'Collection without MCP servers',
      items: [
        { path: 'prompts/test.md', kind: 'prompt' }
      ]
    };

    const result = await validator.validateCollection(collectionWithoutMcp);

    assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
  });

  suite('Error Formatting', () => {
    test('should format required field errors', async () => {
      const result = await validator.validate({}, testSchemaPath);

      assert.ok(result.errors.some((e) => e.includes('Missing required field: name')));
    });

    test('should format type errors', async () => {
      const result = await validator.validate({ name: 123 }, testSchemaPath);

      assert.ok(result.errors.some((e) => e.includes('must be string')));
    });

    test('should format minLength errors', async () => {
      const result = await validator.validate({ name: '' }, testSchemaPath);

      assert.ok(result.errors.some((e) => e.includes('minimum 1 characters')));
    });
  });

  suite('File Reference Validation', () => {
    test('should not check file references by default', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const collectionWithRefs = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        items: [
          { path: 'nonexistent.txt', kind: 'prompt' }
        ]
      };

      const result = await validator.validateCollection(collectionWithRefs);

      // Should be valid (schema-wise) even if files don't exist
      assert.strictEqual(result.valid, true);
      // Should not have file reference errors
      assert.ok(!result.errors.some((e) => e.includes('not found')));
    });

    test('should check file references when option enabled', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const collectionWithRefs = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        items: [
          { path: 'nonexistent.txt', kind: 'prompt' }
        ]
      };

      const result = await validator.validateCollection(collectionWithRefs, {
        checkFileReferences: true,
        workspaceRoot: tempDir
      });

      // Should have file reference errors
      assert.ok(result.errors.some((e) => e.includes('not found')));
    });

    test('should pass when referenced files exist', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      // Create test file
      const testFilePath = path.join(tempDir, 'exists.txt');
      fs.writeFileSync(testFilePath, 'test content');

      const collectionWithRefs = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        items: [
          { path: 'exists.txt', kind: 'prompt' }
        ]
      };

      const result = await validator.validateCollection(collectionWithRefs, {
        checkFileReferences: true,
        workspaceRoot: tempDir
      });

      // Should not have file reference errors
      assert.ok(!result.errors.some((e) => e.includes('not found')));
    });
  });

  suite('Warning Generation', () => {
    test('should warn about long descriptions', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const collection = {
        id: 'test',
        name: 'Test',
        description: 'x'.repeat(350), // Over 300 but under 500
        items: []
      };

      const result = await validator.validateCollection(collection);

      assert.ok(result.warnings.some((w) => w.includes('quite long')));
    });

    test('should warn about empty collections', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const result = await validator.validateCollection(minimalCollection);

      assert.ok(result.warnings.some((w) => w.includes('no items')));
    });

    test('should warn about too many items', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const manyItems = Array.from({ length: 35 }, (_, i) => ({
        path: `item${i}.txt`,
        kind: 'prompt' as const
      }));

      const collection = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        items: manyItems
      };

      const result = await validator.validateCollection(collection);

      assert.ok(result.warnings.some((w) => w.includes('many items')));
    });

    test('should warn about missing version', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const result = await validator.validateCollection(minimalCollection);

      assert.ok(result.warnings.some((w) => w.includes('version')));
    });

    test('should warn about missing author', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const result = await validator.validateCollection(minimalCollection);

      assert.ok(result.warnings.some((w) => w.includes('author')));
    });

    test('should not warn when metadata is complete', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const result = await validator.validateCollection(validCollection);

      // Should have minimal warnings (only about empty items if any)
      const metadataWarnings = result.warnings.filter((w) =>
        w.includes('version') || w.includes('author')
      );
      assert.strictEqual(metadataWarnings.length, 0);
    });
  });

  suite('MCP Remote Server Types (HTTP/SSE)', () => {
    test('should validate HTTP MCP server with url', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const httpMcpCollection = {
        id: 'test-http-mcp',
        name: 'HTTP MCP Collection',
        description: 'Collection with HTTP MCP server',
        items: [],
        mcp: {
          items: {
            'remote-api': {
              type: 'http',
              url: 'https://api.example.com/mcp'
            }
          }
        }
      };

      const result = await validator.validateCollection(httpMcpCollection);
      assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
    });

    test('should validate SSE MCP server with url', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const sseMcpCollection = {
        id: 'test-sse-mcp',
        name: 'SSE MCP Collection',
        description: 'Collection with SSE MCP server',
        items: [],
        mcp: {
          items: {
            'sse-stream': {
              type: 'sse',
              url: 'https://stream.example.com/events'
            }
          }
        }
      };

      const result = await validator.validateCollection(sseMcpCollection);
      assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
    });

    test('should validate HTTP MCP server with headers', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const httpWithHeaders = {
        id: 'test-http-headers',
        name: 'HTTP with Headers',
        description: 'HTTP MCP with authentication headers',
        items: [],
        mcp: {
          items: {
            'authenticated-api': {
              type: 'http',
              url: 'https://api.example.com/mcp',
              headers: {
                Authorization: 'Bearer ${input:api-token}',
                'X-Custom-Header': 'value'
              }
            }
          }
        }
      };

      const result = await validator.validateCollection(httpWithHeaders);
      assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
    });

    test('should reject HTTP MCP server without url', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const invalidHttpMcp = {
        id: 'test-invalid-http',
        name: 'Invalid HTTP MCP',
        description: 'HTTP MCP missing url',
        items: [],
        mcp: {
          items: {
            'broken-http': {
              type: 'http'
            }
          }
        }
      };

      const result = await validator.validateCollection(invalidHttpMcp);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('url')));
    });

    test('should reject SSE MCP server without url', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const invalidSseMcp = {
        id: 'test-invalid-sse',
        name: 'Invalid SSE MCP',
        description: 'SSE MCP missing url',
        items: [],
        mcp: {
          items: {
            'broken-sse': {
              type: 'sse',
              headers: {
                Authorization: 'Bearer token'
              }
            }
          }
        }
      };

      const result = await validator.validateCollection(invalidSseMcp);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('url')));
    });
  });

  suite('MCP Stdio Server with envFile', () => {
    test('should validate stdio MCP server with envFile', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const stdioWithEnvFile = {
        id: 'test-stdio-envfile',
        name: 'Stdio with EnvFile',
        description: 'Stdio MCP with environment file',
        items: [],
        mcp: {
          items: {
            'local-server': {
              type: 'stdio',
              command: 'node',
              args: ['${bundlePath}/server.js'],
              envFile: '${bundlePath}/.env'
            }
          }
        }
      };

      const result = await validator.validateCollection(stdioWithEnvFile);
      assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
    });

    test('should validate stdio MCP server with both env and envFile', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const stdioWithBoth = {
        id: 'test-stdio-both',
        name: 'Stdio with Both',
        description: 'Stdio MCP with env and envFile',
        items: [],
        mcp: {
          items: {
            'hybrid-server': {
              type: 'stdio',
              command: 'python',
              args: ['-m', 'my_mcp_server'],
              env: {
                LOG_LEVEL: 'debug'
              },
              envFile: '${workspaceFolder}/.env'
            }
          }
        }
      };

      const result = await validator.validateCollection(stdioWithBoth);
      assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
    });
  });

  suite('MCP URL Format Support', () => {
    test('should validate Unix socket URL', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const unixSocketMcp = {
        id: 'test-unix-socket',
        name: 'Unix Socket MCP',
        description: 'MCP server via Unix socket',
        items: [],
        mcp: {
          items: {
            'unix-server': {
              type: 'http',
              url: 'unix:///tmp/mcp.sock'
            }
          }
        }
      };

      const result = await validator.validateCollection(unixSocketMcp);
      assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
    });

    test('should validate Windows named pipe URL', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const namedPipeMcp = {
        id: 'test-named-pipe',
        name: 'Named Pipe MCP',
        description: 'MCP server via Windows named pipe',
        items: [],
        mcp: {
          items: {
            'pipe-server': {
              type: 'http',
              url: 'pipe:///pipe/mcp-server'
            }
          }
        }
      };

      const result = await validator.validateCollection(namedPipeMcp);
      assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
    });

    test('should validate standard HTTP URL', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const httpUrlMcp = {
        id: 'test-http-url',
        name: 'HTTP URL MCP',
        description: 'MCP server via HTTP',
        items: [],
        mcp: {
          items: {
            'http-server': {
              type: 'http',
              url: 'http://localhost:3000/mcp'
            }
          }
        }
      };

      const result = await validator.validateCollection(httpUrlMcp);
      assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
    });

    test('should validate HTTPS URL', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const httpsUrlMcp = {
        id: 'test-https-url',
        name: 'HTTPS URL MCP',
        description: 'MCP server via HTTPS',
        items: [],
        mcp: {
          items: {
            'https-server': {
              type: 'http',
              url: 'https://secure.example.com/mcp'
            }
          }
        }
      };

      const result = await validator.validateCollection(httpsUrlMcp);
      assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
    });
  });

  suite('MCP Backward Compatibility', () => {
    test('should accept stdio server without explicit type (defaults to stdio)', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const legacyStdioMcp = {
        id: 'test-legacy-stdio',
        name: 'Legacy Stdio MCP',
        description: 'Stdio MCP without type field',
        items: [],
        mcp: {
          items: {
            'legacy-server': {
              command: 'node',
              args: ['server.js']
            }
          }
        }
      };

      const result = await validator.validateCollection(legacyStdioMcp);
      assert.strictEqual(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
    });

    test('should reject server without type and without command', async function () {
      if (!fs.existsSync(testCollectionSchemaPath)) {
        this.skip();
        return;
      }

      const invalidMcp = {
        id: 'test-invalid-no-type-no-command',
        name: 'Invalid MCP',
        description: 'MCP without type or command',
        items: [],
        mcp: {
          items: {
            'broken-server': {
              args: ['some-arg']
            }
          }
        }
      };

      const result = await validator.validateCollection(invalidMcp);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('command')));
    });
  });
});
