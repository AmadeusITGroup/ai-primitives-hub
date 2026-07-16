/**
 * Tests for domain/bundle/version.ts.
 *
 * Ported example coverage from the extension's
 * `test/utils/version-manager.test.ts`/`.property.test.ts`, translated
 * into Vitest since these functions no longer depend on the extension's
 * `Logger`.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  compareVersions,
  extractBundleIdentity,
  isSameBundleIdentity,
  isUpdateAvailable,
} from '../../../src/domain/bundle/version';

describe('compareVersions', () => {
  it('compares standard semver versions correctly', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
    expect(compareVersions('2.0.0', '1.0.0')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('handles versions with v prefix', () => {
    expect(compareVersions('v1.0.0', 'v2.0.0')).toBe(-1);
    expect(compareVersions('v2.0.0', 'v1.0.0')).toBe(1);
  });

  it('handles mixed format versions', () => {
    expect(compareVersions('v1.0.0', '2.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', 'v2.0.0')).toBe(-1);
  });

  it('handles pre-release versions', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
  });

  it('coerces malformed versions', () => {
    expect(compareVersions('1', '2')).toBe(-1);
    expect(compareVersions('1.0', '1.1')).toBe(-1);
  });

  it('falls back to string comparison for non-semver', () => {
    expect(compareVersions('abc', 'def')).toBe('abc'.localeCompare('def'));
  });

  it('throws for empty strings', () => {
    expect(() => compareVersions('', '1.0.0')).toThrow(/cannot be empty/);
    expect(() => compareVersions('1.0.0', '')).toThrow(/cannot be empty/);
  });

  it('throws for excessively long version strings', () => {
    const longVersion = `1.0.0-${'a'.repeat(200)}`;
    expect(() => compareVersions(longVersion, '1.0.0')).toThrow(/exceeds maximum length/);
  });

  it('ignores build metadata per semver spec', () => {
    expect(compareVersions('1.0.0+build.123', '1.0.0+build.456')).toBe(0);
  });
});

describe('isUpdateAvailable', () => {
  it('returns true when latest version is higher', () => {
    expect(isUpdateAvailable('1.0.0', '2.0.0')).toBe(true);
    expect(isUpdateAvailable('1.0.0', '1.0.1')).toBe(true);
  });

  it('returns false when versions are equal', () => {
    expect(isUpdateAvailable('1.0.0', '1.0.0')).toBe(false);
  });

  it('returns false when installed version is higher', () => {
    expect(isUpdateAvailable('2.0.0', '1.0.0')).toBe(false);
  });

  it('treats differing content-hash versions as an update', () => {
    expect(isUpdateAvailable('hash:aaa', 'hash:bbb')).toBe(true);
    expect(isUpdateAvailable('hash:aaa', 'hash:aaa')).toBe(false);
  });

  it('throws for empty versions', () => {
    expect(() => isUpdateAvailable('', '1.0.0')).toThrow(/cannot be empty/);
  });
});

describe('extractBundleIdentity', () => {
  it('extracts identity from GitHub bundle IDs with version', () => {
    expect(extractBundleIdentity('owner-repo-v1.0.0', 'github')).toBe('owner-repo');
    expect(extractBundleIdentity('microsoft-vscode-1.0.0', 'github')).toBe('microsoft-vscode');
  });

  it('handles GitHub bundle IDs with complex versions', () => {
    expect(extractBundleIdentity('owner-repo-v1.0.0-alpha', 'github')).toBe('owner-repo');
  });

  it('returns as-is for GitHub bundles without version', () => {
    expect(extractBundleIdentity('owner-repo', 'github')).toBe('owner-repo');
  });

  it('returns as-is for non-GitHub sources', () => {
    expect(extractBundleIdentity('bundle-id-v1.0.0', 'local')).toBe('bundle-id-v1.0.0');
  });

  it('throws for excessively long bundle IDs', () => {
    const longId = `${'a'.repeat(201)}-v1.0.0`;
    expect(() => extractBundleIdentity(longId, 'github')).toThrow(/exceeds maximum length/);
  });
});

describe('isSameBundleIdentity', () => {
  it('matches GitHub bundles with different versions', () => {
    expect(isSameBundleIdentity('owner-repo-v1.0.0', 'github', 'owner-repo-v2.0.0', 'github')).toBe(true);
  });

  it('does not match different GitHub repos', () => {
    expect(isSameBundleIdentity('owner-repo1-v1.0.0', 'github', 'owner-repo2-v1.0.0', 'github')).toBe(false);
  });

  it('requires exact match for non-GitHub sources', () => {
    expect(isSameBundleIdentity('bundle-v1.0.0', 'local', 'bundle-v2.0.0', 'local')).toBe(false);
    expect(isSameBundleIdentity('bundle-v1.0.0', 'local', 'bundle-v1.0.0', 'local')).toBe(true);
  });
});
