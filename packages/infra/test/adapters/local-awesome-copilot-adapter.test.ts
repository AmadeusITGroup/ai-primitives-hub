import * as os from 'node:os';
import * as path from 'node:path';
import type {
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  LocalAwesomeCopilotAdapter,
} from '../../src/adapters/local-awesome-copilot-adapter';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

function makeSource(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    id: 'local-ac-test',
    name: 'Local Awesome Copilot Test',
    type: 'local-awesome-copilot',
    url: '/collections-root',
    enabled: true,
    priority: 0,
    ...overrides
  };
}

function collectionYaml(overrides: Record<string, unknown> = {}): string {
  const collection = {
    id: 'my-collection',
    name: 'My Collection',
    description: 'A collection',
    tags: ['azure'],
    items: [{ path: 'prompts/example.prompt.md', kind: 'prompt' }],
    ...overrides
  };
  return [
    `id: ${collection.id}`,
    `name: ${collection.name}`,
    `description: ${collection.description}`,
    `tags: [${collection.tags.join(', ')}]`,
    'items:',
    ...(collection.items as { path: string; kind: string }[]).map((item) => `  - path: ${item.path}\n    kind: ${item.kind}`)
  ].join('\n');
}

describe('LocalAwesomeCopilotAdapter', () => {
  describe('constructor', () => {
    it('rejects a source URL that is neither file://, absolute, ~/, nor ./', () => {
      expect(() => new LocalAwesomeCopilotAdapter(makeSource({ url: 'not-a-path' }), new InMemoryFileSystem())).toThrow(
        'Invalid local path'
      );
    });

    it('accepts file://, absolute, ~/, and ./ URLs', () => {
      for (const url of ['file:///collections-root', '/collections-root', '~/collections-root', './collections-root']) {
        expect(() => new LocalAwesomeCopilotAdapter(makeSource({ url }), new InMemoryFileSystem())).not.toThrow();
      }
    });
  });

  it('never requires authentication', () => {
    expect(new LocalAwesomeCopilotAdapter(makeSource(), new InMemoryFileSystem()).requiresAuthentication()).toBe(false);
  });

  describe('getManifestUrl / getDownloadUrl', () => {
    it('builds a file:// URL under the configured collections directory', () => {
      const adapter = new LocalAwesomeCopilotAdapter(makeSource(), new InMemoryFileSystem());
      expect(adapter.getManifestUrl('my-collection')).toBe('file:///collections-root/collections/my-collection.collection.yml');
      expect(adapter.getDownloadUrl('my-collection')).toBe('file:///collections-root/collections/my-collection.collection.yml');
    });

    it('respects a configured collectionsPath', () => {
      const adapter = new LocalAwesomeCopilotAdapter(makeSource({ config: { collectionsPath: 'my-collections' } }), new InMemoryFileSystem());
      expect(adapter.getManifestUrl('my-collection')).toBe('file:///collections-root/my-collections/my-collection.collection.yml');
    });
  });

  describe('fetchBundles', () => {
    it('discovers a .collection.yml file and builds a bundle from it', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/collections-root/collections/my-collection.collection.yml', collectionYaml(), 1_700_000_000_000);

      const [bundle] = await new LocalAwesomeCopilotAdapter(makeSource(), fs).fetchBundles();

      expect(bundle).toMatchObject({
        id: 'my-collection',
        name: 'My Collection',
        description: 'A collection',
        author: 'Local Developer',
        sourceId: 'local-ac-test',
        tags: ['azure'],
        environments: ['cloud'],
        repository: '/collections-root',
        size: '1 items',
        dependencies: [],
        license: 'MIT',
        manifestUrl: 'file:///collections-root/collections/my-collection.collection.yml',
        downloadUrl: 'file:///collections-root/collections/my-collection.collection.yml'
      });
      expect(bundle.lastUpdated).toBe(new Date(1_700_000_000_000).toISOString());
    });

    it('attaches a content breakdown + mcpServers to the bundle for the Marketplace content-breakdown UI', async () => {
      const yamlContent = [
        'id: my-collection',
        'name: My Collection',
        'description: A collection',
        'items:',
        '  - path: prompts/x.prompt.md',
        '    kind: prompt',
        '  - path: agents/y.agent.md',
        '    kind: agent',
        'mcpServers:',
        '  example-server:',
        '    command: node'
      ].join('\n');
      const fs = new InMemoryFileSystem();
      fs.seed('/collections-root/collections/my-collection.collection.yml', yamlContent);

      const [bundle] = await new LocalAwesomeCopilotAdapter(makeSource(), fs).fetchBundles();

      expect((bundle as unknown as { breakdown: Record<string, number> }).breakdown).toEqual({
        prompts: 1,
        instructions: 0,
        chatmodes: 0,
        agents: 1,
        skills: 0,
        mcpServers: 1
      });
      expect((bundle as unknown as { mcpServers: unknown }).mcpServers).toEqual({ 'example-server': { command: 'node' } });
    });

    it('does not attach mcpServers (but still attaches a zero-count breakdown) when the collection declares none', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/collections-root/collections/my-collection.collection.yml', collectionYaml());

      const [bundle] = await new LocalAwesomeCopilotAdapter(makeSource(), fs).fetchBundles();

      expect(bundle).not.toHaveProperty('mcpServers');
      expect((bundle as unknown as { breakdown: Record<string, number> }).breakdown.mcpServers).toBe(0);
    });

    it('ignores files in the collections directory that are not .collection.yml', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/collections-root/collections/my-collection.collection.yml', collectionYaml());
      fs.seed('/collections-root/collections/README.md', 'not a collection');

      const bundles = await new LocalAwesomeCopilotAdapter(makeSource(), fs).fetchBundles();
      expect(bundles).toHaveLength(1);
    });

    it('skips a malformed collection file without failing the whole fetch', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/collections-root/collections/good.collection.yml', collectionYaml({ id: 'good' }));
      fs.seed('/collections-root/collections/bad.collection.yml', 'id: [this is not: valid yaml');

      const bundles = await new LocalAwesomeCopilotAdapter(makeSource(), fs).fetchBundles();
      expect(bundles.map((b) => b.id)).toEqual(['good']);
    });

    it('wraps a missing collections directory with a descriptive error', async () => {
      await expect(new LocalAwesomeCopilotAdapter(makeSource(), new InMemoryFileSystem()).fetchBundles()).rejects.toThrow(
        'Failed to list local awesome-copilot collections'
      );
    });

    it('expands a ~/ URL to the user\'s home directory', async () => {
      const fs = new InMemoryFileSystem();
      const expandedRoot = path.join(os.homedir(), 'collections-root');
      fs.seed(path.join(expandedRoot, 'collections', 'my-collection.collection.yml'), collectionYaml());

      const bundles = await new LocalAwesomeCopilotAdapter(makeSource({ url: '~/collections-root' }), fs).fetchBundles();
      expect(bundles).toHaveLength(1);
    });
  });

  describe('downloadBundle', () => {
    it('produces a real ZIP archive with prompts/ and a recursively-included skill directory', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed(
        '/collections-root/collections/my-collection.collection.yml',
        collectionYaml({
          items: [
            { path: 'prompts/example.prompt.md', kind: 'prompt' },
            { path: 'skills/my-skill/SKILL.md', kind: 'skill' }
          ]
        })
      );
      fs.seed('/collections-root/prompts/example.prompt.md', '# Example');
      fs.seed('/collections-root/skills/my-skill/SKILL.md', '# Skill');
      fs.seed('/collections-root/skills/my-skill/reference.md', '# Reference');

      const adapter = new LocalAwesomeCopilotAdapter(makeSource(), fs);
      const [bundle] = await adapter.fetchBundles();
      const zip = await adapter.downloadBundle(bundle);

      // ZIP local-file-header magic number: "PK\x03\x04".
      expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4B, 0x03, 0x04]));
      expect(zip.length).toBeGreaterThan(0);
    });

    it('wraps a download failure with a descriptive error', async () => {
      await expect(
        new LocalAwesomeCopilotAdapter(makeSource(), new InMemoryFileSystem()).downloadBundle({
          downloadUrl: 'file:///collections-root/collections/missing.collection.yml'
        } as never)
      ).rejects.toThrow('Failed to download bundle');
    });
  });

  describe('fetchMetadata', () => {
    it('reports the directory name, description, and collection count', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/collections-root/collections/my-collection.collection.yml', collectionYaml());

      const metadata = await new LocalAwesomeCopilotAdapter(makeSource(), fs).fetchMetadata();

      expect(metadata).toMatchObject({
        name: 'collections-root',
        description: 'Local Awesome Copilot collections from /collections-root',
        bundleCount: 1,
        version: '1.0.0'
      });
    });

    it('wraps a missing root directory with a descriptive error', async () => {
      await expect(new LocalAwesomeCopilotAdapter(makeSource(), new InMemoryFileSystem()).fetchMetadata()).rejects.toThrow(
        'Failed to fetch metadata'
      );
    });
  });

  describe('validate', () => {
    it('is invalid when the collections directory does not exist', async () => {
      const result = await new LocalAwesomeCopilotAdapter(makeSource(), new InMemoryFileSystem()).validate();
      expect(result).toEqual({
        valid: false,
        errors: ['Collections directory does not exist: /collections-root/collections'],
        warnings: [],
        bundlesFound: 0
      });
    });

    it('is invalid when the collections directory has no .collection.yml files', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/collections-root/collections/.keep', '');

      const result = await new LocalAwesomeCopilotAdapter(makeSource(), fs).validate();
      expect(result).toEqual({
        valid: false,
        errors: ['No .collection.yml files found in collections directory'],
        warnings: [],
        bundlesFound: 0
      });
    });

    it('is valid when at least one collection is found', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/collections-root/collections/my-collection.collection.yml', collectionYaml());

      const result = await new LocalAwesomeCopilotAdapter(makeSource(), fs).validate();
      expect(result).toEqual({ valid: true, errors: [], warnings: [], bundlesFound: 1 });
    });
  });
});
