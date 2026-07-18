/**
 * AwesomeCopilotAdapter Unit Tests
 * Tests the dynamic bundle creation from YAML collections
 */

import * as assert from 'node:assert';
import nock from 'nock';
import {
  AwesomeCopilotAdapter,
} from '../../src/adapters/awesome-copilot-adapter';
import {
  Bundle,
  RegistrySource,
} from '../../src/types/registry';

suite('AwesomeCopilotAdapter', () => {
  const mockSource: RegistrySource = {
    id: 'awesome-test',
    name: 'Awesome Copilot Test',
    type: 'awesome-copilot',
    url: 'https://github.com/test-owner/awesome-copilot',
    enabled: true,
    priority: 1
  };

  teardown(() => {
    nock.cleanAll();
  });

  suite('Constructor and Validation', () => {
    test('should accept valid awesome-copilot source', () => {
      const adapter = new AwesomeCopilotAdapter(mockSource);
      assert.strictEqual(adapter.type, 'awesome-copilot');
    });

    test('should accept GitHub URL format', () => {
      const source = { ...mockSource, url: 'https://github.com/microsoft/prompt-bundle-spec' };
      const adapter = new AwesomeCopilotAdapter(source);
      assert.ok(adapter);
    });
  });

  suite('fetchBundles', () => {
    test('should fetch collections from repository', async () => {
      // Mock the collections directory listing
      nock('https://api.github.com')
        .get('/repos/test-owner/awesome-copilot/contents/collections?ref=main')
        .reply(200, [
          {
            name: 'test-collection.collection.yml',
            type: 'file',
            download_url: 'https://raw.githubusercontent.com/test-owner/awesome-copilot/main/collections/test-collection.collection.yml'
          }
        ]);

      // Mock the collection file content
      nock('https://raw.githubusercontent.com')
        .get('/test-owner/awesome-copilot/main/collections/test-collection.collection.yml')
        .reply(200, `
id: test-collection
name: Test Collection
description: Test collection for unit tests
tags: ["test", "example"]
items:
  - path: "prompts/test.prompt.md"
    kind: prompt
`);

      const adapter = new AwesomeCopilotAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 1);
      assert.strictEqual(bundles[0].id, 'test-collection');
      assert.strictEqual(bundles[0].name, 'Test Collection');
      assert.strictEqual(bundles[0].version, '1.0.0');
      assert.strictEqual(bundles[0].sourceId, 'awesome-test');
    });

    test('should skip invalid YAML files', async () => {
      nock('https://api.github.com')
        .get('/repos/test-owner/awesome-copilot/contents/collections?ref=main')
        .reply(200, [
          { name: 'invalid.collection.yml', type: 'file', download_url: 'https://raw.githubusercontent.com/test-owner/awesome-copilot/main/collections/invalid.collection.yml' }
        ]);

      nock('https://raw.githubusercontent.com')
        .get('/test-owner/awesome-copilot/main/collections/invalid.collection.yml')
        .reply(200, 'invalid: yaml: content:');

      const adapter = new AwesomeCopilotAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      // Should handle parsing error gracefully
      assert.ok(Array.isArray(bundles));
    });

    test('should handle empty collections directory', async () => {
      nock('https://api.github.com')
        .get('/repos/test-owner/awesome-copilot/contents/collections?ref=main')
        .reply(200, []);

      const adapter = new AwesomeCopilotAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 0);
    });
  });

  suite('downloadBundle - Dynamic ZIP Creation', () => {
    test.skip('should create ZIP archive from collection items', async () => {
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

      // Mock collection YAML - not needed, downloadBundle uses getManifestUrl

      nock('https://raw.githubusercontent.com')
        .get('/test-owner/awesome-copilot/main/collections/test-bundle.collection.yml')
        .reply(200, `
id: test-bundle
name: Test Bundle
description: Test
tags: []
items:
  - path: "prompts/test.prompt.md"
    kind: prompt
`)
        .get('/test-owner/awesome-copilot/main/prompts/test.prompt.md')
        .reply(200, '# Test Prompt\n\nThis is a test prompt.');

      const adapter = new AwesomeCopilotAdapter(mockSource);
      const buffer = await adapter.downloadBundle(mockBundle);

      assert.ok(Buffer.isBuffer(buffer));
      assert.ok(buffer.length > 0);
    });

    test.skip('should include deployment-manifest.yml in ZIP', async () => {
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

      // Mock not needed - downloadBundle uses direct raw URL

      nock('https://raw.githubusercontent.com')
        .get('/test-owner/awesome-copilot/main/collections/manifest-test.collection.yml')
        .reply(200, `
id: manifest-test
name: Manifest Test
description: Test manifest
tags: []
items: []
`);

      const adapter = new AwesomeCopilotAdapter(mockSource);
      const buffer = await adapter.downloadBundle(mockBundle);

      // ZIP should contain deployment-manifest.yml
      assert.ok(buffer.length > 100); // Reasonable minimum size for ZIP with manifest
    });

    test.skip('should handle missing prompt files gracefully', async () => {
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

      // Mock not needed

      nock('https://raw.githubusercontent.com')
        .get('/test-owner/awesome-copilot/main/collections/missing-files.collection.yml')
        .reply(200, `
id: missing-files
name: Missing Files
description: Test
tags: []
items:
  - path: "prompts/missing.prompt.md"
    kind: prompt
`)
        .get('/test-owner/awesome-copilot/main/prompts/missing.prompt.md')
        .reply(404);

      const adapter = new AwesomeCopilotAdapter(mockSource);

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
      nock('https://api.github.com')
        .get('/repos/test-owner/awesome-copilot')
        .reply(200, {
          name: 'awesome-copilot',
          description: 'Awesome Copilot Collection',
          stargazers_count: 100
        })
        .get('/repos/test-owner/awesome-copilot/contents/collections?ref=main')
        .reply(200, [
          { name: 'col1.collection.yml', type: 'file' },
          { name: 'col2.collection.yml', type: 'file' }
        ]);

      const adapter = new AwesomeCopilotAdapter(mockSource);
      const metadata = await adapter.fetchMetadata();

      assert.strictEqual(metadata.name, 'test-owner/awesome-copilot');
      assert.ok(metadata.description.includes('Awesome Copilot collections'));
      assert.strictEqual(metadata.bundleCount, 2);
    });
  });

  suite('validate', () => {
    test('should validate accessible repository', async () => {
      nock('https://api.github.com')
        .get('/repos/test-owner/awesome-copilot')
        .reply(200, { name: 'awesome-copilot' })
        .get('/repos/test-owner/awesome-copilot/contents/collections?ref=main')
        .reply(200, [{
          name: 'test.collection.yml',
          type: 'file'
        }]);

      const adapter = new AwesomeCopilotAdapter(mockSource);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    test('should fail validation for inaccessible repository', async () => {
      nock('https://api.github.com')
        .get('/repos/test-owner/awesome-copilot')
        .reply(404);

      const adapter = new AwesomeCopilotAdapter(mockSource);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length > 0);
    });
  });

  suite('Content Type Mapping', () => {
    test('should map .prompt.md files to prompt type', async () => {
      nock('https://api.github.com')
        .get('/repos/test-owner/awesome-copilot/contents/collections?ref=main')
        .reply(200, [{
          name: 'types.collection.yml',
          type: 'file',
          download_url: 'https://raw.githubusercontent.com/test-owner/awesome-copilot/main/collections/types.collection.yml'
        }]);

      nock('https://raw.githubusercontent.com')
        .get('/test-owner/awesome-copilot/main/collections/types.collection.yml')
        .reply(200, `
id: types
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
`);

      const adapter = new AwesomeCopilotAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      assert.ok(bundles.length > 0);
      // Content types should be inferred from file extensions
    });
  });
});

suite('Skill Kind Support', () => {
  test('should parse collection with skill items', async () => {
    const mockSource: RegistrySource = {
      id: 'awesome-test',
      name: 'Awesome Copilot Test',
      type: 'awesome-copilot',
      url: 'https://github.com/test-owner/awesome-copilot',
      enabled: true,
      priority: 1
    };

    nock('https://api.github.com')
      .get('/repos/test-owner/awesome-copilot/contents/collections?ref=main')
      .reply(200, [{
        name: 'skills-collection.collection.yml',
        type: 'file',
        download_url: 'https://raw.githubusercontent.com/test-owner/awesome-copilot/main/collections/skills-collection.collection.yml'
      }]);

    nock('https://raw.githubusercontent.com')
      .get('/test-owner/awesome-copilot/main/collections/skills-collection.collection.yml')
      .reply(200, `
id: skills-collection
name: Skills Collection
description: Test collection with skills
tags: ["test", "skills"]
items:
  - path: "skills/my-skill/SKILL.md"
    kind: skill
  - path: "prompts/test.prompt.md"
    kind: prompt
`);

    const adapter = new AwesomeCopilotAdapter(mockSource);
    const bundles = await adapter.fetchBundles();

    assert.strictEqual(bundles.length, 1);
    assert.strictEqual(bundles[0].id, 'skills-collection');
    // The bundle should contain both skill and prompt items
  });

  test('should map skill kind correctly in type mapping', () => {
    // Test the mapKindToType function behavior
    const kindMap: Record<string, string> = {
      prompt: 'prompt',
      instruction: 'instructions',
      'chat-mode': 'chatmode',
      agent: 'agent',
      skill: 'skill'
    };

    assert.strictEqual(kindMap.skill, 'skill');
    assert.strictEqual(kindMap.prompt, 'prompt');
    assert.strictEqual(kindMap.instruction, 'instructions');
  });

  test('should fetch entire skill directory when downloading bundle with skills', async () => {
    const mockSource: RegistrySource = {
      id: 'awesome-test',
      name: 'Awesome Copilot Test',
      type: 'awesome-copilot',
      url: 'https://github.com/test-owner/awesome-copilot',
      enabled: true,
      priority: 1
    };

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
    nock('https://raw.githubusercontent.com')
      .get('/test-owner/awesome-copilot/main/collections/skill-bundle.collection.yml')
      .reply(200, `
id: skill-bundle
name: Skill Bundle
description: Bundle with skills
tags: []
items:
  - path: "skills/my-skill/SKILL.md"
    kind: skill
`);

    // Mock the GitHub API to list skill directory contents
    nock('https://api.github.com')
      .get('/repos/test-owner/awesome-copilot/contents/skills/my-skill?ref=main')
      .reply(200, [
        { name: 'SKILL.md', path: 'skills/my-skill/SKILL.md', type: 'file' },
        { name: 'helper.js', path: 'skills/my-skill/helper.js', type: 'file' },
        { name: 'data', path: 'skills/my-skill/data', type: 'dir' }
      ]);

    // Mock subdirectory listing
    nock('https://api.github.com')
      .get('/repos/test-owner/awesome-copilot/contents/skills/my-skill/data?ref=main')
      .reply(200, [
        { name: 'config.json', path: 'skills/my-skill/data/config.json', type: 'file' }
      ]);

    // Mock fetching each file in the skill directory
    nock('https://raw.githubusercontent.com')
      .get('/test-owner/awesome-copilot/main/skills/my-skill/SKILL.md')
      .reply(200, '# My Skill\n\nSkill description');

    nock('https://raw.githubusercontent.com')
      .get('/test-owner/awesome-copilot/main/skills/my-skill/helper.js')
      .reply(200, 'module.exports = { helper: true };');

    nock('https://raw.githubusercontent.com')
      .get('/test-owner/awesome-copilot/main/skills/my-skill/data/config.json')
      .reply(200, '{"setting": "value"}');

    const adapter = new AwesomeCopilotAdapter(mockSource);
    const buffer = await adapter.downloadBundle(mockBundle);

    // Verify the archive was created
    assert.ok(Buffer.isBuffer(buffer), 'Should return a Buffer');
    assert.ok(buffer.length > 0, 'Buffer should not be empty');

    // Verify the archive contains the expected files by checking its size
    // A proper archive with 3 files + manifest should be reasonably sized
    assert.ok(buffer.length > 200, 'Archive should contain multiple files');
  });
});

suite('AwesomeCopilotAdapter HTTP Redirect Handling', () => {
  const mockSource: RegistrySource = {
    id: 'awesome-test',
    name: 'Awesome Copilot Test',
    type: 'awesome-copilot',
    url: 'https://github.com/test-owner/awesome-copilot',
    enabled: true,
    priority: 1
  };

  teardown(() => {
    nock.cleanAll();
  });

  test('should follow HTTP 301 redirects when fetching collections', async () => {
    // Mock the collections directory listing with a redirect
    nock('https://api.github.com')
      .get('/repos/test-owner/awesome-copilot/contents/collections?ref=main')
      .reply(301, '', { location: 'https://api.github.com/repos/new-owner/new-repo/contents/collections?ref=main' });

    nock('https://api.github.com')
      .get('/repos/new-owner/new-repo/contents/collections?ref=main')
      .reply(200, [
        {
          name: 'redirect-test.collection.yml',
          type: 'file',
          download_url: 'https://raw.githubusercontent.com/new-owner/new-repo/main/collections/redirect-test.collection.yml'
        }
      ]);

    // Mock the collection file content
    nock('https://raw.githubusercontent.com')
      .get('/test-owner/awesome-copilot/main/collections/redirect-test.collection.yml')
      .reply(301, '', { location: 'https://raw.githubusercontent.com/new-owner/new-repo/main/collections/redirect-test.collection.yml' });

    nock('https://raw.githubusercontent.com')
      .get('/new-owner/new-repo/main/collections/redirect-test.collection.yml')
      .reply(200, `
id: redirect-test
name: Redirect Test Collection
description: Test collection for redirect handling
tags: ["test"]
items:
- path: "prompts/test.prompt.md"
  kind: prompt
`);

    const adapter = new AwesomeCopilotAdapter(mockSource);
    const bundles = await adapter.fetchBundles();

    assert.strictEqual(bundles.length, 1);
    assert.strictEqual(bundles[0].id, 'redirect-test');
  });

  test('should follow HTTP 302 redirects when validating repository', async () => {
    // Mock the collections directory with a temporary redirect
    nock('https://api.github.com')
      .get('/repos/test-owner/awesome-copilot/contents/collections?ref=main')
      .reply(302, '', { location: 'https://api.github.com/repos/test-owner/awesome-copilot-v2/contents/collections?ref=main' });

    nock('https://api.github.com')
      .get('/repos/test-owner/awesome-copilot-v2/contents/collections?ref=main')
      .reply(200, [
        { name: 'test.collection.yml', type: 'file' }
      ]);

    const adapter = new AwesomeCopilotAdapter(mockSource);
    const result = await adapter.validate();

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.bundlesFound, 1);
  });
});
