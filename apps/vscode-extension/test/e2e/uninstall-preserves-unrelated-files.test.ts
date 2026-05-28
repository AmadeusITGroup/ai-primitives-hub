/**
 * E2E Tests: Uninstall Preserves Unrelated .github Files
 *
 * Bug: When uninstalling the last prompt registry bundle at repository scope,
 * the entire .github folder is removed, including unrelated files like
 * .github/workflows that are not managed by prompt registry.
 *
 * This test verifies that:
 * - Uninstalling bundles only removes prompt registry managed files
 * - Unrelated files in .github (workflows, CODEOWNERS, etc.) are preserved
 * - Empty prompt registry subdirectories (.github/prompts, .github/agents) are cleaned up
 * - The .github folder itself is preserved when it contains unrelated content
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import nock from 'nock';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  LockfileManager,
} from '../../src/services/lockfile-manager';
import {
  RepositoryActivationService,
} from '../../src/services/repository-activation-service';
import {
  createE2ETestContext,
  E2ETestContext,
  generateTestId,
} from '../helpers/e2e-test-helpers';
import {
  cleanupReleaseMocks,
  computeBundleId,
  createMockGitHubSource,
  ReleaseConfig,
  RepositoryTestConfig,
  setupReleaseMocks,
} from '../helpers/repository-fixture-helpers';

suite('E2E: Uninstall Preserves Unrelated .github Files', () => {
  let testContext: E2ETestContext;
  let testId: string;
  let sandbox: sinon.SinonSandbox;
  let workspaceRoot: string;

  // Test configuration using shared fixtures
  const TEST_CONFIG: RepositoryTestConfig = {
    owner: 'test-owner',
    repo: 'test-repo',
    manifestId: 'test-bundle',
    baseVersion: '1.0.0'
  };

  const LOCKFILE_NAME = 'prompt-registry.lock.json';
  const GITHUB_PROMPTS_DIR = '.github/prompts';

  // Bundle ID format: owner-repo-manifestId-version
  const BUNDLE_ID = computeBundleId(TEST_CONFIG, TEST_CONFIG.baseVersion || '1.0.0');

  // Test content identifier
  const TEST_CONTENT = 'preserve-unrelated-files-test';

  /**
   * Helper to handle "not yet implemented" errors gracefully.
   * @param context
   * @param context.skip
   * @param bundleId
   * @param options
   * @param options.scope
   * @param options.commitMode
   * @param options.version
   */
  const installBundleOrSkip = async (
    context: { skip: () => void },
    bundleId: string,
    options: { scope: 'repository' | 'user'; commitMode?: 'commit' | 'local-only'; version: string }
  ): Promise<boolean> => {
    try {
      await testContext.registryManager.installBundle(bundleId, {
        scope: options.scope,
        commitMode: options.commitMode || 'commit',
        version: options.version
      });
      return true;
    } catch (error: any) {
      if (error.message.includes('not yet implemented')) {
        console.log(`[Test Skipped] Feature not implemented: ${options.scope} scope installation`);
        context.skip();
        return false;
      }
      throw error;
    }
  };

  /**
   * Helper to clear adapter authentication for isolated testing.
   */
  const clearAdapterAuth = (): void => {
    const adapters = (testContext.registryManager as any).adapters;
    if (adapters) {
      adapters.forEach((adapter: any) => {
        if (adapter.authToken !== undefined) {
          adapter.authToken = undefined;
          adapter.authMethod = 'none';
        }
      });
    }
  };

  /**
   * Helper to stub VS Code workspace folders for repository scope tests.
   */
  const setupWorkspaceStub = (): void => {
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([
      { uri: vscode.Uri.file(workspaceRoot), name: 'test-workspace', index: 0 }
    ]);
  };

  /**
   * Helper to add and sync a mock GitHub source with release mocks.
   * @param sourceId
   * @param content
   */
  const addAndSyncSource = async (sourceId: string, content: string): Promise<void> => {
    const source = createMockGitHubSource(sourceId, TEST_CONFIG);
    const releases: ReleaseConfig[] = [{ tag: 'v1.0.0', version: '1.0.0', content }];
    setupReleaseMocks(TEST_CONFIG, releases);

    await testContext.registryManager.addSource(source);
    await testContext.registryManager.syncSource(sourceId);
  };

  /**
   * Helper to get a bundle from a synced source.
   * @param sourceId
   */
  const getBundleFromSource = async (sourceId: string): Promise<any> => {
    const rawBundles = await testContext.storage.getCachedSourceBundles(sourceId);
    const bundle = rawBundles.find((b) => b.id === BUNDLE_ID);

    if (!bundle) {
      throw new Error(`Should find bundle ${BUNDLE_ID}, found: ${rawBundles.map((b) => b.id).join(', ')}`);
    }

    return bundle;
  };

  /**
   * Helper to set up a source and get a bundle for testing.
   * @param testIdSuffix
   * @param content
   */
  const setupSourceAndGetBundle = async (
    testIdSuffix: string,
    content: string
  ): Promise<{ sourceId: string; bundle: any }> => {
    const sourceId = `${testId}-${testIdSuffix}`;

    setupWorkspaceStub();
    await addAndSyncSource(sourceId, content);
    const bundle = await getBundleFromSource(sourceId);

    return { sourceId, bundle };
  };

  setup(async function () {
    this.timeout(30_000);
    testId = generateTestId('preserve-files');
    sandbox = sinon.createSandbox();

    if (vscode.authentication && typeof vscode.authentication.getSession === 'function') {
      sandbox.stub(vscode.authentication, 'getSession').resolves(undefined);
    }

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
    workspaceRoot = path.join(testContext.tempStoragePath, 'test-workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, '.git', 'info'), { recursive: true });

    clearAdapterAuth();

    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
  });

  teardown(async function () {
    this.timeout(10_000);
    LockfileManager.resetInstance();
    RepositoryActivationService.resetInstance();
    await testContext.cleanup();
    sandbox.restore();
    cleanupReleaseMocks();
  });

  suite('Bug Fix: Preserve Unrelated .github Files on Uninstall', () => {
    test('Uninstalling last bundle should NOT remove .github folder when unrelated files exist', async function () {
      this.timeout(60_000);

      // === ARRANGE: Create unrelated files in .github BEFORE installing bundle ===
      const githubDir = path.join(workspaceRoot, '.github');
      const workflowsDir = path.join(githubDir, 'workflows');
      fs.mkdirSync(workflowsDir, { recursive: true });

      // Create GitHub Actions workflow files (unrelated to prompt registry)
      const ciWorkflowFile = path.join(workflowsDir, 'ci.yml');
      fs.writeFileSync(ciWorkflowFile, `name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`);

      const releaseWorkflowFile = path.join(workflowsDir, 'release.yml');
      fs.writeFileSync(releaseWorkflowFile, `name: Release
on:
  push:
    tags: ['v*']
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`);

      // Create CODEOWNERS file (unrelated to prompt registry)
      const codeownersFile = path.join(githubDir, 'CODEOWNERS');
      fs.writeFileSync(codeownersFile, '* @test-owner\n/src/ @dev-team\n');

      // Create issue template (unrelated to prompt registry)
      const issueTemplateFile = path.join(githubDir, 'ISSUE_TEMPLATE.md');
      fs.writeFileSync(issueTemplateFile, '## Bug Report\n\n### Description\n\n### Steps to Reproduce\n');

      // Verify unrelated files exist before installation
      assert.ok(fs.existsSync(ciWorkflowFile), 'CI workflow should exist before installation');
      assert.ok(fs.existsSync(releaseWorkflowFile), 'Release workflow should exist before installation');
      assert.ok(fs.existsSync(codeownersFile), 'CODEOWNERS should exist before installation');
      assert.ok(fs.existsSync(issueTemplateFile), 'Issue template should exist before installation');

      // === ACT: Install and then uninstall a bundle ===
      const { bundle } = await setupSourceAndGetBundle('preserve-source', TEST_CONTENT);

      await installBundleOrSkip(this, bundle.id, {
        scope: 'repository', commitMode: 'commit', version: '1.0.0'
      });

      // Verify bundle files were installed
      const promptsDir = path.join(workspaceRoot, GITHUB_PROMPTS_DIR);
      const promptFile = path.join(promptsDir, 'test-prompt.prompt.md');
      assert.ok(fs.existsSync(promptFile), 'Prompt file should exist after installation');

      // Verify lockfile exists
      const lockfilePath = path.join(workspaceRoot, LOCKFILE_NAME);
      assert.ok(fs.existsSync(lockfilePath), 'Lockfile should exist after installation');

      // Get the actual bundle ID from the lockfile
      const lockfileBefore = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
      const actualBundleId = Object.keys(lockfileBefore.bundles)[0];

      // Uninstall the bundle (this is the last bundle)
      await testContext.registryManager.uninstallBundle(actualBundleId, 'repository');

      // === ASSERT: Verify prompt registry files are removed ===
      assert.ok(!fs.existsSync(promptFile), 'Prompt file should be removed after uninstallation');

      // Verify empty prompt registry directories are cleaned up
      assert.ok(!fs.existsSync(promptsDir), '.github/prompts should be removed when empty');

      // === CRITICAL ASSERTIONS: Unrelated files should be preserved ===
      assert.ok(fs.existsSync(githubDir), '.github folder should NOT be removed when unrelated files exist');
      assert.ok(fs.existsSync(workflowsDir), '.github/workflows should NOT be removed');
      assert.ok(fs.existsSync(ciWorkflowFile), 'CI workflow file should be preserved');
      assert.ok(fs.existsSync(releaseWorkflowFile), 'Release workflow file should be preserved');
      assert.ok(fs.existsSync(codeownersFile), 'CODEOWNERS file should be preserved');
      assert.ok(fs.existsSync(issueTemplateFile), 'Issue template file should be preserved');

      // Verify content of preserved files is intact
      const ciContent = fs.readFileSync(ciWorkflowFile, 'utf8');
      assert.ok(ciContent.includes('npm test'), 'CI workflow content should be intact');

      const codeownersContent = fs.readFileSync(codeownersFile, 'utf8');
      assert.ok(codeownersContent.includes('@test-owner'), 'CODEOWNERS content should be intact');
    });

    test('Uninstalling bundle should clean up empty prompt registry subdirectories only', async function () {
      this.timeout(60_000);

      // === ARRANGE: Create unrelated file in .github root ===
      const githubDir = path.join(workspaceRoot, '.github');
      fs.mkdirSync(githubDir, { recursive: true });

      const dependabotFile = path.join(githubDir, 'dependabot.yml');
      fs.writeFileSync(dependabotFile, `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
`);

      assert.ok(fs.existsSync(dependabotFile), 'Dependabot config should exist before installation');

      // === ACT: Install and uninstall bundle ===
      const { bundle } = await setupSourceAndGetBundle('cleanup-source', TEST_CONTENT);

      await installBundleOrSkip(this, bundle.id, {
        scope: 'repository', commitMode: 'commit', version: '1.0.0'
      });

      // Verify installation created .github/prompts
      const promptsDir = path.join(workspaceRoot, GITHUB_PROMPTS_DIR);
      assert.ok(fs.existsSync(promptsDir), '.github/prompts should exist after installation');

      // Get bundle ID and uninstall
      const lockfilePath = path.join(workspaceRoot, LOCKFILE_NAME);
      const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
      const actualBundleId = Object.keys(lockfile.bundles)[0];

      await testContext.registryManager.uninstallBundle(actualBundleId, 'repository');

      // === ASSERT ===
      // Empty prompt registry directory should be removed
      assert.ok(!fs.existsSync(promptsDir), '.github/prompts should be removed when empty');

      // .github folder should still exist with unrelated file
      assert.ok(fs.existsSync(githubDir), '.github folder should be preserved');
      assert.ok(fs.existsSync(dependabotFile), 'Dependabot config should be preserved');

      // Verify dependabot content is intact
      const dependabotContent = fs.readFileSync(dependabotFile, 'utf8');
      assert.ok(dependabotContent.includes('package-ecosystem: npm'), 'Dependabot content should be intact');
    });

    test('Uninstalling bundle should preserve user-modified prompt files', async function () {
      this.timeout(60_000);

      // === ARRANGE: Install a bundle ===
      const { bundle } = await setupSourceAndGetBundle('modified-source', TEST_CONTENT);

      await installBundleOrSkip(this, bundle.id, {
        scope: 'repository', commitMode: 'commit', version: '1.0.0'
      });

      // Verify bundle files were installed
      const promptsDir = path.join(workspaceRoot, GITHUB_PROMPTS_DIR);
      const promptFile = path.join(promptsDir, 'test-prompt.prompt.md');
      assert.ok(fs.existsSync(promptFile), 'Prompt file should exist after installation');

      // === ACT: Modify the prompt file (simulate user customization) ===
      const originalContent = fs.readFileSync(promptFile, 'utf8');
      const modifiedContent = originalContent + '\n\n## User Customization\nThis was added by the user.';
      fs.writeFileSync(promptFile, modifiedContent);

      // Get bundle ID and uninstall
      const lockfilePath = path.join(workspaceRoot, LOCKFILE_NAME);
      const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
      const actualBundleId = Object.keys(lockfile.bundles)[0];

      await testContext.registryManager.uninstallBundle(actualBundleId, 'repository');

      // === ASSERT: User-modified file should be preserved ===
      assert.ok(fs.existsSync(promptFile), 'User-modified prompt file should be preserved');

      // Verify the user's modifications are intact
      const preservedContent = fs.readFileSync(promptFile, 'utf8');
      assert.ok(preservedContent.includes('User Customization'), 'User modifications should be preserved');
      assert.ok(preservedContent.includes('This was added by the user'), 'User content should be intact');

      // .github/prompts should NOT be removed because it contains user-modified file
      assert.ok(fs.existsSync(promptsDir), '.github/prompts should be preserved when containing user-modified files');
    });

    test('Uninstalling bundle should preserve user-created prompt files in same directory', async function () {
      this.timeout(60_000);

      // === ARRANGE: Install a bundle ===
      const { bundle } = await setupSourceAndGetBundle('user-created-source', TEST_CONTENT);

      await installBundleOrSkip(this, bundle.id, {
        scope: 'repository', commitMode: 'commit', version: '1.0.0'
      });

      // Verify bundle files were installed
      const promptsDir = path.join(workspaceRoot, GITHUB_PROMPTS_DIR);
      const bundlePromptFile = path.join(promptsDir, 'test-prompt.prompt.md');
      assert.ok(fs.existsSync(bundlePromptFile), 'Bundle prompt file should exist after installation');

      // === ACT: Create a user's own prompt file in the same directory ===
      const userPromptFile = path.join(promptsDir, 'my-custom-prompt.prompt.md');
      fs.writeFileSync(userPromptFile, `# My Custom Prompt

This is a prompt I created myself, not from any bundle.

## Instructions
Do something custom.
`);

      assert.ok(fs.existsSync(userPromptFile), 'User-created prompt should exist');

      // Get bundle ID and uninstall
      const lockfilePath = path.join(workspaceRoot, LOCKFILE_NAME);
      const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
      const actualBundleId = Object.keys(lockfile.bundles)[0];

      await testContext.registryManager.uninstallBundle(actualBundleId, 'repository');

      // === ASSERT ===
      // Bundle's prompt file should be removed (it's tracked and unmodified)
      assert.ok(!fs.existsSync(bundlePromptFile), 'Bundle prompt file should be removed');

      // User-created prompt file should be preserved (not tracked in lockfile)
      assert.ok(fs.existsSync(userPromptFile), 'User-created prompt file should be preserved');

      // Verify user's content is intact
      const userContent = fs.readFileSync(userPromptFile, 'utf8');
      assert.ok(userContent.includes('My Custom Prompt'), 'User prompt content should be intact');
      assert.ok(userContent.includes('not from any bundle'), 'User prompt should be preserved');

      // .github/prompts should NOT be removed because it contains user-created file
      assert.ok(fs.existsSync(promptsDir), '.github/prompts should be preserved when containing user-created files');
    });
  });
});
