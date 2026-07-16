/**
 * Tests for app/install/install-bundle.ts.
 *
 * Thin wrapper over InstallPipeline; tests confirm correct delegation
 * rather than re-testing pipeline internals (covered by
 * `pipeline.test.ts`).
 */
import type {
  BundleDownloader,
  BundleExtractor,
  BundleResolver,
  ExtractedFiles,
  Installable,
  Target,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  installBundle,
} from '../../src/install/install-bundle';
import type {
  TargetWriter,
} from '../../src/writers/file-tree-writer';

const TARGET: Target = { name: 'my-vscode', type: 'vscode', scope: 'user', path: '/out' };

const installable: Installable = {
  ref: { sourceId: 'github-abc', sourceType: 'github', bundleId: 'my-bundle', bundleVersion: '1.0.0', installed: false },
  downloadUrl: 'https://example.com/bundle.zip'
};

describe('installBundle', () => {
  it('resolves, downloads, extracts, validates, and writes end-to-end', async () => {
    const resolver: BundleResolver = { resolve: async () => installable };
    const downloader: BundleDownloader = { download: async () => ({ bytes: new Uint8Array(), sha256: 'sha' }) };
    const extractor: BundleExtractor = {
      extract: async (): Promise<ExtractedFiles> => new Map([
        ['deployment-manifest.yml', new TextEncoder().encode('id: my-bundle\nversion: 1.0.0\nname: My Bundle\n')]
      ])
    };
    const writer: TargetWriter = {
      write: async () => ({ written: ['/out/deployment-manifest.yml'], skipped: [] }),
      remove: async () => {}
    };

    const outcome = await installBundle(
      { spec: { bundleId: 'my-bundle' }, target: TARGET },
      { resolver, downloader, extractor, writerFactory: () => writer }
    );

    expect(outcome.manifest.id).toBe('my-bundle');
    expect(outcome.write.written).toContain('/out/deployment-manifest.yml');
  });

  it('propagates pipeline errors to the caller', async () => {
    const resolver: BundleResolver = { resolve: async () => null };
    const downloader: BundleDownloader = { download: async () => ({ bytes: new Uint8Array(), sha256: 'sha' }) };
    const extractor: BundleExtractor = { extract: async (): Promise<ExtractedFiles> => new Map() };
    const writer: TargetWriter = { write: async () => ({ written: [], skipped: [] }), remove: async () => {} };

    await expect(installBundle(
      { spec: { bundleId: 'missing' }, target: TARGET },
      { resolver, downloader, extractor, writerFactory: () => writer }
    )).rejects.toMatchObject({ code: 'BUNDLE.NOT_FOUND' });
  });

  it('forwards pipeline events to the onEvent callback', async () => {
    const resolver: BundleResolver = { resolve: async () => installable };
    const downloader: BundleDownloader = { download: async () => ({ bytes: new Uint8Array(), sha256: 'sha' }) };
    const extractor: BundleExtractor = {
      extract: async (): Promise<ExtractedFiles> => new Map([
        ['deployment-manifest.yml', new TextEncoder().encode('id: my-bundle\nversion: 1.0.0\nname: My Bundle\n')]
      ])
    };
    const writer: TargetWriter = { write: async () => ({ written: [], skipped: [] }), remove: async () => {} };
    const seenKinds: string[] = [];

    await installBundle(
      { spec: { bundleId: 'my-bundle' }, target: TARGET },
      { resolver, downloader, extractor, writerFactory: () => writer, onEvent: (e) => seenKinds.push(e.kind) }
    );

    expect(seenKinds).toContain('resolve.start');
    expect(seenKinds).toContain('write.done');
  });
});
