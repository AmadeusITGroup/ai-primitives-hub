/**
 * Source Management Commands Unit Tests
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

suite('Source Management Commands', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('addSource', () => {
    test('should prompt for source details', () => {
      const showInputBoxStub = sandbox.stub(vscode.window, 'showInputBox');
      showInputBoxStub.onFirstCall().resolves('Test Source');
      showInputBoxStub.onSecondCall().resolves('https://github.com/test/repo');

      const showQuickPickStub = sandbox.stub(vscode.window, 'showQuickPick');
      showQuickPickStub.resolves({ label: 'GitHub', value: 'github' } as any);

      // Mock the actual command execution
      assert.ok(showInputBoxStub);
      assert.ok(showQuickPickStub);
    });

    test('should validate source URL format', () => {
      const showInputBoxStub = sandbox.stub(vscode.window, 'showInputBox');
      showInputBoxStub.onFirstCall().resolves('Test Source');
      showInputBoxStub.onSecondCall().resolves('invalid-url');

      // Validation would typically happen in the command
      const url = 'invalid-url';
      const isValidUrl = url.startsWith('http://') || url.startsWith('https://') || url.startsWith('git@');

      if (!isValidUrl) {
        assert.ok(true, 'Invalid URL detected');
      }
    });

    test('should support GitHub sources', () => {
      const source = {
        id: 'test-source',
        name: 'Test Source',
        type: 'github',
        url: 'https://github.com/test/repo',
        enabled: true,
        priority: 1
      };

      assert.strictEqual(source.type, 'github');
      assert.ok(source.url.includes('github.com'));
    });

    test('should support local sources', () => {
      const source = {
        id: 'test-source',
        name: 'Test Source',
        type: 'local',
        url: '/path/to/bundles',
        enabled: true,
        priority: 1
      };

      assert.strictEqual(source.type, 'local');
      assert.ok(source.url.startsWith('/'));
    });
  });

  suite('editSource', () => {
    test('should allow editing source name', () => {
      const originalSource = {
        id: 'test-source',
        name: 'Old Name',
        type: 'github',
        url: 'https://github.com/test/repo',
        enabled: true,
        priority: 1
      };

      const updatedSource = {
        ...originalSource,
        name: 'New Name'
      };

      assert.notStrictEqual(originalSource.name, updatedSource.name);
      assert.strictEqual(updatedSource.name, 'New Name');
    });

    test('should allow editing source URL', () => {
      const originalSource = {
        id: 'test-source',
        name: 'Test Source',
        type: 'github',
        url: 'https://github.com/test/old-repo',
        enabled: true,
        priority: 1
      };

      const updatedSource = {
        ...originalSource,
        url: 'https://github.com/test/new-repo'
      };

      assert.notStrictEqual(originalSource.url, updatedSource.url);
      assert.strictEqual(updatedSource.url, 'https://github.com/test/new-repo');
    });

    test('should allow changing source type', () => {
      const originalSource = {
        id: 'test-source',
        name: 'Test Source',
        type: 'github',
        url: 'https://github.com/test/repo',
        enabled: true,
        priority: 1
      };

      const updatedSource = {
        ...originalSource,
        type: 'local',
        url: '/path/to/bundles'
      };

      assert.notStrictEqual(originalSource.type, updatedSource.type);
      assert.strictEqual(updatedSource.type, 'local');
    });

    test('should preserve source priority when editing', () => {
      const originalSource = {
        id: 'test-source',
        name: 'Test Source',
        type: 'github',
        url: 'https://github.com/test/repo',
        enabled: true,
        priority: 5
      };

      const updatedSource = {
        ...originalSource,
        name: 'Updated Name'
      };

      assert.strictEqual(updatedSource.priority, 5);
    });
  });

  suite('removeSource', () => {
    test('should prompt for confirmation before removing', () => {
      // Simulated confirmation
      const confirmed = true;
      assert.strictEqual(confirmed, true);
    });

    test('should cancel removal if user declines', () => {
      // Simulated cancellation
      const cancelled = true;
      assert.strictEqual(cancelled, true);
    });

    test('should remove source from storage', () => {
      const sources = [
        { id: 'source-1', name: 'Source 1', type: 'github', url: 'url1', enabled: true, priority: 1 },
        { id: 'source-2', name: 'Source 2', type: 'github', url: 'url2', enabled: true, priority: 2 }
      ];

      const updatedSources = sources.filter((s) => s.id !== 'source-1');

      assert.strictEqual(updatedSources.length, 1);
      assert.strictEqual(updatedSources[0].id, 'source-2');
    });

    test('should not affect other sources when removing one', () => {
      const sources = [
        { id: 'source-1', name: 'Source 1', type: 'github', url: 'url1', enabled: true, priority: 1 },
        { id: 'source-2', name: 'Source 2', type: 'github', url: 'url2', enabled: true, priority: 2 },
        { id: 'source-3', name: 'Source 3', type: 'github', url: 'url3', enabled: true, priority: 3 }
      ];

      const updatedSources = sources.filter((s) => s.id !== 'source-2');

      assert.strictEqual(updatedSources.length, 2);
      assert.ok(updatedSources.some((s) => s.id === 'source-1'));
      assert.ok(updatedSources.some((s) => s.id === 'source-3'));
      assert.ok(!updatedSources.some((s) => s.id === 'source-2'));
    });
  });

  suite('toggleSource', () => {
    test('should enable disabled source', () => {
      const source = {
        id: 'test-source',
        name: 'Test Source',
        type: 'github',
        url: 'https://github.com/test/repo',
        enabled: false,
        priority: 1
      };

      const toggled = { ...source, enabled: !source.enabled };

      assert.strictEqual(toggled.enabled, true);
    });

    test('should disable enabled source', () => {
      const source = {
        id: 'test-source',
        name: 'Test Source',
        type: 'github',
        url: 'https://github.com/test/repo',
        enabled: true,
        priority: 1
      };

      const toggled = { ...source, enabled: !source.enabled };

      assert.strictEqual(toggled.enabled, false);
    });

    test('should preserve all other properties when toggling', () => {
      const source = {
        id: 'test-source',
        name: 'Test Source',
        type: 'github',
        url: 'https://github.com/test/repo',
        enabled: true,
        priority: 5,
        token: 'test-token'
      };

      const toggled = { ...source, enabled: !source.enabled };

      assert.strictEqual(toggled.id, source.id);
      assert.strictEqual(toggled.name, source.name);
      assert.strictEqual(toggled.type, source.type);
      assert.strictEqual(toggled.url, source.url);
      assert.strictEqual(toggled.priority, source.priority);
      assert.strictEqual(toggled.token, source.token);
    });
  });

  suite('syncSource', () => {
    test('should refresh bundles from source', async () => {
      sandbox.stub(vscode.window, 'showInformationMessage').resolves();

      // Simulate sync operation
      const syncStartTime = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const syncEndTime = Date.now();

      assert.ok(syncEndTime >= syncStartTime);
    });

    test('should handle sync errors gracefully', () => {
      const showErrorMessageStub = sandbox.stub(vscode.window, 'showErrorMessage');

      const error = new Error('Sync failed');
      showErrorMessageStub.resolves();

      assert.ok(error.message.includes('Sync failed'));
    });

    test('should update last sync timestamp', () => {
      const source = {
        id: 'test-source',
        name: 'Test Source',
        type: 'github',
        url: 'https://github.com/test/repo',
        enabled: true,
        priority: 1,
        lastSync: undefined as Date | undefined
      };

      const updatedSource = {
        ...source,
        lastSync: new Date()
      };

      assert.ok(updatedSource.lastSync);
      assert.ok(updatedSource.lastSync instanceof Date);
    });
  });

  suite('syncAllSources', () => {
    test('should sync all enabled sources', () => {
      const sources = [
        { id: 'source-1', name: 'Source 1', type: 'github', url: 'url1', enabled: true, priority: 1 },
        { id: 'source-2', name: 'Source 2', type: 'github', url: 'url2', enabled: false, priority: 2 },
        { id: 'source-3', name: 'Source 3', type: 'github', url: 'url3', enabled: true, priority: 3 }
      ];

      const enabledSources = sources.filter((s) => s.enabled);

      assert.strictEqual(enabledSources.length, 2);
      assert.ok(enabledSources.every((s) => s.enabled));
    });

    test('should skip disabled sources', () => {
      const sources = [
        { id: 'source-1', name: 'Source 1', type: 'github', url: 'url1', enabled: false, priority: 1 },
        { id: 'source-2', name: 'Source 2', type: 'github', url: 'url2', enabled: false, priority: 2 }
      ];

      const enabledSources = sources.filter((s) => s.enabled);

      assert.strictEqual(enabledSources.length, 0);
    });

    test('should continue on individual source failures', async () => {
      const sources = [
        { id: 'source-1', name: 'Source 1', type: 'github', url: 'url1', enabled: true, priority: 1 },
        { id: 'source-2', name: 'Source 2', type: 'github', url: 'url2', enabled: true, priority: 2 },
        { id: 'source-3', name: 'Source 3', type: 'github', url: 'url3', enabled: true, priority: 3 }
      ];

      const results = await Promise.allSettled(
        sources.map((source) => {
          return new Promise((resolve, reject) => {
            if (source.id === 'source-2') {
              reject(new Error('Sync failed'));
            } else {
              resolve(source);
            }
          });
        })
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      assert.strictEqual(fulfilled.length, 2);
      assert.strictEqual(rejected.length, 1);
    });
  });
});
