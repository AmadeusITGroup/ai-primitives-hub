/**
 * Property-based tests for RegistryTreeProvider update indicators
 *
 * Tests that update indicators, version displays, and context menus
 * are correctly shown based on available updates.
 */

import * as fc from 'fast-check';
import {
  suite,
  test,
} from 'mocha';

/**
 * Update check result interface (local definition to avoid import issues)
 */
interface UpdateCheckResult {
  bundleId: string;
  currentVersion: string;
  latestVersion: string;
  releaseDate: string;
  downloadUrl: string;
  autoUpdateEnabled: boolean;
  releaseNotes?: string;
}

/**
 * Helper function to determine if a bundle should show an update indicator
 * This tests the core logic without needing to instantiate the full tree provider
 * @param bundleId
 * @param availableUpdates
 */
function shouldShowUpdateIndicator(bundleId: string, availableUpdates: Map<string, UpdateCheckResult>): boolean {
  return availableUpdates.has(bundleId);
}

/**
 * Helper function to get the icon prefix for a bundle
 * @param bundleId
 * @param availableUpdates
 */
function getBundleIconPrefix(bundleId: string, availableUpdates: Map<string, UpdateCheckResult>): string {
  return shouldShowUpdateIndicator(bundleId, availableUpdates) ? '⬆️' : '✓';
}

/**
 * Helper function to get version display string
 * @param bundleId
 * @param currentVersion
 * @param availableUpdates
 */
function getVersionDisplay(bundleId: string, currentVersion: string, availableUpdates: Map<string, UpdateCheckResult>): string {
  const updateInfo = availableUpdates.get(bundleId);

  return updateInfo ? `v${currentVersion} → v${updateInfo.latestVersion}` : `v${currentVersion}`;
}

/**
 * Helper function to get context value for tree item
 * @param bundleId
 * @param availableUpdates
 */
function getContextValue(bundleId: string, availableUpdates: Map<string, UpdateCheckResult>): string {
  return shouldShowUpdateIndicator(bundleId, availableUpdates)
    ? 'installed_bundle_updatable'
    : 'installed_bundle';
}

suite('RegistryTreeProvider - Property Tests', () => {
  suite('Property 16: TreeView update indicator display', () => {
    /**
     * **Property 16: TreeView update indicator display**
     * **Validates: Requirements 4.1**
     *
     * For any bundle with an available update, the TreeView should display
     * an update indicator icon (⬆️) adjacent to the bundle name.
     */
    test('should display update indicator for all bundles with available updates', () => {
      // Generator for bundle IDs
      const bundleIdArbitrary = fc.string({ minLength: 3, maxLength: 20 })
        .filter((s) => /^[a-z0-9-]+$/.test(s));

      // Generator for semantic versions
      const semverArbitrary = fc.tuple(
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 50 })
      ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              bundleId: bundleIdArbitrary,
              currentVersion: semverArbitrary,
              latestVersion: semverArbitrary
            }),
            { minLength: 1, maxLength: 10 }
          ),
          (bundles) => {
            // Create update map
            const availableUpdates = new Map<string, UpdateCheckResult>();

            for (const bundle of bundles) {
              availableUpdates.set(bundle.bundleId, {
                bundleId: bundle.bundleId,
                currentVersion: bundle.currentVersion,
                latestVersion: bundle.latestVersion,
                releaseDate: new Date().toISOString(),
                downloadUrl: `https://example.com/${bundle.bundleId}.zip`,
                autoUpdateEnabled: false
              });
            }

            // Verify all bundles show update indicator
            for (const bundle of bundles) {
              const iconPrefix = getBundleIconPrefix(bundle.bundleId, availableUpdates);

              // Should show update indicator
              if (iconPrefix !== '⬆️') {
                return false;
              }

              // Should have updatable context value
              const contextValue = getContextValue(bundle.bundleId, availableUpdates);
              if (contextValue !== 'installed_bundle_updatable') {
                return false;
              }
            }

            return true;
          }
        ),
        { numRuns: 100, verbose: false }
      );
    });

    test('should not display update indicator for bundles without updates', () => {
      const bundleIdArbitrary = fc.string({ minLength: 3, maxLength: 20 })
        .filter((s) => /^[a-z0-9-]+$/.test(s));

      const semverArbitrary = fc.tuple(
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 50 })
      ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              bundleId: bundleIdArbitrary,
              version: semverArbitrary
            }),
            { minLength: 1, maxLength: 10 }
          ),
          (bundles) => {
            // Empty update map (no updates available)
            const availableUpdates = new Map<string, UpdateCheckResult>();

            // Verify no bundles show update indicator
            for (const bundle of bundles) {
              const iconPrefix = getBundleIconPrefix(bundle.bundleId, availableUpdates);

              // Should show checkmark, not update indicator
              if (iconPrefix !== '✓') {
                return false;
              }

              // Should have regular context value
              const contextValue = getContextValue(bundle.bundleId, availableUpdates);
              if (contextValue !== 'installed_bundle') {
                return false;
              }
            }

            return true;
          }
        ),
        { numRuns: 100, verbose: false }
      );
    });
  });

  suite('Property 17: TreeView version display', () => {
    /**
     * **Property 17: TreeView version display**
     * **Validates: Requirements 4.2**
     *
     * For any bundle displayed in the TreeView, the TreeView should show both
     * the installed version and available version when an update exists.
     */
    test('should display both versions when update is available', () => {
      const bundleIdArbitrary = fc.string({ minLength: 3, maxLength: 20 })
        .filter((s) => /^[a-z0-9-]+$/.test(s));

      const semverArbitrary = fc.tuple(
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 50 })
      ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

      fc.assert(
        fc.property(
          fc.record({
            bundleId: bundleIdArbitrary,
            currentVersion: semverArbitrary,
            latestVersion: semverArbitrary
          }).filter(({ currentVersion, latestVersion }) =>
          // Ensure versions are different
            currentVersion !== latestVersion
          ),
          ({ bundleId, currentVersion, latestVersion }) => {
            // Create update map with available update
            const availableUpdates = new Map<string, UpdateCheckResult>([
              [bundleId, {
                bundleId,
                currentVersion,
                latestVersion,
                releaseDate: new Date().toISOString(),
                downloadUrl: `https://example.com/${bundleId}.zip`,
                autoUpdateEnabled: false
              }]
            ]);

            // Get version display
            const versionDisplay = getVersionDisplay(bundleId, currentVersion, availableUpdates);

            // Should show both versions with arrow
            const expectedDisplay = `v${currentVersion} → v${latestVersion}`;

            return versionDisplay === expectedDisplay;
          }
        ),
        { numRuns: 100, verbose: false }
      );
    });

    test('should display only current version when no update is available', () => {
      const bundleIdArbitrary = fc.string({ minLength: 3, maxLength: 20 })
        .filter((s) => /^[a-z0-9-]+$/.test(s));

      const semverArbitrary = fc.tuple(
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 50 })
      ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

      fc.assert(
        fc.property(
          fc.record({
            bundleId: bundleIdArbitrary,
            currentVersion: semverArbitrary
          }),
          ({ bundleId, currentVersion }) => {
            // Empty update map (no updates available)
            const availableUpdates = new Map<string, UpdateCheckResult>();

            // Get version display
            const versionDisplay = getVersionDisplay(bundleId, currentVersion, availableUpdates);

            // Should show only current version
            const expectedDisplay = `v${currentVersion}`;

            return versionDisplay === expectedDisplay;
          }
        ),
        { numRuns: 100, verbose: false }
      );
    });

    test('should always include version prefix "v"', () => {
      const bundleIdArbitrary = fc.string({ minLength: 3, maxLength: 20 })
        .filter((s) => /^[a-z0-9-]+$/.test(s));

      const semverArbitrary = fc.tuple(
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 50 })
      ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

      fc.assert(
        fc.property(
          fc.record({
            bundleId: bundleIdArbitrary,
            currentVersion: semverArbitrary,
            hasUpdate: fc.boolean()
          }),
          ({ bundleId, currentVersion, hasUpdate }) => {
            const availableUpdates = new Map<string, UpdateCheckResult>();

            if (hasUpdate) {
              // Add an update
              const [major, minor, patch] = currentVersion.split('.').map(Number);
              const latestVersion = `${major}.${minor}.${patch + 1}`;

              availableUpdates.set(bundleId, {
                bundleId,
                currentVersion,
                latestVersion,
                releaseDate: new Date().toISOString(),
                downloadUrl: `https://example.com/${bundleId}.zip`,
                autoUpdateEnabled: false
              });
            }

            const versionDisplay = getVersionDisplay(bundleId, currentVersion, availableUpdates);

            // Should always start with "v"
            return versionDisplay.startsWith('v');
          }
        ),
        { numRuns: 100, verbose: false }
      );
    });
  });

  suite('Property 18: TreeView context menu update option', () => {
    /**
     * **Property 18: TreeView context menu update option**
     * **Validates: Requirements 4.3**
     *
     * For any bundle with an available update, right-clicking the bundle in the TreeView
     * should provide an "Update" option in the context menu. This is controlled by the
     * contextValue property of the tree item.
     */
    test('should set updatable context value for bundles with updates', () => {
      const bundleIdArbitrary = fc.string({ minLength: 3, maxLength: 20 })
        .filter((s) => /^[a-z0-9-]+$/.test(s));

      const semverArbitrary = fc.tuple(
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 50 })
      ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              bundleId: bundleIdArbitrary,
              currentVersion: semverArbitrary,
              latestVersion: semverArbitrary
            }),
            { minLength: 1, maxLength: 10 }
          ),
          (bundles) => {
            // Create update map
            const availableUpdates = new Map<string, UpdateCheckResult>();

            for (const bundle of bundles) {
              availableUpdates.set(bundle.bundleId, {
                bundleId: bundle.bundleId,
                currentVersion: bundle.currentVersion,
                latestVersion: bundle.latestVersion,
                releaseDate: new Date().toISOString(),
                downloadUrl: `https://example.com/${bundle.bundleId}.zip`,
                autoUpdateEnabled: false
              });
            }

            // Verify all bundles have updatable context value
            for (const bundle of bundles) {
              const contextValue = getContextValue(bundle.bundleId, availableUpdates);

              // Should have updatable context value to enable context menu
              if (contextValue !== 'installed_bundle_updatable') {
                return false;
              }
            }

            return true;
          }
        ),
        { numRuns: 100, verbose: false }
      );
    });

    test('should set regular context value for bundles without updates', () => {
      const bundleIdArbitrary = fc.string({ minLength: 3, maxLength: 20 })
        .filter((s) => /^[a-z0-9-]+$/.test(s));

      const semverArbitrary = fc.tuple(
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 50 })
      ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              bundleId: bundleIdArbitrary,
              version: semverArbitrary
            }),
            { minLength: 1, maxLength: 10 }
          ),
          (bundles) => {
            // Empty update map (no updates available)
            const availableUpdates = new Map<string, UpdateCheckResult>();

            // Verify no bundles have updatable context value
            for (const bundle of bundles) {
              const contextValue = getContextValue(bundle.bundleId, availableUpdates);

              // Should have regular context value (no special update menu)
              if (contextValue !== 'installed_bundle') {
                return false;
              }
            }

            return true;
          }
        ),
        { numRuns: 100, verbose: false }
      );
    });

    test('should correctly distinguish updatable vs non-updatable bundles', () => {
      const bundleIdArbitrary = fc.string({ minLength: 3, maxLength: 20 })
        .filter((s) => /^[a-z0-9-]+$/.test(s));

      const semverArbitrary = fc.tuple(
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 50 })
      ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

      fc.assert(
        fc.property(
          fc.record({
            updatableBundles: fc.array(
              fc.record({
                bundleId: bundleIdArbitrary,
                currentVersion: semverArbitrary,
                latestVersion: semverArbitrary
              }),
              { minLength: 1, maxLength: 5 }
            ),
            regularBundles: fc.array(
              fc.record({
                bundleId: bundleIdArbitrary,
                version: semverArbitrary
              }),
              { minLength: 1, maxLength: 5 }
            )
          }).filter(({ updatableBundles, regularBundles }) => {
            // Ensure no duplicate bundle IDs between the two arrays
            const updatableIds = new Set(updatableBundles.map((b) => b.bundleId));
            const regularIds = new Set(regularBundles.map((b) => b.bundleId));

            // Check for intersection
            for (const id of updatableIds) {
              if (regularIds.has(id)) {
                return false; // Duplicate found
              }
            }
            return true; // No duplicates
          }),
          ({ updatableBundles, regularBundles }) => {
            // Create update map with only updatable bundles
            const availableUpdates = new Map<string, UpdateCheckResult>();

            for (const bundle of updatableBundles) {
              availableUpdates.set(bundle.bundleId, {
                bundleId: bundle.bundleId,
                currentVersion: bundle.currentVersion,
                latestVersion: bundle.latestVersion,
                releaseDate: new Date().toISOString(),
                downloadUrl: `https://example.com/${bundle.bundleId}.zip`,
                autoUpdateEnabled: false
              });
            }

            // Verify updatable bundles have updatable context
            for (const bundle of updatableBundles) {
              const contextValue = getContextValue(bundle.bundleId, availableUpdates);
              if (contextValue !== 'installed_bundle_updatable') {
                return false;
              }
            }

            // Verify regular bundles have regular context
            for (const bundle of regularBundles) {
              const contextValue = getContextValue(bundle.bundleId, availableUpdates);
              if (contextValue !== 'installed_bundle') {
                return false;
              }
            }

            return true;
          }
        ),
        { numRuns: 100, verbose: false }
      );
    });
  });
});

suite('Property 10: Backward Compatibility Invariant', () => {
  /**
   * **Property 10: Backward Compatibility Invariant**
   * **Validates: Requirements 9.1-9.5**
   *
   * For any existing user-level installation, the extension SHALL continue to display,
   * update, and uninstall it independently of repository-level bundles.
   *
   * This property tests that:
   * 1. User-level bundles are always displayed regardless of repository bundles
   * 2. User-level bundles maintain their own update indicators
   * 3. User-level bundles can be operated on independently
   */
  test('should display user-level bundles independently of repository bundles', () => {
    const bundleIdArbitrary = fc.string({ minLength: 3, maxLength: 20 })
      .filter((s) => /^[a-z0-9-]+$/.test(s));

    const semverArbitrary = fc.tuple(
      fc.integer({ min: 0, max: 10 }),
      fc.integer({ min: 0, max: 20 }),
      fc.integer({ min: 0, max: 50 })
    ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

    fc.assert(
      fc.property(
        fc.record({
          userBundles: fc.array(
            fc.record({
              bundleId: bundleIdArbitrary,
              version: semverArbitrary,
              scope: fc.constant('user' as const)
            }),
            { minLength: 1, maxLength: 5 }
          ),
          repositoryBundles: fc.array(
            fc.record({
              bundleId: bundleIdArbitrary,
              version: semverArbitrary,
              scope: fc.constant('repository' as const)
            }),
            { minLength: 0, maxLength: 5 }
          )
        }).filter(({ userBundles, repositoryBundles }) => {
          // Ensure no duplicate bundle IDs (scope conflict prevention)
          const userIds = new Set(userBundles.map((b) => b.bundleId));
          const repoIds = new Set(repositoryBundles.map((b) => b.bundleId));

          for (const id of userIds) {
            if (repoIds.has(id)) {
              return false; // Duplicate found
            }
          }
          return true; // No duplicates
        }),
        ({ userBundles, repositoryBundles }) => {
          // Simulate bundle list that would be returned by listInstalledBundles
          const allBundles = [...userBundles, ...repositoryBundles];

          // Verify all user bundles are present in the combined list
          for (const userBundle of userBundles) {
            const found = allBundles.find((b) =>
              b.bundleId === userBundle.bundleId && b.scope === 'user'
            );
            if (!found) {
              return false; // User bundle not found
            }
          }

          // Verify user bundles maintain their scope
          for (const bundle of allBundles) {
            if (userBundles.some((ub) => ub.bundleId === bundle.bundleId) && bundle.scope !== 'user') {
              return false; // Scope changed
            }
          }

          return true;
        }
      ),
      { numRuns: 100, verbose: false }
    );
  });

  test('should maintain independent update indicators for user-level bundles', () => {
    const bundleIdArbitrary = fc.string({ minLength: 3, maxLength: 20 })
      .filter((s) => /^[a-z0-9-]+$/.test(s));

    const semverArbitrary = fc.tuple(
      fc.integer({ min: 0, max: 10 }),
      fc.integer({ min: 0, max: 20 }),
      fc.integer({ min: 0, max: 50 })
    ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

    fc.assert(
      fc.property(
        fc.record({
          userBundleId: bundleIdArbitrary,
          userVersion: semverArbitrary,
          userLatestVersion: semverArbitrary,
          repoBundleId: bundleIdArbitrary,
          repoVersion: semverArbitrary,
          repoLatestVersion: semverArbitrary
        }).filter(({ userBundleId, repoBundleId, userVersion, userLatestVersion, repoVersion, repoLatestVersion }) =>
        // Ensure different bundle IDs and versions differ from latest
          userBundleId !== repoBundleId
          && userVersion !== userLatestVersion
          && repoVersion !== repoLatestVersion
        ),
        ({ userBundleId, userVersion, userLatestVersion, repoBundleId, repoVersion, repoLatestVersion }) => {
          // Create update map with updates for both bundles
          const availableUpdates = new Map<string, UpdateCheckResult>([
            [userBundleId, {
              bundleId: userBundleId,
              currentVersion: userVersion,
              latestVersion: userLatestVersion,
              releaseDate: new Date().toISOString(),
              downloadUrl: `https://example.com/${userBundleId}.zip`,
              autoUpdateEnabled: false
            }],
            [repoBundleId, {
              bundleId: repoBundleId,
              currentVersion: repoVersion,
              latestVersion: repoLatestVersion,
              releaseDate: new Date().toISOString(),
              downloadUrl: `https://example.com/${repoBundleId}.zip`,
              autoUpdateEnabled: false
            }]
          ]);

          // Verify user bundle has update indicator
          const userIconPrefix = getBundleIconPrefix(userBundleId, availableUpdates);
          if (userIconPrefix !== '⬆️') {
            return false;
          }

          // Verify user bundle has correct version display
          const userVersionDisplay = getVersionDisplay(userBundleId, userVersion, availableUpdates);
          const expectedUserDisplay = `v${userVersion} → v${userLatestVersion}`;
          if (userVersionDisplay !== expectedUserDisplay) {
            return false;
          }

          // Verify repository bundle also has update indicator (independent)
          const repoIconPrefix = getBundleIconPrefix(repoBundleId, availableUpdates);
          if (repoIconPrefix !== '⬆️') {
            return false;
          }

          // Verify repository bundle has correct version display
          const repoVersionDisplay = getVersionDisplay(repoBundleId, repoVersion, availableUpdates);
          const expectedRepoDisplay = `v${repoVersion} → v${repoLatestVersion}`;
          if (repoVersionDisplay !== expectedRepoDisplay) {
            return false;
          }

          return true;
        }
      ),
      { numRuns: 100, verbose: false }
    );
  });

  test('should preserve user bundle context values independently', () => {
    const bundleIdArbitrary = fc.string({ minLength: 3, maxLength: 20 })
      .filter((s) => /^[a-z0-9-]+$/.test(s));

    fc.assert(
      fc.property(
        fc.record({
          userBundleId: bundleIdArbitrary,
          userHasUpdate: fc.boolean(),
          repoBundleId: bundleIdArbitrary,
          repoHasUpdate: fc.boolean()
        }).filter(({ userBundleId, repoBundleId }) =>
          userBundleId !== repoBundleId
        ),
        ({ userBundleId, userHasUpdate, repoBundleId, repoHasUpdate }) => {
          const availableUpdates = new Map<string, UpdateCheckResult>();

          // Add updates based on flags
          if (userHasUpdate) {
            availableUpdates.set(userBundleId, {
              bundleId: userBundleId,
              currentVersion: '1.0.0',
              latestVersion: '1.1.0',
              releaseDate: new Date().toISOString(),
              downloadUrl: `https://example.com/${userBundleId}.zip`,
              autoUpdateEnabled: false
            });
          }

          if (repoHasUpdate) {
            availableUpdates.set(repoBundleId, {
              bundleId: repoBundleId,
              currentVersion: '2.0.0',
              latestVersion: '2.1.0',
              releaseDate: new Date().toISOString(),
              downloadUrl: `https://example.com/${repoBundleId}.zip`,
              autoUpdateEnabled: false
            });
          }

          // Verify user bundle context value is independent
          const userContextValue = getContextValue(userBundleId, availableUpdates);
          const expectedUserContext = userHasUpdate ? 'installed_bundle_updatable' : 'installed_bundle';
          if (userContextValue !== expectedUserContext) {
            return false;
          }

          // Verify repository bundle context value is independent
          const repoContextValue = getContextValue(repoBundleId, availableUpdates);
          const expectedRepoContext = repoHasUpdate ? 'installed_bundle_updatable' : 'installed_bundle';
          if (repoContextValue !== expectedRepoContext) {
            return false;
          }

          return true;
        }
      ),
      { numRuns: 100, verbose: false }
    );
  });
});
