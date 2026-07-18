/**
 * E2E Tests: GitHub Bundle Update Workflow
 *
 * Tests the complete update workflow for GitHub bundles:
 * - Version-based installation and update detection
 * - Update check comparing installed vs latest version
 * - Update action installing latest version
 * - Previous installation record and files removal
 * - New installation record creation
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2, 3.3
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
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

suite('E2E: GitHub Bundle Update Tests', () => {
  let testContext: E2ETestContext;
  let testId: string;
  let sandbox: sinon.SinonSandbox;

  // Test fixtures for deployment manifest
  // Note: For GitHub bundles, the manifest ID is used in generateGitHubBundleId.
  // If manifestId is provided, bundle ID becomes: owner-repo-manifestId-version
  // If manifestId is NOT provided (undefined), bundle ID becomes: owner-repo-tag (legacy format)
  //
  // For these tests, we use a simple collection ID to get predictable bundle IDs:
  // manifestId = "test-collection" → bundleId = "test-owner-test-repo-test-collection-1.0.0"
  const createDeploymentManifest = (version: string, _tag: string, content = 'initial') => ({
    id: 'test-collection',
    name: `Test Bundle - ${content}`,
    version: version,
    description: `Test bundle for E2E tests - ${content}`,
    author: 'test-owner',
    tags: ['test', 'e2e'],
    environments: ['development'],
    dependencies: [],
    license: 'MIT'
  });

  const createPromptContent = (content: string) => `# Test Prompt

This is a test prompt for E2E testing.
Content: ${content}
`;

  // Create a valid bundle ZIP file
  // Note: Bundle ID format with manifestId: owner-repo-manifestId-version
  // e.g., test-owner-test-repo-test-collection-1.0.0
  const createBundleZip = (version: string, _tag: string, content = 'initial'): Buffer => {
    const zip = new AdmZip();

    // Add deployment manifest with simple collection ID
    const manifest = `id: test-collection
name: Test Bundle - ${content}
version: ${version}
description: Test bundle for E2E tests - ${content}
author: test-owner
tags:
  - test
  - e2e
environments:
  - development
dependencies: []
license: MIT
`;
    zip.addFile('deployment-manifest.yml', Buffer.from(manifest));

    // Add a prompt file
    zip.addFile('prompts/test.prompt.md', Buffer.from(createPromptContent(content)));

    return zip.toBuffer();
  };

  // Mock source configuration
  const createMockSource = (id: string): RegistrySource => ({
    id,
    name: 'Test GitHub Source',
    type: 'github',
    url: 'https://github.com/test-owner/test-repo',
    enabled: true,
    priority: 1,
    token: 'test-token'
  });

  setup(async function () {
    this.timeout(30_000);
    testId = generateTestId('github');

    // Create sinon sandbox for stubbing
    sandbox = sinon.createSandbox();

    // Stub VS Code authentication to return undefined (no auth)
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
    nock.enableNetConnect('127.0.0.1');
  });

  teardown(async function () {
    this.timeout(10_000);
    await testContext.cleanup();
    sandbox.restore();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  /**
   * Helper to set up nock mocks for GitHub releases API
   * @param releases
   */
  const setupReleaseMocks = (releases: {
    tag: string;
    version: string;
    content: string;
  }[]): void => {
    // Mock GitHub API for releases listing
    const releasesResponse = releases.map((r, index) => ({
      tag_name: r.tag,
      name: `Release ${r.version}`,
      body: `Release notes for ${r.version}`,
      published_at: new Date(Date.now() - index * 86_400_000).toISOString(),
      assets: [
        {
          name: 'deployment-manifest.yml',
          url: `https://api.github.com/repos/test-owner/test-repo/releases/assets/${1000 + index}`,
          browser_download_url: `https://github.com/test-owner/test-repo/releases/download/${r.tag}/deployment-manifest.yml`,
          size: 512
        },
        {
          name: 'bundle.zip',
          url: `https://api.github.com/repos/test-owner/test-repo/releases/assets/${2000 + index}`,
          browser_download_url: `https://github.com/test-owner/test-repo/releases/download/${r.tag}/bundle.zip`,
          size: 2048
        }
      ]
    }));

    nock('https://api.github.com')
      .persist()
      .get('/repos/test-owner/test-repo/releases')
      .reply(200, releasesResponse);

    // Mock repository info for validation
    nock('https://api.github.com')
      .persist()
      .get('/repos/test-owner/test-repo')
      .reply(200, {
        name: 'test-repo',
        description: 'Test repository',
        updated_at: new Date().toISOString()
      });

    // Mock manifest and bundle downloads for each release
    releases.forEach((r, index) => {
      const manifest = createDeploymentManifest(r.version, r.tag, r.content);
      const bundleZip = createBundleZip(r.version, r.tag, r.content);

      // Manifest download (API URL with Accept header)
      nock('https://api.github.com')
        .persist()
        .get(`/repos/test-owner/test-repo/releases/assets/${1000 + index}`)
        .reply(200, JSON.stringify(manifest));

      // Bundle download (API URL redirects to actual download)
      nock('https://api.github.com')
        .persist()
        .get(`/repos/test-owner/test-repo/releases/assets/${2000 + index}`)
        .reply(302, '', {
          location: `https://objects.githubusercontent.com/test-owner/test-repo/${r.tag}/bundle.zip`
        });

      // Actual bundle content
      nock('https://objects.githubusercontent.com')
        .persist()
        .get(`/test-owner/test-repo/${r.tag}/bundle.zip`)
        .reply(200, bundleZip);
    });
  };

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

  suite('GitHub Bundle Update Workflow', () => {
    test('Example 2.1: Specific version installation records correct version', async function () {
      this.timeout(60_000);

      const sourceId = `${testId}-source-version`;
      const source = createMockSource(sourceId);

      // Setup mocks with two versions
      setupReleaseMocks([
        { tag: 'v2.0.0', version: '2.0.0', content: 'v2' },
        { tag: 'v1.0.0', version: '1.0.0', content: 'v1' }
      ]);

      // Step 1: Add source
      await testContext.registryManager.addSource(source);

      // Step 2: Sync source to get bundles
      await testContext.registryManager.syncSource(sourceId);

      // Step 3: Get raw bundles from cache (not consolidated) to find specific version
      const rawBundles = await testContext.storage.getCachedSourceBundles(sourceId);
      assert.ok(rawBundles.length >= 2, 'Should have both versions in cache');

      // Find the v1.0.0 bundle by its full ID (owner-repo-manifestId-version format)
      const v1Bundle = rawBundles.find((b) => b.id === 'test-owner-test-repo-test-collection-1.0.0');
      assert.ok(v1Bundle, 'Should find v1.0.0 bundle');

      // Step 4: Install v1.0.0 using the version option to get the specific version
      // The version option triggers applyVersionOverride which uses the correct bundle ID
      await testContext.registryManager.installBundle(v1Bundle.id, { scope: 'user', version: '1.0.0' });

      // Step 5: Verify installation record shows v1.0.0
      const installed = await testContext.registryManager.listInstalledBundles();
      assert.strictEqual(installed.length, 1, 'Should have one installed bundle');
      assert.strictEqual(installed[0].version, '1.0.0', 'Installation record should show v1.0.0');
    });

    test('Example 2.2: Update check compares installed vs latest version', async function () {
      this.timeout(60_000);

      const sourceId = `${testId}-source-check`;
      const source = createMockSource(sourceId);

      // Setup mocks with two versions
      setupReleaseMocks([
        { tag: 'v2.0.0', version: '2.0.0', content: 'v2' },
        { tag: 'v1.0.0', version: '1.0.0', content: 'v1' }
      ]);

      // Add source and sync
      await testContext.registryManager.addSource(source);
      await testContext.registryManager.syncSource(sourceId);

      // Get raw bundles from cache and install v1.0.0 using version option
      const rawBundles = await testContext.storage.getCachedSourceBundles(sourceId);
      const v1Bundle = rawBundles.find((b) => b.id === 'test-owner-test-repo-test-collection-1.0.0');
      assert.ok(v1Bundle, 'Should find v1.0.0 bundle');

      await testContext.registryManager.installBundle(v1Bundle.id, { scope: 'user', version: '1.0.0' });

      // Check for updates
      const updates = await testContext.registryManager.checkUpdates();

      // Verify update is detected
      assert.ok(updates.length > 0, 'Should detect available updates');
      const update = updates.find((u) => u.bundleId.includes('test-owner-test-repo'));
      assert.ok(update, 'Should find update for our bundle');
      assert.strictEqual(update.currentVersion, '1.0.0', 'Current version should be 1.0.0');
      assert.strictEqual(update.latestVersion, '2.0.0', 'Latest version should be 2.0.0');
    });

    test('Example 2.3: Update information displays both versions', async function () {
      this.timeout(60_000);

      const sourceId = `${testId}-source-info`;
      const source = createMockSource(sourceId);

      // Setup mocks with two versions
      setupReleaseMocks([
        { tag: 'v2.0.0', version: '2.0.0', content: 'v2' },
        { tag: 'v1.0.0', version: '1.0.0', content: 'v1' }
      ]);

      // Add source and sync
      await testContext.registryManager.addSource(source);
      await testContext.registryManager.syncSource(sourceId);

      // Get raw bundles from cache and install v1.0.0 using full bundle ID with version option
      const rawBundles = await testContext.storage.getCachedSourceBundles(sourceId);
      const v1Bundle = rawBundles.find((b) => b.id === 'test-owner-test-repo-test-collection-1.0.0');
      await testContext.registryManager.installBundle(v1Bundle!.id, { scope: 'user', version: '1.0.0' });

      // Check for updates
      const updates = await testContext.registryManager.checkUpdates();

      // Verify update information contains both versions
      const update = updates.find((u) => u.bundleId.includes('test-owner-test-repo'));
      assert.ok(update, 'Should find update info');
      assert.ok(update.currentVersion, 'Update info should have currentVersion');
      assert.ok(update.latestVersion, 'Update info should have latestVersion');
      assert.notStrictEqual(update.currentVersion, update.latestVersion,
        'Current and latest versions should be different');
    });

    test('Example 2.4: Update action installs latest version', async function () {
      this.timeout(60_000);

      const sourceId = `${testId}-source-update`;
      const source = createMockSource(sourceId);

      // Setup mocks with two versions
      setupReleaseMocks([
        { tag: 'v2.0.0', version: '2.0.0', content: 'v2' },
        { tag: 'v1.0.0', version: '1.0.0', content: 'v1' }
      ]);

      // Add source and sync
      await testContext.registryManager.addSource(source);
      await testContext.registryManager.syncSource(sourceId);

      // Get raw bundles from cache and install v1.0.0 using full bundle ID with version option
      const rawBundles = await testContext.storage.getCachedSourceBundles(sourceId);
      const v1Bundle = rawBundles.find((b) => b.id === 'test-owner-test-repo-test-collection-1.0.0');
      assert.ok(v1Bundle, 'Should find v1.0.0 bundle');

      await testContext.registryManager.installBundle(v1Bundle.id, { scope: 'user', version: '1.0.0' });

      // Verify v1.0.0 is installed
      const installedBefore = await testContext.registryManager.listInstalledBundles();
      assert.strictEqual(installedBefore[0].version, '1.0.0', 'Should have v1.0.0 installed');

      // Trigger update using the installed bundle ID
      const installedBundleId = installedBefore[0].bundleId;
      await testContext.registryManager.updateBundle(installedBundleId);

      // Verify v2.0.0 is now installed
      const installedAfter = await testContext.registryManager.listInstalledBundles();
      assert.strictEqual(installedAfter.length, 1, 'Should have one installed bundle');
      assert.strictEqual(installedAfter[0].version, '2.0.0', 'Should have v2.0.0 installed after update');
    });

    test('Example 2.5: Previous installation record is removed', async function () {
      this.timeout(60_000);

      const sourceId = `${testId}-source-record-remove`;
      const source = createMockSource(sourceId);

      // Setup mocks with two versions
      setupReleaseMocks([
        { tag: 'v2.0.0', version: '2.0.0', content: 'v2' },
        { tag: 'v1.0.0', version: '1.0.0', content: 'v1' }
      ]);

      // Add source and sync
      await testContext.registryManager.addSource(source);
      await testContext.registryManager.syncSource(sourceId);

      // Get raw bundles from cache and install v1.0.0 using full bundle ID with version option
      const rawBundles = await testContext.storage.getCachedSourceBundles(sourceId);
      const v1Bundle = rawBundles.find((b) => b.id === 'test-owner-test-repo-test-collection-1.0.0');

      await testContext.registryManager.installBundle(v1Bundle!.id, { scope: 'user', version: '1.0.0' });

      // Get the v1.0.0 bundle ID
      const installedBefore = await testContext.registryManager.listInstalledBundles();
      const v1BundleId = installedBefore[0].bundleId;

      // Trigger update
      await testContext.registryManager.updateBundle(v1BundleId);

      // Verify no v1.0.0 record exists
      const installedAfter = await testContext.registryManager.listInstalledBundles();
      const v1Record = installedAfter.find((b) => b.bundleId === v1BundleId && b.version === '1.0.0');
      assert.ok(!v1Record, 'v1.0.0 installation record should be removed');

      // Verify only v2.0.0 exists
      assert.strictEqual(installedAfter.length, 1, 'Should have exactly one installation record');
      assert.strictEqual(installedAfter[0].version, '2.0.0', 'Only v2.0.0 should exist');
    });

    test('Example 2.6: Previous version files are removed', async function () {
      this.timeout(60_000);

      const sourceId = `${testId}-source-files-remove`;
      const source = createMockSource(sourceId);

      // Setup mocks with two versions
      setupReleaseMocks([
        { tag: 'v2.0.0', version: '2.0.0', content: 'UPDATED_CONTENT' },
        { tag: 'v1.0.0', version: '1.0.0', content: 'INITIAL_CONTENT' }
      ]);

      // Add source and sync
      await testContext.registryManager.addSource(source);
      await testContext.registryManager.syncSource(sourceId);

      // Get raw bundles from cache and install v1.0.0 using full bundle ID with version option
      const rawBundles = await testContext.storage.getCachedSourceBundles(sourceId);
      const v1Bundle = rawBundles.find((b) => b.id === 'test-owner-test-repo-test-collection-1.0.0');

      await testContext.registryManager.installBundle(v1Bundle!.id, { scope: 'user', version: '1.0.0' });

      // Get v1.0.0 install path
      const installedBefore = await testContext.registryManager.listInstalledBundles();
      const v1InstallPath = installedBefore[0].installPath;
      const v1BundleId = installedBefore[0].bundleId;

      // Verify v1.0.0 files exist with initial content
      const v1PromptPath = path.join(v1InstallPath, 'prompts', 'test.prompt.md');
      assert.ok(fs.existsSync(v1PromptPath), 'v1.0.0 prompt file should exist');
      const v1Content = fs.readFileSync(v1PromptPath, 'utf8');
      assert.ok(v1Content.includes('INITIAL_CONTENT'), 'v1.0.0 should have initial content');

      // Trigger update
      await testContext.registryManager.updateBundle(v1BundleId);

      // Verify v1.0.0 files are removed or replaced
      const installedAfter = await testContext.registryManager.listInstalledBundles();
      const v2InstallPath = installedAfter[0].installPath;

      // If paths are different, v1 path should not exist
      if (v1InstallPath !== v2InstallPath) {
        assert.ok(!fs.existsSync(v1InstallPath), 'v1.0.0 install directory should be removed');
      }

      // v2 files should have updated content
      const v2PromptPath = path.join(v2InstallPath, 'prompts', 'test.prompt.md');
      assert.ok(fs.existsSync(v2PromptPath), 'v2.0.0 prompt file should exist');
      const v2Content = fs.readFileSync(v2PromptPath, 'utf8');
      assert.ok(v2Content.includes('UPDATED_CONTENT'), 'v2.0.0 should have updated content');
      assert.ok(!v2Content.includes('INITIAL_CONTENT'), 'v2.0.0 should not have initial content');
    });

    test('Example 2.7: New installation record is created', async function () {
      this.timeout(60_000);

      const sourceId = `${testId}-source-new-record`;
      const source = createMockSource(sourceId);

      // Setup mocks with two versions
      setupReleaseMocks([
        { tag: 'v2.0.0', version: '2.0.0', content: 'v2' },
        { tag: 'v1.0.0', version: '1.0.0', content: 'v1' }
      ]);

      // Add source and sync
      await testContext.registryManager.addSource(source);
      await testContext.registryManager.syncSource(sourceId);

      // Get raw bundles from cache and install v1.0.0 using full bundle ID with version option
      const rawBundles = await testContext.storage.getCachedSourceBundles(sourceId);
      const v1Bundle = rawBundles.find((b) => b.id === 'test-owner-test-repo-test-collection-1.0.0');

      await testContext.registryManager.installBundle(v1Bundle!.id, { scope: 'user', version: '1.0.0' });

      // Get the installed bundle ID
      const installedBefore = await testContext.registryManager.listInstalledBundles();
      const v1BundleId = installedBefore[0].bundleId;

      // Trigger update
      await testContext.registryManager.updateBundle(v1BundleId);

      // Verify new installation record exists with v2.0.0
      const installedAfter = await testContext.registryManager.listInstalledBundles();
      assert.strictEqual(installedAfter.length, 1, 'Should have one installation record');

      const newRecord = installedAfter[0];
      assert.strictEqual(newRecord.version, '2.0.0', 'New record should have v2.0.0');
      assert.ok(newRecord.bundleId, 'New record should have bundleId');
      assert.ok(newRecord.installPath, 'New record should have installPath');
      assert.ok(newRecord.installedAt, 'New record should have installedAt timestamp');
    });
  });
});
