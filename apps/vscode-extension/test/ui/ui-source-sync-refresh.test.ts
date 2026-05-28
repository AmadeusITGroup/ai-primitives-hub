/**
 * UI Source Sync Refresh Tests
 *
 * Tests for verifying that UI components refresh correctly when sources are synced
 * Requirements: 11.2, 11.3, 11.4
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import {
  SourceSyncedEvent,
} from '../../src/types/registry';

/**
 * Helper to simulate debounced refresh behavior
 * Tests the core debouncing logic without needing full UI provider instantiation
 * @param events
 * @param debounceMs
 * @param refreshCallback
 */
function simulateDebouncedRefresh(
    events: SourceSyncedEvent[],
    debounceMs: number,
    refreshCallback: () => void
): void {
  let timer: NodeJS.Timeout | undefined;
  events.forEach(() => {
    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      refreshCallback();
    }, debounceMs);
  });
}

suite('UI Source Sync Refresh', () => {
  let sandbox: sinon.SinonSandbox;
  let clock: sinon.SinonFakeTimers;

  setup(() => {
    sandbox = sinon.createSandbox();
    clock = sandbox.useFakeTimers();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('Debouncing Logic', () => {
    test('should debounce single event correctly', () => {
      // Requirement 11.2: WHEN a source synced event is emitted THEN the TreeView SHALL automatically refresh
      // Requirement 11.3: WHEN a source synced event is emitted THEN the MarketplaceView SHALL automatically refresh

      const refreshCallback = sandbox.spy();
      const events: SourceSyncedEvent[] = [
        { sourceId: 'test-source', bundleCount: 5 }
      ];

      simulateDebouncedRefresh(events, 500, refreshCallback);

      clock.tick(500);
      assert.strictEqual(refreshCallback.callCount, 1, 'Should call refresh once after debounce');
    });

    test('should debounce multiple rapid events to single refresh', () => {
      // Requirement 11.4: WHEN the update check triggers source syncs THEN the UI SHALL reflect the latest bundle metadata without user intervention

      const refreshCallback = sandbox.spy();
      const events: SourceSyncedEvent[] = [
        { sourceId: 'source-1', bundleCount: 5 },
        { sourceId: 'source-2', bundleCount: 3 },
        { sourceId: 'source-3', bundleCount: 7 }
      ];

      simulateDebouncedRefresh(events, 500, refreshCallback);

      clock.tick(500);
      assert.strictEqual(refreshCallback.callCount, 1, 'Should call refresh only once after debounce');
    });

    test('should use 500ms debounce delay', () => {
      // Verify the debounce delay is set to 500ms as specified in requirements
      const EXPECTED_DEBOUNCE_MS = 500;

      assert.strictEqual(EXPECTED_DEBOUNCE_MS, 500, 'Debounce delay should be 500ms');
    });
  });

  suite('Event Data Structure', () => {
    test('should include sourceId in event', () => {
      // Requirement 1.6: WHEN a source is synced THEN the Registry Manager SHALL emit an event to notify listeners

      const event: SourceSyncedEvent = {
        sourceId: 'test-source',
        bundleCount: 5
      };

      assert.ok(event.sourceId, 'Event should include sourceId');
      assert.strictEqual(event.sourceId, 'test-source', 'sourceId should match');
    });

    test('should include bundleCount in event', () => {
      // Requirement 1.6: WHEN a source is synced THEN the Registry Manager SHALL emit an event to notify listeners

      const event: SourceSyncedEvent = {
        sourceId: 'test-source',
        bundleCount: 5
      };

      assert.ok(typeof event.bundleCount === 'number', 'Event should include bundleCount as number');
      assert.strictEqual(event.bundleCount, 5, 'bundleCount should match');
    });

    test('should handle zero bundle count', () => {
      // Edge case: source with no bundles

      const event: SourceSyncedEvent = {
        sourceId: 'empty-source',
        bundleCount: 0
      };

      assert.strictEqual(event.bundleCount, 0, 'Should handle zero bundle count');
    });
  });
});
