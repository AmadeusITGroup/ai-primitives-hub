/**
 * LocalModificationWarningService Property Tests
 *
 * Property-based tests for the local modification warning service.
 *
 * Requirements: 14.4-14.10
 */

import * as assert from 'node:assert';
import * as fc from 'fast-check';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  LocalModificationWarningService,
} from '../../src/services/local-modification-warning-service';
import {
  LockfileManager,
} from '../../src/services/lockfile-manager';
import {
  ModifiedFileInfo,
} from '../../src/types/lockfile';
import {
  LockfileGenerators,
} from '../helpers/lockfile-test-helpers';

suite('LocalModificationWarningService - Property Tests', () => {
  let sandbox: sinon.SinonSandbox;
  let mockLockfileManager: sinon.SinonStubbedInstance<LockfileManager>;
  let service: LocalModificationWarningService;
  let showWarningMessageStub: sinon.SinonStub;
  let openExternalStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    mockLockfileManager = sandbox.createStubInstance(LockfileManager);
    service = new LocalModificationWarningService(mockLockfileManager);

    // Mock VS Code APIs
    showWarningMessageStub = sandbox.stub(vscode.window, 'showWarningMessage');

    // Create openExternal stub if it doesn't exist
    if (!vscode.env.openExternal) {
      (vscode.env as any).openExternal = () => Promise.resolve(true);
    }
    openExternalStub = sandbox.stub(vscode.env, 'openExternal').resolves(true);
  });

  teardown(() => {
    sandbox.restore();
  });

  /**
   * Generator for modified file info
   */
  const modifiedFileInfoArb = (): fc.Arbitrary<ModifiedFileInfo> => {
    return fc.record({
      path: LockfileGenerators.filePath(),
      originalChecksum: LockfileGenerators.checksum(),
      currentChecksum: fc.oneof(
        LockfileGenerators.checksum(),
        fc.constant('') // For missing files
      ),
      modificationType: fc.constantFrom('modified', 'missing', 'new')
    });
  };

  /**
   * Generator for user dialog responses
   */
  const dialogResponseArb = (): fc.Arbitrary<string | undefined> => {
    return fc.oneof(
      fc.constant('Contribute Changes'),
      fc.constant('Override'),
      fc.constant('Cancel'),
      fc.constant(undefined) // User dismissed
    );
  };

  /**
   * Property 13: Local Modification Warning Dialog
   *
   * For any set of modified files, when showWarningDialog is called:
   * - The dialog should be displayed with exactly 3 action buttons
   * - The message should list all modified file paths
   * - User selection should map to correct ModificationWarningResult
   * - "Contribute Changes" should open the repository URL if provided
   *
   * Validates: Requirements 14.4-14.10
   *
   * Feature: repository-level-installation, Property 13: Local Modification Warning Dialog
   */
  test('Property 13: Dialog displays correct options and handles all user responses', async () => {
    await fc.assert(
      fc.asyncProperty(
        LockfileGenerators.bundleId(),
        fc.array(modifiedFileInfoArb(), { minLength: 1, maxLength: 5 }),
        fc.option(LockfileGenerators.url(), { nil: undefined }),
        dialogResponseArb(),
        async (bundleId, modifiedFiles, bundleRepoUrl, userResponse) => {
          // Reset stubs for each iteration
          showWarningMessageStub.reset();
          openExternalStub.reset();
          showWarningMessageStub.resolves(userResponse);
          openExternalStub.resolves(true);

          // Act
          const result = await service.showWarningDialog(bundleId, modifiedFiles, bundleRepoUrl);

          // Assert: Dialog should be displayed
          assert.strictEqual(
            showWarningMessageStub.callCount,
            1,
            'Dialog should be displayed exactly once'
          );

          // Assert: Dialog should have exactly 3 buttons
          const callArgs = showWarningMessageStub.firstCall.args;
          const buttons = callArgs.slice(1); // Skip message, get buttons
          assert.strictEqual(
            buttons.length,
            3,
            'Dialog should have exactly 3 action buttons'
          );
          assert.ok(
            buttons.includes('Contribute Changes'),
            'Dialog should have "Contribute Changes" button'
          );
          assert.ok(
            buttons.includes('Override'),
            'Dialog should have "Override" button'
          );
          assert.ok(
            buttons.includes('Cancel'),
            'Dialog should have "Cancel" button'
          );

          // Assert: Message should list all modified files
          const message = callArgs[0] as string;
          for (const file of modifiedFiles) {
            assert.ok(
              message.includes(file.path),
              `Message should include file path: ${file.path}`
            );
          }

          // Assert: User response maps to correct result
          if (userResponse === 'Contribute Changes') {
            assert.strictEqual(result, 'contribute', 'Should return "contribute" for Contribute Changes');

            // Assert: URL should be opened if provided
            if (bundleRepoUrl) {
              assert.ok(
                openExternalStub.calledOnce,
                'Should open repository URL when Contribute Changes clicked and URL provided'
              );
              const uri = openExternalStub.firstCall.args[0] as vscode.Uri;
              assert.strictEqual(
                uri.toString(),
                bundleRepoUrl,
                'Should open correct repository URL'
              );
            } else {
              assert.ok(
                !openExternalStub.called,
                'Should not open URL when none provided'
              );
            }
          } else if (userResponse === 'Override') {
            assert.strictEqual(result, 'override', 'Should return "override" for Override');
            assert.ok(!openExternalStub.called, 'Should not open URL for Override');
          } else {
            // Cancel or dismissed
            assert.strictEqual(result, 'cancel', 'Should return "cancel" for Cancel or dismiss');
            assert.ok(!openExternalStub.called, 'Should not open URL for Cancel');
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property: checkAndWarn returns null when no modifications
   *
   * For any bundle ID, when no modifications are detected,
   * checkAndWarn should return null without showing a dialog.
   */
  test('Property: checkAndWarn returns null when no modifications detected', async () => {
    await fc.assert(
      fc.asyncProperty(
        LockfileGenerators.bundleId(),
        async (bundleId) => {
          // Reset stubs
          showWarningMessageStub.reset();
          mockLockfileManager.detectModifiedFiles.reset();
          mockLockfileManager.detectModifiedFiles.resolves([]);

          // Act
          const result = await service.checkAndWarn(bundleId);

          // Assert
          assert.strictEqual(result, null, 'Should return null when no modifications');
          assert.ok(
            !showWarningMessageStub.called,
            'Should not show dialog when no modifications'
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property: checkAndWarn shows dialog when modifications exist
   *
   * For any bundle ID with modifications, checkAndWarn should
   * show the dialog and return the user's choice.
   */
  test('Property: checkAndWarn shows dialog and returns result when modifications exist', async () => {
    await fc.assert(
      fc.asyncProperty(
        LockfileGenerators.bundleId(),
        fc.array(modifiedFileInfoArb(), { minLength: 1, maxLength: 5 }),
        dialogResponseArb(),
        async (bundleId, modifiedFiles, userResponse) => {
          // Reset stubs
          showWarningMessageStub.reset();
          openExternalStub.reset();
          mockLockfileManager.detectModifiedFiles.reset();

          mockLockfileManager.detectModifiedFiles.resolves(modifiedFiles);
          showWarningMessageStub.resolves(userResponse);
          openExternalStub.resolves(true);

          // Act
          const result = await service.checkAndWarn(bundleId);

          // Assert
          assert.ok(result !== null, 'Should return a result when modifications exist');
          assert.ok(
            showWarningMessageStub.calledOnce,
            'Should show dialog when modifications exist'
          );

          // Verify result matches user response
          if (userResponse === 'Contribute Changes') {
            assert.strictEqual(result, 'contribute');
          } else if (userResponse === 'Override') {
            assert.strictEqual(result, 'override');
          } else {
            assert.strictEqual(result, 'cancel');
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property: Dialog message completeness
   *
   * For any set of modified files, the dialog message should
   * include all file paths, regardless of modification type.
   */
  test('Property: Dialog message includes all modified file paths', async () => {
    await fc.assert(
      fc.asyncProperty(
        LockfileGenerators.bundleId(),
        fc.array(modifiedFileInfoArb(), { minLength: 1, maxLength: 10 }),
        async (bundleId, modifiedFiles) => {
          // Reset stubs
          showWarningMessageStub.reset();
          showWarningMessageStub.resolves('Cancel');

          // Act
          await service.showWarningDialog(bundleId, modifiedFiles);

          // Assert
          const message = showWarningMessageStub.firstCall.args[0] as string;

          // Every file path should appear in the message
          for (const file of modifiedFiles) {
            assert.ok(
              message.includes(file.path),
              `Message should include file path: ${file.path}`
            );
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property: Consistent button order
   *
   * For any dialog invocation, the buttons should always appear
   * in the same order: Contribute Changes, Override, Cancel.
   */
  test('Property: Dialog buttons appear in consistent order', async () => {
    await fc.assert(
      fc.asyncProperty(
        LockfileGenerators.bundleId(),
        fc.array(modifiedFileInfoArb(), { minLength: 1, maxLength: 5 }),
        async (bundleId, modifiedFiles) => {
          // Reset stubs
          showWarningMessageStub.reset();
          showWarningMessageStub.resolves('Cancel');

          // Act
          await service.showWarningDialog(bundleId, modifiedFiles);

          // Assert
          const callArgs = showWarningMessageStub.firstCall.args;
          const buttons = callArgs.slice(1);

          assert.strictEqual(buttons[0], 'Contribute Changes', 'First button should be Contribute Changes');
          assert.strictEqual(buttons[1], 'Override', 'Second button should be Override');
          assert.strictEqual(buttons[2], 'Cancel', 'Third button should be Cancel');
        }
      ),
      { numRuns: 100 }
    );
  });
});
