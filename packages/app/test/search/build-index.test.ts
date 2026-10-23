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

  it('short-circuits without invoking the provider when a matching indexKey snapshot already exists', async () => {
    const storedIndex = path.join(tempDir, 'shared', 'primitive-index.v2.json');
    const indexKey = {
      hubId: 'local',
      sourceRevision: 'rev-1',
      searchProfileId: 'bm25-v1'
    };
    const indexStore = {
      getIndexPath: () => storedIndex
    };

    const initialProvider = new LocalFolderBundleProvider({ root: tempDir, sourceId: 'local' });
    const first = await buildIndex({
      provider: initialProvider,
      indexStore,
      indexKey
    });
    expect(first.primitives).toBe(1);
    expect(first.report.shortCircuited).toBeUndefined();

    let listBundlesCalled = false;
    const failingProvider: BundleProvider = {
      async* listBundles(): AsyncIterable<BundleRef> {
        listBundlesCalled = true;
        yield* [];
        throw new Error('provider must not be called when snapshot already exists');
      },
      readManifest: async (): Promise<BundleManifest> => ({ id: 'x', version: '1.0.0' }),
      readFile: async (): Promise<string> => ''
    };

    const second = await buildIndex({
      provider: failingProvider,
      indexStore,
      indexKey
    });

    expect(listBundlesCalled).toBe(false);
    expect(second.primitives).toBe(1);
    expect(second.bundles).toBe(1);
    expect(second.report.shortCircuited).toBe(true);
  });

  it('incrementally harvests only changed/added sources and prunes removed sources via sourceRevisions', async () => {
    const sourceADir = path.join(tempDir, 'source-a');
    const sourceBDir = path.join(tempDir, 'source-b');
    await fs.promises.mkdir(path.join(sourceADir, 'bundle-a', 'prompts'), { recursive: true });
    await fs.promises.mkdir(path.join(sourceBDir, 'bundle-b', 'prompts'), { recursive: true });
    await fs.promises.writeFile(
      path.join(sourceADir, 'bundle-a', 'deployment-manifest.yml'),
      'id: bundle-a\nversion: 1.0.0\nname: Bundle A\nitems:\n  - path: prompts/a.prompt.md\n    kind: prompt\n'
    );
    await fs.promises.writeFile(
      path.join(sourceADir, 'bundle-a', 'prompts', 'a.prompt.md'),
      '# Alpha Prompt\n\nAlpha content.\n'
    );
    await fs.promises.writeFile(
      path.join(sourceBDir, 'bundle-b', 'deployment-manifest.yml'),
      'id: bundle-b\nversion: 1.0.0\nname: Bundle B\nitems:\n  - path: prompts/b.prompt.md\n    kind: prompt\n'
    );
    await fs.promises.writeFile(
      path.join(sourceBDir, 'bundle-b', 'prompts', 'b.prompt.md'),
      '# Beta Prompt\n\nBeta content.\n'
    );

    const rev1Path = path.join(tempDir, 'indexes', 'rev-1', 'primitive-index.v2.json');
    const rev2Path = path.join(tempDir, 'indexes', 'rev-2', 'primitive-index.v2.json');
    const rev3Path = path.join(tempDir, 'indexes', 'rev-3', 'primitive-index.v2.json');

    let latestSavedPath: string | undefined;
    const indexStore = {
      getIndexPath: (key: { sourceRevision: string }) => {
        if (key.sourceRevision === 'rev-1') {
          return rev1Path;
        }
        if (key.sourceRevision === 'rev-2') {
          return rev2Path;
        }
        return rev3Path;
      },
      findLatestIndexPath: async () => latestSavedPath
    };

    const providerRev1 = new CompositeBundleProvider([
      { sourceId: 'src-a', provider: new LocalFolderBundleProvider({ root: sourceADir, sourceId: 'src-a' }) },
      { sourceId: 'src-b', provider: new LocalFolderBundleProvider({ root: sourceBDir, sourceId: 'src-b' }) }
    ]);

    const res1 = await buildIndex({
      provider: providerRev1,
      indexStore,
      indexKey: { hubId: 'hub-1', sourceRevision: 'rev-1', searchProfileId: 'ternlight-dual-v1' },
      profile: 'ternlight-dual-v1',
      sourceRevisions: { 'src-a': 'sha-a1', 'src-b': 'sha-b1' }
    });
    latestSavedPath = res1.outFile;
    expect(res1.primitives).toBe(2);

    // In rev-2, src-a is unchanged ('sha-a1') and src-b is updated ('sha-b2').
    // Give src-a a throwing provider to prove src-a is NOT re-harvested!
    let srcACalled = false;
    const throwingSrcA: BundleProvider = {
      async* listBundles(): AsyncIterable<BundleRef> {
        srcACalled = true;
        yield* [];
        throw new Error('unchanged source src-a must not be harvested');
      },
      readManifest: async (): Promise<BundleManifest> => ({ id: 'a', version: '1.0.0' }),
      readFile: async (): Promise<string> => ''
    };
    const providerRev2 = new CompositeBundleProvider([
      { sourceId: 'src-a', provider: throwingSrcA },
      { sourceId: 'src-b', provider: new LocalFolderBundleProvider({ root: sourceBDir, sourceId: 'src-b' }) }
    ]);

    const logsRev2: string[] = [];
    const res2 = await buildIndex({
      provider: providerRev2,
      indexStore,
      indexKey: { hubId: 'hub-1', sourceRevision: 'rev-2', searchProfileId: 'ternlight-dual-v1' },
      profile: 'ternlight-dual-v1',
      sourceRevisions: { 'src-a': 'sha-a1', 'src-b': 'sha-b2' },
      onLog: (msg) => logsRev2.push(msg)
    });
    latestSavedPath = res2.outFile;

    expect(srcACalled).toBe(false);
    expect(res2.primitives).toBe(2);
    expect(res2.bundles).toBe(2);
    expect(res2.report.state).toBe('ready');
    expect(logsRev2.some((m) => m.includes('reused all 4 embeddings'))).toBe(true);

    // In rev-3, src-b is removed; only src-a ('sha-a1') remains.
    // Neither source needs harvesting or embedding!
    const providerRev3 = new CompositeBundleProvider([
      { sourceId: 'src-a', provider: throwingSrcA }
    ]);
    const logsRev3: string[] = [];
    const res3 = await buildIndex({
      provider: providerRev3,
      indexStore,
      indexKey: { hubId: 'hub-1', sourceRevision: 'rev-3', searchProfileId: 'ternlight-dual-v1' },
      profile: 'ternlight-dual-v1',
      sourceRevisions: { 'src-a': 'sha-a1' },
      onLog: (msg) => logsRev3.push(msg)
    });

    expect(srcACalled).toBe(false);
    expect(res3.primitives).toBe(1);
    expect(res3.bundles).toBe(1);
    expect(logsRev3.some((m) => m.includes('reused all 2 embeddings'))).toBe(true);
  });

  it('re-harvests a previously failed/empty source even when its revision in sourceRevisions is unchanged, and harvests provider sources omitted from sourceRevisions', async () => {
    const sourceADir = path.join(tempDir, 'source-a-retry');
    const sourceBDir = path.join(tempDir, 'source-b-retry');
    const sourceCDir = path.join(tempDir, 'source-c-unlisted');
    await fs.promises.mkdir(path.join(sourceADir, 'bundle-a', 'prompts'), { recursive: true });
    await fs.promises.mkdir(path.join(sourceBDir, 'bundle-b', 'prompts'), { recursive: true });
    await fs.promises.mkdir(path.join(sourceCDir, 'bundle-c', 'prompts'), { recursive: true });
    await fs.promises.writeFile(
      path.join(sourceADir, 'bundle-a', 'deployment-manifest.yml'),
      'id: bundle-a\nversion: 1.0.0\nname: Bundle A\nitems:\n  - path: prompts/a.prompt.md\n    kind: prompt\n'
    );
    await fs.promises.writeFile(path.join(sourceADir, 'bundle-a', 'prompts', 'a.prompt.md'), '# Alpha\n');
    await fs.promises.writeFile(
      path.join(sourceBDir, 'bundle-b', 'deployment-manifest.yml'),
      'id: bundle-b\nversion: 1.0.0\nname: Bundle B\nitems:\n  - path: prompts/b.prompt.md\n    kind: prompt\n'
    );
    await fs.promises.writeFile(path.join(sourceBDir, 'bundle-b', 'prompts', 'b.prompt.md'), '# Beta\n');
    await fs.promises.writeFile(
      path.join(sourceCDir, 'bundle-c', 'deployment-manifest.yml'),
      'id: bundle-c\nversion: 1.0.0\nname: Bundle C\nitems:\n  - path: prompts/c.prompt.md\n    kind: prompt\n'
    );
    await fs.promises.writeFile(path.join(sourceCDir, 'bundle-c', 'prompts', 'c.prompt.md'), '# Gamma\n');

    const indexPath = path.join(tempDir, 'retry-index', 'primitive-index.v2.json');
    const indexStore = {
      getIndexPath: () => indexPath,
      findLatestIndexPath: async () => indexPath
    };
    const indexKey = { hubId: 'hub-retry', sourceRevision: 'rev-same', searchProfileId: 'bm25-v1' };

    // Build 1: src-b fails transiently, so the persisted snapshot has primitives only for src-a
    const brokenSrcB: BundleProvider = {
      async* listBundles(): AsyncIterable<BundleRef> {
        yield* [];
        throw new Error('transient network failure');
      },
      readManifest: async (): Promise<BundleManifest> => ({ id: 'b', version: '1.0.0' }),
      readFile: async (): Promise<string> => ''
    };
    const res1 = await buildIndex({
      provider: new CompositeBundleProvider([
        { sourceId: 'src-a', provider: new LocalFolderBundleProvider({ root: sourceADir, sourceId: 'src-a' }) },
        { sourceId: 'src-b', provider: brokenSrcB }
      ]),
      indexStore,
      indexKey,
      sourceRevisions: { 'src-a': 'sha-a', 'src-b': 'sha-b' }
    });
    expect(res1.primitives).toBe(1);
    expect(res1.report.state).toBe('partial');

    // Build 2: same indexKey and same sourceRevisions, plus an unlisted provider source 'src-c'.
    // Must NOT short-circuit on the incomplete snapshot, must retry 'src-b', and must harvest 'src-c'!
    let srcAReharvested = false;
    const throwingSrcA: BundleProvider = {
      async* listBundles(): AsyncIterable<BundleRef> {
        srcAReharvested = true;
        yield* [];
        throw new Error('healthy unchanged src-a must be carried over, not re-harvested');
      },
      readManifest: async (): Promise<BundleManifest> => ({ id: 'a', version: '1.0.0' }),
      readFile: async (): Promise<string> => ''
    };
    const res2 = await buildIndex({
      provider: new CompositeBundleProvider([
        { sourceId: 'src-a', provider: throwingSrcA },
        { sourceId: 'src-b', provider: new LocalFolderBundleProvider({ root: sourceBDir, sourceId: 'src-b' }) },
        { sourceId: 'src-c', provider: new LocalFolderBundleProvider({ root: sourceCDir, sourceId: 'src-c' }) }
      ]),
      indexStore,
      indexKey,
      sourceRevisions: { 'src-a': 'sha-a', 'src-b': 'sha-b' }
    });

    expect(srcAReharvested).toBe(false);
    expect(res2.report.shortCircuited).toBeUndefined();
    expect(res2.primitives).toBe(3);
    expect(res2.bundles).toBe(3);

    // Build 3: with all sources now healthy (even if we add a healthy 0-primitive source 'src-empty'),
    // after 'src-empty' is harvested once, subsequent builds with the same revision MUST short-circuit
    // and skip 'src-empty' without re-harvesting it!
    let emptySourceCalls = 0;
    const healthyEmptySource: BundleProvider = {
      async* listBundles(): AsyncIterable<BundleRef> {
        emptySourceCalls += 1;
        yield* [];
      },
      readManifest: async (): Promise<BundleManifest> => ({ id: 'empty', version: '1.0.0' }),
      readFile: async (): Promise<string> => ''
    };
    const revEmptyKey = { hubId: 'hub-retry', sourceRevision: 'rev-with-empty', searchProfileId: 'bm25-v1' };
    const res3 = await buildIndex({
      provider: new CompositeBundleProvider([
        { sourceId: 'src-a', provider: throwingSrcA },
        { sourceId: 'src-empty', provider: healthyEmptySource }
      ]),
      indexStore,
      indexKey: revEmptyKey,
      sourceRevisions: { 'src-a': 'sha-a', 'src-empty': 'sha-empty', 'src-skipped-by-provider': 'sha-skipped' }
    });
    expect(emptySourceCalls).toBe(1);
    expect(res3.primitives).toBe(1);

    // Build 4: same revEmptyKey -> must short-circuit in 0 calls even though 'src-empty' has 0 primitives!
    const res4 = await buildIndex({
      provider: new CompositeBundleProvider([
        { sourceId: 'src-a', provider: throwingSrcA },
        { sourceId: 'src-empty', provider: healthyEmptySource }
      ]),
      indexStore,
      indexKey: revEmptyKey,
      sourceRevisions: { 'src-a': 'sha-a', 'src-empty': 'sha-empty', 'src-skipped-by-provider': 'sha-skipped' }
    });
    expect(emptySourceCalls).toBe(1);
    expect(res4.report.shortCircuited).toBe(true);
  });
});
