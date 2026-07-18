/**
 * Property-based tests for VersionConsolidator
 *
 * These tests use fast-check to generate random inputs and verify
 * correctness properties hold across all valid executions.
 */
import * as fc from 'fast-check';
import {
  VersionConsolidator,
} from '../../src/services/version-consolidator';
import {
  BundleBuilder,
} from '../helpers/bundle-test-helpers';

/**
 * Constants for property test generation
 */
const MAX_MAJOR_VERSION = 10;
const MAX_MINOR_VERSION = 20;
const MAX_PATCH_VERSION = 50;
const MIN_IDENTIFIER_LENGTH = 1;
const MAX_IDENTIFIER_LENGTH = 20;
const MIN_VERSIONS_PER_BUNDLE = 2;
const MAX_VERSIONS_PER_BUNDLE = 10;
const MIN_BUNDLES = 1;
const MAX_BUNDLES = 10;

suite('VersionConsolidator Property Tests', () => {
  let consolidator: VersionConsolidator;

  setup(() => {
    consolidator = new VersionConsolidator();
  });

  /**
   * Property 1: Bundle identity consistency
   * Feature: github-version-consolidation, Property 1: Bundle identity consistency
   *
   * For any GitHub repository with multiple releases, all releases should map
   * to the same bundle identity based on owner and repository name.
   *
   * Validates: Requirements 4.1, 4.2
   */
  test('Property 1: All releases from same GitHub repo map to same identity', () => {
    fc.assert(
      fc.property(
        fc.record({
          owner: fc.string({
            unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
            minLength: MIN_IDENTIFIER_LENGTH,
            maxLength: MAX_IDENTIFIER_LENGTH
          }),
          repo: fc.string({
            unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
            minLength: MIN_IDENTIFIER_LENGTH,
            maxLength: MAX_IDENTIFIER_LENGTH
          }),
          versions: fc.array(
            fc.tuple(
              fc.integer({ min: 0, max: MAX_MAJOR_VERSION }),
              fc.integer({ min: 0, max: MAX_MINOR_VERSION }),
              fc.integer({ min: 0, max: MAX_PATCH_VERSION })
            ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`),
            { minLength: MIN_VERSIONS_PER_BUNDLE, maxLength: MAX_VERSIONS_PER_BUNDLE }
          )
        }),
        ({ owner, repo, versions }) => {
          // Create bundles with same owner/repo but different versions
          const bundles = versions.map((v) =>
            BundleBuilder.github(owner, repo).withVersion(v).build()
          );

          // Consolidate
          const consolidated = consolidator.consolidateBundles(bundles);

          // Should have exactly one consolidated entry
          return consolidated.length === 1 && consolidated[0].isConsolidated === true;
        }
      ),
      { numRuns: 100, verbose: false }
    );
  });

  /**
   * Property 2: Latest version selection
   * Feature: github-version-consolidation, Property 2: Latest version selection
   *
   * For any set of versions for a bundle, the system should consistently select
   * the version with the highest semantic version number.
   *
   * Validates: Requirements 2.1, 2.2
   */
  test('Property 2: Consolidator selects highest semantic version', () => {
    fc.assert(
      fc.property(
        fc.record({
          owner: fc.string({
            unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
            minLength: MIN_IDENTIFIER_LENGTH,
            maxLength: MAX_IDENTIFIER_LENGTH
          }),
          repo: fc.string({
            unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
            minLength: MIN_IDENTIFIER_LENGTH,
            maxLength: MAX_IDENTIFIER_LENGTH
          }),
          versions: fc.array(
            fc.tuple(
              fc.integer({ min: 0, max: MAX_MAJOR_VERSION }),
              fc.integer({ min: 0, max: MAX_MINOR_VERSION }),
              fc.integer({ min: 0, max: MAX_PATCH_VERSION })
            ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`),
            { minLength: MIN_VERSIONS_PER_BUNDLE, maxLength: MAX_VERSIONS_PER_BUNDLE }
          )
        }),
        ({ owner, repo, versions }) => {
          // Create bundles with same owner/repo but different versions
          const bundles = versions.map((v) =>
            BundleBuilder.github(owner, repo).withVersion(v).build()
          );

          // Consolidate
          const consolidated = consolidator.consolidateBundles(bundles);

          // Should have exactly one consolidated entry
          if (consolidated.length !== 1) {
            return false;
          }

          // Find expected latest by sorting versions
          const sortedVersions = [...versions].toSorted((a, b) => {
            const [aMajor, aMinor, aPatch] = a.split('.').map(Number);
            const [bMajor, bMinor, bPatch] = b.split('.').map(Number);

            if (bMajor !== aMajor) {
              return bMajor - aMajor;
            }
            if (bMinor !== aMinor) {
              return bMinor - aMinor;
            }
            return bPatch - aPatch;
          });
          const expectedLatest = sortedVersions[0];

          // Consolidated bundle should have the latest version
          const hasCorrectVersion = consolidated[0].version === expectedLatest;
          const isMarkedConsolidated = consolidated[0].isConsolidated === true;
          const hasAllVersions = consolidated[0].availableVersions.length === versions.length;

          return hasCorrectVersion && isMarkedConsolidated && hasAllVersions;
        }
      ),
      { numRuns: 100, verbose: false }
    );
  });

  /**
   * Property 5: Source type isolation
   * Feature: github-version-consolidation, Property 5: Source type isolation
   *
   * For any bundle from a non-GitHub source, the consolidation process should
   * not modify or group that bundle.
   *
   * Validates: Requirements 7.1, 7.2, 7.3
   */
  test('Property 5: Non-GitHub bundles are not consolidated', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            bundleId: fc.string({
              unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
              minLength: 5,
              maxLength: 30
            }),
            version: fc.tuple(
              fc.integer({ min: 0, max: MAX_MAJOR_VERSION }),
              fc.integer({ min: 0, max: MAX_MINOR_VERSION }),
              fc.integer({ min: 0, max: MAX_PATCH_VERSION })
            ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`),
            sourceType: fc.constantFrom('LOCAL', 'AWESOME_COPILOT')
          }),
          { minLength: MIN_BUNDLES, maxLength: MAX_BUNDLES }
        ),
        (bundleConfigs) => {
          // Create bundles from non-GitHub sources
          const bundles = bundleConfigs.map((config) =>
            BundleBuilder.fromSource(config.bundleId, config.sourceType as any)
              .withVersion(config.version)
              .build()
          );

          // Consolidate
          const consolidated = consolidator.consolidateBundles(bundles);

          // Output count should equal input count (no consolidation)
          return consolidated.length === bundles.length;
        }
      ),
      { numRuns: 100, verbose: false }
    );
  });

  /**
   * Property 6: Marketplace entry uniqueness
   * Feature: github-version-consolidation, Property 6: Marketplace entry uniqueness
   *
   * For any GitHub repository, exactly one marketplace entry should be displayed
   * regardless of the number of releases.
   *
   * Validates: Requirements 1.2, 1.3
   */
  test('Property 6: Exactly one entry per GitHub repository', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            owner: fc.string({
              unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
              minLength: MIN_IDENTIFIER_LENGTH,
              maxLength: MAX_IDENTIFIER_LENGTH
            }),
            repo: fc.string({
              unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
              minLength: MIN_IDENTIFIER_LENGTH,
              maxLength: MAX_IDENTIFIER_LENGTH
            }),
            versions: fc.array(
              fc.tuple(
                fc.integer({ min: 0, max: MAX_MAJOR_VERSION }),
                fc.integer({ min: 0, max: MAX_MINOR_VERSION }),
                fc.integer({ min: 0, max: MAX_PATCH_VERSION })
              ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`),
              { minLength: MIN_VERSIONS_PER_BUNDLE, maxLength: MAX_VERSIONS_PER_BUNDLE }
            )
          }),
          { minLength: 1, maxLength: 5 }
        ),
        (repoConfigs) => {
          // Create bundles: multiple versions for each repository
          const allBundles = repoConfigs.flatMap((config) =>
            config.versions.map((v) =>
              BundleBuilder.github(config.owner, config.repo)
                .withVersion(v)
                .build()
            )
          );

          // Consolidate
          const consolidated = consolidator.consolidateBundles(allBundles);

          // Should have exactly one entry per unique repository
          const expectedCount = repoConfigs.length;

          // Verify count matches
          if (consolidated.length !== expectedCount) {
            return false;
          }

          // Verify all entries are from GitHub sources
          const allFromGitHub = consolidated.every((b) =>
            b.sourceId === 'github-source'
          );

          // Verify all entries are marked as consolidated (since we have multiple versions)
          const allConsolidated = consolidated.every((b) => b.isConsolidated === true);

          return allFromGitHub && allConsolidated;
        }
      ),
      { numRuns: 100, verbose: false }
    );
  });
});
