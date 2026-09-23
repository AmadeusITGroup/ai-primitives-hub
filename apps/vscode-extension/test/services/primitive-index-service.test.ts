import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LocalFolderBundleProvider,
} from '@ai-primitives-hub/infra';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  PrimitiveIndexService,
} from '../../src/services/primitive-index-service';
import {
  Logger,
} from '../../src/utils/logger';

suite('PrimitiveIndexService', () => {
  let tempDir: string;
  let bundleDir: string;
  let context: vscode.ExtensionContext;

  setup(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'primitive-index-service-'));
    bundleDir = path.join(tempDir, 'local-bundle');
    await fs.mkdir(path.join(bundleDir, 'prompts'), { recursive: true });
    await fs.writeFile(
      path.join(bundleDir, 'deployment-manifest.yml'),
      'id: local-bundle\nversion: 1.0.0\nname: Local Bundle\nitems:\n  - path: prompts/hello.prompt.md\n    kind: prompt\n'
    );
    await fs.writeFile(
      path.join(bundleDir, 'prompts', 'hello.prompt.md'),
      '# Hello Prompt\n\nA diagnostic prompt.\n'
    );
    context = {
      globalStorageUri: vscode.Uri.file(path.join(tempDir, 'extension-storage')),
      globalState: {} as any,
      subscriptions: []
    } as any as vscode.ExtensionContext;
  });

  teardown(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('uses the app search use cases with one configured profile', async () => {
    const indexPath = path.join(tempDir, 'index.json');
    const service = new PrimitiveIndexService(context, {
      profile: 'bm25-v1',
      indexPath,
      providerFactory: () => new LocalFolderBundleProvider({ root: tempDir, sourceId: 'local' })
    });

    const build = await service.rebuild();
    const result = await service.search({ q: 'hello', limit: 5 });

    assert.strictEqual(service.getProfile(), 'bm25-v1');
    assert.strictEqual(service.getIndexPath(), indexPath);
    assert.strictEqual(build.primitives, 1);
    assert.strictEqual(result.hits.length, 1);
    assert.strictEqual(result.hits[0]?.primitive.title, 'Hello Prompt');
  });

  test('logs rebuild start, build progress, and completion', async () => {
    const info = sinon.stub(Logger.getInstance(), 'info');
    const indexPath = path.join(tempDir, 'index-with-progress.json');
    const service = new PrimitiveIndexService(context, {
      profile: 'bm25-v1',
      indexPath,
      providerFactory: () => new LocalFolderBundleProvider({ root: tempDir, sourceId: 'local' })
    });

    try {
      await service.rebuild();

      assert.ok(info.calledWith('Primitive index rebuild started (profile=bm25-v1)'));
      assert.ok(info.args.some(([message]) => String(message).includes('harvested 1 primitive from 1 bundle')));
      assert.ok(info.args.some(([message]) => String(message).includes('building BM25 index and facet maps')));
      assert.ok(info.args.some(([message]) => String(message).includes('Primitive index rebuild completed: 1 primitive from 1 bundle')));
    } finally {
      info.restore();
    }
  });

  test('searches a prebuilt index without invoking the bundle provider', async () => {
    const indexPath = path.join(tempDir, 'prebuilt-index.json');
    const builder = new PrimitiveIndexService(context, {
      profile: 'bm25-v1',
      indexPath,
      providerFactory: () => new LocalFolderBundleProvider({ root: tempDir, sourceId: 'local' })
    });
    await builder.rebuild();

    let providerCalls = 0;
    const searcher = new PrimitiveIndexService(context, {
      profile: 'bm25-v1',
      indexPath,
      providerFactory: () => {
        providerCalls += 1;
        throw new Error('provider must not be called during search');
      }
    });

    const result = await searcher.search({ q: 'hello', limit: 5 });

    assert.strictEqual(providerCalls, 0);
    assert.strictEqual(result.hits.length, 1);
    assert.strictEqual(result.hits[0]?.primitive.title, 'Hello Prompt');
  });

  test('uses the local-only search key provider instead of the rebuild key provider', async () => {
    const indexPath = path.join(tempDir, 'prebuilt-namespaced-index.json');
    const builder = new PrimitiveIndexService(context, {
      profile: 'bm25-v1',
      indexPath,
      providerFactory: () => new LocalFolderBundleProvider({ root: tempDir, sourceId: 'local' })
    });
    await builder.rebuild();

    const searcher = new PrimitiveIndexService(context, {
      profile: 'bm25-v1',
      indexStore: {
        getIndexPath: () => indexPath
      },
      indexKeyProvider: async () => {
        throw new Error('remote-aware key provider must not be called during search');
      },
      searchIndexKeyProvider: async () => ({
        hubId: 'my-hub-id',
        sourceRevision: 'cached',
        searchProfileId: 'bm25-v1'
      }),
      providerFactory: () => {
        throw new Error('provider must not be called during search');
      }
    });

    const result = await searcher.search({ q: 'hello', limit: 5 });

    assert.strictEqual(result.hits.length, 1);
    assert.strictEqual(result.hits[0]?.primitive.title, 'Hello Prompt');
  });

  test('uses the extension app-storage cache by default', () => {
    const service = new PrimitiveIndexService(context, {
      profile: 'bm25-v1',
      providerFactory: () => new LocalFolderBundleProvider({ root: bundleDir, sourceId: 'local' })
    });

    assert.strictEqual(
      service.getIndexPath(),
      path.join(tempDir, 'extension-storage', 'cache', 'primitive-index.json')
    );
  });

  test('uses an injected namespaced index store', () => {
    const indexPath = path.join(tempDir, 'shared', 'primitive-index.v2.json');
    const service = new PrimitiveIndexService(context, {
      profile: 'bm25-v1',
      indexStore: {
        getIndexPath: () => indexPath
      },
      providerFactory: () => new LocalFolderBundleProvider({ root: bundleDir, sourceId: 'local' })
    });

    assert.strictEqual(service.getIndexPath(), indexPath);
  });

  test('reads the legacy cache until a namespaced index is available', async () => {
    const legacyService = new PrimitiveIndexService(context, {
      profile: 'bm25-v1',
      providerFactory: () => new LocalFolderBundleProvider({ root: tempDir, sourceId: 'local' })
    });
    await legacyService.rebuild();
    const legacyResult = await legacyService.search({ q: 'hello', limit: 5 });
    assert.strictEqual(legacyResult.hits.length, 1);

    const namespacedService = new PrimitiveIndexService(context, {
      profile: 'bm25-v1',
      indexStore: {
        getIndexPath: () => path.join(tempDir, 'shared', 'primitive-index.v2.json')
      },
      providerFactory: () => new LocalFolderBundleProvider({ root: tempDir, sourceId: 'local' })
    });

    await namespacedService.ensureBuilt();
    const result = await namespacedService.search({ q: 'hello', limit: 5 });

    assert.strictEqual(result.hits.length, 1);
    assert.strictEqual(result.hits[0]?.primitive.title, 'Hello Prompt');
  });

  test('does not use a legacy BM25 cache for an embedding profile', async () => {
    const legacyService = new PrimitiveIndexService(context, {
      profile: 'bm25-v1',
      providerFactory: () => new LocalFolderBundleProvider({ root: tempDir, sourceId: 'local' })
    });
    await legacyService.rebuild();

    const embeddingService = new PrimitiveIndexService(context, {
      profile: 'ternlight-dual-v1',
      indexStore: {
        getIndexPath: () => path.join(tempDir, 'dual', 'primitive-index.v2.json')
      },
      providerFactory: () => new LocalFolderBundleProvider({ root: tempDir, sourceId: 'local' })
    });

    await assert.rejects(
      embeddingService.search({ q: 'hello', limit: 5 }),
      (error: unknown) => error instanceof Error && error.message.includes('primitive-index.v2.json')
    );
  });

  test('uses the newest non-empty snapshot when the current snapshot is empty', async () => {
    const fallbackService = new PrimitiveIndexService(context, {
      profile: 'bm25-v1',
      providerFactory: () => new LocalFolderBundleProvider({ root: tempDir, sourceId: 'local' })
    });
    await fallbackService.rebuild();

    const currentPath = path.join(tempDir, 'current', 'primitive-index.v2.json');
    await fs.mkdir(path.dirname(currentPath), { recursive: true });
    await fs.writeFile(currentPath, JSON.stringify({ primitives: [] }));
    const service = new PrimitiveIndexService(context, {
      profile: 'bm25-v1',
      indexStore: {
        getIndexPath: () => currentPath,
        findLatestIndexPath: async () => fallbackService.getIndexPath()
      },
      providerFactory: () => new LocalFolderBundleProvider({ root: tempDir, sourceId: 'local' })
    });

    const result = await service.search({ q: 'hello', limit: 5 });

    assert.strictEqual(result.hits.length, 1);
    assert.strictEqual(result.hits[0]?.primitive.title, 'Hello Prompt');
  });

  test('waits for initial source sync and recovers an empty persisted index', async () => {
    const indexPath = path.join(tempDir, 'empty-index.json');
    await fs.writeFile(indexPath, JSON.stringify({ primitives: [] }));
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    let buildCalls = 0;
    const service = new PrimitiveIndexService(context, {
      profile: 'bm25-v1',
      indexPath,
      initializationReady: ready,
      providerFactory: () => {
        buildCalls += 1;
        return new LocalFolderBundleProvider({ root: tempDir, sourceId: 'local' });
      }
    });

    const ensure = service.ensureBuilt();
    await Promise.resolve();
    assert.strictEqual(buildCalls, 0);
    releaseReady();
    await ensure;
    assert.strictEqual(buildCalls, 1);
    const result = await service.search({ q: 'hello', limit: 5 });
    assert.strictEqual(result.hits.length, 1);
  });
});
