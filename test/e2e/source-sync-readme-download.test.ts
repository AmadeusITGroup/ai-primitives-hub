import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import nock from 'nock';
import * as sinon from 'sinon';
import {
  SourceCommands,
} from '../../src/commands/source-commands';
import {
  RegistrySource,
} from '../../src/types/registry';
import {
  createE2ETestContext,
  E2ETestContext,
  generateTestId,
} from '../helpers/e2e-test-helpers';
import {
  computeBundleId,
  createMockGitHubSource,
  createTestConfig,
  setupReleaseMocks,
} from '../helpers/repository-fixture-helpers';

suite('Test Readme Download on Source Sync', () => {
  const readmeDownload = (sourceId: string) => {
    return new Promise<{ sourceId: string; succeeded: string[]; failed: string[] }>((resolve) => {
      testContext.registryManager.onReadmeDownloadComplete((e) => {
        if (e.sourceId === sourceId) {
          resolve(e);
        }
      });
    });
  };

  const fixturesPath = path.join(__dirname, '../fixtures/local-awesome-collections');
  let testContext: E2ETestContext;
  let testId: string;
  let sandbox: sinon.SinonSandbox;
  let sourceCommands: SourceCommands;
  let mockGithubSource: RegistrySource;
  let mockAwesomeCopilotSource: RegistrySource;
  let mockLocalAwesomeCopilotSource: RegistrySource;

  setup(async () => {
    testId = generateTestId('readme-download');
    sandbox = sinon.createSandbox();
    testContext = await createE2ETestContext();
    sourceCommands = new SourceCommands(testContext.registryManager);

    const githubConfig = createTestConfig({
      owner: 'test-owner',
      repo: 'test-repo',
      manifestId: 'test-collection'
    });
    setupReleaseMocks(githubConfig, [
      {
        tag: 'v1.0.0',
        version: '1.0.0',
        content: 'initial',
        readme: '# My Bundle\nThis is the README content.'
      }
    ]);

    // Mock awesome copilot source responses
    nock('https://api.github.com')
      .persist()
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
      .persist()
      .get('/test-owner/awesome-copilot/main/collections/test-collection.collection.yml')
      .reply(200, `id: test-collection
name: Test Collection
description: Test collection for unit tests
tags: ["test", "example"]
readme:
  path: "docs/README.md"
items:
  - path: "prompts/test.prompt.md"
    kind: prompt
`);

    nock('https://raw.githubusercontent.com')
      .persist()
      .get('/test-owner/awesome-copilot/main/docs/README.md')
      .reply(200, '# Awesome README\nAwesome source README content.');

    // Mock the branch head commit sha used as the readme revision
    nock('https://api.github.com')
      .persist()
      .get('/repos/test-owner/awesome-copilot/commits/main')
      .reply(200, { sha: 'awesome-sha-1' });

    // Mock sources with different types

    mockGithubSource = createMockGitHubSource(`${testId}-github-source`, githubConfig);

    mockAwesomeCopilotSource =
      {
        id: `${testId}-awesome-copilot-source`,
        name: 'Awesome Copilot Test',
        type: 'awesome-copilot',
        url: 'https://github.com/test-owner/awesome-copilot',
        enabled: true,
        priority: 1
      };

    mockLocalAwesomeCopilotSource =
      {
        id: `${testId}-local-awesome-copilot-source`,
        name: 'Local Awesome Copilot Test',
        type: 'local-awesome-copilot',
        url: `file://${fixturesPath}`,
        enabled: true,
        priority: 1
      };
  });

  teardown(async () => {
    sandbox.restore();
    nock.cleanAll();
    nock.enableNetConnect();
    await testContext.cleanup();
  });

  suite('should download and cache readme correctly', () => {
    test('for github source type', async () => {
      const githubReadmePromise = readmeDownload(mockGithubSource.id);

      await testContext.registryManager.addSource(mockGithubSource);
      await sourceCommands.syncAllSources({ silent: true });

      const githubReadme = await githubReadmePromise;
      const cachedGithubSourceBundles = await testContext.storage.getCachedSourceBundles(mockGithubSource.id);

      assert.strictEqual(githubReadme.sourceId, mockGithubSource.id, 'GitHub source ID should match');
      assert.strictEqual(githubReadme.succeeded[0], 'test-owner-test-repo-test-collection-1.0.0', 'GitHub readme should be downloaded for the correct bundle');
      assert.strictEqual(cachedGithubSourceBundles[0].readme, '# My Bundle\nThis is the README content.', 'GitHub source bundle should have correct readme cached');
    });

    test('for awesome-copilot source type', async () => {
      const awesomeCopilotReadmePromise = readmeDownload(mockAwesomeCopilotSource.id);

      await testContext.registryManager.addSource(mockAwesomeCopilotSource);
      await sourceCommands.syncAllSources({ silent: true });

      const awesomeCopilotReadme = await awesomeCopilotReadmePromise;
      const cachedAwesomeCopilotSourceBundles = await testContext.storage.getCachedSourceBundles(mockAwesomeCopilotSource.id);

      assert.strictEqual(awesomeCopilotReadme.sourceId, mockAwesomeCopilotSource.id, 'Awesome Copilot source ID should match');
      assert.strictEqual(awesomeCopilotReadme.succeeded[0], 'test-collection', 'Awesome Copilot readme should be downloaded for the correct bundle');
      assert.strictEqual(cachedAwesomeCopilotSourceBundles[0].readme, '# Awesome README\nAwesome source README content.', 'Awesome Copilot source bundle should have correct readme cached');
      assert.strictEqual(cachedAwesomeCopilotSourceBundles[0].readmeRevision, 'awesome-sha-1', 'Awesome Copilot bundle should record the branch sha as its readme revision');
    });

    test('for local-awesome-copilot source type', async () => {
      const localAwesomeCopilotReadmePromise = readmeDownload(mockLocalAwesomeCopilotSource.id);

      await testContext.registryManager.addSource(mockLocalAwesomeCopilotSource);
      await sourceCommands.syncAllSources({ silent: true });

      const localAwesomeCopilotReadme = await localAwesomeCopilotReadmePromise;
      const cachedLocalAwesomeCopilotSourceBundles = await testContext.storage.getCachedSourceBundles(mockLocalAwesomeCopilotSource.id);
      const bundleWithReadme = cachedLocalAwesomeCopilotSourceBundles.find((bundle) => bundle.id === 'test-with-readme');

      assert.strictEqual(localAwesomeCopilotReadme.sourceId, mockLocalAwesomeCopilotSource.id, 'Local Awesome Copilot source ID should match');
      assert.ok(localAwesomeCopilotReadme.succeeded.includes('test-with-readme'), 'Local Awesome Copilot readme should be downloaded for the explicit readme fixture bundle');
      assert.ok(bundleWithReadme, 'Bundle with readme metadata should be cached');
      assert.strictEqual(bundleWithReadme.readme,
        '# Test Collection With Readme\nThis is a dedicated README fixture for local-awesome-copilot tests.\n', 'Local Awesome Copilot readme fixture should have correct readme cached');
    });
  });

  suite('should reuse cached readme when the source revision is unchanged', () => {
    test('for github source type', async () => {
      const expectedBundleId = 'test-owner-test-repo-test-collection-1.0.0';

      // First sync downloads the readme
      const firstComplete = readmeDownload(mockGithubSource.id);
      await testContext.registryManager.addSource(mockGithubSource);
      await sourceCommands.syncAllSources({ silent: true });
      const first = await firstComplete;
      assert.ok(first.succeeded.includes(expectedBundleId), 'first sync should download the readme');

      // Second sync of the same release should reuse the cached readme without re-downloading
      const secondComplete = readmeDownload(mockGithubSource.id);
      await sourceCommands.syncAllSources({ silent: true });
      const second = await secondComplete;
      assert.deepStrictEqual(second.succeeded, [], 'second sync should not re-download an unchanged readme');

      const cached = await testContext.storage.getCachedSourceBundles(mockGithubSource.id);
      assert.strictEqual(cached[0].readme, '# My Bundle\nThis is the README content.', 'cached readme should be preserved across re-sync');
    });
  });

  suite('should handle missing readme gracefully', () => {
    test('for github source type', async () => {
      const githubConfig = createTestConfig({
        owner: 'test-owner',
        repo: 'test-repo-no-readme',
        manifestId: 'test-collection-no-readme'
      });
      setupReleaseMocks(githubConfig, [
        {
          tag: 'v1.0.0',
          version: '1.0.0',
          content: 'initial'
        }
      ]);
      const githubSourceWithoutReadme = createMockGitHubSource(`${testId}-github-source-without-readme`, githubConfig);
      const githubReadmePromise = readmeDownload(githubSourceWithoutReadme.id);

      await testContext.registryManager.addSource(githubSourceWithoutReadme);
      await sourceCommands.syncAllSources({ silent: true });

      const githubReadme = await githubReadmePromise;
      const cachedGithubSourceBundles = await testContext.storage.getCachedSourceBundles(githubSourceWithoutReadme.id);
      const expectedBundleId = computeBundleId(githubConfig, '1.0.0');
      const bundleWithoutReadme = cachedGithubSourceBundles.find((bundle) => bundle.id === expectedBundleId);

      assert.ok(bundleWithoutReadme, 'GitHub bundle without readme metadata should still be cached');
      assert.strictEqual(bundleWithoutReadme.readme, undefined, 'GitHub bundle without readme metadata should not get a cached readme');
      assert.ok(!githubReadme.succeeded.includes(bundleWithoutReadme.id), 'GitHub bundle without readme metadata should not be marked as succeeded');
      assert.ok(!githubReadme.failed.includes(bundleWithoutReadme.id), 'GitHub bundle without readme metadata should not be marked as failed');
    });

    test('for awesome-copilot source type', async () => {
      const awesomeCopilotSourceWithoutReadme: RegistrySource = {
        id: `${testId}-awesome-copilot-source-without-readme`,
        name: 'Awesome Copilot Source Without Readme',
        type: 'awesome-copilot',
        url: 'https://github.com/test-owner/awesome-copilot-no-readme',
        enabled: true,
        priority: 1
      };

      nock('https://api.github.com')
        .persist()
        .get('/repos/test-owner/awesome-copilot-no-readme/contents/collections?ref=main')
        .reply(200, [
          {
            name: 'no-readme.collection.yml',
            type: 'file',
            download_url: 'https://raw.githubusercontent.com/test-owner/awesome-copilot-no-readme/main/collections/no-readme.collection.yml'
          }
        ]);

      nock('https://api.github.com')
        .persist()
        .get('/repos/test-owner/awesome-copilot-no-readme/commits/main')
        .reply(200, { sha: 'no-readme-sha-1' });

      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/awesome-copilot-no-readme/main/collections/no-readme.collection.yml')
        .reply(200, `id: no-readme
name: No Readme Collection
description: Collection without readme metadata
items:
  - path: prompts/test.prompt.md
    kind: prompt
`);

      const awesomeCopilotReadmePromise = readmeDownload(awesomeCopilotSourceWithoutReadme.id);

      await testContext.registryManager.addSource(awesomeCopilotSourceWithoutReadme);
      await sourceCommands.syncAllSources({ silent: true });

      const awesomeCopilotReadme = await awesomeCopilotReadmePromise;
      const cachedAwesomeCopilotSourceBundles = await testContext.storage.getCachedSourceBundles(awesomeCopilotSourceWithoutReadme.id);
      const bundleWithoutReadme = cachedAwesomeCopilotSourceBundles.find((bundle) => bundle.id === 'no-readme');

      assert.ok(bundleWithoutReadme, 'Awesome Copilot bundle without readme metadata should still be cached');
      assert.strictEqual(bundleWithoutReadme.readme, undefined, 'Awesome Copilot bundle without readme metadata should not get a cached readme');
      assert.ok(!awesomeCopilotReadme.succeeded.includes(bundleWithoutReadme.id), 'Awesome Copilot bundle without readme metadata should not be marked as succeeded');
      assert.ok(!awesomeCopilotReadme.failed.includes(bundleWithoutReadme.id), 'Awesome Copilot bundle without readme metadata should not be marked as failed');
    });

    test('for local-awesome-copilot source type', async () => {
      const localAwesomeCopilotReadmePromise = readmeDownload(mockLocalAwesomeCopilotSource.id);

      await testContext.registryManager.addSource(mockLocalAwesomeCopilotSource);
      await sourceCommands.syncAllSources({ silent: true });

      const localAwesomeCopilotReadme = await localAwesomeCopilotReadmePromise;
      const cachedLocalAwesomeCopilotSourceBundles = await testContext.storage.getCachedSourceBundles(mockLocalAwesomeCopilotSource.id);
      const bundleWithoutReadme = cachedLocalAwesomeCopilotSourceBundles.find((bundle) => bundle.id === 'test-without-readme');

      assert.ok(bundleWithoutReadme, 'Bundle without readme metadata should still be cached');
      assert.strictEqual(bundleWithoutReadme.readme, undefined, 'Bundle without readme metadata should not get a cached readme');
      assert.ok(!localAwesomeCopilotReadme.succeeded.includes('test-without-readme'), 'Bundle without readme metadata should not be marked as succeeded');
      assert.ok(!localAwesomeCopilotReadme.failed.includes('test-without-readme'), 'Bundle without readme metadata should not be marked as failed');
    });
  });

  suite('should handle readme pointing at wrong file', () => {
    test('for github source type', async () => {
      const githubConfig = createTestConfig({
        owner: 'test-owner',
        repo: 'test-repo-broken-readme',
        manifestId: 'broken-github-readme'
      });
      setupReleaseMocks(githubConfig, [
        {
          tag: 'v1.0.0',
          version: '1.0.0',
          content: 'initial',
          readme: '# Broken README',
          readmeStatus: 404
        }
      ]);
      const brokenGithubSource = createMockGitHubSource(`${testId}-broken-github-source`, githubConfig);

      const brokenGithubReadmePromise = readmeDownload(brokenGithubSource.id);

      await testContext.registryManager.addSource(brokenGithubSource);
      await sourceCommands.syncAllSources({ silent: true });

      const brokenGithubReadme = await brokenGithubReadmePromise;
      const cachedBrokenGithubSourceBundles = await testContext.storage.getCachedSourceBundles(brokenGithubSource.id);
      const expectedBundleId = computeBundleId(githubConfig, '1.0.0');
      const brokenGithubBundle = cachedBrokenGithubSourceBundles.find((bundle) => bundle.id === expectedBundleId);

      assert.ok(brokenGithubBundle, 'Broken GitHub bundle should still be cached after sync');
      assert.strictEqual(brokenGithubBundle.readme, undefined, 'Failed GitHub readme downloads should not cache readme content');
      assert.deepStrictEqual(brokenGithubReadme.succeeded, [], 'Missing GitHub readme downloads should not be marked as succeeded');
      assert.deepStrictEqual(brokenGithubReadme.failed, [brokenGithubBundle.id], 'Missing GitHub readme downloads should be marked as failed');
    });

    test('for awesome-copilot source type', async () => {
      const brokenAwesomeCopilotSource: RegistrySource = {
        id: `${testId}-broken-awesome-copilot-source`,
        name: 'Broken Awesome Copilot Source',
        type: 'awesome-copilot',
        url: 'https://github.com/test-owner/awesome-copilot-broken-readme',
        enabled: true,
        priority: 1
      };

      nock('https://api.github.com')
        .persist()
        .get('/repos/test-owner/awesome-copilot-broken-readme/contents/collections?ref=main')
        .reply(200, [
          {
            name: 'broken-readme.collection.yml',
            type: 'file',
            download_url: 'https://raw.githubusercontent.com/test-owner/awesome-copilot-broken-readme/main/collections/broken-readme.collection.yml'
          }
        ]);

      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/awesome-copilot-broken-readme/main/collections/broken-readme.collection.yml')
        .reply(200, `id: broken-readme
name: Broken Readme
description: Collection with a missing readme file
readme:
  path: docs/missing-readme.md
items:
  - path: prompts/test.prompt.md
    kind: prompt
`);

      const brokenAwesomeCopilotReadmePromise = readmeDownload(brokenAwesomeCopilotSource.id);

      await testContext.registryManager.addSource(brokenAwesomeCopilotSource);
      await sourceCommands.syncAllSources({ silent: true });

      const brokenAwesomeCopilotReadme = await brokenAwesomeCopilotReadmePromise;
      const cachedBrokenAwesomeCopilotSourceBundles = await testContext.storage.getCachedSourceBundles(brokenAwesomeCopilotSource.id);
      const brokenAwesomeCopilotBundle = cachedBrokenAwesomeCopilotSourceBundles.find((bundle) => bundle.id === 'broken-readme');

      assert.ok(brokenAwesomeCopilotBundle, 'Broken awesome-copilot bundle should still be cached after sync');
      assert.strictEqual(brokenAwesomeCopilotBundle.readme, undefined, 'Failed awesome-copilot readme downloads should not cache readme content');
      assert.deepStrictEqual(brokenAwesomeCopilotReadme.succeeded, [], 'Missing awesome-copilot readme downloads should not be marked as succeeded');
      assert.deepStrictEqual(brokenAwesomeCopilotReadme.failed, ['broken-readme'], 'Missing awesome-copilot readme downloads should be marked as failed');
    });

    test('for local-awesome-copilot source type', async () => {
      const brokenCollectionsRoot = path.join(testContext.tempStoragePath, `broken-local-awesome-${testId}`);
      await fs.mkdir(path.join(brokenCollectionsRoot, 'collections'), { recursive: true });
      await fs.mkdir(path.join(brokenCollectionsRoot, 'prompts'), { recursive: true });

      await fs.writeFile(
        path.join(brokenCollectionsRoot, 'collections', 'broken-readme.collection.yml'),
        `id: broken-readme
name: Broken Readme
description: Collection with a missing readme file
readme:
  path: docs/missing-readme.md
items:
  - path: prompts/test.prompt.md
    kind: prompt
`
      );
      await fs.writeFile(
        path.join(brokenCollectionsRoot, 'prompts', 'test.prompt.md'),
        '# Test prompt\n'
      );

      const brokenSource: RegistrySource = {
        id: `${testId}-broken-local-awesome-copilot-source`,
        name: 'Broken Local Awesome Copilot Test',
        type: 'local-awesome-copilot',
        url: `file://${brokenCollectionsRoot}`,
        enabled: true,
        priority: 1
      };

      const brokenReadmePromise = readmeDownload(brokenSource.id);

      await testContext.registryManager.addSource(brokenSource);
      await sourceCommands.syncAllSources({ silent: true });

      const brokenReadme = await brokenReadmePromise;
      const cachedBrokenSourceBundles = await testContext.storage.getCachedSourceBundles(brokenSource.id);
      const brokenBundle = cachedBrokenSourceBundles.find((bundle) => bundle.id === 'broken-readme');

      assert.strictEqual(brokenReadme.sourceId, brokenSource.id, 'Broken source ID should match');
      assert.deepStrictEqual(brokenReadme.succeeded, [], 'Missing readme downloads should not be marked as succeeded');
      assert.deepStrictEqual(brokenReadme.failed, ['broken-readme'], 'Missing readme downloads should be marked as failed');
      assert.ok(brokenBundle, 'Broken bundle should still be cached after sync');
      assert.strictEqual(brokenBundle.readme, undefined, 'Failed readme downloads should not cache readme content');
    });
  });
});
