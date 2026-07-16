/**
 * Tests for app/install/pipeline.ts.
 *
 * No direct reference-branch equivalent exists (the reference's own
 * `InstallPipeline` had no dedicated unit test — exercised only
 * indirectly via its CLI command tests, which this migration hasn't
 * reached yet). Written fresh against the five-stage pipeline
 * (resolve -> download -> extract -> validate -> write).
 */
import type {
  BundleDownloader,
  BundleExtractor,
  BundleResolver,
  BundleSpec,
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
  InstallPipeline,
  InstallPipelineError,
  type PipelineEvent,
} from '../../src/install/pipeline';
import type {
  TargetWriter,
} from '../../src/writers/file-tree-writer';

const TARGET: Target = { name: 'my-vscode', type: 'vscode', scope: 'user', path: '/out' };

const MANIFEST_YAML = 'id: my-bundle\nversion: 1.0.0\nname: My Bundle\n';

const installable: Installable = {
  ref: { sourceId: 'github-abc', sourceType: 'github', bundleId: 'my-bundle', bundleVersion: '1.0.0', installed: false },
  downloadUrl: 'https://example.com/bundle.zip'
};

const okResolver: BundleResolver = { resolve: async () => installable };
const okDownloader: BundleDownloader = {
  download: async () => ({ bytes: new Uint8Array([1, 2, 3]), sha256: 'abc123' })
};
const okExtractor: BundleExtractor = {
  extract: async (): Promise<ExtractedFiles> => new Map([
    ['deployment-manifest.yml', new TextEncoder().encode(MANIFEST_YAML)]
  ])
};
const okWriter: TargetWriter = {
  write: async () => ({ written: ['/out/deployment-manifest.yml'], skipped: [] }),
  remove: async () => {}
};

describe('InstallPipeline', () => {
  it('runs all five stages successfully and returns the outcome', async () => {
    const pipeline = new InstallPipeline({
      resolver: okResolver,
      downloader: okDownloader,
      extractor: okExtractor,
      writerFactory: () => okWriter
    });

    const outcome = await pipeline.run({ bundleId: 'my-bundle', bundleVersion: 'latest' }, TARGET);

    expect(outcome.manifest.id).toBe('my-bundle');
    expect(outcome.sha256).toBe('abc123');
    expect(outcome.write.written).toContain('/out/deployment-manifest.yml');
  });

  it('emits events for every stage in order', async () => {
    const events: PipelineEvent['kind'][] = [];
    const pipeline = new InstallPipeline({
      resolver: okResolver,
      downloader: okDownloader,
      extractor: okExtractor,
      writerFactory: () => okWriter,
      onEvent: (e) => events.push(e.kind)
    });

    await pipeline.run({ bundleId: 'my-bundle' }, TARGET);

    expect(events).toEqual([
      'resolve.start', 'resolve.done',
      'download.start', 'download.done',
      'extract.start', 'extract.done',
      'validate.start', 'validate.done',
      'write.start', 'write.done'
    ]);
  });

  it('throws BUNDLE.NOT_FOUND when the resolver returns null', async () => {
    const pipeline = new InstallPipeline({
      resolver: { resolve: async () => null },
      downloader: okDownloader,
      extractor: okExtractor,
      writerFactory: () => okWriter
    });

    const spec: BundleSpec = { bundleId: 'missing' };
    await expect(pipeline.run(spec, TARGET)).rejects.toMatchObject({
      code: 'BUNDLE.NOT_FOUND',
      stage: 'resolve'
    });
    await expect(pipeline.run(spec, TARGET)).rejects.toBeInstanceOf(InstallPipelineError);
  });

  it('wraps a download failure as NETWORK.DOWNLOAD_FAILED', async () => {
    const pipeline = new InstallPipeline({
      resolver: okResolver,
      downloader: { download: async () => {
        throw new Error('network down');
      } },
      extractor: okExtractor,
      writerFactory: () => okWriter
    });

    await expect(pipeline.run({ bundleId: 'my-bundle' }, TARGET)).rejects.toMatchObject({
      code: 'NETWORK.DOWNLOAD_FAILED',
      stage: 'download'
    });
  });

  it('wraps an extract failure as BUNDLE.EXTRACT_FAILED', async () => {
    const pipeline = new InstallPipeline({
      resolver: okResolver,
      downloader: okDownloader,
      extractor: { extract: async () => {
        throw new Error('bad zip');
      } },
      writerFactory: () => okWriter
    });

    await expect(pipeline.run({ bundleId: 'my-bundle' }, TARGET)).rejects.toMatchObject({
      code: 'BUNDLE.EXTRACT_FAILED',
      stage: 'extract'
    });
  });

  it('wraps a manifest validation failure with the validator\'s own error code', async () => {
    const pipeline = new InstallPipeline({
      resolver: okResolver,
      downloader: okDownloader,
      extractor: { extract: async (): Promise<ExtractedFiles> => new Map() },
      writerFactory: () => okWriter
    });

    await expect(pipeline.run({ bundleId: 'my-bundle' }, TARGET)).rejects.toMatchObject({
      code: 'BUNDLE.MANIFEST_MISSING',
      stage: 'validate'
    });
  });

  it('rejects when the manifest version does not match the requested version', async () => {
    const pipeline = new InstallPipeline({
      resolver: okResolver,
      downloader: okDownloader,
      extractor: okExtractor,
      writerFactory: () => okWriter
    });

    await expect(pipeline.run({ bundleId: 'my-bundle', bundleVersion: '9.9.9' }, TARGET)).rejects.toMatchObject({
      code: 'BUNDLE.VERSION_MISMATCH',
      stage: 'validate'
    });
  });

  it('wraps a write failure as FS.WRITE_FAILED', async () => {
    const pipeline = new InstallPipeline({
      resolver: okResolver,
      downloader: okDownloader,
      extractor: okExtractor,
      writerFactory: () => ({ write: async () => {
        throw new Error('disk full');
      }, remove: async () => {} })
    });

    await expect(pipeline.run({ bundleId: 'my-bundle' }, TARGET)).rejects.toMatchObject({
      code: 'FS.WRITE_FAILED',
      stage: 'write'
    });
  });

  it('selects the writer via writerFactory based on the target', async () => {
    let calledWith: Target | null = null;
    const pipeline = new InstallPipeline({
      resolver: okResolver,
      downloader: okDownloader,
      extractor: okExtractor,
      writerFactory: (t) => {
        calledWith = t;
        return okWriter;
      }
    });

    await pipeline.run({ bundleId: 'my-bundle' }, TARGET);
    expect(calledWith).toBe(TARGET);
  });
});
