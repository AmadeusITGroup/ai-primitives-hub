/**
 * Property-based tests for UpdateChecker
 *
 * These tests use fast-check to generate random inputs and verify
 * correctness properties hold across all valid executions.
 *
 * Feature: bundle-update-notifications
 */
import * as fc from 'fast-check';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  UpdateChecker,
} from '../../src/services/update-checker';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  BundleUpdate,
} from '../../src/types/registry';
import {
  BundleGenerators,
  PropertyTestConfig,
} from '../helpers/property-test-helpers';

/**
 * Constants for property test generation
 */
const MAX_MAJOR_VERSION = 10;
const MAX_MINOR_VERSION = 20;
const MAX_PATCH_VERSION = 50;
const MIN_BUNDLES = 1;
const MAX_BUNDLES = 10;

suite('UpdateChecker Property Tests', () => {
  let sandbox: sinon.SinonSandbox;
  let mockMemento: vscode.Memento;
  let registryManager: sinon.SinonStubbedInstance<RegistryManager>;
  let registryStorage: sinon.SinonStubbedInstance<RegistryStorage>;
  let updateChecker: UpdateChecker;

  setup(() => {
    sandbox = sinon.createSandbox();

    // Create mock memento for cache storage
    const storage = new Map<string, any>();
    mockMemento = {
      get: sandbox.stub().callsFake((key: string, defaultValue?: any) => {
        return storage.get(key) ?? defaultValue;
      }),
      update: sandbox.stub().callsFake((key: string, value: any) => {
        if (value === undefined) {
          storage.delete(key);
        } else {
          storage.set(key, value);
        }
      }),
      keys: sandbox.stub().returns([])
    };

    // Create stubbed instances
    registryManager = sandbox.createStubInstance(RegistryManager);
    registryStorage = sandbox.createStubInstance(RegistryStorage);

    // Mock listSources to return empty array by default (no sources to sync)
    registryManager.listSources.resolves([]);

    // Create UpdateChecker with mocked dependencies
    updateChecker = new UpdateChecker(
      registryManager,
      registryStorage,
      mockMemento
    );
  });

  teardown(() => {
    sandbox.restore();
  });

  /**
   * Property 3: Version comparison correctness
   * Feature: bundle-update-notifications, Property 3: Version comparison correctness
   *
   * For any installed bundle and latest bundle, the Update Checker should correctly
   * identify an update as available if and only if the semantic version of the latest
   * bundle is greater than the installed version.
   *
   * Validates: Requirements 1.3
   */
  test('Property 3: Version comparison identifies updates correctly', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Ensure each bundleId is unique in the generated array to avoid
        // ambiguous expectations when multiple entries share the same ID.
        fc.uniqueArray(
          fc.record({
            bundleId: BundleGenerators.bundleId(),
            installedVersion: BundleGenerators.versionTuple(MAX_MAJOR_VERSION, MAX_MINOR_VERSION, MAX_PATCH_VERSION),
            latestVersion: BundleGenerators.versionTuple(MAX_MAJOR_VERSION, MAX_MINOR_VERSION, MAX_PATCH_VERSION)
          }),
          {
            minLength: MIN_BUNDLES,
            maxLength: MAX_BUNDLES,
            selector: (config) => config.bundleId
          }
        ),
        async (bundleConfigs) => {
          // Format versions as semantic version strings
          const bundles = bundleConfigs.map((config) => ({
            bundleId: config.bundleId,
            installedVersion: `${config.installedVersion[0]}.${config.installedVersion[1]}.${config.installedVersion[2]}`,
            latestVersion: `${config.latestVersion[0]}.${config.latestVersion[1]}.${config.latestVersion[2]}`
          }));

          // Determine which bundles should have updates
          const expectedUpdates = bundles.filter((b) => {
            const [iMajor, iMinor, iPatch] = b.installedVersion.split('.').map(Number);
            const [lMajor, lMinor, lPatch] = b.latestVersion.split('.').map(Number);

            // Compare semantic versions
            if (lMajor > iMajor) {
              return true;
            }
            if (lMajor < iMajor) {
              return false;
            }
            if (lMinor > iMinor) {
              return true;
            }
            if (lMinor < iMinor) {
              return false;
            }
            return lPatch > iPatch;
          });

          // Mock RegistryManager.checkUpdates() to return updates
          const mockUpdates: BundleUpdate[] = expectedUpdates.map((b) => ({
            bundleId: b.bundleId,
            currentVersion: b.installedVersion,
            latestVersion: b.latestVersion
          }));

          registryManager.checkUpdates.resolves(mockUpdates);

          // Mock getBundleDetails for enrichment
          for (const bundle of bundles) {
            registryManager.getBundleDetails.withArgs(bundle.bundleId).resolves({
              id: bundle.bundleId,
              name: bundle.bundleId,
              version: bundle.latestVersion,
              description: 'Test bundle',
              author: 'test',
              tags: [],
              environments: [],
              sourceId: 'test-source',
              downloadUrl: 'https://example.com/bundle.zip',
              manifestUrl: 'https://example.com/manifest.yml',
              lastUpdated: new Date().toISOString(),
              contents: { prompts: 0, instructions: 0, chatmodes: 0, agents: 0 }
            } as any);
          }

          // Mock getUpdatePreference to return false
          registryStorage.getUpdatePreference.resolves(false);

          // Check for updates
          const results = await updateChecker.checkForUpdates(true); // bypass cache

          // Verify: number of updates matches expected
          if (results.length !== expectedUpdates.length) {
            return false;
          }

          // Verify: all results have correct version comparison
          for (const result of results) {
            const expected = expectedUpdates.find((e) => e.bundleId === result.bundleId);
            if (!expected) {
              return false;
            }

            // Verify versions match
            if (result.currentVersion !== expected.installedVersion) {
              return false;
            }
            if (result.latestVersion !== expected.latestVersion) {
              return false;
            }

            // Verify latest version is greater than current
            const [cMajor, cMinor, cPatch] = result.currentVersion.split('.').map(Number);
            const [lMajor, lMinor, lPatch] = result.latestVersion.split('.').map(Number);

            const isGreater =
              lMajor > cMajor
              || (lMajor === cMajor && lMinor > cMinor)
              || (lMajor === cMajor && lMinor === cMinor && lPatch > cPatch);

            if (!isGreater) {
              return false;
            }
          }

          return true;
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.STANDARD, timeout: 10_000 }
    );
  });

  /**
   * Property 4: Cache prevents redundant API calls
   * Feature: bundle-update-notifications, Property 4: Cache prevents redundant API calls
   *
   * For any update check request within the cache TTL period, the Update Checker
   * should return cached results without making new API calls.
   *
   * Validates: Requirements 1.4
   */
  test('Property 4: Cache prevents redundant API calls within TTL', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          bundles: fc.array(
            fc.record({
              bundleId: fc.string({
                unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
                minLength: 5,
                maxLength: 20
              }),
              currentVersion: fc.tuple(
                fc.integer({ min: 0, max: MAX_MAJOR_VERSION }),
                fc.integer({ min: 0, max: MAX_MINOR_VERSION }),
                fc.integer({ min: 0, max: MAX_PATCH_VERSION })
              ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`),
              latestVersion: fc.tuple(
                fc.integer({ min: 1, max: MAX_MAJOR_VERSION + 1 }),
                fc.integer({ min: 0, max: MAX_MINOR_VERSION }),
                fc.integer({ min: 0, max: MAX_PATCH_VERSION })
              ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`)
            }),
            { minLength: MIN_BUNDLES, maxLength: MAX_BUNDLES }
          ),
          subsequentCalls: fc.integer({ min: 2, max: 5 })
        }),
        async ({ bundles, subsequentCalls }) => {
          // Create fresh instances for this property test run
          const testSandbox = sinon.createSandbox();
          const storage = new Map<string, any>();
          const testMemento: vscode.Memento = {
            get: testSandbox.stub().callsFake((key: string, defaultValue?: any) => {
              return storage.get(key) ?? defaultValue;
            }),
            update: testSandbox.stub().callsFake((key: string, value: any) => {
              if (value === undefined) {
                storage.delete(key);
              } else {
                storage.set(key, value);
              }
            }),
            keys: testSandbox.stub().returns([])
          };

          const testRegistryManager = testSandbox.createStubInstance(RegistryManager);
          const testRegistryStorage = testSandbox.createStubInstance(RegistryStorage);
          const testUpdateChecker = new UpdateChecker(
            testRegistryManager,
            testRegistryStorage,
            testMemento
          );

          try {
            // Mock RegistryManager.checkUpdates() to return updates
            const mockUpdates: BundleUpdate[] = bundles.map((b) => ({
              bundleId: b.bundleId,
              currentVersion: b.currentVersion,
              latestVersion: b.latestVersion
            }));

            testRegistryManager.checkUpdates.resolves(mockUpdates);

            // Mock getBundleDetails for enrichment
            for (const bundle of bundles) {
              testRegistryManager.getBundleDetails.withArgs(bundle.bundleId).resolves({
                id: bundle.bundleId,
                name: bundle.bundleId,
                version: bundle.latestVersion,
                description: 'Test bundle',
                author: 'test',
                tags: [],
                environments: [],
                sourceId: 'test-source',
                downloadUrl: 'https://example.com/bundle.zip',
                manifestUrl: 'https://example.com/manifest.yml',
                lastUpdated: new Date().toISOString(),
                changelog: 'Test changelog',
                contents: { prompts: 0, instructions: 0, chatmodes: 0, agents: 0 }
              } as any);
            }

            // Mock getUpdatePreference to return false
            testRegistryStorage.getUpdatePreference.resolves(false);

            // First call - should hit RegistryManager
            const firstResults = await testUpdateChecker.checkForUpdates(false);
            const firstCallCount = testRegistryManager.checkUpdates.callCount;

            // Verify first call returned results
            if (firstResults.length !== bundles.length) {
              return false;
            }

            // Subsequent calls - should use cache
            for (let i = 0; i < subsequentCalls; i++) {
              const cachedResults = await testUpdateChecker.checkForUpdates(false);

              // Verify cache returned same results
              if (cachedResults.length !== firstResults.length) {
                return false;
              }

              // Verify results match
              for (const [j, cachedResult] of cachedResults.entries()) {
                if (cachedResult.bundleId !== firstResults[j].bundleId) {
                  return false;
                }
                if (cachedResult.currentVersion !== firstResults[j].currentVersion) {
                  return false;
                }
                if (cachedResult.latestVersion !== firstResults[j].latestVersion) {
                  return false;
                }
              }
            }

            // Verify RegistryManager.checkUpdates was only called once
            const finalCallCount = testRegistryManager.checkUpdates.callCount;
            return finalCallCount === firstCallCount;
          } finally {
            testSandbox.restore();
          }
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.STANDARD, verbose: false }
    );
  });

  /**
   * Property 20: Manual check triggers immediate query
   * Feature: bundle-update-notifications, Property 20: Manual check triggers immediate query
   *
   * For any user invocation of the "Check for Updates" command, the Update Checker
   * should immediately query all installed bundles for updates, bypassing the cache.
   *
   * Validates: Requirements 5.1
   */
  test('Property 20: Manual check bypasses cache and triggers immediate query', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          bundles: fc.array(
            fc.record({
              bundleId: fc.string({
                unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
                minLength: 5,
                maxLength: 20
              }),
              currentVersion: fc.tuple(
                fc.integer({ min: 0, max: MAX_MAJOR_VERSION }),
                fc.integer({ min: 0, max: MAX_MINOR_VERSION }),
                fc.integer({ min: 0, max: MAX_PATCH_VERSION })
              ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`),
              latestVersion: fc.tuple(
                fc.integer({ min: 1, max: MAX_MAJOR_VERSION + 1 }),
                fc.integer({ min: 0, max: MAX_MINOR_VERSION }),
                fc.integer({ min: 0, max: MAX_PATCH_VERSION })
              ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`)
            }),
            { minLength: MIN_BUNDLES, maxLength: MAX_BUNDLES }
          ),
          // Generate different update results for cached vs fresh check
          hasNewUpdates: fc.boolean()
        }),
        async ({ bundles, hasNewUpdates }) => {
          // Create fresh instances for this property test run
          const testSandbox = sinon.createSandbox();
          const storage = new Map<string, any>();
          const testMemento: vscode.Memento = {
            get: testSandbox.stub().callsFake((key: string, defaultValue?: any) => {
              return storage.get(key) ?? defaultValue;
            }),
            update: testSandbox.stub().callsFake((key: string, value: any) => {
              if (value === undefined) {
                storage.delete(key);
              } else {
                storage.set(key, value);
              }
            }),
            keys: testSandbox.stub().returns([])
          };

          const testRegistryManager = testSandbox.createStubInstance(RegistryManager);
          const testRegistryStorage = testSandbox.createStubInstance(RegistryStorage);
          const testUpdateChecker = new UpdateChecker(
            testRegistryManager,
            testRegistryStorage,
            testMemento
          );

          try {
            // Mock initial updates
            const initialUpdates: BundleUpdate[] = bundles.map((b) => ({
              bundleId: b.bundleId,
              currentVersion: b.currentVersion,
              latestVersion: b.latestVersion
            }));

            testRegistryManager.checkUpdates.resolves(initialUpdates);

            // Mock getBundleDetails for enrichment
            for (const bundle of bundles) {
              testRegistryManager.getBundleDetails.withArgs(bundle.bundleId).resolves({
                id: bundle.bundleId,
                name: bundle.bundleId,
                version: bundle.latestVersion,
                description: 'Test bundle',
                author: 'test',
                tags: [],
                environments: [],
                sourceId: 'test-source',
                downloadUrl: 'https://example.com/bundle.zip',
                manifestUrl: 'https://example.com/manifest.yml',
                lastUpdated: new Date().toISOString(),
                changelog: 'Test changelog',
                contents: { prompts: 0, instructions: 0, chatmodes: 0, agents: 0 }
              } as any);
            }

            testRegistryStorage.getUpdatePreference.resolves(false);

            // First call - populate cache
            await testUpdateChecker.checkForUpdates(false);
            const afterFirstCallCount = testRegistryManager.checkUpdates.callCount;

            // Verify cache was populated
            if (afterFirstCallCount !== 1) {
              return false;
            }

            // Optionally modify the updates to simulate new updates available
            if (hasNewUpdates && bundles.length > 0) {
              const newUpdates: BundleUpdate[] = [
                ...initialUpdates,
                {
                  bundleId: 'new-bundle-' + Math.random().toString(36).substring(7),
                  currentVersion: '1.0.0',
                  latestVersion: '2.0.0'
                }
              ];
              testRegistryManager.checkUpdates.resolves(newUpdates);

              // Mock getBundleDetails for new bundle
              testRegistryManager.getBundleDetails.withArgs(newUpdates.at(-1)!.bundleId).resolves({
                id: newUpdates.at(-1)!.bundleId,
                name: newUpdates.at(-1)!.bundleId,
                version: '2.0.0',
                description: 'New test bundle',
                author: 'test',
                tags: [],
                environments: [],
                sourceId: 'test-source',
                downloadUrl: 'https://example.com/bundle.zip',
                manifestUrl: 'https://example.com/manifest.yml',
                lastUpdated: new Date().toISOString(),
                changelog: 'New bundle changelog',
                contents: { prompts: 0, instructions: 0, chatmodes: 0, agents: 0 }
              } as any);
            }

            // Manual check - should bypass cache (bypassCache = true)
            const manualResults = await testUpdateChecker.checkForUpdates(true);
            const afterManualCallCount = testRegistryManager.checkUpdates.callCount;

            // Verify: RegistryManager.checkUpdates was called again (bypassed cache)
            if (afterManualCallCount !== afterFirstCallCount + 1) {
              return false;
            }

            // Verify: Results reflect the current state (not cached)
            if (hasNewUpdates && bundles.length > 0) {
              // Should have one more update than initial
              if (manualResults.length !== bundles.length + 1) {
                return false;
              }
            } else {
              // Should have same number of updates
              if (manualResults.length !== bundles.length) {
                return false;
              }
            }

            // Verify: Subsequent call without bypass uses cache
            await testUpdateChecker.checkForUpdates(false);
            const afterCachedCallCount = testRegistryManager.checkUpdates.callCount;

            // Should not have called RegistryManager again (used cache)
            if (afterCachedCallCount !== afterManualCallCount) {
              return false;
            }

            return true;
          } finally {
            testSandbox.restore();
          }
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.STANDARD, verbose: false }
    );
  });

  /**
   * Property 46: Update check syncs only GitHub release sources
   * Feature: bundle-update-notifications, Property 46: Update check syncs only GitHub release sources
   *
   * For any collection of sources with different types, the Update Checker should
   * sync ONLY sources where type === 'github' and should NOT sync sources of type
   * 'awesome-copilot', 'local-awesome-copilot', or 'local'.
   *
   * Validates: Requirements 1.7
   */
  test('Property 46: Update check syncs only GitHub release sources', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          githubSources: fc.array(
            fc.record({
              // Prefix IDs to ensure they cannot collide with non-GitHub IDs
              id: fc.string({
                unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
                minLength: 2,
                maxLength: 17
              }).map((s) => `gh-${s}`),
              name: fc.string({ minLength: 5, maxLength: 30 }),
              url: fc.string({ minLength: 10, maxLength: 50 })
            }),
            { minLength: 1, maxLength: 5 }
          ),
          nonGithubSources: fc.array(
            fc.record({
              // Use a different prefix space so IDs are disjoint from GitHub ones
              id: fc.string({
                unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
                minLength: 2,
                maxLength: 17
              }).map((s) => `ngh-${s}`),
              name: fc.string({ minLength: 5, maxLength: 30 }),
              url: fc.string({ minLength: 10, maxLength: 50 }),
              type: fc.constantFrom('awesome-copilot', 'local-awesome-copilot', 'local')
            }),
            { minLength: 1, maxLength: 5 }
          )
        }),
        async ({ githubSources, nonGithubSources }) => {
          // Create fresh instances for this property test run
          const testSandbox = sinon.createSandbox();
          const storage = new Map<string, any>();
          const testMemento: vscode.Memento = {
            get: testSandbox.stub().callsFake((key: string, defaultValue?: any) => {
              return storage.get(key) ?? defaultValue;
            }),
            update: testSandbox.stub().callsFake((key: string, value: any) => {
              if (value === undefined) {
                storage.delete(key);
              } else {
                storage.set(key, value);
              }
            }),
            keys: testSandbox.stub().returns([])
          };

          const testRegistryManager = testSandbox.createStubInstance(RegistryManager);
          const testRegistryStorage = testSandbox.createStubInstance(RegistryStorage);
          const testUpdateChecker = new UpdateChecker(
            testRegistryManager,
            testRegistryStorage,
            testMemento
          );

          try {
            // Create all sources with proper types matching RegistrySource interface
            const allSources = [
              ...githubSources.map((s) => ({
                id: s.id,
                name: s.name,
                type: 'github' as const,
                url: s.url,
                enabled: true,
                priority: 1
              })),
              ...nonGithubSources.map((s) => ({
                id: s.id,
                name: s.name,
                type: s.type as any,
                url: s.url,
                enabled: true,
                priority: 1
              }))
            ];

            // Mock listSources to return all sources
            testRegistryManager.listSources.resolves(allSources);

            // Mock syncSource to resolve successfully
            testRegistryManager.syncSource.resolves();

            // Mock checkUpdates to return empty array (we're testing sync behavior, not updates)
            testRegistryManager.checkUpdates.resolves([]);

            // Trigger update check with bypassCache=true to force source sync
            await testUpdateChecker.checkForUpdates(true);

            // Verify: syncSource was called for each GitHub source
            for (const githubSource of githubSources) {
              const wasCalledForGithub = testRegistryManager.syncSource.calledWith(githubSource.id);
              if (!wasCalledForGithub) {
                return false;
              }
            }

            // Verify: syncSource was NOT called for any non-GitHub source
            for (const nonGithubSource of nonGithubSources) {
              const wasCalledForNonGithub = testRegistryManager.syncSource.calledWith(nonGithubSource.id);
              if (wasCalledForNonGithub) {
                return false;
              }
            }

            // Verify: syncSource was called exactly the right number of times (only GitHub sources)
            const expectedCallCount = githubSources.length;
            const actualCallCount = testRegistryManager.syncSource.callCount;
            if (actualCallCount !== expectedCallCount) {
              return false;
            }

            return true;
          } finally {
            testSandbox.restore();
          }
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.STANDARD, verbose: false }
    );
  });
});
