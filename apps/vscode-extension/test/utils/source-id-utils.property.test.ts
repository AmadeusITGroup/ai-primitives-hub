/**
 * Source ID Utilities Property Tests
 *
 * Property-based tests for the sourceIdUtils module to verify invariants
 * across a wide range of inputs.
 *
 * Properties tested:
 * - Property 2: SourceId determinism - same inputs always produce same output
 * - Property 3: SourceId format - output matches `{type}-{12-hex-chars}` pattern
 * - Property 6: Hub key stability - same URL+branch always produces same key
 */

import * as fc from 'fast-check';
import {
  generateHubKey,
  generateHubSourceId,
} from '../../src/utils/source-id-utils';
import {
  PropertyTestConfig,
} from '../helpers/property-test-helpers';

suite('sourceIdUtils Property Tests', () => {
  /**
   * Generators for property tests
   */
  // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
  const Generators = {
    /**
     * Generate valid source types (common adapter types)
     */
    sourceType: () => fc.constantFrom('github', 'local', 'bitbucket', 'azure'),

    /**
     * Generate arbitrary source type strings (for broader coverage)
     */
    arbitrarySourceType: () => fc.string({ minLength: 1, maxLength: 20 })
      .filter((s) => s.trim().length > 0 && !s.includes(':'))
      .map((s) => s.toLowerCase().replace(/[^a-z0-9-]/g, '')),

    /**
     * Generate valid URLs for testing
     */
    url: () => fc.oneof(
      // Standard web URLs
      fc.webUrl({ validSchemes: ['http', 'https'] }),
      // GitHub-style URLs
      fc.tuple(
        fc.constantFrom('https://github.com/', 'https://bitbucket.org/'),
        fc.string({ minLength: 1, maxLength: 30 }).map((s) => s.replace(/[^a-zA-Z0-9-]/g, 'a')),
        fc.string({ minLength: 1, maxLength: 30 }).map((s) => s.replace(/[^a-zA-Z0-9-]/g, 'a'))
      ).map(([base, owner, repo]) => `${base}${owner}/${repo}`)
    ),

    /**
     * Generate branch names
     */
    branch: () => fc.oneof(
      fc.constant(undefined),
      fc.constant(''),
      fc.constant('main'),
      fc.constant('master'),
      fc.string({ minLength: 1, maxLength: 30 })
        .filter((s) => s.trim().length > 0)
        .map((s) => s.replace(/\s/g, '-'))
    )
  };

  suite('Property 2: SourceId Determinism', () => {
    /**
     * **Validates: Requirements 5.2, 5.5**
     *
     * Property: generateHubSourceId is deterministic - calling it multiple times
     * with the same inputs always produces the same output.
     *
     * This ensures lockfiles remain stable and predictable.
     */
    test('generateHubSourceId always produces same output for same inputs', () => {
      fc.assert(
        fc.property(
          Generators.sourceType(),
          Generators.url(),
          (sourceType, url) => {
            const result1 = generateHubSourceId(sourceType, url);
            const result2 = generateHubSourceId(sourceType, url);
            const result3 = generateHubSourceId(sourceType, url);

            // All calls with same inputs must produce identical output
            return result1 === result2 && result2 === result3;
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.STANDARD
        }
      );
    });

    /**
     * **Validates: Requirements 5.2, 5.5**
     *
     * Property: generateHubSourceId with arbitrary string inputs is still deterministic.
     * Tests with a broader range of source types beyond the common ones.
     */
    test('generateHubSourceId is deterministic with arbitrary source types', () => {
      fc.assert(
        fc.property(
          Generators.arbitrarySourceType(),
          Generators.url(),
          (sourceType, url) => {
            // Skip empty source types after filtering
            if (!sourceType || sourceType.length === 0) {
              return true;
            }

            const result1 = generateHubSourceId(sourceType, url);
            const result2 = generateHubSourceId(sourceType, url);

            return result1 === result2;
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.STANDARD
        }
      );
    });
  });

  suite('Property 3: SourceId Format', () => {
    /**
     * **Validates: Requirements 5.3**
     *
     * Property: generateHubSourceId output always matches the format `{type}-{12-hex-chars}`.
     * The hash portion must be exactly 12 lowercase hexadecimal characters.
     */
    test('generateHubSourceId output matches {type}-{12-hex-chars} pattern', () => {
      fc.assert(
        fc.property(
          Generators.sourceType(),
          Generators.url(),
          (sourceType, url) => {
            const result = generateHubSourceId(sourceType, url);

            // Build expected pattern: sourceType followed by hyphen and 12 hex chars
            const expectedPattern = new RegExp(`^${sourceType}-[a-f0-9]{12}$`);

            return expectedPattern.test(result);
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.STANDARD
        }
      );
    });
  });

  suite('Property 6: Hub Key Stability', () => {
    /**
     * **Validates: Requirements 4.6, 5.6**
     *
     * Property: generateHubKey is deterministic - same URL and branch always
     * produce the same key.
     */
    test('generateHubKey always produces same output for same URL and branch', () => {
      fc.assert(
        fc.property(
          Generators.url(),
          Generators.branch(),
          (url, branch) => {
            const result1 = generateHubKey(url, branch);
            const result2 = generateHubKey(url, branch);
            const result3 = generateHubKey(url, branch);

            return result1 === result2 && result2 === result3;
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.STANDARD
        }
      );
    });

    /**
     * **Validates: Requirements 4.6, 5.6**
     *
     * Property: Hub key format is correct - either 12 hex chars or 12 hex chars + branch.
     * Main/master branches should not be appended.
     */
    test('generateHubKey output has correct format', () => {
      fc.assert(
        fc.property(
          Generators.url(),
          Generators.branch(),
          (url, branch) => {
            const result = generateHubKey(url, branch);

            // If branch is main, master, empty, or undefined, should be just 12 hex chars
            if (!branch || branch === 'main' || branch === 'master' || branch === '') {
              return /^[a-f0-9]{12}$/.test(result);
            }

            // Otherwise should be 12 hex chars followed by hyphen and branch
            const expectedPattern = new RegExp(`^[a-f0-9]{12}-${escapeRegex(branch)}$`);
            return expectedPattern.test(result);
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.STANDARD
        }
      );
    });

    /**
     * **Validates: Requirements 4.6, 5.6**
     *
     * Property: The hash portion of the hub key is consistent regardless of branch.
     * This ensures the same URL always produces the same base hash.
     */
    test('generateHubKey hash portion is consistent across branches', () => {
      fc.assert(
        fc.property(
          Generators.url(),
          fc.tuple(Generators.branch(), Generators.branch()),
          (url, [branch1, branch2]) => {
            const result1 = generateHubKey(url, branch1);
            const result2 = generateHubKey(url, branch2);

            // Extract hash portion (first 12 characters)
            const hash1 = result1.substring(0, 12);
            const hash2 = result2.substring(0, 12);

            return hash1 === hash2;
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.STANDARD
        }
      );
    });

    /**
     * **Validates: Requirements 4.6**
     *
     * Property: Main and master branches produce identical keys (no branch suffix).
     */
    test('generateHubKey treats main and master branches identically', () => {
      fc.assert(
        fc.property(
          Generators.url(),
          (url) => {
            const keyMain = generateHubKey(url, 'main');
            const keyMaster = generateHubKey(url, 'master');
            const keyUndefined = generateHubKey(url, undefined);
            const keyEmpty = generateHubKey(url, '');

            // All should produce the same result (just the hash)
            return keyMain === keyMaster
              && keyMaster === keyUndefined
              && keyUndefined === keyEmpty;
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.STANDARD
        }
      );
    });
  });
});

/**
 * Helper function to escape special regex characters in a string.
 * @param str
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
