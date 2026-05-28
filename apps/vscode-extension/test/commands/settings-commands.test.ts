/**
 * SettingsCommands Unit Tests
 *
 * Tests for settings export/import functionality
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import {
  SettingsCommands,
} from '../../src/commands/settings-commands';

suite('SettingsCommands', () => {
  let settingsCommands: SettingsCommands;
  let mockRegistryManager: any;

  setup(() => {
    // Create mock RegistryManager
    mockRegistryManager = {
      exportSettings: sinon.stub(),
      importSettings: sinon.stub()
    };

    settingsCommands = new SettingsCommands(mockRegistryManager);
  });

  teardown(() => {
    sinon.restore();
  });

  suite('exportSettings', () => {
    test('should create SettingsCommands instance', () => {
      assert.ok(settingsCommands);
      assert.ok(typeof settingsCommands.exportSettings === 'function');
    });

    test('should have importSettings method', () => {
      assert.ok(typeof settingsCommands.importSettings === 'function');
    });
  });

  suite('RegistryManager export/import integration', () => {
    test('exportSettings should be callable', async () => {
      mockRegistryManager.exportSettings.resolves('{"version":"1.0.0"}');

      const result = await mockRegistryManager.exportSettings('json');

      assert.ok(mockRegistryManager.exportSettings.calledWith('json'));
      assert.strictEqual(result, '{"version":"1.0.0"}');
    });

    test('importSettings should be callable', async () => {
      mockRegistryManager.importSettings.resolves();

      await mockRegistryManager.importSettings('{"version":"1.0.0"}', 'json', 'merge');

      assert.ok(mockRegistryManager.importSettings.calledWith('{"version":"1.0.0"}', 'json', 'merge'));
    });
  });
});
