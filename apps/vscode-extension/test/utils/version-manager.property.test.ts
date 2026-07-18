/**
 * Property-based tests for VersionManager
 * Feature: github-version-consolidation, Property 3: Version comparison transitivity
 * Validates: Requirements 2.1
 */
import * as fc from 'fast-check';
import {
  VersionManager,
} from '../../src/utils/version-manager';

suite('VersionManager Property Tests', () => {
  // Generator for valid semver strings
  const semverArbitrary = fc.tuple(
    fc.integer({ min: 0, max: 10 }),
    fc.integer({ min: 0, max: 20 }),
    fc.integer({ min: 0, max: 50 })
  ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

  test('Property 3: Version comparison transitivity', () => {
    /**
     * Feature: github-version-consolidation, Property 3: Version comparison transitivity
     * Validates: Requirements 2.1
     */
    fc.assert(
      fc.property(
        fc.tuple(semverArbitrary, semverArbitrary, semverArbitrary),
        ([v1, v2, v3]) => {
          const cmp12 = VersionManager.compareVersions(v1, v2);
          const cmp23 = VersionManager.compareVersions(v2, v3);
          const cmp13 = VersionManager.compareVersions(v1, v3);

          // If v1 < v2 and v2 < v3, then v1 < v3
          if (cmp12 < 0 && cmp23 < 0) {
            return cmp13 < 0;
          }

          // If v1 > v2 and v2 > v3, then v1 > v3
          if (cmp12 > 0 && cmp23 > 0) {
            return cmp13 > 0;
          }

          // If v1 == v2 and v2 == v3, then v1 == v3
          if (cmp12 === 0 && cmp23 === 0) {
            return cmp13 === 0;
          }

          return true; // Other cases don't violate transitivity
        }
      ),
      { numRuns: 100, verbose: false }
    );
  });
});
