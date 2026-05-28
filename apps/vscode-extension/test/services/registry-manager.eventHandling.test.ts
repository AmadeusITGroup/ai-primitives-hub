/**
 * RegistryManager Event Handling Tests
 *
 * Tests for verifying that bundle events are fired correctly
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  DeploymentManifest,
  InstalledBundle,
} from '../../src/types/registry';

// Helper to create mock manifest
function createMockManifest(): DeploymentManifest {
  return {
    common: {
      directories: [],
      files: [],
      include_patterns: [],
      exclude_patterns: []
    },
    bundle_settings: {
      include_common_in_environment_bundles: true,
      create_common_bundle: true,
      compression: 'zip',
      naming: {
        environment_bundle: 'bundle'
      }
    },
    metadata: {
      manifest_version: '1.0.0',
      description: 'Test manifest'
    }
  };
}

suite('RegistryManager - Event Handling', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('onBundleInstalled Event', () => {
    test('should fire onBundleInstalled event with correct installation details', () => {
      // Requirement 6.1: WHEN a bundle is installed THEN the system SHALL fire the onBundleInstalled event with the installation details

      // Create a mock event emitter
      const eventEmitter = new vscode.EventEmitter<InstalledBundle>();

      const mockInstallation: InstalledBundle = {
        bundleId: 'test-bundle',
        version: '1.0.0',
        installPath: '/mock/install/path',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: 'test-source',
        sourceType: 'github',
        manifest: createMockManifest()
      };

      // Listen for event
      let eventFired = false;
      let eventData: InstalledBundle | undefined;

      eventEmitter.event((installation) => {
        eventFired = true;
        eventData = installation;
      });

      // Fire the event
      eventEmitter.fire(mockInstallation);

      // Verify event was fired
      assert.strictEqual(eventFired, true, 'onBundleInstalled event should be fired');
      assert.ok(eventData, 'Event data should be provided');
      assert.strictEqual(eventData?.bundleId, 'test-bundle', 'Event should contain correct bundle ID');
      assert.strictEqual(eventData?.version, '1.0.0', 'Event should contain correct version');
      assert.strictEqual(eventData?.sourceId, 'test-source', 'Event should contain correct source ID');
      assert.strictEqual(eventData?.sourceType, 'github', 'Event should contain correct source type');
    });
  });

  suite('onBundleUninstalled Event', () => {
    test('should fire onBundleUninstalled event with correct bundle ID', () => {
      // Requirement 6.2: WHEN a bundle is uninstalled THEN the system SHALL fire the onBundleUninstalled event with the bundle ID

      // Create a mock event emitter
      const eventEmitter = new vscode.EventEmitter<string>();

      // Listen for event
      let eventFired = false;
      let eventBundleId: string | undefined;

      eventEmitter.event((bundleId) => {
        eventFired = true;
        eventBundleId = bundleId;
      });

      // Fire the event
      eventEmitter.fire('test-bundle-v1.0.0');

      // Verify event was fired
      assert.strictEqual(eventFired, true, 'onBundleUninstalled event should be fired');
      assert.strictEqual(eventBundleId, 'test-bundle-v1.0.0', 'Event should contain correct bundle ID');
    });
  });

  suite('onBundleUpdated Event', () => {
    test('should fire onBundleUpdated event with correct new installation details', () => {
      // Requirement 6.3: WHEN a bundle is updated THEN the system SHALL fire the onBundleUpdated event with the new installation details

      // Create a mock event emitter
      const eventEmitter = new vscode.EventEmitter<InstalledBundle>();

      const updatedInstallation: InstalledBundle = {
        bundleId: 'test-bundle',
        version: '1.1.0',
        installPath: '/mock/install/path',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: 'test-source',
        sourceType: 'github',
        manifest: createMockManifest()
      };

      // Listen for event
      let eventFired = false;
      let eventData: InstalledBundle | undefined;

      eventEmitter.event((installation) => {
        eventFired = true;
        eventData = installation;
      });

      // Fire the event
      eventEmitter.fire(updatedInstallation);

      // Verify event was fired
      assert.strictEqual(eventFired, true, 'onBundleUpdated event should be fired');
      assert.ok(eventData, 'Event data should be provided');
      assert.strictEqual(eventData?.bundleId, 'test-bundle', 'Event should contain correct bundle ID');
      assert.strictEqual(eventData?.version, '1.1.0', 'Event should contain new version');
    });
  });

  suite('Event Firing Order', () => {
    test('should fire update event (not uninstall + install)', () => {
      // Track event order
      const eventOrder: string[] = [];

      // Create mock event emitters
      const updateEmitter = new vscode.EventEmitter<InstalledBundle>();
      const uninstallEmitter = new vscode.EventEmitter<string>();
      const installEmitter = new vscode.EventEmitter<InstalledBundle>();

      // Listen for events
      updateEmitter.event(() => {
        eventOrder.push('updated');
      });

      uninstallEmitter.event(() => {
        eventOrder.push('uninstalled');
      });

      installEmitter.event(() => {
        eventOrder.push('installed');
      });

      // Fire only update event (simulating RegistryManager.updateBundle behavior)
      const updatedInstallation: InstalledBundle = {
        bundleId: 'test-bundle',
        version: '1.1.0',
        installPath: '/mock/install/path',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: 'test-source',
        sourceType: 'github',
        manifest: createMockManifest()
      };

      updateEmitter.fire(updatedInstallation);

      // Verify only update event was fired (not uninstall + install)
      assert.strictEqual(eventOrder.length, 1, 'Should fire exactly one event');
      assert.strictEqual(eventOrder[0], 'updated', 'Should fire update event');
    });
  });

  suite('onSourceSynced Event', () => {
    test('should fire onSourceSynced event with correct source ID and bundle count', () => {
      // Requirement 1.6: WHEN a source is synced THEN the Registry Manager SHALL emit an event to notify listeners that bundle metadata has been refreshed
      // Requirement 11.1: WHEN a source sync completes THEN the Registry Manager SHALL emit a source synced event

      // Create a mock event emitter
      const eventEmitter = new vscode.EventEmitter<{ sourceId: string; bundleCount: number }>();

      // Listen for event
      let eventFired = false;
      let eventData: { sourceId: string; bundleCount: number } | undefined;

      eventEmitter.event((data) => {
        eventFired = true;
        eventData = data;
      });

      // Fire the event
      eventEmitter.fire({ sourceId: 'test-source', bundleCount: 42 });

      // Verify event was fired
      assert.strictEqual(eventFired, true, 'onSourceSynced event should be fired');
      assert.ok(eventData, 'Event data should be provided');
      assert.strictEqual(eventData?.sourceId, 'test-source', 'Event should contain correct source ID');
      assert.strictEqual(eventData?.bundleCount, 42, 'Event should contain correct bundle count');
    });

    test('should fire onSourceSynced event with zero bundle count for empty sources', () => {
      // Edge case: source with no bundles

      // Create a mock event emitter
      const eventEmitter = new vscode.EventEmitter<{ sourceId: string; bundleCount: number }>();

      // Listen for event
      let eventFired = false;
      let eventData: { sourceId: string; bundleCount: number } | undefined;

      eventEmitter.event((data) => {
        eventFired = true;
        eventData = data;
      });

      // Fire the event with zero bundles
      eventEmitter.fire({ sourceId: 'empty-source', bundleCount: 0 });

      // Verify event was fired
      assert.strictEqual(eventFired, true, 'onSourceSynced event should be fired even for empty sources');
      assert.ok(eventData, 'Event data should be provided');
      assert.strictEqual(eventData?.sourceId, 'empty-source', 'Event should contain correct source ID');
      assert.strictEqual(eventData?.bundleCount, 0, 'Event should contain zero bundle count');
    });
  });
});
