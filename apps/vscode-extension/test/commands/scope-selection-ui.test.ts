/**
 * Unit Tests for Scope Selection UI
 *
 * Tests the scope selection dialog functionality for bundle installation.
 * Validates Requirements 2.1-2.6, 1.8
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  createScopeQuickPickItems,
  hasOpenWorkspace,
  ScopeQuickPickItem,
  showScopeSelectionDialog,
} from '../../src/utils/scope-selection-ui';

suite('ScopeSelectionUI', () => {
  let sandbox: sinon.SinonSandbox;
  let mockCreateQuickPick: sinon.SinonStub;
  let mockQuickPick: {
    items: ScopeQuickPickItem[];
    selectedItems: ScopeQuickPickItem[];
    title: string;
    placeholder: string;
    ignoreFocusOut: boolean;
    onDidChangeSelection: sinon.SinonStub;
    onDidAccept: sinon.SinonStub;
    onDidHide: sinon.SinonStub;
    show: sinon.SinonStub;
    hide: sinon.SinonStub;
    dispose: sinon.SinonStub;
  };
  let originalWorkspaceFolders: typeof vscode.workspace.workspaceFolders;

  // Store event handlers for triggering in tests
  let selectionChangeHandler: ((selection: ScopeQuickPickItem[]) => void) | null = null;
  let acceptHandler: (() => void) | null = null;
  let hideHandler: (() => void) | null = null;

  // ===== Test Utilities =====

  const setWorkspaceOpen = (isOpen: boolean): void => {
    if (isOpen) {
      (vscode.workspace as any).workspaceFolders = [
        { uri: { fsPath: '/mock/workspace' }, name: 'workspace', index: 0 }
      ];
    } else {
      (vscode.workspace as any).workspaceFolders = undefined;
    }
  };

  const createMockQuickPick = () => {
    mockQuickPick = {
      items: [],
      selectedItems: [],
      title: '',
      placeholder: '',
      ignoreFocusOut: false,
      onDidChangeSelection: sandbox.stub().callsFake((handler) => {
        selectionChangeHandler = handler;
        return { dispose: () => {} };
      }),
      onDidAccept: sandbox.stub().callsFake((handler) => {
        acceptHandler = handler;
        return { dispose: () => {} };
      }),
      onDidHide: sandbox.stub().callsFake((handler) => {
        hideHandler = handler;
        return { dispose: () => {} };
      }),
      show: sandbox.stub(),
      hide: sandbox.stub(),
      dispose: sandbox.stub()
    };
    return mockQuickPick;
  };

  // ===== Test Lifecycle =====
  setup(() => {
    sandbox = sinon.createSandbox();
    createMockQuickPick();
    mockCreateQuickPick = sandbox.stub(vscode.window, 'createQuickPick').returns(mockQuickPick as any);
    // Save original workspace folders
    originalWorkspaceFolders = vscode.workspace.workspaceFolders;
  });

  teardown(() => {
    sandbox.restore();
    // Restore original workspace folders
    (vscode.workspace as any).workspaceFolders = originalWorkspaceFolders;
  });

  // ===== Unit Tests =====

  suite('hasOpenWorkspace()', () => {
    test('should return true when workspace folders exist', () => {
      setWorkspaceOpen(true);
      assert.strictEqual(hasOpenWorkspace(), true);
    });

    test('should return false when workspace folders is undefined', () => {
      setWorkspaceOpen(false);
      assert.strictEqual(hasOpenWorkspace(), false);
    });

    test('should return false when workspace folders is empty array', () => {
      (vscode.workspace as any).workspaceFolders = [];
      assert.strictEqual(hasOpenWorkspace(), false);
    });
  });

  suite('createScopeQuickPickItems()', () => {
    test('should create three items', () => {
      const items = createScopeQuickPickItems(true);
      assert.strictEqual(items.length, 3);
    });

    test('should mark repository options as disabled when no workspace', () => {
      const items = createScopeQuickPickItems(false);
      assert.strictEqual(items[0]._disabled, true, 'Repository - Commit should be disabled');
      assert.strictEqual(items[1]._disabled, true, 'Repository - Local Only should be disabled');
      assert.strictEqual(items[2]._disabled, false, 'User Profile should not be disabled');
    });

    test('should enable all options when workspace is open', () => {
      const items = createScopeQuickPickItems(true);
      assert.strictEqual(items[0]._disabled, false, 'Repository - Commit should be enabled');
      assert.strictEqual(items[1]._disabled, false, 'Repository - Local Only should be enabled');
      assert.strictEqual(items[2]._disabled, false, 'User Profile should be enabled');
    });

    test('should include _originalDetail for disabled items', () => {
      const items = createScopeQuickPickItems(false);
      assert.strictEqual(items[0]._originalDetail, '(Requires an open workspace)');
      assert.strictEqual(items[1]._originalDetail, '(Requires an open workspace)');
      assert.strictEqual(items[2]._originalDetail, undefined);
    });
  });

  suite('Dialog Options When Workspace Is Open', () => {
    setup(() => {
      setWorkspaceOpen(true);
    });

    /**
     * Requirement 2.1: WHEN presenting installation options, THE Extension SHALL display
     * a single QuickPick dialog with three options
     */
    test('should display exactly three options when workspace is open', async () => {
      const dialogPromise = showScopeSelectionDialog();

      // Simulate user selecting an option and accepting
      mockQuickPick.selectedItems = [mockQuickPick.items[0]];
      acceptHandler?.();

      await dialogPromise;

      assert.strictEqual(mockCreateQuickPick.callCount, 1, 'Should create one QuickPick dialog');
      assert.strictEqual(mockQuickPick.items.length, 3, 'Should have exactly 3 options');
    });

    /**
     * Requirement 2.2: WHEN displaying the QuickPick dialog, THE Extension SHALL show
     * "Repository - Commit to Git (Recommended)" as the first option
     */
    test('should show "Repository - Commit to Git (Recommended)" as first option', async () => {
      const dialogPromise = showScopeSelectionDialog();

      mockQuickPick.selectedItems = [mockQuickPick.items[2]]; // User Profile
      acceptHandler?.();

      await dialogPromise;

      const items = mockQuickPick.items;
      assert.ok(
        items[0].label.includes('Repository - Commit to Git'),
        'First option should be Repository - Commit to Git'
      );
      assert.ok(
        items[0].label.includes('Recommended'),
        'First option should indicate it is recommended'
      );
      assert.ok(
        items[0].description?.includes('tracked in version control'),
        'First option should describe version control tracking'
      );
    });

    /**
     * Requirement 2.3: WHEN displaying the QuickPick dialog, THE Extension SHALL show
     * "Repository - Local Only" as the second option
     */
    test('should show "Repository - Local Only" as second option', async () => {
      const dialogPromise = showScopeSelectionDialog();

      mockQuickPick.selectedItems = [mockQuickPick.items[2]];
      acceptHandler?.();

      await dialogPromise;

      const items = mockQuickPick.items;
      assert.ok(
        items[1].label.includes('Repository - Local Only'),
        'Second option should be Repository - Local Only'
      );
      assert.ok(
        items[1].description?.includes('excluded via .git/info/exclude'),
        'Second option should describe git exclude'
      );
    });

    /**
     * Requirement 2.4: WHEN displaying the QuickPick dialog, THE Extension SHALL show
     * "User Profile" as the third option
     */
    test('should show "User Profile" as third option', async () => {
      const dialogPromise = showScopeSelectionDialog();

      mockQuickPick.selectedItems = [mockQuickPick.items[2]];
      acceptHandler?.();

      await dialogPromise;

      const items = mockQuickPick.items;
      assert.ok(
        items[2].label.includes('User Profile'),
        'Third option should be User Profile'
      );
      assert.ok(
        items[2].description?.includes('available everywhere'),
        'Third option should describe availability'
      );
    });

    /**
     * Requirement 2.2: First option should have description "Install in .github/, tracked in version control"
     */
    test('should have correct description for Repository - Commit option', async () => {
      const dialogPromise = showScopeSelectionDialog();

      mockQuickPick.selectedItems = [mockQuickPick.items[2]];
      acceptHandler?.();

      await dialogPromise;

      const items = mockQuickPick.items;
      assert.strictEqual(
        items[0].description,
        'Install in .github/, tracked in version control',
        'First option should have correct description'
      );
    });

    /**
     * Requirement 2.3: Second option should have description "Install in .github/, excluded via .git/info/exclude"
     */
    test('should have correct description for Repository - Local Only option', async () => {
      const dialogPromise = showScopeSelectionDialog();

      mockQuickPick.selectedItems = [mockQuickPick.items[2]];
      acceptHandler?.();

      await dialogPromise;

      const items = mockQuickPick.items;
      assert.strictEqual(
        items[1].description,
        'Install in .github/, excluded via .git/info/exclude',
        'Second option should have correct description'
      );
    });

    /**
     * Requirement 2.4: Third option should have description "Install in user config, available everywhere"
     */
    test('should have correct description for User Profile option', async () => {
      const dialogPromise = showScopeSelectionDialog();

      mockQuickPick.selectedItems = [mockQuickPick.items[2]];
      acceptHandler?.();

      await dialogPromise;

      const items = mockQuickPick.items;
      assert.strictEqual(
        items[2].description,
        'Install in user config, available everywhere',
        'Third option should have correct description'
      );
    });

    /**
     * All repository options should be enabled when workspace is open
     */
    test('should enable all repository options when workspace is open', async () => {
      const dialogPromise = showScopeSelectionDialog();

      mockQuickPick.selectedItems = [mockQuickPick.items[0]];
      acceptHandler?.();

      await dialogPromise;

      const items = mockQuickPick.items;

      // Repository options should not have disabled detail
      assert.ok(
        !items[0].detail || !items[0].detail.includes('Requires'),
        'Repository - Commit should not show disabled message'
      );
      assert.ok(
        !items[1].detail || !items[1].detail.includes('Requires'),
        'Repository - Local Only should not show disabled message'
      );
    });
  });

  suite('Dialog Options When No Workspace Is Open', () => {
    setup(() => {
      setWorkspaceOpen(false);
    });

    /**
     * Requirement 1.8: WHEN no workspace is open, THE Extension SHALL disable repository
     * scope option and default to user scope
     */
    test('should show disabled message for repository options when no workspace', async () => {
      const dialogPromise = showScopeSelectionDialog();

      mockQuickPick.selectedItems = [mockQuickPick.items[2]]; // User Profile
      acceptHandler?.();

      await dialogPromise;

      const items = mockQuickPick.items;

      // Repository options should have disabled detail
      assert.ok(
        items[0].detail && items[0].detail.includes('Requires an open workspace'),
        'Repository - Commit should show disabled message'
      );
      assert.ok(
        items[1].detail && items[1].detail.includes('Requires an open workspace'),
        'Repository - Local Only should show disabled message'
      );
    });

    /**
     * User Profile option should always be available
     */
    test('should keep User Profile option enabled when no workspace', async () => {
      const dialogPromise = showScopeSelectionDialog();

      mockQuickPick.selectedItems = [mockQuickPick.items[2]];
      acceptHandler?.();

      await dialogPromise;

      const items = mockQuickPick.items;

      // User Profile should not have disabled detail
      assert.ok(
        !items[2].detail || !items[2].detail.includes('Requires'),
        'User Profile should not show disabled message'
      );
    });

    /**
     * Should still display all three options even when some are disabled
     */
    test('should still display three options when no workspace', async () => {
      const dialogPromise = showScopeSelectionDialog();

      mockQuickPick.selectedItems = [mockQuickPick.items[2]];
      acceptHandler?.();

      await dialogPromise;

      const items = mockQuickPick.items;
      assert.strictEqual(items.length, 3, 'Should still have 3 options');
    });
  });

  suite('Selection Handling', () => {
    setup(() => {
      setWorkspaceOpen(true);
    });

    /**
     * Requirement 2.5: WHEN user selects an option, THE Extension SHALL proceed with
     * installation using the selected scope and commit preference
     */
    test('should return repository scope with commit mode when first option selected', async () => {
      const dialogPromise = showScopeSelectionDialog();

      mockQuickPick.selectedItems = [mockQuickPick.items[0]];
      acceptHandler?.();

      const result = await dialogPromise;

      assert.ok(result, 'Should return a result');
      assert.strictEqual(result.scope, 'repository', 'Should return repository scope');
      assert.strictEqual(result.commitMode, 'commit', 'Should return commit mode');
    });

    test('should return repository scope with local-only mode when second option selected', async () => {
      const dialogPromise = showScopeSelectionDialog();

      mockQuickPick.selectedItems = [mockQuickPick.items[1]];
      acceptHandler?.();

      const result = await dialogPromise;

      assert.ok(result, 'Should return a result');
      assert.strictEqual(result.scope, 'repository', 'Should return repository scope');
      assert.strictEqual(result.commitMode, 'local-only', 'Should return local-only mode');
    });

    test('should return user scope without commit mode when third option selected', async () => {
      const dialogPromise = showScopeSelectionDialog();

      mockQuickPick.selectedItems = [mockQuickPick.items[2]];
      acceptHandler?.();

      const result = await dialogPromise;

      assert.ok(result, 'Should return a result');
      assert.strictEqual(result.scope, 'user', 'Should return user scope');
      assert.strictEqual(result.commitMode, undefined, 'Should not have commit mode for user scope');
    });

    /**
     * Requirement 2.6: WHEN user cancels the dialog, THE Extension SHALL abort the installation
     */
    test('should return undefined when user cancels dialog', async () => {
      const dialogPromise = showScopeSelectionDialog();

      // Simulate user pressing Escape
      hideHandler?.();

      const result = await dialogPromise;

      assert.strictEqual(result, undefined, 'Should return undefined when cancelled');
    });
  });

  suite('Disabled Option Handling (Improved UX)', () => {
    setup(() => {
      setWorkspaceOpen(false);
    });

    /**
     * Requirement 1.8: Dialog should remain open when disabled option is selected
     */
    test('should keep dialog open when disabled option is selected via onDidChangeSelection', async () => {
      const dialogPromise = showScopeSelectionDialog();

      // Simulate selecting a disabled option
      const disabledItem = mockQuickPick.items[0]; // Repository - Commit (disabled)
      selectionChangeHandler?.([disabledItem]);

      // Verify selection was cleared (dialog stays open)
      assert.deepStrictEqual(mockQuickPick.selectedItems, [], 'Selection should be cleared');

      // Verify hide was NOT called
      assert.strictEqual(mockQuickPick.hide.callCount, 0, 'Dialog should not be hidden');

      // Now select a valid option to close the dialog
      mockQuickPick.selectedItems = [mockQuickPick.items[2]]; // User Profile
      acceptHandler?.();

      await dialogPromise;
    });

    /**
     * Requirement 1.8: Dialog should show inline warning when disabled option is selected
     */
    test('should show inline warning when disabled option is selected', async () => {
      const dialogPromise = showScopeSelectionDialog();

      // Simulate selecting a disabled option
      const disabledItem = mockQuickPick.items[0]; // Repository - Commit (disabled)
      selectionChangeHandler?.([disabledItem]);

      // Verify the item's detail was updated to show warning
      const updatedItem = mockQuickPick.items.find((item) => item._scope === 'repository' && item._commitMode === 'commit');
      assert.ok(
        updatedItem?.detail?.includes('⚠️') || updatedItem?.detail?.includes('Requires an open workspace'),
        'Should show warning in detail'
      );

      // Close dialog properly
      mockQuickPick.selectedItems = [mockQuickPick.items[2]];
      acceptHandler?.();

      await dialogPromise;
    });

    /**
     * Requirement 1.8: Dialog should not accept disabled option on Enter/Accept
     */
    test('should not accept disabled option when user presses Enter', async () => {
      const dialogPromise = showScopeSelectionDialog();

      // Simulate selecting a disabled option and pressing Enter
      mockQuickPick.selectedItems = [mockQuickPick.items[0]]; // Repository - Commit (disabled)
      acceptHandler?.();

      // Verify hide was NOT called (dialog stays open)
      assert.strictEqual(mockQuickPick.hide.callCount, 0, 'Dialog should not be hidden for disabled option');

      // Verify selection was cleared
      assert.deepStrictEqual(mockQuickPick.selectedItems, [], 'Selection should be cleared');

      // Now select a valid option to close the dialog
      mockQuickPick.selectedItems = [mockQuickPick.items[2]]; // User Profile
      acceptHandler?.();

      const result = await dialogPromise;
      assert.ok(result, 'Should return result after valid selection');
      assert.strictEqual(result.scope, 'user', 'Should return user scope');
    });

    /**
     * Requirement 1.8: User Profile should always be selectable
     */
    test('should allow User Profile selection when no workspace is open', async () => {
      const dialogPromise = showScopeSelectionDialog();

      mockQuickPick.selectedItems = [mockQuickPick.items[2]]; // User Profile
      acceptHandler?.();

      const result = await dialogPromise;

      assert.ok(result, 'Should return a result');
      assert.strictEqual(result.scope, 'user', 'Should return user scope');
      assert.strictEqual(mockQuickPick.hide.callCount, 1, 'Dialog should be hidden after valid selection');
    });

    /**
     * Test that warning is shown for both disabled repository options
     */
    test('should show warning for Repository - Local Only when disabled', async () => {
      const dialogPromise = showScopeSelectionDialog();

      // Simulate selecting the second disabled option
      const disabledItem = mockQuickPick.items[1]; // Repository - Local Only (disabled)
      selectionChangeHandler?.([disabledItem]);

      // Verify selection was cleared
      assert.deepStrictEqual(mockQuickPick.selectedItems, [], 'Selection should be cleared');

      // Close dialog properly
      mockQuickPick.selectedItems = [mockQuickPick.items[2]];
      acceptHandler?.();

      await dialogPromise;
    });
  });

  suite('QuickPick Configuration', () => {
    setup(() => {
      setWorkspaceOpen(true);
    });

    test('should set appropriate title for the dialog', async () => {
      const dialogPromise = showScopeSelectionDialog();

      mockQuickPick.selectedItems = [mockQuickPick.items[2]];
      acceptHandler?.();

      await dialogPromise;

      assert.ok(mockQuickPick.title, 'Should have a title');
      assert.ok(
        mockQuickPick.title.toLowerCase().includes('scope')
        || mockQuickPick.title.toLowerCase().includes('installation'),
        'Title should mention scope or installation'
      );
    });

    test('should include bundle name in title when provided', async () => {
      const dialogPromise = showScopeSelectionDialog('my-bundle');

      mockQuickPick.selectedItems = [mockQuickPick.items[2]];
      acceptHandler?.();

      await dialogPromise;

      assert.ok(mockQuickPick.title.includes('my-bundle'), 'Title should include bundle name');
    });

    test('should set ignoreFocusOut to true', async () => {
      const dialogPromise = showScopeSelectionDialog();

      mockQuickPick.selectedItems = [mockQuickPick.items[2]];
      acceptHandler?.();

      await dialogPromise;

      assert.strictEqual(mockQuickPick.ignoreFocusOut, true, 'Should ignore focus out');
    });

    test('should have a placeholder text', async () => {
      const dialogPromise = showScopeSelectionDialog();

      mockQuickPick.selectedItems = [mockQuickPick.items[2]];
      acceptHandler?.();

      await dialogPromise;

      assert.ok(mockQuickPick.placeholder, 'Should have placeholder text');
    });

    test('should call show() to display the dialog', async () => {
      const dialogPromise = showScopeSelectionDialog();

      assert.strictEqual(mockQuickPick.show.callCount, 1, 'Should call show()');

      mockQuickPick.selectedItems = [mockQuickPick.items[2]];
      acceptHandler?.();

      await dialogPromise;
    });

    test('should dispose QuickPick when dialog is hidden', async () => {
      const dialogPromise = showScopeSelectionDialog();

      hideHandler?.();

      await dialogPromise;

      assert.strictEqual(mockQuickPick.dispose.callCount, 1, 'Should dispose QuickPick');
    });
  });
});
