import type {
  RegistrySource,
} from '@ai-primitives-hub/core';
import * as yaml from 'js-yaml';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  LocalApmAdapter,
} from '../../src/adapters/local-apm-adapter';
import {
  FixedClock,
} from '../helpers/fixed-clock';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

function makeSource(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    id: 'local-apm-test',
    name: 'Local APM Test',
    type: 'local-apm',
    url: '/packages-root',
    enabled: true,
    priority: 0,
    ...overrides
  };
}

function apmManifestYaml(overrides: Record<string, unknown> = {}): string {
  return yaml.dump({ name: 'My Package', version: '1.0.0', description: 'A package', tags: ['azure'], license: 'MIT', ...overrides });
}

function makeAdapter(overrides: { source?: RegistrySource; fs?: InMemoryFileSystem; clock?: FixedClock } = {}): LocalApmAdapter {
  return new LocalApmAdapter(overrides.source ?? makeSource(), overrides.fs ?? new InMemoryFileSystem(), overrides.clock ?? new FixedClock(0));
}

describe('LocalApmAdapter', () => {
  describe('constructor', () => {
    it('rejects a source URL that is neither file://, absolute, ~/, nor ./', () => {
      expect(() => makeAdapter({ source: makeSource({ url: 'not-a-path' }) })).toThrow('Invalid local path');
    });

    it('accepts file://, absolute, ~/, and ./ URLs', () => {
      for (const url of ['file:///packages-root', '/packages-root', '~/packages-root', './packages-root']) {
        expect(() => makeAdapter({ source: makeSource({ url }) })).not.toThrow();
      }
    });
  });

  it('never requires authentication', () => {
    expect(makeAdapter().requiresAuthentication()).toBe(false);
  });

  describe('fetchBundles', () => {
    it('discovers a single package at the root when apm.yml is present there', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/packages-root/apm.yml', apmManifestYaml());

      const [bundle] = await makeAdapter({ fs }).fetchBundles();

      expect(bundle).toMatchObject({
        id: 'local-my-package',
        name: 'My Package',
        version: '1.0.0',
        description: 'A package',
        author: 'Local Developer',
        sourceId: 'local-apm-test',
        environments: ['cloud'],
        tags: ['azure', 'apm', 'local'],
        license: 'MIT',
        manifestUrl: 'file:///packages-root/apm.yml',
        downloadUrl: 'file:///packages-root',
        repository: 'file:///packages-root'
      });
    });

    it('discovers a package one subdirectory deep (monorepo layout)', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/packages-root/package-a/apm.yml', apmManifestYaml({ name: 'Package A' }));
      fs.seed('/packages-root/package-b/apm.yml', apmManifestYaml({ name: 'Package B' }));

      const bundles = await makeAdapter({ fs }).fetchBundles();

      expect(bundles.map((b) => b.name).toSorted()).toEqual(['Package A', 'Package B']);
      expect(bundles.map((b) => b.downloadUrl).toSorted()).toEqual(['file:///packages-root/package-a', 'file:///packages-root/package-b']);
    });

    it('finds both a root package and nested packages together', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/packages-root/apm.yml', apmManifestYaml({ name: 'Root Package' }));
      fs.seed('/packages-root/nested/apm.yml', apmManifestYaml({ name: 'Nested Package' }));

      const bundles = await makeAdapter({ fs }).fetchBundles();
      expect(bundles.map((b) => b.name).toSorted()).toEqual(['Nested Package', 'Root Package']);
    });

    it('skips node_modules/apm_modules/.git and other skip-listed directories', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/packages-root/valid/apm.yml', apmManifestYaml({ name: 'Valid' }));
      fs.seed('/packages-root/node_modules/apm.yml', apmManifestYaml({ name: 'Should not appear' }));
      fs.seed('/packages-root/.git/apm.yml', apmManifestYaml({ name: 'Should not appear either' }));

      const bundles = await makeAdapter({ fs }).fetchBundles();
      expect(bundles.map((b) => b.name)).toEqual(['Valid']);
    });

    it('does not scan subdirectories when scanSubdirectories is false', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/packages-root/nested/apm.yml', apmManifestYaml({ name: 'Nested Package' }));

      const bundles = await makeAdapter({ source: makeSource({ config: { scanSubdirectories: false } }), fs }).fetchBundles();
      expect(bundles).toEqual([]);
    });

    it('respects a configured maxDepth', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/packages-root/a/b/apm.yml', apmManifestYaml({ name: 'Deep Package' }));

      const shallow = await makeAdapter({ source: makeSource({ config: { maxDepth: 1 } }), fs }).fetchBundles();
      expect(shallow).toEqual([]);

      const deep = await makeAdapter({ source: makeSource({ config: { maxDepth: 2 } }), fs }).fetchBundles();
      expect(deep.map((b) => b.name)).toEqual(['Deep Package']);
    });

    it('defaults description/author/license/environments/tags when the manifest omits them', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/packages-root/apm.yml', yaml.dump({ name: 'Bare' }));

      const [bundle] = await makeAdapter({ fs }).fetchBundles();
      expect(bundle).toMatchObject({ author: 'Local Developer', license: 'MIT', environments: ['general'], tags: ['apm', 'local'] });
      expect(bundle.description).toContain('Local APM package from');
    });

    it('throws when the root directory does not exist', async () => {
      await expect(makeAdapter().fetchBundles()).rejects.toThrow('Local APM packages directory not found');
    });
  });

  describe('downloadBundle', () => {
    it('produces a real ZIP archive from .apm/ and root-level prompt files', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/packages-root/apm.yml', apmManifestYaml());
      fs.seed('/packages-root/.apm/agents/reviewer.md', '# Reviewer');
      fs.seed('/packages-root/root.prompt.md', '# Root');

      const adapter = makeAdapter({ fs });
      const [bundle] = await adapter.fetchBundles();
      const zip = await adapter.downloadBundle(bundle);

      // ZIP local-file-header magic number: "PK\x03\x04".
      expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4B, 0x03, 0x04]));
      expect(zip.length).toBeGreaterThan(0);
    });

    it('throws when the package directory referenced by downloadUrl no longer exists', async () => {
      await expect(makeAdapter().downloadBundle({ downloadUrl: 'file:///packages-root/gone' } as never)).rejects.toThrow(
        'Package directory not found'
      );
    });
  });

  describe('fetchMetadata', () => {
    it('reports the directory name and package count', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/packages-root/apm.yml', apmManifestYaml());

      const metadata = await makeAdapter({ fs }).fetchMetadata();
      expect(metadata).toMatchObject({ name: 'packages-root', bundleCount: 1, version: '1.0.0' });
    });

    it('throws when the root directory does not exist', async () => {
      await expect(makeAdapter().fetchMetadata()).rejects.toThrow('Directory not found');
    });
  });

  describe('validate', () => {
    it('is invalid when the root directory does not exist', async () => {
      const result = await makeAdapter().validate();
      expect(result).toEqual({ valid: false, errors: ['Directory does not exist: /packages-root'], warnings: [], bundlesFound: 0 });
    });

    it('is valid with a warning when the directory has no apm.yml files', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/packages-root/.keep', '');

      const result = await makeAdapter({ fs }).validate();
      expect(result).toEqual({ valid: true, errors: [], warnings: ['No apm.yml files found in directory'], bundlesFound: 0 });
    });

    it('is valid with the package count when packages are found', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/packages-root/apm.yml', apmManifestYaml());

      const result = await makeAdapter({ fs }).validate();
      expect(result).toEqual({ valid: true, errors: [], warnings: [], bundlesFound: 1 });
    });
  });
});
