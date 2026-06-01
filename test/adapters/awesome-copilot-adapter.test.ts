/**
 * AwesomeCopilotAdapter Unit Tests
 * Tests the dynamic bundle creation from YAML collections using GitHubClient mocks
 */

import * as assert from 'node:assert';
import AdmZip from 'adm-zip';
import * as sinon from 'sinon';
import {
  AwesomeCopilotAdapter,
} from '../../src/adapters/awesome-copilot-adapter';
import {
  GitHubClient,
} from '../../src/services/github-client';
import {
  GitHubNotFoundError,
} from '../../src/services/github-client-errors';
import {
  Bundle,
  RegistrySource,
} from '../../src/types/registry';

suite('AwesomeCopilotAdapter', () => {
  let sandbox: sinon.SinonSandbox;
  let mockClient: sinon.SinonStubbedInstance<GitHubClient>;

  const mockSource: RegistrySource = {
    id: 'awesome-test',
    name: 'Awesome Copilot Test',
    type: 'awesome-copilot',
    url: 'https://github.com/test-owner/awesome-copilot',
    enabled: true,
    priority: 1
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    mockClient = sandbox.createStubInstance(GitHubClient);
    Object.defineProperty(mockClient, 'owner', { value: 'test-owner', configurable: true });
    Object.defineProperty(mockClient, 'repo', { value: 'awesome-copilot', configurable: true });
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('Constructor and Validation', () => {
    test('should accept valid awesome-copilot source', () => {
      const adapter = new AwesomeCopilotAdapter(mockSource, mockClient);
      assert.strictEqual(adapter.type, 'awesome-copilot');
    });

    test('should accept GitHub URL format', () => {
      const source = { ...mockSource, url: 'https://github.com/microsoft/prompt-bundle-spec' };
      const client = sandbox.createStubInstance(GitHubClient);
      Object.defineProperty(client, 'owner', { value: 'microsoft', configurable: true });
      Object.defineProperty(client, 'repo', { value: 'prompt-bundle-spec', configurable: true });
      const adapter = new AwesomeCopilotAdapter(source, client);
      assert.ok(adapter);
    });
  });

  suite('fetchBundles', () => {
    test('should fetch collections from repository', async () => {
      // Mock the collections directory listing
      mockClient.getContents.withArgs('collections', 'main').resolves([
        { name: 'test-collection.collection.yml', path: 'collections/test-collection.collection.yml', type: 'file' }
      ]);

      // Mock the collection file content
      mockClient.getFileContent.withArgs('collections/test-collection.collection.yml', 'main').resolves(
        Buffer.from(`id: test-collection
name: Test Collection
description: Test collection for unit tests
tags: ["test", "example"]
items:
  - path: "prompts/test.prompt.md"
    kind: prompt
`)
      );

      const adapter = new AwesomeCopilotAdapter(mockSource, mockClient);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 1);
      assert.strictEqual(bundles[0].id, 'test-collection');
      assert.strictEqual(bundles[0].name, 'Test Collection');
      assert.strictEqual(bundles[0].version, '1.0.0');
      assert.strictEqual(bundles[0].sourceId, 'awesome-test');
    });

    test('should skip invalid YAML files', async () => {
      mockClient.getContents.withArgs('collections', 'main').resolves([
        { name: 'invalid.collection.yml', path: 'collections/invalid.collection.yml', type: 'file' }
      ]);

      mockClient.getFileContent.withArgs('collections/invalid.collection.yml', 'main').resolves(
        Buffer.from('invalid: yaml: content:')
      );

      const adapter = new AwesomeCopilotAdapter(mockSource, mockClient);
      const bundles = await adapter.fetchBundles();

      // Should handle parsing error gracefully (returns null for invalid collections)
      assert.ok(Array.isArray(bundles));
    });

    test('should handle empty collections directory', async () => {
      mockClient.getContents.withArgs('collections', 'main').resolves([]);

      const adapter = new AwesomeCopilotAdapter(mockSource, mockClient);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 0);
    });

    test('should cache results for 5 minutes', async () => {
      mockClient.getContents.withArgs('collections', 'main').resolves([
        { name: 'cached.collection.yml', path: 'collections/cached.collection.yml', type: 'file' }
      ]);

      mockClient.getFileContent.withArgs('collections/cached.collection.yml', 'main').resolves(
        Buffer.from(`id: cached
name: Cached
description: Test caching
items:
  - path: "prompts/test.prompt.md"
    kind: prompt
`)
      );

      const adapter = new AwesomeCopilotAdapter(mockSource, mockClient);

      // First call should hit the API
      const bundles1 = await adapter.fetchBundles();
      assert.strictEqual(bundles1.length, 1);

      // Second call should use cache (no additional API call)
      const bundles2 = await adapter.fetchBundles();
      assert.strictEqual(bundles2.length, 1);

      // getContents should only be called once
      assert.strictEqual(mockClient.getContents.callCount, 1);
    });

    test('should use custom branch and collectionsPath from config', async () => {
      const source: RegistrySource = {
        ...mockSource,
        config: { branch: 'develop', collectionsPath: 'custom-path' }
      };

      mockClient.getContents.withArgs('custom-path', 'develop').resolves([
        { name: 'test.collection.yml', path: 'custom-path/test.collection.yml', type: 'file' }
      ]);

      mockClient.getFileContent.withArgs('custom-path/test.collection.yml', 'develop').resolves(
        Buffer.from(`id: test
name: Test
description: Custom path
items:
  - path: "prompts/test.prompt.md"
    kind: prompt
`)
      );

      const adapter = new AwesomeCopilotAdapter(source, mockClient);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 1);
      // Verify it called with custom branch and path
      assert.ok(mockClient.getContents.calledWith('custom-path', 'develop'), 'getContents called with custom-path and develop branch');
    });

    test('should set manifestUrl and downloadUrl on bundles', async () => {
      mockClient.getContents.withArgs('collections', 'main').resolves([
        { name: 'urls-test.collection.yml', path: 'collections/urls-test.collection.yml', type: 'file' }
      ]);

      mockClient.getFileContent.withArgs('collections/urls-test.collection.yml', 'main').resolves(
        Buffer.from(`id: urls-test
name: URLs Test
description: Test URL generation
items:
  - path: "prompts/test.prompt.md"
    kind: prompt
`)
      );

      const adapter = new AwesomeCopilotAdapter(mockSource, mockClient);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles[0].manifestUrl, 'https://raw.githubusercontent.com/test-owner/awesome-copilot/main/collections/urls-test.collection.yml');
      assert.strictEqual(bundles[0].downloadUrl, 'https://raw.githubusercontent.com/test-owner/awesome-copilot/main/collections/urls-test.collection.yml');
    });
  });

  suite('downloadBundle - Dynamic ZIP Creation', () => {
    test('should create ZIP archive from collection items', async () => {
      const mockBundle: Bundle = {
        id: 'test-bundle',
        name: 'Test Bundle',
        version: '1.0.0',
        description: 'Test',
        author: 'Test Author',
        sourceId: 'awesome-test',
        environments: ['vscode'],
        tags: ['test'],
        lastUpdated: '2025-01-01T00:00:00Z',
        size: '1KB',
        dependencies: [],
        license: 'MIT',
        manifestUrl: 'https://example.com/manifest.json',
        downloadUrl: 'https://example.com/bundle.zip'
      };

      // Mock collection YAML fetch
      mockClient.getFileContent.withArgs('collections/test-bundle.collection.yml', 'main').resolves(
        Buffer.from(`id: test-bundle
name: Test Bundle
description: Test
tags: []
items:
  - path: "prompts/test.prompt.md"
    kind: prompt
`)
      );

      // Mock prompt file fetch
      mockClient.getFileContent.withArgs('prompts/test.prompt.md', 'main').resolves(
        Buffer.from('# Test Prompt\n\nThis is a test prompt.')
      );

      const adapter = new AwesomeCopilotAdapter(mockSource, mockClient);
      const buffer = await adapter.downloadBundle(mockBundle);

      assert.ok(Buffer.isBuffer(buffer));
      assert.ok(buffer.length > 0);

      // Verify ZIP contents
      const zip = new AdmZip(buffer);
      const entries = zip.getEntries().map((e) => e.entryName);
      assert.ok(entries.includes('deployment-manifest.yml'));
      assert.ok(entries.includes('prompts/test.prompt.md'));
    });

    test('should include deployment-manifest.yml in ZIP', async () => {
      const mockBundle: Bundle = {
        id: 'manifest-test',
        name: 'Manifest Test',
        version: '2.0.0',
        description: 'Test manifest creation',
        author: 'Test',
        sourceId: 'awesome-test',
        environments: ['vscode'],
        tags: [],
        lastUpdated: '2025-01-01',
        size: '1KB',
        dependencies: [],
        license: 'MIT',
        manifestUrl: 'https://example.com/manifest.json',
        downloadUrl: 'https://example.com/bundle.zip'
      };

      mockClient.getFileContent.withArgs('collections/manifest-test.collection.yml', 'main').resolves(
        Buffer.from(`id: manifest-test
name: Manifest Test
description: Test manifest
tags: []
items: []
`)
      );

      const adapter = new AwesomeCopilotAdapter(mockSource, mockClient);
      const buffer = await adapter.downloadBundle(mockBundle);

      // ZIP should contain deployment-manifest.yml
      const zip = new AdmZip(buffer);
      const manifestEntry = zip.getEntry('deployment-manifest.yml');
      assert.ok(manifestEntry, 'Should contain deployment-manifest.yml');
      assert.ok(buffer.length > 100); // Reasonable minimum size for ZIP with manifest
    });

    test('should handle missing prompt files gracefully', async () => {
      const mockBundle: Bundle = {
        id: 'missing-files',
        name: 'Missing Files Test',
        version: '1.0.0',
        description: 'Test',
        author: 'Test',
        sourceId: 'awesome-test',
        environments: [],
        tags: [],
        lastUpdated: '2025-01-01',
        size: '1KB',
        dependencies: [],
        license: 'MIT',
        manifestUrl: 'https://example.com/manifest.json',
        downloadUrl: 'https://example.com/bundle.zip'
      };

      mockClient.getFileContent.withArgs('collections/missing-files.collection.yml', 'main').resolves(
        Buffer.from(`id: missing-files
name: Missing Files
description: Test
tags: []
items:
  - path: "prompts/missing.prompt.md"
    kind: prompt
`)
      );

      // Simulate 404 for the prompt file
      mockClient.getFileContent.withArgs('prompts/missing.prompt.md', 'main').rejects(
        new GitHubNotFoundError('test-owner', 'awesome-copilot', 'prompts/missing.prompt.md')
      );

      const adapter = new AwesomeCopilotAdapter(mockSource, mockClient);

      // Should throw error for missing files
      let errorThrown = false;
      try {
        await adapter.downloadBundle(mockBundle);
      } catch (error: any) {
        errorThrown = true;
        assert.ok(error.message, 'Error should have a message');
      }
      assert.ok(errorThrown, 'Should throw error for missing files');
    });
  });

  suite('fetchMetadata', () => {
    test('should fetch repository metadata', async () => {
      mockClient.getContents.withArgs('collections', 'main').resolves([
        { name: 'col1.collection.yml', path: 'collections/col1.collection.yml', type: 'file' },
        { name: 'col2.collection.yml', path: 'collections/col2.collection.yml', type: 'file' }
      ]);

      const adapter = new AwesomeCopilotAdapter(mockSource, mockClient);
      const metadata = await adapter.fetchMetadata();

      assert.strictEqual(metadata.name, 'test-owner/awesome-copilot');
      assert.ok(metadata.description.includes('Awesome Copilot collections'));
      assert.strictEqual(metadata.bundleCount, 2);
    });
  });

  suite('validate', () => {
    test('should validate accessible repository', async () => {
      mockClient.getContents.withArgs('collections', 'main').resolves([
        { name: 'test.collection.yml', path: 'collections/test.collection.yml', type: 'file' }
      ]);

      const adapter = new AwesomeCopilotAdapter(mockSource, mockClient);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
      assert.strictEqual(result.bundlesFound, 1);
    });

    test('should fail validation for inaccessible repository', async () => {
      mockClient.getContents.withArgs('collections', 'main').rejects(
        new GitHubNotFoundError('test-owner', 'awesome-copilot', 'collections')
      );

      const adapter = new AwesomeCopilotAdapter(mockSource, mockClient);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length > 0);
    });

    test('should fail validation when no collection files found', async () => {
      mockClient.getContents.withArgs('collections', 'main').resolves([
        { name: 'readme.md', path: 'collections/readme.md', type: 'file' }
      ]);

      const adapter = new AwesomeCopilotAdapter(mockSource, mockClient);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors[0].includes('No .collection.yml files found'));
    });
  });

  suite('Content Type Mapping', () => {
    test('should map content types correctly in bundles', async () => {
      mockClient.getContents.withArgs('collections', 'main').resolves([
        { name: 'types.collection.yml', path: 'collections/types.collection.yml', type: 'file' }
      ]);

      mockClient.getFileContent.withArgs('collections/types.collection.yml', 'main').resolves(
        Buffer.from(`id: types
name: Types Test
description: Test content types
tags: []
items:
  - path: "test.prompt.md"
    kind: prompt
  - path: "test.instructions.md"
    kind: instruction
  - path: "test.chat-mode.md"
    kind: chat-mode
  - path: "test.agent.md"
    kind: agent
`)
      );

      const adapter = new AwesomeCopilotAdapter(mockSource, mockClient);
      const bundles = await adapter.fetchBundles();

      assert.ok(bundles.length > 0);
      // Content types are stored in breakdown
      const breakdown = (bundles[0] as any).breakdown;
      assert.strictEqual(breakdown.prompts, 1);
      assert.strictEqual(breakdown.instructions, 1);
      assert.strictEqual(breakdown.agents, 2);
    });
  });

  suite('getManifestUrl / getDownloadUrl', () => {
    test('should build correct raw GitHub URLs', () => {
      const adapter = new AwesomeCopilotAdapter(mockSource, mockClient);

      const manifestUrl = adapter.getManifestUrl('test-bundle');
      assert.strictEqual(manifestUrl, 'https://raw.githubusercontent.com/test-owner/awesome-copilot/main/collections/test-bundle.collection.yml');

      const downloadUrl = adapter.getDownloadUrl('test-bundle');
      assert.strictEqual(downloadUrl, manifestUrl); // Same for awesome-copilot
    });

    test('should use configured branch in URLs', () => {
      const source: RegistrySource = {
        ...mockSource,
        config: { branch: 'develop' }
      };
      const adapter = new AwesomeCopilotAdapter(source, mockClient);

      const url = adapter.getManifestUrl('test-bundle');
      assert.ok(url.includes('/develop/'));
    });
  });
});

suite('Skill Kind Support', () => {
  let sandbox: sinon.SinonSandbox;
  let mockClient: sinon.SinonStubbedInstance<GitHubClient>;

  const mockSource: RegistrySource = {
    id: 'awesome-test',
    name: 'Awesome Copilot Test',
    type: 'awesome-copilot',
    url: 'https://github.com/test-owner/awesome-copilot',
    enabled: true,
    priority: 1
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    mockClient = sandbox.createStubInstance(GitHubClient);
    Object.defineProperty(mockClient, 'owner', { value: 'test-owner', configurable: true });
    Object.defineProperty(mockClient, 'repo', { value: 'awesome-copilot', configurable: true });
  });

  teardown(() => {
    sandbox.restore();
  });

  test('should parse collection with skill items', async () => {
    mockClient.getContents.withArgs('collections', 'main').resolves([
      { name: 'skills-collection.collection.yml', path: 'collections/skills-collection.collection.yml', type: 'file' }
    ]);

    mockClient.getFileContent.withArgs('collections/skills-collection.collection.yml', 'main').resolves(
      Buffer.from(`id: skills-collection
name: Skills Collection
description: Test collection with skills
tags: ["test", "skills"]
items:
  - path: "skills/my-skill/SKILL.md"
    kind: skill
  - path: "prompts/test.prompt.md"
    kind: prompt
`)
    );

    const adapter = new AwesomeCopilotAdapter(mockSource, mockClient);
    const bundles = await adapter.fetchBundles();

    assert.strictEqual(bundles.length, 1);
    assert.strictEqual(bundles[0].id, 'skills-collection');
    // Bundle should have breakdown showing both skill and prompt
    const breakdown = (bundles[0] as any).breakdown;
    assert.strictEqual(breakdown.skills, 1);
    assert.strictEqual(breakdown.prompts, 1);
  });

  test('should fetch entire skill directory when downloading bundle with skills', async () => {
    const mockBundle: Bundle = {
      id: 'skill-bundle',
      name: 'Skill Bundle',
      version: '1.0.0',
      description: 'Bundle with skills',
      author: 'Test Author',
      sourceId: 'awesome-test',
      environments: ['vscode'],
      tags: ['test'],
      lastUpdated: '2025-01-01T00:00:00Z',
      size: '1KB',
      dependencies: [],
      license: 'MIT',
      manifestUrl: 'https://example.com/manifest.json',
      downloadUrl: 'https://example.com/bundle.zip'
    };

    // Mock the collection YAML with a skill item
    mockClient.getFileContent.withArgs('collections/skill-bundle.collection.yml', 'main').resolves(
      Buffer.from(`id: skill-bundle
name: Skill Bundle
description: Bundle with skills
tags: []
items:
  - path: "skills/my-skill/SKILL.md"
    kind: skill
`)
    );

    // Mock recursive directory listing for the skill
    mockClient.getContentsRecursive.withArgs('skills/my-skill', 'main').resolves([
      { name: 'SKILL.md', path: 'skills/my-skill/SKILL.md', type: 'file' },
      { name: 'helper.js', path: 'skills/my-skill/helper.js', type: 'file' },
      { name: 'data', path: 'skills/my-skill/data', type: 'dir' },
      { name: 'config.json', path: 'skills/my-skill/data/config.json', type: 'file' }
    ]);

    // Mock fetching each file in the skill directory
    mockClient.getFileContent.withArgs('skills/my-skill/SKILL.md', 'main').resolves(
      Buffer.from('# My Skill\n\nSkill description')
    );
    mockClient.getFileContent.withArgs('skills/my-skill/helper.js', 'main').resolves(
      Buffer.from('module.exports = { helper: true };')
    );
    mockClient.getFileContent.withArgs('skills/my-skill/data/config.json', 'main').resolves(
      Buffer.from('{"setting": "value"}')
    );

    const adapter = new AwesomeCopilotAdapter(mockSource, mockClient);
    const buffer = await adapter.downloadBundle(mockBundle);

    // Verify the archive was created
    assert.ok(Buffer.isBuffer(buffer), 'Should return a Buffer');
    assert.ok(buffer.length > 0, 'Buffer should not be empty');

    // Verify the archive contains the expected files
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries().map((e) => e.entryName);
    assert.ok(entries.includes('deployment-manifest.yml'), 'Should include manifest');
    assert.ok(entries.includes('skills/my-skill/SKILL.md'), 'Should include SKILL.md');
    assert.ok(entries.includes('skills/my-skill/helper.js'), 'Should include helper.js');
    assert.ok(entries.includes('skills/my-skill/data/config.json'), 'Should include nested file');
  });
});

suite('AwesomeCopilotAdapter MCP Servers', () => {
  let sandbox: sinon.SinonSandbox;
  let mockClient: sinon.SinonStubbedInstance<GitHubClient>;

  const mockSource: RegistrySource = {
    id: 'awesome-test',
    name: 'Awesome Copilot Test',
    type: 'awesome-copilot',
    url: 'https://github.com/test-owner/awesome-copilot',
    enabled: true,
    priority: 1
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    mockClient = sandbox.createStubInstance(GitHubClient);
    Object.defineProperty(mockClient, 'owner', { value: 'test-owner', configurable: true });
    Object.defineProperty(mockClient, 'repo', { value: 'awesome-copilot', configurable: true });
  });

  teardown(() => {
    sandbox.restore();
  });

  test('should attach mcpServers to bundle when present in collection', async () => {
    mockClient.getContents.withArgs('collections', 'main').resolves([
      { name: 'mcp-test.collection.yml', path: 'collections/mcp-test.collection.yml', type: 'file' }
    ]);

    mockClient.getFileContent.withArgs('collections/mcp-test.collection.yml', 'main').resolves(
      Buffer.from(`id: mcp-test
name: MCP Test
description: Test with MCP servers
tags: []
items:
  - path: "prompts/test.prompt.md"
    kind: prompt
mcpServers:
  my-server:
    command: npx
    args: ["-y", "my-mcp-server"]
`)
    );

    const adapter = new AwesomeCopilotAdapter(mockSource, mockClient);
    const bundles = await adapter.fetchBundles();

    assert.strictEqual(bundles.length, 1);
    const mcpServers = (bundles[0] as any).mcpServers;
    assert.ok(mcpServers, 'Should have mcpServers attached');
    assert.ok(mcpServers['my-server'], 'Should have my-server entry');
    // Breakdown should count MCP servers
    const breakdown = (bundles[0] as any).breakdown;
    assert.strictEqual(breakdown.mcpServers, 1);
  });
});
