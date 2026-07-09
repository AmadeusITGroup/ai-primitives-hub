/**
 * Generate Manifest Script Tests
 *
 * Tests for the generate-manifest.js CLI script that creates deployment manifests
 * from collection YAML files.
 */
import * as assert from 'node:assert';
import {
  spawnSync,
} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(root: string, relativePath: string, content: string): void {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('Generate Manifest Script', () => {
  let tempDir: string;
  // When compiled to dist-test/test/, resolve back to lib/bin/
  const libRoot = path.resolve(__dirname, '..', '..');
  const scriptPath = path.join(libRoot, 'bin', 'generate-manifest.js');

  beforeEach(() => {
    tempDir = createTempDir('generate-manifest-test-');
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  describe('MCP Servers', () => {
    it('should include MCP servers from mcp.items field', () => {
      // Create collection with MCP servers in mcp.items format (schema format)
      const collectionYaml = `
id: test-collection
name: Test Collection
description: A test collection with MCP servers
version: "1.0.0"
items:
  - path: prompts/test.prompt.md
    kind: prompt
mcp:
  items:
    test-server:
      command: node
      args:
        - server.js
      env:
        API_KEY: test-key
    another-server:
      command: python
      args:
        - mcp_server.py
`;

      writeFile(tempDir, 'collections/test.collection.yml', collectionYaml);
      writeFile(tempDir, 'prompts/test.prompt.md', '# Test Prompt\n\nTest content');

      const outFile = path.join(tempDir, 'deployment-manifest.yml');

      // Run the generate-manifest script
      const result = spawnSync('node', [scriptPath, '1.0.0', '--collection-file', 'collections/test.collection.yml', '--out', outFile], {
        cwd: tempDir,
        encoding: 'utf8'
      });

      assert.strictEqual(result.status, 0, `Script failed: ${result.stderr}`);
      assert.ok(fs.existsSync(outFile), 'Manifest file should be created');

      // Parse the generated manifest
      const manifestContent = fs.readFileSync(outFile, 'utf8');
      const manifest = yaml.load(manifestContent) as any;

      // Verify MCP servers are included
      assert.ok(manifest.mcpServers, 'Manifest should include mcpServers field');
      assert.strictEqual(Object.keys(manifest.mcpServers).length, 2, 'Should have 2 MCP servers');
      assert.ok(manifest.mcpServers['test-server'], 'Should include test-server');
      assert.ok(manifest.mcpServers['another-server'], 'Should include another-server');

      // Verify server configuration
      assert.strictEqual(manifest.mcpServers['test-server'].command, 'node');
      assert.deepStrictEqual(manifest.mcpServers['test-server'].args, ['server.js']);
      assert.deepStrictEqual(manifest.mcpServers['test-server'].env, { API_KEY: 'test-key' });
    });

    it('should include MCP servers from mcpServers field (legacy format)', () => {
      // Create collection with MCP servers in mcpServers format (manifest format)
      const collectionYaml = `
id: legacy-collection
name: Legacy Collection
description: A collection with legacy mcpServers format
version: "1.0.0"
items:
  - path: prompts/test.prompt.md
    kind: prompt
mcpServers:
  legacy-server:
    command: npx
    args:
      - legacy-mcp
`;

      writeFile(tempDir, 'collections/legacy.collection.yml', collectionYaml);
      writeFile(tempDir, 'prompts/test.prompt.md', '# Test Prompt\n\nTest content');

      const outFile = path.join(tempDir, 'deployment-manifest.yml');

      const result = spawnSync('node', [scriptPath, '1.0.0', '--collection-file', 'collections/legacy.collection.yml', '--out', outFile], {
        cwd: tempDir,
        encoding: 'utf8'
      });

      assert.strictEqual(result.status, 0, `Script failed: ${result.stderr}`);

      const manifestContent = fs.readFileSync(outFile, 'utf8');
      const manifest = yaml.load(manifestContent) as any;

      assert.ok(manifest.mcpServers, 'Manifest should include mcpServers field');
      assert.ok(manifest.mcpServers['legacy-server'], 'Should include legacy-server');
      assert.strictEqual(manifest.mcpServers['legacy-server'].command, 'npx');
    });

    it('should not include mcpServers field when no MCP servers defined', () => {
      const collectionYaml = `
id: no-mcp-collection
name: No MCP Collection
description: A collection without MCP servers
version: "1.0.0"
items:
  - path: prompts/test.prompt.md
    kind: prompt
`;

      writeFile(tempDir, 'collections/no-mcp.collection.yml', collectionYaml);
      writeFile(tempDir, 'prompts/test.prompt.md', '# Test Prompt\n\nTest content');

      const outFile = path.join(tempDir, 'deployment-manifest.yml');

      const result = spawnSync('node', [scriptPath, '1.0.0', '--collection-file', 'collections/no-mcp.collection.yml', '--out', outFile], {
        cwd: tempDir,
        encoding: 'utf8'
      });

      assert.strictEqual(result.status, 0, `Script failed: ${result.stderr}`);

      const manifestContent = fs.readFileSync(outFile, 'utf8');
      const manifest = yaml.load(manifestContent) as any;

      assert.strictEqual(manifest.mcpServers, undefined, 'Manifest should not include mcpServers field when none defined');
    });

    it('should log MCP servers count when present', () => {
      const collectionYaml = `
id: logged-collection
name: Logged Collection
description: A collection to test logging
version: "1.0.0"
items:
  - path: prompts/test.prompt.md
    kind: prompt
mcp:
  items:
    server-one:
      command: node
      args: [server.js]
    server-two:
      command: python
      args: [server.py]
    server-three:
      command: npx
      args: [mcp-server]
`;

      writeFile(tempDir, 'collections/logged.collection.yml', collectionYaml);
      writeFile(tempDir, 'prompts/test.prompt.md', '# Test Prompt\n\nTest content');

      const outFile = path.join(tempDir, 'deployment-manifest.yml');

      const result = spawnSync('node', [scriptPath, '1.0.0', '--collection-file', 'collections/logged.collection.yml', '--out', outFile], {
        cwd: tempDir,
        encoding: 'utf8'
      });

      assert.strictEqual(result.status, 0, `Script failed: ${result.stderr}`);
      assert.ok(result.stdout.includes('MCP Servers: 3'), 'Should log MCP servers count in output');
    });
  });

  describe('Basic Manifest Generation', () => {
    it('should generate valid manifest from collection', () => {
      const collectionYaml = `
id: basic-collection
name: Basic Collection
description: A basic test collection
version: "1.0.0"
items:
  - path: prompts/test.prompt.md
    kind: prompt
`;

      writeFile(tempDir, 'collections/basic.collection.yml', collectionYaml);
      writeFile(tempDir, 'prompts/test.prompt.md', '# Test Prompt\n\nTest content');

      const outFile = path.join(tempDir, 'deployment-manifest.yml');

      const result = spawnSync('node', [scriptPath, '1.0.0', '--collection-file', 'collections/basic.collection.yml', '--out', outFile], {
        cwd: tempDir,
        encoding: 'utf8'
      });

      assert.strictEqual(result.status, 0, `Script failed: ${result.stderr}`);
      assert.ok(fs.existsSync(outFile), 'Manifest file should be created');

      const manifestContent = fs.readFileSync(outFile, 'utf8');
      const manifest = yaml.load(manifestContent) as any;

      assert.strictEqual(manifest.id, 'basic-collection');
      assert.strictEqual(manifest.version, '1.0.0');
      assert.strictEqual(manifest.name, 'Basic Collection');
      assert.ok(Array.isArray(manifest.prompts));
      assert.strictEqual(manifest.prompts.length, 1);
    });
  });

  describe('README asset', () => {
    it('should record the README basename when the collection declares a readme', () => {
      const collectionYaml = `
id: readme-collection
name: Readme Collection
description: A collection with a readme
version: "1.0.0"
readme:
  path: docs/collection-overview.md
items:
  - path: prompts/test.prompt.md
    kind: prompt
`;

      writeFile(tempDir, 'collections/readme.collection.yml', collectionYaml);
      writeFile(tempDir, 'prompts/test.prompt.md', '# Test Prompt\n\nTest content');
      writeFile(tempDir, 'docs/collection-overview.md', '# Overview');

      const outFile = path.join(tempDir, 'deployment-manifest.yml');

      const result = spawnSync('node', [scriptPath, '1.0.0', '--collection-file', 'collections/readme.collection.yml', '--out', outFile], {
        cwd: tempDir,
        encoding: 'utf8'
      });

      assert.strictEqual(result.status, 0, `Script failed: ${result.stderr}`);

      const manifest = yaml.load(fs.readFileSync(outFile, 'utf8')) as any;

      // GitHub names the release asset after the file basename, so the manifest
      // records the basename rather than the full declared path.
      assert.strictEqual(manifest.readme, 'collection-overview.md');
    });

    it('should not include a readme field when the collection has none', () => {
      const collectionYaml = `
id: no-readme-collection
name: No Readme Collection
description: A collection without a readme
version: "1.0.0"
items:
  - path: prompts/test.prompt.md
    kind: prompt
`;

      writeFile(tempDir, 'collections/no-readme.collection.yml', collectionYaml);
      writeFile(tempDir, 'prompts/test.prompt.md', '# Test Prompt\n\nTest content');

      const outFile = path.join(tempDir, 'deployment-manifest.yml');

      const result = spawnSync('node', [scriptPath, '1.0.0', '--collection-file', 'collections/no-readme.collection.yml', '--out', outFile], {
        cwd: tempDir,
        encoding: 'utf8'
      });

      assert.strictEqual(result.status, 0, `Script failed: ${result.stderr}`);

      const manifest = yaml.load(fs.readFileSync(outFile, 'utf8')) as any;
      assert.strictEqual(manifest.readme, undefined);
    });
  });
});
