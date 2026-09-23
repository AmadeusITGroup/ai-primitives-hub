import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  BundleManifest,
  BundleProvider,
  BundleRef,
} from '@ai-primitives-hub/core';
import {
  CompositeBundleProvider,
  LocalFolderBundleProvider,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  buildIndex,
} from '../../src/search/build-index';

describe('buildIndex', () => {
  let tempDir: string;
  let bundleDir: string;
  let outFile: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'app-build-index-test-'));
    bundleDir = path.join(tempDir, 'local-foo');
    await fs.promises.mkdir(path.join(bundleDir, 'prompts'), { recursive: true });
    await fs.promises.writeFile(
      path.join(bundleDir, 'deployment-manifest.yml'),
      'id: local-foo\nversion: 1.0.0\nname: Local Foo\nitems:\n  - path: prompts/hello.prompt.md\n    kind: prompt\n'
    );
    await fs.promises.writeFile(
      path.join(bundleDir, 'prompts', 'hello.prompt.md'),
      '# Hello Prompt\n\nA diagnostic prompt.\n'
    );
    outFile = path.join(tempDir, 'primitive-index.json');
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('builds and persists an index without embeddings by default', async () => {
    const provider = new LocalFolderBundleProvider({ root: tempDir, sourceId: 'local' });
    const result = await buildIndex({ provider, outFile });
    expect(result.outFile).toBe(outFile);
    expect(result.primitives).toBe(1);
    expect(result.bundles).toBe(1);
    expect(result.embeddings).toBeUndefined();
    expect(fs.existsSync(outFile)).toBe(true);
  });

  it('embeds primitive text when embed is true', async () => {
    const provider = new LocalFolderBundleProvider({ root: tempDir, sourceId: 'local' });
    const result = await buildIndex({ provider, outFile, embed: true });
    expect(result.primitives).toBe(1);
    expect(result.embeddings).toBeTruthy();
    expect(result.embeddings?.dim).toBe(384);
    expect(fs.existsSync(outFile)).toBe(true);

    const raw = JSON.parse(await fs.promises.readFile(outFile, 'utf8')) as {
      embeddingsMeta?: { provider: string; dim: number } | null;
    };
    expect(raw.embeddingsMeta).toBeTruthy();
  });

  it('resolves the output path through an injected index store', async () => {
    const provider = new LocalFolderBundleProvider({ root: tempDir, sourceId: 'local' });
    const storedIndex = path.join(tempDir, 'shared', 'primitive-index.v2.json');
    const indexStore = {
      getIndexPath: () => storedIndex
    };

    const result = await buildIndex({
      provider,
      indexStore,
      indexKey: {
        hubId: 'local',
        sourceRevision: 'current',
        searchProfileId: 'bm25-v1'
      }
    });

    expect(result.outFile).toBe(storedIndex);
    expect(fs.existsSync(storedIndex)).toBe(true);
  });

  it('reports partial coverage when a configured source cannot enumerate bundles', async () => {
    const healthy = new LocalFolderBundleProvider({ root: tempDir, sourceId: 'healthy' });
    const broken: BundleProvider = {
      async* listBundles(): AsyncIterable<BundleRef> {
        yield* [];
        throw new Error('source is unavailable');
      },
      readManifest: async (): Promise<BundleManifest> => ({ id: 'broken', version: '1.0.0', name: 'Broken' }),
      readFile: async (): Promise<string> => ''
    };
    const provider = new CompositeBundleProvider([
      { sourceId: 'healthy', provider: healthy },
      { sourceId: 'broken', provider: broken }
    ]);

    const result = await buildIndex({ provider, outFile });

    expect(result.primitives).toBe(1);
    expect(result.report).toMatchObject({
      state: 'partial',
      primitives: 1,
      bundles: 1,
      sourceCoverage: [
        { sourceId: 'healthy', state: 'indexed' },
        { sourceId: 'broken', state: 'failed', message: 'source is unavailable' }
      ]
    });
    expect(result.report.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
