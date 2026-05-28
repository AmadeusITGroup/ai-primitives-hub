/**
 * Tests for configuration type guards
 */

import * as assert from 'node:assert';
import {
  getValidNotificationPreference,
  getValidUpdateCheckFrequency,
  isValidNotificationPreference,
  isValidUpdateCheckFrequency,
} from '../../src/utils/config-type-guards';

suite('configTypeGuards', () => {
  suite('isValidUpdateCheckFrequency()', () => {
    test('should return true for "daily"', () => {
      assert.strictEqual(isValidUpdateCheckFrequency('daily'), true);
    });

    test('should return true for "weekly"', () => {
      assert.strictEqual(isValidUpdateCheckFrequency('weekly'), true);
    });

    test('should return true for "manual"', () => {
      assert.strictEqual(isValidUpdateCheckFrequency('manual'), true);
    });

    test('should return false for invalid string', () => {
      assert.strictEqual(isValidUpdateCheckFrequency('hourly'), false);
      assert.strictEqual(isValidUpdateCheckFrequency('monthly'), false);
      assert.strictEqual(isValidUpdateCheckFrequency(''), false);
    });

    test('should return false for non-string values', () => {
      assert.strictEqual(isValidUpdateCheckFrequency(123), false);
      assert.strictEqual(isValidUpdateCheckFrequency(true), false);
      assert.strictEqual(isValidUpdateCheckFrequency(null), false);
      assert.strictEqual(isValidUpdateCheckFrequency(undefined), false);
      assert.strictEqual(isValidUpdateCheckFrequency({}), false);
      assert.strictEqual(isValidUpdateCheckFrequency([]), false);
    });
  });

  suite('isValidNotificationPreference()', () => {
    test('should return true for "all"', () => {
      assert.strictEqual(isValidNotificationPreference('all'), true);
    });

    test('should return true for "critical"', () => {
      assert.strictEqual(isValidNotificationPreference('critical'), true);
    });

    test('should return true for "none"', () => {
      assert.strictEqual(isValidNotificationPreference('none'), true);
    });

    test('should return false for invalid string', () => {
      assert.strictEqual(isValidNotificationPreference('some'), false);
      assert.strictEqual(isValidNotificationPreference('important'), false);
      assert.strictEqual(isValidNotificationPreference(''), false);
    });

    test('should return false for non-string values', () => {
      assert.strictEqual(isValidNotificationPreference(123), false);
      assert.strictEqual(isValidNotificationPreference(true), false);
      assert.strictEqual(isValidNotificationPreference(null), false);
      assert.strictEqual(isValidNotificationPreference(undefined), false);
      assert.strictEqual(isValidNotificationPreference({}), false);
      assert.strictEqual(isValidNotificationPreference([]), false);
    });
  });

  suite('getValidUpdateCheckFrequency()', () => {
    test('should return valid frequency unchanged', () => {
      assert.strictEqual(getValidUpdateCheckFrequency('daily'), 'daily');
      assert.strictEqual(getValidUpdateCheckFrequency('weekly'), 'weekly');
      assert.strictEqual(getValidUpdateCheckFrequency('manual'), 'manual');
    });

    test('should return default "daily" for invalid values', () => {
      assert.strictEqual(getValidUpdateCheckFrequency('hourly'), 'daily');
      assert.strictEqual(getValidUpdateCheckFrequency(''), 'daily');
      assert.strictEqual(getValidUpdateCheckFrequency(123), 'daily');
      assert.strictEqual(getValidUpdateCheckFrequency(null), 'daily');
      assert.strictEqual(getValidUpdateCheckFrequency(undefined), 'daily');
    });

    test('should use custom default when provided', () => {
      assert.strictEqual(getValidUpdateCheckFrequency('invalid', 'weekly'), 'weekly');
      assert.strictEqual(getValidUpdateCheckFrequency(null, 'manual'), 'manual');
    });
  });

  suite('getValidNotificationPreference()', () => {
    test('should return valid preference unchanged', () => {
      assert.strictEqual(getValidNotificationPreference('all'), 'all');
      assert.strictEqual(getValidNotificationPreference('critical'), 'critical');
      assert.strictEqual(getValidNotificationPreference('none'), 'none');
    });

    test('should return default "all" for invalid values', () => {
      assert.strictEqual(getValidNotificationPreference('some'), 'all');
      assert.strictEqual(getValidNotificationPreference(''), 'all');
      assert.strictEqual(getValidNotificationPreference(123), 'all');
      assert.strictEqual(getValidNotificationPreference(null), 'all');
      assert.strictEqual(getValidNotificationPreference(undefined), 'all');
    });

    test('should use custom default when provided', () => {
      assert.strictEqual(getValidNotificationPreference('invalid', 'critical'), 'critical');
      assert.strictEqual(getValidNotificationPreference(null, 'none'), 'none');
    });
  });
});
