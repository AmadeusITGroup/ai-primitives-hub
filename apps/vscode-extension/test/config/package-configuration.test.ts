/**
 * Package Configuration Tests
 *
 * Tests for validating configuration settings in package.json
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

suite('Package Configuration - Update Check Settings', () => {
  let packageJson: any;

  setup(() => {
    // Load package.json
    const packagePath = path.join(process.cwd(), 'package.json');
    const packageContent = fs.readFileSync(packagePath, 'utf8');
    packageJson = JSON.parse(packageContent);
  });

  suite('Configuration Schema Structure', () => {
    test('should prefer workspace extension host for remote environments', () => {
      assert.ok(Array.isArray(packageJson.extensionKind), 'package.json should define extensionKind array');
      assert.ok(packageJson.extensionKind.includes('workspace'), 'extensionKind should include workspace');
      assert.ok(packageJson.extensionKind.includes('ui'), 'extensionKind should include ui fallback');
      assert.strictEqual(
        packageJson.extensionKind[0],
        'workspace',
        'workspace should be first so WSL/remote sessions run repository file operations in the remote host'
      );
    });

    test('should have configuration section', () => {
      assert.ok(packageJson.contributes, 'package.json should have contributes section');
      assert.ok(packageJson.contributes.configuration, 'contributes should have configuration section');
      assert.ok(packageJson.contributes.configuration.properties, 'configuration should have properties');
    });

    test('should have updateCheck.enabled setting', () => {
      const setting = packageJson.contributes.configuration.properties['promptregistry.updateCheck.enabled'];

      assert.ok(setting, 'updateCheck.enabled setting should exist');
      assert.strictEqual(setting.type, 'boolean', 'updateCheck.enabled should be boolean type');
      assert.ok(setting.description, 'updateCheck.enabled should have description');
    });

    test('should have updateCheck.frequency setting', () => {
      const setting = packageJson.contributes.configuration.properties['promptregistry.updateCheck.frequency'];

      assert.ok(setting, 'updateCheck.frequency setting should exist');
      assert.strictEqual(setting.type, 'string', 'updateCheck.frequency should be string type');
      assert.ok(setting.description, 'updateCheck.frequency should have description');
    });

    test('should have updateCheck.notificationPreference setting', () => {
      const setting = packageJson.contributes.configuration.properties['promptregistry.updateCheck.notificationPreference'];

      assert.ok(setting, 'updateCheck.notificationPreference setting should exist');
      assert.strictEqual(setting.type, 'string', 'updateCheck.notificationPreference should be string type');
      assert.ok(setting.description, 'updateCheck.notificationPreference should have description');
    });

    test('should have updateCheck.autoUpdate setting', () => {
      const setting = packageJson.contributes.configuration.properties['promptregistry.updateCheck.autoUpdate'];

      assert.ok(setting, 'updateCheck.autoUpdate setting should exist');
      assert.strictEqual(setting.type, 'boolean', 'updateCheck.autoUpdate should be boolean type');
      assert.ok(setting.description, 'updateCheck.autoUpdate should have description');
    });
  });

  suite('Default Values', () => {
    test('updateCheck.enabled should default to true', () => {
      const setting = packageJson.contributes.configuration.properties['promptregistry.updateCheck.enabled'];
      assert.strictEqual(setting.default, true, 'updateCheck.enabled should default to true');
    });

    test('updateCheck.frequency should default to "daily"', () => {
      const setting = packageJson.contributes.configuration.properties['promptregistry.updateCheck.frequency'];
      assert.strictEqual(setting.default, 'daily', 'updateCheck.frequency should default to "daily"');
    });

    test('updateCheck.notificationPreference should default to "all"', () => {
      const setting = packageJson.contributes.configuration.properties['promptregistry.updateCheck.notificationPreference'];
      assert.strictEqual(setting.default, 'all', 'updateCheck.notificationPreference should default to "all"');
    });

    test('updateCheck.autoUpdate should default to false', () => {
      const setting = packageJson.contributes.configuration.properties['promptregistry.updateCheck.autoUpdate'];
      assert.strictEqual(setting.default, false, 'updateCheck.autoUpdate should default to false');
    });
  });

  suite('Enum Options', () => {
    test('updateCheck.frequency should have correct enum values', () => {
      const setting = packageJson.contributes.configuration.properties['promptregistry.updateCheck.frequency'];

      assert.ok(Array.isArray(setting.enum), 'updateCheck.frequency should have enum array');
      assert.strictEqual(setting.enum.length, 3, 'updateCheck.frequency should have 3 enum values');
      assert.ok(setting.enum.includes('daily'), 'enum should include "daily"');
      assert.ok(setting.enum.includes('weekly'), 'enum should include "weekly"');
      assert.ok(setting.enum.includes('manual'), 'enum should include "manual"');
    });

    test('updateCheck.notificationPreference should have correct enum values', () => {
      const setting = packageJson.contributes.configuration.properties['promptregistry.updateCheck.notificationPreference'];

      assert.ok(Array.isArray(setting.enum), 'updateCheck.notificationPreference should have enum array');
      assert.strictEqual(setting.enum.length, 3, 'updateCheck.notificationPreference should have 3 enum values');
      assert.ok(setting.enum.includes('all'), 'enum should include "all"');
      assert.ok(setting.enum.includes('critical'), 'enum should include "critical"');
      assert.ok(setting.enum.includes('none'), 'enum should include "none"');
    });
  });
});
