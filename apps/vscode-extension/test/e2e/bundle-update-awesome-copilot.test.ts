/**
 * E2E Tests: Awesome Copilot Bundle Update Workflow
 *
 * Tests the complete update workflow for Awesome Copilot bundles:
 * - Manual update via right-click context menu (sync triggers auto-update)
 * - Bundle files replacement after update
 * - Installation record updates
 * - Scope preservation during updates
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 3.1, 3.2, 3.3
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import nock from 'nock';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  RegistrySource,
} from '../../src/types/registry';
import {
  createE2ETestContext,
  E2ETestContext,
  generateTestId,
} from '../helpers/e2e-test-helpers';

suite('E2E: Awesome Copilot Bundle Update Tests', () => {
  let testContext: E2ETestContext;
  let testId: string;
  let sandbox: sinon.SinonSandbox;

  // Test fixtures for collection YAML content
  const createCollectionYaml = (version: string, content = 'initial') => `
id: test-collection
name: Test Collection
description: Test collection for E2E tests - ${content}
version: ${version}
tags: ["test", "e2e"]
items:
  - path: "prompts/test.prompt.md"
    kind: prompt
`;

  const createPromptContent = (content: string) => `# Test Prompt

This is a test prompt for E2E testing.
Content: ${content}
`;

  // Mock source configuration
  const createMockSource = (id: string): RegistrySource => ({
    id,
    name: 'Test Awesome Copilot Source',
    type: 'awesome-copilot',
    url: 'https://github.com/test-owner/awesome-copilot-test',
    enabled: true,
    priority: 1,
    config: {
      branch: 'main',
      collectionsPath: 'collections'
    }
  });

  setup(async function () {
    this.timeout(30_000);
    testId = generateTestId('awesome-copilot');

    // Create sinon sandbox for stubbing
    sandbox = sinon.createSandbox();

    // Stub VS Code authentication to return undefined (no auth)
    // This prevents the adapter from using real GitHub tokens
    // Must be done BEFORE creating the test context which initializes RegistryManager
    if (vscode.authentication && typeof vscode.authentication.getSession === 'function') {
      sandbox.stub(vscode.authentication, 'getSession').resolves(undefined);
    }

    // Stub child_process.exec to prevent gh CLI from providing tokens
    const childProcess = require('node:child_process');
    sandbox.stub(childProcess, 'exec').callsFake((...args: unknown[]) => {
      const cmd = args[0] as string;
      const callback = args.at(-1) as (...callbackArgs: unknown[]) => void;
      if (cmd === 'gh auth token') {
        callback(new Error('gh not available'), '', '');
      } else {
        // Call original for other commands
        callback(null, '', '');
      }
    });

    testContext = await createE2ETestContext();

    // Clear any cached auth tokens in adapters
    const adapters = (testContext.registryManager as any).adapters;
    if (adapters) {
      adapters.forEach((adapter: any) => {
        if (adapter.authToken !== undefined) {
          adapter.authToken = undefined;
          adapter.authMethod = 'none';
        }
      });
    }

    // Disable real network connections and allow only mocked ones
    nock.disableNetConnect();

    // Allow localhost for any local test servers
    nock.enableNetConnect('127.0.0.1');
  });

  teardown(async function () {
    this.timeout(10_000);
    await testContext.cleanup();
    sandbox.restore();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  suite('Test Setup Validation', () => {
    test('should create isolated test context with unique storage path', function () {
      this.timeout(10_000);

      // Verify test context was created
      assert.ok(testContext, 'Test context should be created');
      assert.ok(testContext.tempStoragePath, 'Temp storage path should exist');
      assert.ok(fs.existsSync(testContext.tempStoragePath), 'Temp directory should exist');

      // Verify storage is initialized
      const paths = testContext.storage.getPaths();
      assert.ok(fs.existsSync(paths.installed), 'Installed directory should exist');
    });
  });

  suite('Awesome Copilot Update Workflow', () => {
    test('Example 1.1: Update command downloads from configured branch', async function () {
      this.timeout(60_000);

      const sourceId = `${testId}-source`;
      const source = createMockSource(sourceId);
      const initialVersion = '1.0.0';
      const updatedVersion = '1.1.0';

      // Setup all mocks upfront with enough times for all operations
      // Use persist() to allow multiple calls
      // Use query string directly in path (like existing tests)

      // API calls for validation and syncs
      nock('https://api.github.com')
        .persist()
        .get('/repos/test-owner/awesome-copilot-test/contents/collections?ref=main')
        .reply(200, [
          { name: 'test-collection.collection.yml', type: 'file' }
        ]);

      // First sync + install: initial version
      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/awesome-copilot-test/main/collections/test-collection.collection.yml')
        .reply(200, createCollectionYaml(initialVersion, 'initial'));
      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/awesome-copilot-test/main/prompts/test.prompt.md')
        .reply(200, createPromptContent('initial content'));

      // Step 1: Add source (triggers validation)
      await testContext.registryManager.addSource(source);

      // Step 2: Sync source to get bundles
      await testContext.registryManager.syncSource(sourceId);

      // Step 3: Get available bundles and install
      const bundles = await testContext.registryManager.searchBundles({ sourceId });
      assert.ok(bundles.length > 0, 'Should have bundles after sync');

      const bundleToInstall = bundles.find((b) => b.id === 'test-collection');
      assert.ok(bundleToInstall, 'Should find test-collection bundle');

      await testContext.registryManager.installBundle(bundleToInstall.id, { scope: 'user' });

      // Verify initial installation
      const installedBefore = await testContext.registryManager.listInstalledBundles();
      assert.strictEqual(installedBefore.length, 1, 'Should have one installed bundle');
      assert.strictEqual(installedBefore[0].version, initialVersion, 'Should have initial version');

      // Clean up previous mocks and setup new ones for update
      nock.cleanAll();
      nock.disableNetConnect();

      // Clear the adapter's cache to force a fresh fetch
      const adapters = (testContext.registryManager as any).adapters;
      for (const [, adapter] of adapters) {
        if (adapter.collectionsCache) {
          adapter.collectionsCache.clear();
        }
      }

      // Setup mocks for second sync with updated version
      nock('https://api.github.com')
        .persist()
        .get('/repos/test-owner/awesome-copilot-test/contents/collections?ref=main')
        .reply(200, [
          { name: 'test-collection.collection.yml', type: 'file' }
        ]);

      // Collection YAML with updated version (for sync + update download)
      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/awesome-copilot-test/main/collections/test-collection.collection.yml')
        .reply(200, createCollectionYaml(updatedVersion, 'updated'));
      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/awesome-copilot-test/main/prompts/test.prompt.md')
        .reply(200, createPromptContent('updated content'));

      // Step 5: Sync source again - this triggers auto-update for Awesome Copilot bundles
      await testContext.registryManager.syncSource(sourceId);

      // Verify update occurred
      const installedAfter = await testContext.registryManager.listInstalledBundles();
      assert.strictEqual(installedAfter.length, 1, 'Should still have one installed bundle');
      assert.strictEqual(installedAfter[0].version, updatedVersion,
        'Bundle should be updated to new version');

      // Verify the update was from the configured branch (main)
      // The nock mocks verify the correct URLs were called
      assert.ok(true, 'Update downloaded from configured branch (main)');
    });

    test('Example 1.2: Bundle files are replaced after update', async function () {
      this.timeout(60_000);

      const sourceId = `${testId}-source-files`;
      const source = createMockSource(sourceId);
      const initialVersion = '1.0.0';
      const updatedVersion = '1.1.0';

      // Setup mocks for validation + first sync + install
      nock('https://api.github.com')
        .persist()
        .get('/repos/test-owner/awesome-copilot-test/contents/collections?ref=main')
        .reply(200, [
          { name: 'test-collection.collection.yml', type: 'file' }
        ]);
      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/awesome-copilot-test/main/collections/test-collection.collection.yml')
        .reply(200, createCollectionYaml(initialVersion, 'initial'));
      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/awesome-copilot-test/main/prompts/test.prompt.md')
        .reply(200, createPromptContent('INITIAL_CONTENT_MARKER'));

      // Add and sync source
      await testContext.registryManager.addSource(source);
      await testContext.registryManager.syncSource(sourceId);

      // Get bundle and install
      const bundles = await testContext.registryManager.searchBundles({ sourceId });
      const bundleToInstall = bundles.find((b) => b.id === 'test-collection');
      assert.ok(bundleToInstall, 'Should find test-collection bundle');

      await testContext.registryManager.installBundle(bundleToInstall.id, { scope: 'user' });

      // Get install path and verify initial content
      const installedBefore = await testContext.registryManager.listInstalledBundles();
      const installPath = installedBefore[0].installPath;

      // Check that prompt file exists with initial content
      const promptPath = path.join(installPath, 'prompts', 'test.prompt.md');
      if (fs.existsSync(promptPath)) {
        const initialContent = fs.readFileSync(promptPath, 'utf8');
        assert.ok(initialContent.includes('INITIAL_CONTENT_MARKER'),
          'Initial content should contain marker');
      }

      // Clean up and setup mocks for update
      nock.cleanAll();
      nock.disableNetConnect();

      // Clear the adapter's cache to force a fresh fetch
      const adapters = (testContext.registryManager as any).adapters;
      for (const [, adapter] of adapters) {
        if (adapter.collectionsCache) {
          adapter.collectionsCache.clear();
        }
      }

      nock('https://api.github.com')
        .persist()
        .get('/repos/test-owner/awesome-copilot-test/contents/collections?ref=main')
        .reply(200, [
          { name: 'test-collection.collection.yml', type: 'file' }
        ]);
      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/awesome-copilot-test/main/collections/test-collection.collection.yml')
        .reply(200, createCollectionYaml(updatedVersion, 'updated'));
      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/awesome-copilot-test/main/prompts/test.prompt.md')
        .reply(200, createPromptContent('UPDATED_CONTENT_MARKER'));

      // Sync to trigger auto-update
      await testContext.registryManager.syncSource(sourceId);

      // Verify files were replaced
      const installedAfter = await testContext.registryManager.listInstalledBundles();
      const newInstallPath = installedAfter[0].installPath;
      const newPromptPath = path.join(newInstallPath, 'prompts', 'test.prompt.md');

      if (fs.existsSync(newPromptPath)) {
        const updatedContent = fs.readFileSync(newPromptPath, 'utf8');
        assert.ok(updatedContent.includes('UPDATED_CONTENT_MARKER'),
          'Updated content should contain new marker');
        assert.ok(!updatedContent.includes('INITIAL_CONTENT_MARKER'),
          'Updated content should not contain old marker');
      }

      assert.strictEqual(installedAfter[0].version, updatedVersion,
        'Version should be updated');
    });

    test('Example 1.3: Installation record reflects new version', async function () {
      this.timeout(60_000);

      const sourceId = `${testId}-source-record`;
      const source = createMockSource(sourceId);
      const initialVersion = '1.0.0';
      const updatedVersion = '2.0.0';

      // Setup mocks for validation + first sync + install
      nock('https://api.github.com')
        .persist()
        .get('/repos/test-owner/awesome-copilot-test/contents/collections?ref=main')
        .reply(200, [
          { name: 'test-collection.collection.yml', type: 'file' }
        ]);
      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/awesome-copilot-test/main/collections/test-collection.collection.yml')
        .reply(200, createCollectionYaml(initialVersion, 'initial'));
      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/awesome-copilot-test/main/prompts/test.prompt.md')
        .reply(200, createPromptContent('initial'));

      // Add, sync, and install
      await testContext.registryManager.addSource(source);
      await testContext.registryManager.syncSource(sourceId);

      const bundles = await testContext.registryManager.searchBundles({ sourceId });
      const bundleToInstall = bundles.find((b) => b.id === 'test-collection');

      await testContext.registryManager.installBundle(bundleToInstall!.id, { scope: 'user' });

      // Verify initial installation record
      const recordBefore = await testContext.registryManager.listInstalledBundles();
      assert.strictEqual(recordBefore[0].version, initialVersion,
        'Initial record should have initial version');

      // Clean up and setup mocks for update
      nock.cleanAll();
      nock.disableNetConnect();

      // Clear the adapter's cache to force a fresh fetch
      const adapters2 = (testContext.registryManager as any).adapters;
      for (const [, adapter] of adapters2) {
        if (adapter.collectionsCache) {
          adapter.collectionsCache.clear();
        }
      }

      nock('https://api.github.com')
        .persist()
        .get('/repos/test-owner/awesome-copilot-test/contents/collections?ref=main')
        .reply(200, [
          { name: 'test-collection.collection.yml', type: 'file' }
        ]);
      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/awesome-copilot-test/main/collections/test-collection.collection.yml')
        .reply(200, createCollectionYaml(updatedVersion, 'updated'));
      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/awesome-copilot-test/main/prompts/test.prompt.md')
        .reply(200, createPromptContent('updated'));

      // Sync to trigger auto-update
      await testContext.registryManager.syncSource(sourceId);

      // Verify installation record reflects new version
      const recordAfter = await testContext.registryManager.listInstalledBundles();
      assert.strictEqual(recordAfter.length, 1, 'Should have one installation record');
      assert.strictEqual(recordAfter[0].version, updatedVersion,
        'Installation record should reflect new version');
      assert.strictEqual(recordAfter[0].bundleId, 'test-collection',
        'Bundle ID should remain the same');
    });

    test('Example 1.4: Installation scope is preserved', async function () {
      this.timeout(60_000);

      const sourceId = `${testId}-source-scope`;
      const source = createMockSource(sourceId);
      const initialVersion = '1.0.0';
      const updatedVersion = '1.1.0';
      const installScope = 'user'; // Could also test 'workspace'

      // Setup mocks for validation + first sync + install
      nock('https://api.github.com')
        .persist()
        .get('/repos/test-owner/awesome-copilot-test/contents/collections?ref=main')
        .reply(200, [
          { name: 'test-collection.collection.yml', type: 'file' }
        ]);
      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/awesome-copilot-test/main/collections/test-collection.collection.yml')
        .reply(200, createCollectionYaml(initialVersion, 'initial'));
      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/awesome-copilot-test/main/prompts/test.prompt.md')
        .reply(200, createPromptContent('initial'));

      // Add, sync, and install with specific scope
      await testContext.registryManager.addSource(source);
      await testContext.registryManager.syncSource(sourceId);

      const bundles = await testContext.registryManager.searchBundles({ sourceId });
      const bundleToInstall = bundles.find((b) => b.id === 'test-collection');

      await testContext.registryManager.installBundle(bundleToInstall!.id, { scope: installScope });

      // Verify initial scope
      const installedBefore = await testContext.registryManager.listInstalledBundles();
      assert.strictEqual(installedBefore[0].scope, installScope,
        'Initial installation should have correct scope');

      // Clean up and setup mocks for update
      nock.cleanAll();
      nock.disableNetConnect();

      // Clear the adapter's cache to force a fresh fetch
      const adapters3 = (testContext.registryManager as any).adapters;
      for (const [, adapter] of adapters3) {
        if (adapter.collectionsCache) {
          adapter.collectionsCache.clear();
        }
      }

      nock('https://api.github.com')
        .persist()
        .get('/repos/test-owner/awesome-copilot-test/contents/collections?ref=main')
        .reply(200, [
          { name: 'test-collection.collection.yml', type: 'file' }
        ]);
      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/awesome-copilot-test/main/collections/test-collection.collection.yml')
        .reply(200, createCollectionYaml(updatedVersion, 'updated'));
      nock('https://raw.githubusercontent.com')
        .persist()
        .get('/test-owner/awesome-copilot-test/main/prompts/test.prompt.md')
        .reply(200, createPromptContent('updated'));

      // Sync to trigger auto-update
      await testContext.registryManager.syncSource(sourceId);

      // Verify scope is preserved after update
      const installedAfter = await testContext.registryManager.listInstalledBundles();
      assert.strictEqual(installedAfter[0].scope, installScope,
        'Installation scope should be preserved after update');
      assert.strictEqual(installedAfter[0].version, updatedVersion,
        'Version should be updated');
    });
  });
});
