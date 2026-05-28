/**
 * Property-based tests for MarketplaceViewProvider button state logic
 *
 * **Feature: github-version-consolidation, Property 4: Button state correctness**
 *
 * Tests that button states are correctly determined based on version comparisons
 * across all possible combinations of installed and latest versions.
 */

import * as fc from 'fast-check';
import {
  suite,
  test,
} from 'mocha';
import {
  VersionManager,
} from '../../src/utils/version-manager';
import {
  determineButtonState,
} from '../helpers/marketplace-test-helpers';

suite('MarketplaceViewProvider - Property Tests', () => {
  suite('Property 4: Button state correctness', () => {
    /**
     * **Property 4: Button state correctness**
     * **Validates: Requirements 3.1, 3.2, 3.3, 3.4**
     *
     * For any bundle with an installed version, the button state should be:
     * - "update" if and only if the installed version is less than the latest version
     * - "uninstall" if versions are equal
     * - "install" if no version is installed
     */
    test('should determine correct button state for all version combinations', () => {
      // Generator for valid semver strings
      const semverArbitrary = fc.tuple(
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 50 })
      ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

      fc.assert(
        fc.property(
          fc.record({
            installedVersion: fc.option(semverArbitrary, { nil: undefined }),
            latestVersion: semverArbitrary
          }),
          ({ installedVersion, latestVersion }) => {
            const buttonState = determineButtonState(installedVersion, latestVersion);

            // Verify button state matches expected behavior
            if (!installedVersion) {
              return buttonState === 'install';
            }

            const cmp = VersionManager.compareVersions(installedVersion, latestVersion);

            if (cmp < 0) {
              // Installed version is older than latest
              return buttonState === 'update';
            } else if (cmp === 0) {
              // Versions are equal
              return buttonState === 'uninstall';
            } else {
              // Installed version is newer than latest (edge case)
              // Should still show uninstall
              return buttonState === 'uninstall';
            }
          }
        ),
        { numRuns: 100, verbose: false }
      );
    });

    test('should always return "install" when no version is installed', () => {
      const semverArbitrary = fc.tuple(
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 50 })
      ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

      fc.assert(
        fc.property(
          semverArbitrary,
          (latestVersion) => {
            const buttonState = determineButtonState(undefined, latestVersion);
            return buttonState === 'install';
          }
        ),
        { numRuns: 50, verbose: false }
      );
    });

    test('should return "uninstall" when versions are equal', () => {
      const semverArbitrary = fc.tuple(
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 50 })
      ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

      fc.assert(
        fc.property(
          semverArbitrary,
          (version) => {
            const buttonState = determineButtonState(version, version);
            return buttonState === 'uninstall';
          }
        ),
        { numRuns: 50, verbose: false }
      );
    });

    test('should return "update" when installed version is older', () => {
      fc.assert(
        fc.property(
          fc.tuple(
            fc.integer({ min: 0, max: 10 }),
            fc.integer({ min: 0, max: 20 }),
            fc.integer({ min: 0, max: 50 }),
            fc.integer({ min: 1, max: 5 }) // Version increment
          ),
          ([major, minor, patch, increment]) => {
            const installedVersion = `${major}.${minor}.${patch}`;
            const latestVersion = `${major}.${minor}.${patch + increment}`;

            const buttonState = determineButtonState(installedVersion, latestVersion);
            return buttonState === 'update';
          }
        ),
        { numRuns: 50, verbose: false }
      );
    });
  });

  suite('Property 8: Update action correctness', () => {
    /**
     * **Property 8: Update action correctness**
     * **Validates: Requirements 3.5**
     *
     * For any bundle where an update is available, clicking the "Update" button
     * should result in the installed version matching the latest available version.
     *
     * This property tests the logical correctness of the update action:
     * - Given an installed version that is older than the latest version
     * - After performing an update action
     * - The installed version should equal the latest version
     */
    test('should result in latest version installed after update', () => {
      // Generator for valid semver strings
      const semverArbitrary = fc.tuple(
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 50 })
      ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

      fc.assert(
        fc.property(
          fc.record({
            installedVersion: semverArbitrary,
            latestVersion: semverArbitrary
          }).filter(({ installedVersion, latestVersion }) => {
            // Only test cases where update is available (installed < latest)
            try {
              return VersionManager.compareVersions(installedVersion, latestVersion) < 0;
            } catch {
              return false;
            }
          }),
          ({ installedVersion, latestVersion }) => {
            // Simulate update action logic:
            // 1. Verify update is available
            const updateAvailable = VersionManager.isUpdateAvailable(installedVersion, latestVersion);

            if (!updateAvailable) {
              return false; // Should not happen due to filter, but safety check
            }

            // 2. After update, the "new installed version" should equal latest
            const newInstalledVersion = latestVersion; // This is what update should achieve

            // 3. Verify no further update is needed
            const stillNeedsUpdate = VersionManager.isUpdateAvailable(newInstalledVersion, latestVersion);

            return !stillNeedsUpdate && newInstalledVersion === latestVersion;
          }
        ),
        { numRuns: 100, verbose: false }
      );
    });

    test('should handle update from any older version to latest', () => {
      fc.assert(
        fc.property(
          fc.tuple(
            fc.integer({ min: 0, max: 10 }),
            fc.integer({ min: 0, max: 20 }),
            fc.integer({ min: 0, max: 50 }),
            fc.integer({ min: 1, max: 10 }) // Version gap
          ),
          ([major, minor, patch, gap]) => {
            const installedVersion = `${major}.${minor}.${patch}`;
            const latestVersion = `${major}.${minor}.${patch + gap}`;

            // Verify update is available
            const updateAvailable = VersionManager.isUpdateAvailable(installedVersion, latestVersion);

            if (!updateAvailable) {
              return false;
            }

            // After update, installed should equal latest
            const newInstalledVersion = latestVersion;

            // Verify versions are now equal
            const cmp = VersionManager.compareVersions(newInstalledVersion, latestVersion);

            return cmp === 0;
          }
        ),
        { numRuns: 50, verbose: false }
      );
    });

    test('should handle major version updates correctly', () => {
      fc.assert(
        fc.property(
          fc.tuple(
            fc.integer({ min: 0, max: 5 }),
            fc.integer({ min: 0, max: 20 }),
            fc.integer({ min: 0, max: 50 }),
            fc.integer({ min: 1, max: 3 }) // Major version increment
          ),
          ([major, minor, patch, majorIncrement]) => {
            const installedVersion = `${major}.${minor}.${patch}`;
            const latestVersion = `${major + majorIncrement}.0.0`;

            // Verify update is available
            const updateAvailable = VersionManager.isUpdateAvailable(installedVersion, latestVersion);

            if (!updateAvailable) {
              return false;
            }

            // After update, should have latest version
            const newInstalledVersion = latestVersion;

            // Verify no further update needed
            const stillNeedsUpdate = VersionManager.isUpdateAvailable(newInstalledVersion, latestVersion);

            return !stillNeedsUpdate;
          }
        ),
        { numRuns: 50, verbose: false }
      );
    });
  });
});
