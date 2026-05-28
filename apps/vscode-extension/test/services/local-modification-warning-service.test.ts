/**
 * LocalModificationWarningService Unit Tests
 *
 * Tests for the service that detects local file modifications and warns users
 * before updating bundles that would override their changes.
 *
 * Requirements: 14.1-14.10
 */

import * as assert from 'node:assert';
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

suite('LocalModificationWarningService', () => {
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

  suite('checkForModifications()', () => {
    test('should return empty array when no modifications detected', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      mockLockfileManager.detectModifiedFiles.resolves([]);

      // Act
      const result = await service.checkForModifications(bundleId);

      // Assert
      assert.deepStrictEqual(result, [], 'Should return empty array when no modifications');
      assert.ok(mockLockfileManager.detectModifiedFiles.calledOnceWith(bundleId));
    });

    test('should return modified files when modifications detected', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      const modifiedFiles: ModifiedFileInfo[] = [
        {
          path: '.github/prompts/test.prompt.md',
          originalChecksum: 'abc123',
          currentChecksum: 'def456',
          modificationType: 'modified'
        },
        {
          path: '.github/agents/test.agent.md',
          originalChecksum: 'ghi789',
          currentChecksum: 'jkl012',
          modificationType: 'modified'
        }
      ];
      mockLockfileManager.detectModifiedFiles.resolves(modifiedFiles);

      // Act
      const result = await service.checkForModifications(bundleId);

      // Assert
      assert.strictEqual(result.length, 2, 'Should return all modified files');
      assert.deepStrictEqual(result, modifiedFiles);
    });

    test('should include missing files in results', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      const modifiedFiles: ModifiedFileInfo[] = [
        {
          path: '.github/prompts/missing.prompt.md',
          originalChecksum: 'abc123',
          currentChecksum: '',
          modificationType: 'missing'
        }
      ];
      mockLockfileManager.detectModifiedFiles.resolves(modifiedFiles);

      // Act
      const result = await service.checkForModifications(bundleId);

      // Assert
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].modificationType, 'missing');
    });

    test('should delegate to LockfileManager.detectModifiedFiles', async () => {
      // Arrange
      const bundleId = 'my-bundle';
      mockLockfileManager.detectModifiedFiles.resolves([]);

      // Act
      await service.checkForModifications(bundleId);

      // Assert
      assert.ok(mockLockfileManager.detectModifiedFiles.calledOnceWith(bundleId),
        'Should call LockfileManager.detectModifiedFiles with bundle ID');
    });
  });

  suite('showWarningDialog()', () => {
    test('should display warning dialog with modified file list', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      const modifiedFiles: ModifiedFileInfo[] = [
        {
          path: '.github/prompts/test.prompt.md',
          originalChecksum: 'abc123',
          currentChecksum: 'def456',
          modificationType: 'modified'
        }
      ];
      const bundleRepoUrl = 'https://github.com/owner/repo';
      showWarningMessageStub.resolves('Cancel');

      // Act
      await service.showWarningDialog(bundleId, modifiedFiles, bundleRepoUrl);

      // Assert
      assert.ok(showWarningMessageStub.calledOnce, 'Should show warning dialog');
      const message = showWarningMessageStub.firstCall.args[0] as string;
      assert.ok(message.includes('modified'), 'Message should mention modifications');
      assert.ok(message.includes('.github/prompts/test.prompt.md'), 'Message should list modified files');
    });

    test('should include three action buttons: Contribute Changes, Override, Cancel', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      const modifiedFiles: ModifiedFileInfo[] = [
        {
          path: '.github/prompts/test.prompt.md',
          originalChecksum: 'abc123',
          currentChecksum: 'def456',
          modificationType: 'modified'
        }
      ];
      showWarningMessageStub.resolves('Cancel');

      // Act
      await service.showWarningDialog(bundleId, modifiedFiles);

      // Assert
      const callArgs = showWarningMessageStub.firstCall.args;
      const buttons = callArgs.slice(1); // Skip message, get buttons
      assert.strictEqual(buttons.length, 3, 'Should have exactly 3 buttons');
      assert.ok(buttons.includes('Contribute Changes'), 'Should have Contribute Changes button');
      assert.ok(buttons.includes('Override'), 'Should have Override button');
      assert.ok(buttons.includes('Cancel'), 'Should have Cancel button');
    });

    test('should return "contribute" when user clicks Contribute Changes', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      const modifiedFiles: ModifiedFileInfo[] = [
        {
          path: '.github/prompts/test.prompt.md',
          originalChecksum: 'abc123',
          currentChecksum: 'def456',
          modificationType: 'modified'
        }
      ];
      showWarningMessageStub.resolves('Contribute Changes');

      // Act
      const result = await service.showWarningDialog(bundleId, modifiedFiles);

      // Assert
      assert.strictEqual(result, 'contribute', 'Should return "contribute" action');
    });

    test('should return "override" when user clicks Override', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      const modifiedFiles: ModifiedFileInfo[] = [
        {
          path: '.github/prompts/test.prompt.md',
          originalChecksum: 'abc123',
          currentChecksum: 'def456',
          modificationType: 'modified'
        }
      ];
      showWarningMessageStub.resolves('Override');

      // Act
      const result = await service.showWarningDialog(bundleId, modifiedFiles);

      // Assert
      assert.strictEqual(result, 'override', 'Should return "override" action');
    });

    test('should return "cancel" when user clicks Cancel', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      const modifiedFiles: ModifiedFileInfo[] = [
        {
          path: '.github/prompts/test.prompt.md',
          originalChecksum: 'abc123',
          currentChecksum: 'def456',
          modificationType: 'modified'
        }
      ];
      showWarningMessageStub.resolves('Cancel');

      // Act
      const result = await service.showWarningDialog(bundleId, modifiedFiles);

      // Assert
      assert.strictEqual(result, 'cancel', 'Should return "cancel" action');
    });

    test('should return "cancel" when user dismisses dialog', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      const modifiedFiles: ModifiedFileInfo[] = [
        {
          path: '.github/prompts/test.prompt.md',
          originalChecksum: 'abc123',
          currentChecksum: 'def456',
          modificationType: 'modified'
        }
      ];
      showWarningMessageStub.resolves(undefined); // User dismissed

      // Act
      const result = await service.showWarningDialog(bundleId, modifiedFiles);

      // Assert
      assert.strictEqual(result, 'cancel', 'Should return "cancel" when dismissed');
    });

    test('should open repository URL when Contribute Changes is clicked and URL provided', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      const modifiedFiles: ModifiedFileInfo[] = [
        {
          path: '.github/prompts/test.prompt.md',
          originalChecksum: 'abc123',
          currentChecksum: 'def456',
          modificationType: 'modified'
        }
      ];
      const bundleRepoUrl = 'https://github.com/owner/repo';
      showWarningMessageStub.resolves('Contribute Changes');
      openExternalStub.resolves(true);

      // Act
      await service.showWarningDialog(bundleId, modifiedFiles, bundleRepoUrl);

      // Assert
      assert.ok(openExternalStub.calledOnce, 'Should open external URL');
      const uri = openExternalStub.firstCall.args[0] as vscode.Uri;
      assert.strictEqual(uri.toString(), bundleRepoUrl, 'Should open correct repository URL');
    });

    test('should not open URL when Contribute Changes clicked but no URL provided', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      const modifiedFiles: ModifiedFileInfo[] = [
        {
          path: '.github/prompts/test.prompt.md',
          originalChecksum: 'abc123',
          currentChecksum: 'def456',
          modificationType: 'modified'
        }
      ];
      showWarningMessageStub.resolves('Contribute Changes');

      // Act
      await service.showWarningDialog(bundleId, modifiedFiles);

      // Assert
      assert.ok(!openExternalStub.called, 'Should not open URL when none provided');
    });

    test('should list all modified files in dialog message', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      const modifiedFiles: ModifiedFileInfo[] = [
        {
          path: '.github/prompts/file1.prompt.md',
          originalChecksum: 'abc123',
          currentChecksum: 'def456',
          modificationType: 'modified'
        },
        {
          path: '.github/agents/file2.agent.md',
          originalChecksum: 'ghi789',
          currentChecksum: 'jkl012',
          modificationType: 'modified'
        },
        {
          path: '.github/instructions/file3.instructions.md',
          originalChecksum: 'mno345',
          currentChecksum: '',
          modificationType: 'missing'
        }
      ];
      showWarningMessageStub.resolves('Cancel');

      // Act
      await service.showWarningDialog(bundleId, modifiedFiles);

      // Assert
      const message = showWarningMessageStub.firstCall.args[0] as string;
      assert.ok(message.includes('file1.prompt.md'), 'Should list first file');
      assert.ok(message.includes('file2.agent.md'), 'Should list second file');
      assert.ok(message.includes('file3.instructions.md'), 'Should list third file');
    });

    test('should indicate file modification type in message', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      const modifiedFiles: ModifiedFileInfo[] = [
        {
          path: '.github/prompts/modified.prompt.md',
          originalChecksum: 'abc123',
          currentChecksum: 'def456',
          modificationType: 'modified'
        },
        {
          path: '.github/prompts/missing.prompt.md',
          originalChecksum: 'ghi789',
          currentChecksum: '',
          modificationType: 'missing'
        }
      ];
      showWarningMessageStub.resolves('Cancel');

      // Act
      await service.showWarningDialog(bundleId, modifiedFiles);

      // Assert
      const message = showWarningMessageStub.firstCall.args[0] as string;
      assert.ok(message.includes('modified') || message.includes('changed'),
        'Should indicate modification type');
    });
  });

  suite('checkAndWarn()', () => {
    test('should return null when no modifications detected', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      mockLockfileManager.detectModifiedFiles.resolves([]);

      // Act
      const result = await service.checkAndWarn(bundleId);

      // Assert
      assert.strictEqual(result, null, 'Should return null when no modifications');
      assert.ok(!showWarningMessageStub.called, 'Should not show dialog when no modifications');
    });

    test('should show dialog and return result when modifications detected', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      const modifiedFiles: ModifiedFileInfo[] = [
        {
          path: '.github/prompts/test.prompt.md',
          originalChecksum: 'abc123',
          currentChecksum: 'def456',
          modificationType: 'modified'
        }
      ];
      const bundleRepoUrl = 'https://github.com/owner/repo';
      mockLockfileManager.detectModifiedFiles.resolves(modifiedFiles);
      showWarningMessageStub.resolves('Override');

      // Act
      const result = await service.checkAndWarn(bundleId, bundleRepoUrl);

      // Assert
      assert.strictEqual(result, 'override', 'Should return dialog result');
      assert.ok(showWarningMessageStub.calledOnce, 'Should show dialog');
    });

    test('should pass bundle repo URL to dialog', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      const bundleRepoUrl = 'https://github.com/owner/repo';
      const modifiedFiles: ModifiedFileInfo[] = [
        {
          path: '.github/prompts/test.prompt.md',
          originalChecksum: 'abc123',
          currentChecksum: 'def456',
          modificationType: 'modified'
        }
      ];
      mockLockfileManager.detectModifiedFiles.resolves(modifiedFiles);
      showWarningMessageStub.resolves('Contribute Changes');
      openExternalStub.resolves(true);

      // Act
      await service.checkAndWarn(bundleId, bundleRepoUrl);

      // Assert
      assert.ok(openExternalStub.calledOnce, 'Should open URL when Contribute Changes clicked');
      const uri = openExternalStub.firstCall.args[0] as vscode.Uri;
      assert.strictEqual(uri.toString(), bundleRepoUrl);
    });

    test('should combine check and warn in single call', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      const modifiedFiles: ModifiedFileInfo[] = [
        {
          path: '.github/prompts/test.prompt.md',
          originalChecksum: 'abc123',
          currentChecksum: 'def456',
          modificationType: 'modified'
        }
      ];
      mockLockfileManager.detectModifiedFiles.resolves(modifiedFiles);
      showWarningMessageStub.resolves('Cancel');

      // Act
      const result = await service.checkAndWarn(bundleId);

      // Assert
      assert.ok(mockLockfileManager.detectModifiedFiles.calledOnce, 'Should check for modifications');
      assert.ok(showWarningMessageStub.calledOnce, 'Should show warning');
      assert.strictEqual(result, 'cancel');
    });
  });

  suite('Edge cases', () => {
    test('should handle empty bundle ID gracefully', async () => {
      // Arrange
      mockLockfileManager.detectModifiedFiles.resolves([]);

      // Act
      const result = await service.checkForModifications('');

      // Assert
      assert.deepStrictEqual(result, []);
    });

    test('should handle LockfileManager errors gracefully', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      mockLockfileManager.detectModifiedFiles.rejects(new Error('Lockfile error'));

      // Act & Assert
      await assert.rejects(
        () => service.checkForModifications(bundleId),
        /Lockfile error/,
        'Should propagate LockfileManager errors'
      );
    });

    test('should handle dialog errors gracefully', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      const modifiedFiles: ModifiedFileInfo[] = [
        {
          path: '.github/prompts/test.prompt.md',
          originalChecksum: 'abc123',
          currentChecksum: 'def456',
          modificationType: 'modified'
        }
      ];
      showWarningMessageStub.rejects(new Error('Dialog error'));

      // Act & Assert
      await assert.rejects(
        () => service.showWarningDialog(bundleId, modifiedFiles),
        /Dialog error/,
        'Should propagate dialog errors'
      );
    });

    test('should handle openExternal errors gracefully', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      const modifiedFiles: ModifiedFileInfo[] = [
        {
          path: '.github/prompts/test.prompt.md',
          originalChecksum: 'abc123',
          currentChecksum: 'def456',
          modificationType: 'modified'
        }
      ];
      const bundleRepoUrl = 'https://github.com/owner/repo';
      showWarningMessageStub.resolves('Contribute Changes');
      openExternalStub.rejects(new Error('Failed to open URL'));

      // Act
      const result = await service.showWarningDialog(bundleId, modifiedFiles, bundleRepoUrl);

      // Assert - should still return contribute even if URL fails to open
      assert.strictEqual(result, 'contribute', 'Should return contribute action even if URL fails');
    });
  });
});
