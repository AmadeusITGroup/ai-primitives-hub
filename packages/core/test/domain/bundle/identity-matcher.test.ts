/**
 * Tests for domain/bundle/identity-matcher.ts.
 *
 * Ported example coverage from the JSDoc examples/behavior of the
 * extension's `src/utils/bundle-identity-matcher.ts` (`BundleIdentityMatcher`),
 * which had no dedicated unit test file of its own (only exercised
 * indirectly via `test/helpers/marketplace-test-helpers.ts`).
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  bundleIdentitiesMatch,
  bundleIdHasVersionSuffix,
  extractBaseBundleId,
  VERSION_SUFFIX_REGEX,
} from '../../../src/domain/bundle/identity-matcher';

describe('bundleIdentitiesMatch', () => {
  it('matches GitHub bundles by identity, ignoring version', () => {
    expect(bundleIdentitiesMatch('owner-repo-v1.0.0', 'owner-repo-v2.0.0', 'github')).toBe(true);
  });

  it('does not match different GitHub repos', () => {
    expect(bundleIdentitiesMatch('owner-repo1-v1.0.0', 'owner-repo2-v1.0.0', 'github')).toBe(false);
  });

  it('requires an exact match for non-GitHub sources', () => {
    expect(bundleIdentitiesMatch('local-bundle-v1.0.0', 'local-bundle-v2.0.0', 'local')).toBe(false);
    expect(bundleIdentitiesMatch('local-bundle-v1.0.0', 'local-bundle-v1.0.0', 'local')).toBe(true);
  });
});

describe('extractBaseBundleId', () => {
  it('strips a version suffix', () => {
    expect(extractBaseBundleId('my-bundle-v1.0.0')).toBe('my-bundle');
  });

  it('strips a version suffix without the v prefix', () => {
    expect(extractBaseBundleId('my-bundle-1.2.3')).toBe('my-bundle');
  });

  it('returns the id unchanged when there is no version suffix', () => {
    expect(extractBaseBundleId('my-bundle')).toBe('my-bundle');
  });
});

describe('bundleIdHasVersionSuffix', () => {
  it('returns true when a version suffix is present', () => {
    expect(bundleIdHasVersionSuffix('my-bundle-v1.0.0')).toBe(true);
  });

  it('returns false when no version suffix is present', () => {
    expect(bundleIdHasVersionSuffix('my-bundle')).toBe(false);
  });
});

describe('VERSION_SUFFIX_REGEX', () => {
  it('is exported for callers that need the raw pattern', () => {
    expect(VERSION_SUFFIX_REGEX.test('bundle-v1.0.0')).toBe(true);
  });
});
