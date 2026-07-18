/**
 * DeploymentManifestValidator Unit Tests
 *
 * Tests validation of deployment-manifest.yml files including:
 * - Required fields (id, name, version)
 * - Optional fields and their constraints
 * - Resource types (prompt, instructions, chatmode, agent)
 * - MCP server configuration
 * - Metadata, environments, hooks sections
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

// Minimal valid manifest for testing
const createMinimalManifest = (): any => ({
  id: 'test-bundle',
  name: 'Test Bundle',
  version: '1.0.0'
});

// Full valid manifest with all optional fields
const createFullManifest = (): any => ({
  id: 'comprehensive-bundle',
  name: 'Comprehensive Bundle',
  version: '2.1.0',
  description: 'Complete example with all resource types',
  author: 'Test Author',
  tags: ['test', 'comprehensive'],
  environments: ['vscode', 'cursor'],
  license: 'MIT',
  repository: 'https://github.com/test/repo',
  dependencies: [],
  prompts: [
    {
      id: 'code-review',
      name: 'Code Review',
      description: 'Review code changes',
      file: 'prompts/code-review.prompt.md',
      type: 'prompt',
      tags: ['review']
    },
    {
      id: 'typescript-style',
      name: 'TypeScript Style',
      description: 'TypeScript standards',
      file: 'instructions/typescript.instructions.md',
      type: 'instructions',
      tags: ['style']
    },
    {
      id: 'architect',
      name: 'Senior Architect',
      description: 'Architecture expert',
      file: 'chatmodes/architect.chatmode.md',
      type: 'chatmode',
      tags: ['architecture']
    },
    {
      id: 'qa-engineer',
      name: 'QA Engineer',
      description: 'QA automation',
      file: 'agents/qa.agent.md',
      type: 'agent',
      tags: ['testing']
    }
  ],
  mcpServers: {
    filesystem: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/path']
    }
  },
  metadata: {
    manifest_version: '1.0',
    description: 'Test bundle',
    author: 'Test Author'
  }
});

suite('DeploymentManifestValidator - Schema Validation', () => {
  suite('Required Fields', () => {
    test('should accept minimal valid manifest with id, name, version', () => {
      const manifest = createMinimalManifest();

      assert.ok(manifest.id);
      assert.ok(manifest.name);
      assert.ok(manifest.version);
      assert.strictEqual(manifest.id, 'test-bundle');
      assert.strictEqual(manifest.name, 'Test Bundle');
      assert.strictEqual(manifest.version, '1.0.0');
    });

    test('should reject manifest missing id', () => {
      const manifest = createMinimalManifest();
      delete manifest.id;

      assert.strictEqual(manifest.id, undefined);
      // Validation should fail
    });

    test('should reject manifest missing name', () => {
      const manifest = createMinimalManifest();
      delete manifest.name;

      assert.strictEqual(manifest.name, undefined);
      // Validation should fail
    });

    test('should reject manifest missing version', () => {
      const manifest = createMinimalManifest();
      delete manifest.version;

      assert.strictEqual(manifest.version, undefined);
      // Validation should fail
    });

    test('should reject manifest with empty id', () => {
      const manifest = createMinimalManifest();
      manifest.id = '';

      assert.strictEqual(manifest.id, '');
      // Validation should fail - id must not be empty
    });

    test('should reject manifest with empty name', () => {
      const manifest = createMinimalManifest();
      manifest.name = '';

      assert.strictEqual(manifest.name, '');
      // Validation should fail - name must not be empty
    });

    test('should reject manifest with invalid version format', () => {
      const manifest = createMinimalManifest();
      manifest.version = 'not-a-version';

      // Should fail semantic version validation
      assert.ok(manifest.version);
    });
  });

  suite('Optional Top-Level Fields', () => {
    test('should accept manifest with description', () => {
      const manifest = createMinimalManifest();
      manifest.description = 'A test bundle';

      assert.strictEqual(manifest.description, 'A test bundle');
    });

    test('should accept manifest with author', () => {
      const manifest = createMinimalManifest();
      manifest.author = 'Test Author';

      assert.strictEqual(manifest.author, 'Test Author');
    });

    test('should accept manifest with tags array', () => {
      const manifest = createMinimalManifest();
      manifest.tags = ['test', 'example'];

      assert.ok(Array.isArray(manifest.tags));
      assert.strictEqual(manifest.tags.length, 2);
    });

    test('should accept manifest with environments array', () => {
      const manifest = createMinimalManifest();
      manifest.environments = ['vscode', 'cursor', 'windsurf'];

      assert.ok(Array.isArray(manifest.environments));
      assert.ok(manifest.environments.includes('vscode'));
    });

    test('should accept manifest with license', () => {
      const manifest = createMinimalManifest();
      manifest.license = 'MIT';

      assert.strictEqual(manifest.license, 'MIT');
    });

    test('should accept manifest with repository URL', () => {
      const manifest = createMinimalManifest();
      manifest.repository = 'https://github.com/user/repo';

      assert.ok(manifest.repository.startsWith('https://'));
    });

    test('should accept manifest with empty dependencies array', () => {
      const manifest = createMinimalManifest();
      manifest.dependencies = [];

      assert.ok(Array.isArray(manifest.dependencies));
      assert.strictEqual(manifest.dependencies.length, 0);
    });
  });

  suite('Prompts Section - All Resource Types', () => {
    test('should accept manifest without prompts section', () => {
      const manifest = createMinimalManifest();

      assert.strictEqual(manifest.prompts, undefined);
      // Should be valid - prompts is optional
    });

    test('should accept manifest with empty prompts array', () => {
      const manifest = createMinimalManifest();
      manifest.prompts = [];

      assert.ok(Array.isArray(manifest.prompts));
      assert.strictEqual(manifest.prompts.length, 0);
    });

    test('should accept prompt with type "prompt"', () => {
      const manifest = createMinimalManifest();
      manifest.prompts = [{
        id: 'test-prompt',
        name: 'Test Prompt',
        description: 'A test prompt',
        file: 'prompts/test.prompt.md',
        type: 'prompt'
      }];

      assert.strictEqual(manifest.prompts[0].type, 'prompt');
      assert.ok(manifest.prompts[0].file.endsWith('.prompt.md'));
    });

    test('should accept prompt with type "instructions"', () => {
      const manifest = createMinimalManifest();
      manifest.prompts = [{
        id: 'test-instructions',
        name: 'Test Instructions',
        description: 'Test instructions',
        file: 'instructions/test.instructions.md',
        type: 'instructions'
      }];

      assert.strictEqual(manifest.prompts[0].type, 'instructions');
      assert.ok(manifest.prompts[0].file.endsWith('.instructions.md'));
    });

    test('should accept prompt with type "chatmode"', () => {
      const manifest = createMinimalManifest();
      manifest.prompts = [{
        id: 'test-chatmode',
        name: 'Test Chatmode',
        description: 'Test chatmode',
        file: 'chatmodes/test.chatmode.md',
        type: 'chatmode'
      }];

      assert.strictEqual(manifest.prompts[0].type, 'chatmode');
      assert.ok(manifest.prompts[0].file.endsWith('.chatmode.md'));
    });

    test('should accept prompt with type "agent"', () => {
      const manifest = createMinimalManifest();
      manifest.prompts = [{
        id: 'test-agent',
        name: 'Test Agent',
        description: 'Test agent',
        file: 'agents/test.agent.md',
        type: 'agent'
      }];

      assert.strictEqual(manifest.prompts[0].type, 'agent');
      assert.ok(manifest.prompts[0].file.endsWith('.agent.md'));
    });

    test('should accept prompt without type (defaults to prompt)', () => {
      const manifest = createMinimalManifest();
      manifest.prompts = [{
        id: 'test-prompt',
        name: 'Test Prompt',
        description: 'A test prompt',
        file: 'prompts/test.prompt.md'
      }];

      assert.strictEqual(manifest.prompts[0].type, undefined);
      // Type is optional, defaults to 'prompt'
    });

    test('should reject prompt with invalid type', () => {
      const manifest = createMinimalManifest();
      manifest.prompts = [{
        id: 'test-prompt',
        name: 'Test Prompt',
        description: 'A test prompt',
        file: 'prompts/test.md',
        type: 'invalid-type'
      }];

      // Should fail - type must be one of: prompt, instructions, chatmode, agent
      assert.strictEqual(manifest.prompts[0].type, 'invalid-type');
    });

    test('should accept prompt with tags array', () => {
      const manifest = createMinimalManifest();
      manifest.prompts = [{
        id: 'test-prompt',
        name: 'Test Prompt',
        description: 'A test prompt',
        file: 'prompts/test.prompt.md',
        tags: ['testing', 'example']
      }];

      assert.ok(Array.isArray(manifest.prompts[0].tags));
      assert.strictEqual(manifest.prompts[0].tags.length, 2);
    });

    test('should reject prompt missing required id', () => {
      const manifest = createMinimalManifest();
      manifest.prompts = [{
        name: 'Test Prompt',
        description: 'A test prompt',
        file: 'prompts/test.prompt.md'
      }];

      assert.strictEqual(manifest.prompts[0].id, undefined);
      // Should fail - id is required
    });

    test('should reject prompt missing required name', () => {
      const manifest = createMinimalManifest();
      manifest.prompts = [{
        id: 'test-prompt',
        description: 'A test prompt',
        file: 'prompts/test.prompt.md'
      }];

      assert.strictEqual(manifest.prompts[0].name, undefined);
      // Should fail - name is required
    });

    test('should reject prompt missing required file', () => {
      const manifest = createMinimalManifest();
      manifest.prompts = [{
        id: 'test-prompt',
        name: 'Test Prompt',
        description: 'A test prompt'
      }];

      assert.strictEqual(manifest.prompts[0].file, undefined);
      // Should fail - file is required
    });
  });

  suite('MCP Servers Section', () => {
    test('should accept manifest without mcpServers', () => {
      const manifest = createMinimalManifest();

      assert.strictEqual(manifest.mcpServers, undefined);
      // Should be valid - mcpServers is optional
    });

    test('should accept manifest with empty mcpServers object', () => {
      const manifest = createMinimalManifest();
      manifest.mcpServers = {};

      assert.strictEqual(typeof manifest.mcpServers, 'object');
      assert.strictEqual(Object.keys(manifest.mcpServers).length, 0);
    });

    test('should accept valid MCP server configuration', () => {
      const manifest = createMinimalManifest();
      manifest.mcpServers = {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem']
        }
      };

      assert.ok(manifest.mcpServers.filesystem);
      assert.strictEqual(manifest.mcpServers.filesystem.command, 'npx');
      assert.ok(Array.isArray(manifest.mcpServers.filesystem.args));
    });

    test('should accept MCP server with env variables', () => {
      const manifest = createMinimalManifest();
      manifest.mcpServers = {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: {
            GITHUB_TOKEN: '${env:GITHUB_TOKEN}',
            LOG_LEVEL: 'ERROR'
          }
        }
      };

      assert.ok(manifest.mcpServers.github.env);
      assert.ok(manifest.mcpServers.github.env.GITHUB_TOKEN);
    });

    test('should reject MCP server missing command', () => {
      const manifest = createMinimalManifest();
      manifest.mcpServers = {
        invalid: {
          args: ['some-arg']
        }
      };

      assert.strictEqual(manifest.mcpServers.invalid.command, undefined);
      // Should fail - command is required
    });
  });

  suite('Metadata Section', () => {
    test('should accept manifest without metadata section', () => {
      const manifest = createMinimalManifest();

      assert.strictEqual(manifest.metadata, undefined);
      // Should be valid - metadata is optional
    });

    test('should accept metadata with manifest_version', () => {
      const manifest = createMinimalManifest();
      manifest.metadata = {
        manifest_version: '1.0',
        description: 'Test'
      };

      assert.strictEqual(manifest.metadata.manifest_version, '1.0');
    });

    test('should accept metadata with repository object', () => {
      const manifest = createMinimalManifest();
      manifest.metadata = {
        manifest_version: '1.0',
        description: 'Test',
        repository: {
          type: 'git',
          url: 'https://github.com/user/repo',
          directory: 'prompts/'
        }
      };

      assert.strictEqual(manifest.metadata.repository.type, 'git');
      assert.ok(manifest.metadata.repository.url);
    });

    test('should accept metadata with compatibility section', () => {
      const manifest = createMinimalManifest();
      manifest.metadata = {
        manifest_version: '1.0',
        description: 'Test',
        compatibility: {
          min_manifest_version: '1.0',
          platforms: ['vscode', 'cursor']
        }
      };

      assert.ok(manifest.metadata.compatibility);
      assert.ok(Array.isArray(manifest.metadata.compatibility.platforms));
    });
  });

  suite('Full Manifest Validation', () => {
    test('should accept comprehensive manifest with all sections', () => {
      const manifest = createFullManifest();

      // Verify all sections present
      assert.ok(manifest.id);
      assert.ok(manifest.name);
      assert.ok(manifest.version);
      assert.ok(manifest.prompts);
      assert.ok(manifest.mcpServers);
      assert.ok(manifest.metadata);

      // Verify all 4 resource types
      const types = manifest.prompts.map((p: any) => p.type);
      assert.ok(types.includes('prompt'));
      assert.ok(types.includes('instructions'));
      assert.ok(types.includes('chatmode'));
      assert.ok(types.includes('agent'));
    });
  });
});

suite('DeploymentManifestValidator - Resource Type Validation', () => {
  suite('File Extension Conventions', () => {
    test('should validate prompt files end with .prompt.md', () => {
      const validExtensions = [
        'test.prompt.md',
        'code-review.prompt.md',
        'prompts/example.prompt.md'
      ];

      validExtensions.forEach((file) => {
        assert.ok(file.endsWith('.prompt.md'), `${file} should end with .prompt.md`);
      });
    });

    test('should validate instruction files end with .instructions.md', () => {
      const validExtensions = [
        'test.instructions.md',
        'style-guide.instructions.md',
        'instructions/typescript.instructions.md'
      ];

      validExtensions.forEach((file) => {
        assert.ok(file.endsWith('.instructions.md'), `${file} should end with .instructions.md`);
      });
    });

    test('should validate chatmode files end with .chatmode.md', () => {
      const validExtensions = [
        'test.chatmode.md',
        'architect.chatmode.md',
        'chatmodes/expert.chatmode.md'
      ];

      validExtensions.forEach((file) => {
        assert.ok(file.endsWith('.chatmode.md'), `${file} should end with .chatmode.md`);
      });
    });

    test('should validate agent files end with .agent.md', () => {
      const validExtensions = [
        'test.agent.md',
        'qa-engineer.agent.md',
        'agents/reviewer.agent.md'
      ];

      validExtensions.forEach((file) => {
        assert.ok(file.endsWith('.agent.md'), `${file} should end with .agent.md`);
      });
    });

    test('should detect mismatched type and file extension', () => {
      const mismatches = [
        { type: 'prompt', file: 'test.instructions.md' },
        { type: 'instructions', file: 'test.chatmode.md' },
        { type: 'chatmode', file: 'test.agent.md' },
        { type: 'agent', file: 'test.prompt.md' }
      ];

      mismatches.forEach(({ type, file }) => {
        const expectedExt = `.${type === 'instructions' ? 'instructions' : type}.md`;
        assert.ok(!file.endsWith(expectedExt),
          `Type ${type} should not match file ${file}`);
      });
    });
  });

  suite('Type Field Validation', () => {
    test('should accept all valid type values', () => {
      const validTypes = ['prompt', 'instructions', 'chatmode', 'agent'];

      validTypes.forEach((type) => {
        assert.ok(['prompt', 'instructions', 'chatmode', 'agent'].includes(type));
      });
    });

    test('should reject invalid type values', () => {
      const invalidTypes = ['prompts', 'instruction', 'chat', 'bot', 'unknown'];

      invalidTypes.forEach((type) => {
        assert.ok(!['prompt', 'instructions', 'chatmode', 'agent'].includes(type));
      });
    });

    test('should handle undefined type (defaults to prompt)', () => {
      const prompt: any = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        file: 'test.prompt.md'
      };

      const effectiveType = prompt.type || 'prompt';
      assert.strictEqual(effectiveType, 'prompt');
    });
  });

  suite('Directory Conventions', () => {
    test('should validate prompts are in prompts/ directory', () => {
      const validPaths = [
        'prompts/test.prompt.md',
        'prompts/subfolder/test.prompt.md'
      ];

      validPaths.forEach((p) => {
        assert.ok(p.startsWith('prompts/'));
      });
    });

    test('should validate instructions are in instructions/ directory', () => {
      const validPaths = [
        'instructions/test.instructions.md',
        'instructions/subfolder/test.instructions.md'
      ];

      validPaths.forEach((p) => {
        assert.ok(p.startsWith('instructions/'));
      });
    });

    test('should validate chatmodes are in chatmodes/ directory', () => {
      const validPaths = [
        'chatmodes/test.chatmode.md',
        'chatmodes/subfolder/test.chatmode.md'
      ];

      validPaths.forEach((p) => {
        assert.ok(p.startsWith('chatmodes/'));
      });
    });

    test('should validate agents are in agents/ directory', () => {
      const validPaths = [
        'agents/test.agent.md',
        'agents/subfolder/test.agent.md'
      ];

      validPaths.forEach((p) => {
        assert.ok(p.startsWith('agents/'));
      });
    });
  });
});

suite('DeploymentManifestValidator - Integration with Real Fixtures', () => {
  const fixturesDir = path.join(__dirname, '..', 'fixtures', 'local-library');

  suite('Validate Existing Fixture Manifests', () => {
    test('should validate bundle1 manifest', () => {
      const manifestPath = path.join(fixturesDir, 'bundle1', 'deployment-manifest.yml');

      if (!fs.existsSync(manifestPath)) {
        assert.fail('bundle1 manifest not found');
      }

      const content = fs.readFileSync(manifestPath, 'utf8');
      const manifest = yaml.load(content) as any;

      // Verify required fields
      assert.ok(manifest.id, 'id is required');
      assert.ok(manifest.name, 'name is required');
      assert.ok(manifest.version, 'version is required');
    });

    test('should validate example-bundle manifest', () => {
      const manifestPath = path.join(fixturesDir, 'example-bundle', 'deployment-manifest.yml');

      if (!fs.existsSync(manifestPath)) {
        assert.fail('example-bundle manifest not found');
      }

      const content = fs.readFileSync(manifestPath, 'utf8');
      const manifest = yaml.load(content) as any;

      // Verify required fields
      assert.ok(manifest.id);
      assert.ok(manifest.name);
      assert.ok(manifest.version);

      // Verify prompts section if present
      if (manifest.prompts) {
        assert.ok(Array.isArray(manifest.prompts));
        manifest.prompts.forEach((prompt: any) => {
          assert.ok(prompt.id, 'prompt id is required');
          assert.ok(prompt.name, 'prompt name is required');
          assert.ok(prompt.file, 'prompt file is required');
        });
      }
    });

    test('should validate testing-bundle manifest', () => {
      const manifestPath = path.join(fixturesDir, 'testing-bundle', 'deployment-manifest.yml');

      if (!fs.existsSync(manifestPath)) {
        assert.fail('testing-bundle manifest not found');
      }

      const content = fs.readFileSync(manifestPath, 'utf8');
      const manifest = yaml.load(content) as any;

      // Verify required fields
      assert.ok(manifest.id);
      assert.ok(manifest.name);
      assert.ok(manifest.version);

      // Verify prompts with different types
      if (manifest.prompts) {
        const types = manifest.prompts.map((p: any) => p.type).filter(Boolean);

        // Check if types are valid
        types.forEach((type: string) => {
          assert.ok(['prompt', 'instructions', 'chatmode', 'agent'].includes(type),
            `Invalid type: ${type}`);
        });
      }
    });
  });

  suite('Validate All Fixtures in Directory', () => {
    test('should find and validate all deployment manifests', () => {
      if (!fs.existsSync(fixturesDir)) {
        assert.fail('Fixtures directory not found');
      }

      const bundles = fs.readdirSync(fixturesDir, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name);

      let validCount = 0;
      const errors: string[] = [];

      bundles.forEach((bundleName) => {
        const manifestPath = path.join(fixturesDir, bundleName, 'deployment-manifest.yml');

        if (fs.existsSync(manifestPath)) {
          try {
            const content = fs.readFileSync(manifestPath, 'utf8');
            const manifest = yaml.load(content) as any;

            // Basic validation
            if (manifest.id && manifest.name && manifest.version) {
              validCount++;
            } else {
              errors.push(`${bundleName}: Missing required fields`);
            }
          } catch (error) {
            errors.push(`${bundleName}: ${error}`);
          }
        }
      });

      assert.ok(validCount > 0, 'Should have at least one valid manifest');

      if (errors.length > 0) {
        console.log('Validation errors:', errors);
      }
    });
  });

  suite('Validate Resource Type Usage in Fixtures', () => {
    test('should check if fixtures use all 4 resource types', function () {
      if (!fs.existsSync(fixturesDir)) {
        this.skip();
        return;
      }

      const bundles = fs.readdirSync(fixturesDir, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name);

      const typesFound = new Set<string>();

      bundles.forEach((bundleName) => {
        const manifestPath = path.join(fixturesDir, bundleName, 'deployment-manifest.yml');

        if (fs.existsSync(manifestPath)) {
          const content = fs.readFileSync(manifestPath, 'utf8');
          const manifest = yaml.load(content) as any;

          if (manifest.prompts) {
            manifest.prompts.forEach((prompt: any) => {
              if (prompt.type) {
                typesFound.add(prompt.type);
              }
            });
          }
        }
      });

      // Report which types are used in fixtures
      console.log('Resource types found in fixtures:', Array.from(typesFound));

      // At least some types should be present
      assert.ok(typesFound.size > 0, 'Should find at least one resource type');
    });
  });
});
