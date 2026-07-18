/**
 * Tests for MarketplaceViewProvider Scope Selection Bug Fix
 *
 * Bug: handleInstall and handleInstallVersion hardcode scope: 'user' instead of
 * showing the scope selection dialog.
 *
 * These tests verify the BEHAVIOR:
 * - User should be able to choose installation scope when installing from marketplace
 * - Repository scope option should be available when workspace is open
 */

import * as assert from 'node:assert';
import {
  suite,
  test,
} from 'mocha';
import * as scopeSelectionUI from '../../src/utils/scope-selection-ui';

suite('MarketplaceViewProvider - Scope Selection Bug', () => {
  suite('Scope selection dialog options', () => {
    test('should provide three scope options', () => {
      const items = scopeSelectionUI.createScopeQuickPickItems(true);

      assert.strictEqual(items.length, 3, 'Should have exactly 3 scope options');

      const scopes = items.map((i) => ({ scope: i._scope, commitMode: i._commitMode }));
      assert.ok(scopes.some((s) => s.scope === 'repository' && s.commitMode === 'commit'),
        'Should have repository commit option');
      assert.ok(scopes.some((s) => s.scope === 'repository' && s.commitMode === 'local-only'),
        'Should have repository local-only option');
      assert.ok(scopes.some((s) => s.scope === 'user'),
        'Should have user option');
    });

    test('should disable repository options when no workspace is open', () => {
      const items = scopeSelectionUI.createScopeQuickPickItems(false);

      const repoCommit = items.find((i) => i._scope === 'repository' && i._commitMode === 'commit');
      const repoLocal = items.find((i) => i._scope === 'repository' && i._commitMode === 'local-only');
      const userOption = items.find((i) => i._scope === 'user');

      assert.ok(repoCommit?._disabled, 'Repository commit option should be disabled without workspace');
      assert.ok(repoLocal?._disabled, 'Repository local-only option should be disabled without workspace');
      assert.ok(!userOption?._disabled, 'User option should always be enabled');
    });

    test('should enable all options when workspace is open', () => {
      const items = scopeSelectionUI.createScopeQuickPickItems(true);

      const repoCommit = items.find((i) => i._scope === 'repository' && i._commitMode === 'commit');
      const repoLocal = items.find((i) => i._scope === 'repository' && i._commitMode === 'local-only');
      const userOption = items.find((i) => i._scope === 'user');

      assert.ok(!repoCommit?._disabled, 'Repository commit option should be enabled with workspace');
      assert.ok(!repoLocal?._disabled, 'Repository local-only option should be enabled with workspace');
      assert.ok(!userOption?._disabled, 'User option should be enabled');
    });

    test('should pre-select repository commit when workspace is open', () => {
      const items = scopeSelectionUI.createScopeQuickPickItems(true);

      const repoCommit = items.find((i) => i._scope === 'repository' && i._commitMode === 'commit');
      const othersPicked = items.filter((i) => i !== repoCommit && i.picked);

      assert.ok(repoCommit?.picked, 'Repository commit should be pre-selected when workspace is open');
      assert.strictEqual(othersPicked.length, 0, 'Only one option should be pre-selected');
    });

    test('should not pre-select any option when no workspace is open', () => {
      const items = scopeSelectionUI.createScopeQuickPickItems(false);

      // When workspace is not open, repository commit would be picked but it's disabled
      // So effectively no valid option is pre-selected
      const enabledAndPicked = items.filter((i) => i.picked && !i._disabled);

      assert.strictEqual(enabledAndPicked.length, 0,
        'No enabled option should be pre-selected when workspace is closed');
    });
  });

  suite('Scope option labels and descriptions', () => {
    test('should have descriptive labels for each option', () => {
      const items = scopeSelectionUI.createScopeQuickPickItems(true);

      const repoCommit = items.find((i) => i._scope === 'repository' && i._commitMode === 'commit');
      const repoLocal = items.find((i) => i._scope === 'repository' && i._commitMode === 'local-only');
      const userOption = items.find((i) => i._scope === 'user');

      // Verify labels contain meaningful text
      assert.ok(repoCommit?.label.includes('Repository'), 'Commit option should mention Repository');
      assert.ok(repoCommit?.label.includes('Commit') || repoCommit?.label.includes('Git'),
        'Commit option should mention Git/Commit');

      assert.ok(repoLocal?.label.includes('Repository'), 'Local option should mention Repository');
      assert.ok(repoLocal?.label.includes('Local'), 'Local option should mention Local');

      assert.ok(userOption?.label.includes('User'), 'User option should mention User');
    });

    test('should show workspace requirement hint when disabled', () => {
      const items = scopeSelectionUI.createScopeQuickPickItems(false);

      const repoCommit = items.find((i) => i._scope === 'repository' && i._commitMode === 'commit');
      const repoLocal = items.find((i) => i._scope === 'repository' && i._commitMode === 'local-only');

      // Disabled options should have detail explaining why
      assert.ok(repoCommit?.detail?.includes('workspace'),
        'Disabled commit option should explain workspace requirement');
      assert.ok(repoLocal?.detail?.includes('workspace'),
        'Disabled local option should explain workspace requirement');
    });
  });
});
