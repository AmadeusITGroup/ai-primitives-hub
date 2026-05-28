/**
 * VS Code Extension Integration Tests
 *
 * These tests run in a REAL VS Code instance via `@vscode/test-electron`.
 * They verify actual command registration and extension activation.
 *
 * Run with: node test/runExtensionTests.js
 *
 * ============================================================================
 * TEST STATUS OVERVIEW
 * ============================================================================
 *
 * IMPLEMENTED:
 * - Command registration tests (Scenario 5) - verify commands exist in VS Code
 *
 * ============================================================================
 * WHY SOME TESTS ARE PLACEHOLDERS
 * ============================================================================
 *
 * Full E2E tests for scope migration and installation workflows require:
 *
 * 1. TEST WORKSPACE SETUP
 *    - A test workspace with .github/prompts/ folder structure
 *    - Proper VS Code workspace folder configuration
 *    - Git repository initialization for .git/info/exclude tests
 *
 * 2. BUNDLE SOURCE MOCKING
 *    - Mock or real bundle source with downloadable bundles
 *    - HTTP mocking (nock) doesn't work well in VS Code extension host
 *    - May need local file-based bundle source for reliable testing
 *
 * 3. FILE SYSTEM SETUP
 *    - User scope paths (platform-specific Copilot directories)
 *    - Repository scope paths (.github/prompts/)
 *    - Lockfile at repository root
 *
 * 4. CLEANUP REQUIREMENTS
 *    - Proper cleanup to avoid test pollution
 *    - Reset singleton instances between tests
 *    - Remove test files from both scopes
 *
 * 5. AUTHENTICATION MOCKING
 *    - Mock VS Code authentication API
 *    - Prevent real token usage during tests
 *
 * ============================================================================
 * ALTERNATIVE TEST COVERAGE
 * ============================================================================
 *
 * The actual scope migration and installation logic IS tested in:
 *
 * - test/e2e/repository-level-installation.test.ts
 *   Tests switchCommitMode, moveToUser, moveToRepository through BundleScopeCommands
 *   Uses real file system operations with mocked VS Code
 *
 * - test/commands/BundleScopeCommands.test.ts
 *   Unit tests for BundleScopeCommands class
 *
 * - test/services/ScopeConflictResolver.test.ts
 *   Tests migration logic and conflict detection
 *
 * - test/services/RepositoryScopeService.test.ts
 *   Tests git exclude management and file placement
 *
 * - test/services/LockfileManager.test.ts
 *   Tests lockfile CRUD operations
 *
 * ============================================================================
 * TO IMPLEMENT FULL VS CODE E2E TESTS
 * ============================================================================
 *
 * If you want to implement full E2E tests in this file:
 *
 * 1. Create test workspace fixture:
 *    ```typescript
 *    const testWorkspace = path.join(__dirname, 'test-workspace');
 *    fs.mkdirSync(path.join(testWorkspace, '.github', 'prompts'), { recursive: true });
 *    fs.mkdirSync(path.join(testWorkspace, '.git', 'info'), { recursive: true });
 *    ```
 *
 * 2. Set up local bundle source (avoid HTTP mocking issues):
 *    ```typescript
 *    const localSource = {
 *        id: 'test-source',
 *        type: 'local',
 *        path: path.join(__dirname, 'fixtures', 'test-bundle')
 *    };
 *    ```
 *
 * 3. Execute commands and verify:
 *    ```typescript
 *    await vscode.commands.executeCommand('promptRegistry.installBundle', bundleId, {
 *        scope: 'repository', version: '1.0.0'
 *    });
 *    await vscode.commands.executeCommand('promptRegistry.moveToUser', bundleId);
 *    // Verify files moved, lockfile updated
 *    ```
 *
 * 4. Clean up after each test:
 *    ```typescript
 *    afterEach(async () => {
 *        await vscode.commands.executeCommand('promptRegistry.uninstallBundle', bundleId);
 *        fs.rmSync(testWorkspace, { recursive: true, force: true });
 *    });
 *    ```
 */

import * as assert from 'node:assert';
import * as vscode from 'vscode';

describe('Prompt Registry Integration Test Scenarios', () => {
  // Note: The extension may show a first-run hub selector dialog.
  // Commands are registered before this dialog appears, so we can test
  // command registration without waiting for full activation.
  //
  // We use a shorter timeout and don't require full extension activation
  // since commands are registered early in the activation process.

  describe('Scenario 5: Extension Activation Performance', () => {
    /**
     * EXTENSION ACTIVATION TESTS
     *
     * These tests verify basic activation behavior. They serve as smoke tests
     * to ensure the extension activates and registers commands.
     *
     * LIMITATION: The "webview not stuck during sync" behavior cannot be
     * reliably tested in an automated way because:
     * 1. Test environment has no configured sources, so sync completes instantly
     * 2. Testing would require a slow source and timing-dependent assertions
     *
     * The non-blocking sync behavior should be verified through:
     * - Manual testing: Open marketplace while sync is running with real sources
     * - Code review: Ensure syncAllSources() uses .then() not await in activate()
     *
     * REQUIREMENT: In extension.ts, syncAllSources() must be called with
     * .then().catch() pattern (non-blocking), NOT await (blocking).
     * This allows the webview to resolve immediately and show cached bundles.
     */

    it('should activate extension and register commands', async function () {
      this.timeout(10_000);

      // Find and activate the extension
      const allExtensions = vscode.extensions.all;
      const promptRegistryExt = allExtensions.find((ext) =>
        ext.id.toLowerCase().includes('prompt-registry')
        || ext.id.toLowerCase().includes('promptregistry')
      );

      assert.ok(promptRegistryExt, 'Prompt Registry extension should be found');

      // If not already active, activate it
      if (!promptRegistryExt.isActive) {
        await promptRegistryExt.activate();
      }

      assert.ok(promptRegistryExt.isActive, 'Extension should be active after activation');
    });

    it('should have sync command available after activation', async function () {
      this.timeout(5000);

      const commands = await vscode.commands.getCommands(true);

      // Verify sync command is registered
      assert.ok(
        commands.includes('promptRegistry.syncAllSources'),
        'promptRegistry.syncAllSources command should be available'
      );
    });
  });

  describe('Scenario 6: Scope Migration Commands', () => {
    /**
     * SCOPE MIGRATION COMMAND REGISTRATION TESTS
     *
     * STATUS: Implemented - command registration verification only
     *
     * These tests verify that scope migration commands are properly registered
     * in VS Code when the extension activates. This ensures:
     * - extension.ts correctly calls vscode.commands.registerCommand()
     * - Command IDs match what's defined in package.json
     * - Commands are available for context menu binding
     *
     * WHAT IS TESTED:
     * ✓ promptRegistry.moveToUser command exists
     * ✓ promptRegistry.moveToRepositoryCommit command exists
     * ✓ promptRegistry.moveToRepositoryLocalOnly command exists
     * ✓ promptRegistry.switchToLocalOnly command exists
     * ✓ promptRegistry.switchToCommit command exists
     *
     * WHAT IS NOT TESTED HERE (but IS tested elsewhere):
     * - Actual command execution with real bundles
     * - File movement between scopes
     * - Lockfile updates
     * - Git exclude modifications
     *
     * See test/e2e/repository-level-installation.test.ts for full E2E tests
     * that verify the actual BundleScopeCommands behavior.
     *
     * Requirements covered:
     * - 7.2-7.3: Move to Repository (Commit/Local-Only)
     * - 7.4, 7.6: Move to User
     * - 7.5, 7.7: Switch commit mode
     */

    // Wait for extension to activate before running command registration tests
    before(async function () {
      this.timeout(30_000); // Allow up to 30 seconds for extension activation

      // Find and activate the extension
      const allExtensions = vscode.extensions.all;
      const promptRegistryExt = allExtensions.find((ext) =>
        ext.id.toLowerCase().includes('prompt-registry')
        || ext.id.toLowerCase().includes('promptregistry')
      );

      if (promptRegistryExt && !promptRegistryExt.isActive) {
        await promptRegistryExt.activate();
      }

      // Poll for commands to be registered (they're registered during activation)
      const targetCommand = 'promptRegistry.moveToUser';
      const maxWaitMs = 10_000;
      const pollIntervalMs = 100;
      let elapsed = 0;

      while (elapsed < maxWaitMs) {
        const commands = await vscode.commands.getCommands(true);
        if (commands.includes(targetCommand)) {
          return; // Commands are ready
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        elapsed += pollIntervalMs;
      }

      // If we get here, commands weren't registered in time - tests will fail with clear message
    });

    it('should have moveToUser command registered', async () => {
      // Verify the command is registered
      const commands = await vscode.commands.getCommands(true);
      assert.ok(
        commands.includes('promptRegistry.moveToUser'),
        'promptRegistry.moveToUser command should be registered'
      );
    });

    it('should have moveToRepositoryCommit command registered', async () => {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(
        commands.includes('promptRegistry.moveToRepositoryCommit'),
        'promptRegistry.moveToRepositoryCommit command should be registered'
      );
    });

    it('should have moveToRepositoryLocalOnly command registered', async () => {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(
        commands.includes('promptRegistry.moveToRepositoryLocalOnly'),
        'promptRegistry.moveToRepositoryLocalOnly command should be registered'
      );
    });

    it('should have switchToLocalOnly command registered', async () => {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(
        commands.includes('promptRegistry.switchToLocalOnly'),
        'promptRegistry.switchToLocalOnly command should be registered'
      );
    });

    it('should have switchToCommit command registered', async () => {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(
        commands.includes('promptRegistry.switchToCommit'),
        'promptRegistry.switchToCommit command should be registered'
      );
    });

    /**
     * PLACEHOLDER: Full E2E Scope Migration Tests
     *
     * To implement these tests, you would need to:
     *
     * 1. Set up a test workspace with .github/ folder
     * 2. Configure a local bundle source (to avoid HTTP mocking issues)
     * 3. Install a bundle at one scope
     * 4. Execute the migration command
     * 5. Verify files moved and lockfile updated
     * 6. Clean up test artifacts
     *
     * Example implementation:
     *
     * it('should migrate bundle from repository to user via command', async () => {
     *     // Setup: Install bundle at repository scope
     *     await vscode.commands.executeCommand('promptRegistry.installBundle', bundleId, {
     *         scope: 'repository', version: '1.0.0'
     *     });
     *
     *     // Act: Execute the actual VS Code command
     *     await vscode.commands.executeCommand('promptRegistry.moveToUser', bundleId);
     *
     *     // Assert: Verify end state
     *     // - Bundle removed from lockfile
     *     // - Bundle added to user storage
     *     // - Files moved from .github/ to user config
     * });
     *
     * For now, this functionality is tested in:
     * - test/e2e/repository-level-installation.test.ts (through BundleScopeCommands)
     */
  });
});
