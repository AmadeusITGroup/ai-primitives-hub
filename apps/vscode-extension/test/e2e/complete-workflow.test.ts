/**
 * End-to-End Integration Tests
 *
 * Tests complete workflows from source addition to bundle installation.
 * These tests require running in VS Code extension host environment.
 *
 * To run these tests, use the VS Code Extension Test Runner or:
 * npm run test:integration
 */

import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('E2E: Complete Workflow Tests', () => {
  suiteSetup(async function () {
    this.timeout(30_000);

    // Get extension context - this only works when running in VS Code extension host
    const ext = vscode.extensions.getExtension('AmadeusITGroup.prompt-registry');
    if (!ext) {
      // Skip all tests in this suite if extension is not available
      // This happens when running tests outside of VS Code extension host
      this.skip();
      return;
    }
    await ext.activate();
  });

  // Note: Placeholder tests have been removed.
  // Real E2E tests should be added when running in VS Code extension host.
  // See test/e2e/AGENTS.md for guidance on writing E2E tests.

  test('Extension activates successfully', function () {
    this.timeout(10_000);

    const ext = vscode.extensions.getExtension('AmadeusITGroup.prompt-registry');
    assert.ok(ext, 'Extension should be available');
    assert.ok(ext.isActive, 'Extension should be active');
  });
});
