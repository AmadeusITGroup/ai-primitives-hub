import type {
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  LocalAdapter,
} from '../../src/adapters/local-adapter';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

function makeSource(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    id: 'local-test',
    name: 'Local Test',
    type: 'local',
    url: '/registry',
    enabled: true,
    priority: 0,
    ...overrides
  };
}

const MANIFEST_YAML = [
  'id: my-bundle',
  'name: My Bundle',
  'version: 1.0.0',
  'description: A test bundle',
  'author: tester',
  'tags: [test]',
  'license: MIT'
].join('\n');

describe('LocalAdapter', () => {
  it('rejects a source URL that is neither file://, absolute, ~/, nor ./', () => {
    expect(() => new LocalAdapter(makeSource({ url: 'not-a-path' }), new InMemoryFileSystem())).toThrow(
      'Invalid local path'
    );
  });

  it('accepts file://, absolute, ~/, and ./ URLs', () => {
    for (const url of ['file:///registry', '/registry', '~/registry', './registry']) {
      expect(() => new LocalAdapter(makeSource({ url }), new InMemoryFileSystem())).not.toThrow();
    }
  });

  it('never requires authentication', () => {
    const adapter = new LocalAdapter(makeSource(), new InMemoryFileSystem());
    expect(adapter.requiresAuthentication()).toBe(false);
  });

  it('builds file:// manifest and download URLs', () => {
    const adapter = new LocalAdapter(makeSource(), new InMemoryFileSystem());
    expect(adapter.getManifestUrl('my-bundle')).toBe('file:///registry/my-bundle/deployment-manifest.yml');
    expect(adapter.getDownloadUrl('my-bundle')).toBe('file:///registry/my-bundle');
  });

  it('fetches bundles by discovering directories with a deployment-manifest.yml', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed('/registry/my-bundle/deployment-manifest.yml', MANIFEST_YAML, 1_700_000_000_000);
    fs.seed('/registry/my-bundle/prompts/example.prompt.md', '# hello');
    fs.seed('/registry/not-a-bundle/readme.md', 'no manifest here');

    const bundles = await new LocalAdapter(makeSource(), fs).fetchBundles();

    expect(bundles).toHaveLength(1);
    expect(bundles[0]).toMatchObject({
      id: 'my-bundle',
      name: 'My Bundle',
      version: '1.0.0',
      sourceId: 'local-test',
      tags: ['test'],
      license: 'MIT',
      downloadUrl: 'file:///registry/my-bundle',
      manifestUrl: 'file:///registry/my-bundle/deployment-manifest.yml'
    });
    expect(bundles[0].lastUpdated).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('skips a bundle directory with a malformed manifest instead of failing the whole fetch', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed('/registry/good/deployment-manifest.yml', MANIFEST_YAML);
    fs.seed('/registry/bad/deployment-manifest.yml', 'id: [this is not: valid yaml');

    const bundles = await new LocalAdapter(makeSource(), fs).fetchBundles();

    expect(bundles.map((b) => b.id)).toEqual(['my-bundle']);
  });

  it('reports metadata including bundle count and directory mtime', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed('/registry/my-bundle/deployment-manifest.yml', MANIFEST_YAML);
    // Force the directory's own entry to exist for stat() by seeding a file under it.
    const metadata = await new LocalAdapter(makeSource(), fs).fetchMetadata();

    expect(metadata.bundleCount).toBe(1);
    expect(metadata.name).toBe('registry');
  });

  it('prefers registry.json metadata when present', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed('/registry/my-bundle/deployment-manifest.yml', MANIFEST_YAML);
    fs.seed('/registry/registry.json', JSON.stringify({ name: 'Curated', description: 'desc', version: '2.0.0' }));

    const metadata = await new LocalAdapter(makeSource(), fs).fetchMetadata();

    expect(metadata).toMatchObject({ name: 'Curated', description: 'desc', version: '2.0.0' });
  });

  it('fails fetchMetadata when the directory does not exist', async () => {
    await expect(new LocalAdapter(makeSource(), new InMemoryFileSystem()).fetchMetadata()).rejects.toThrow(
      'Directory does not exist'
    );
  });

  it('validate() reports invalid when the directory is missing', async () => {
    const result = await new LocalAdapter(makeSource(), new InMemoryFileSystem()).validate();
    expect(result).toEqual({ valid: false, errors: [expect.stringContaining('does not exist')], warnings: [] });
  });

  it('validate() warns but stays valid when the directory has no bundles', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed('/registry/.keep', '');
    const result = await new LocalAdapter(makeSource(), fs).validate();
    expect(result).toEqual({ valid: true, errors: [], warnings: ['No bundles found in directory'] });
  });

  it('validate() is clean when at least one bundle is found', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed('/registry/my-bundle/deployment-manifest.yml', MANIFEST_YAML);
    const result = await new LocalAdapter(makeSource(), fs).validate();
    expect(result).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it('downloadBundle() produces a real ZIP archive containing every file', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed('/registry/my-bundle/deployment-manifest.yml', MANIFEST_YAML);
    fs.seed('/registry/my-bundle/prompts/example.prompt.md', '# hello world');

    const adapter = new LocalAdapter(makeSource(), fs);
    const [bundle] = await adapter.fetchBundles();
    const zip = await adapter.downloadBundle(bundle);

    // ZIP local-file-header magic number: "PK\x03\x04".
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4B, 0x03, 0x04]));
    expect(zip.length).toBeGreaterThan(0);
  });

  it('downloadBundle() rejects when the bundle directory no longer exists', async () => {
    const adapter = new LocalAdapter(makeSource(), new InMemoryFileSystem());
    await expect(
      adapter.downloadBundle({
        id: 'gone',
        downloadUrl: 'file:///registry/gone'
      } as never)
    ).rejects.toThrow('Bundle directory not found');
  });
});
