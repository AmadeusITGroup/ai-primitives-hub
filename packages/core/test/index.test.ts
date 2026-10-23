import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  buildInstalledBundleLookupKeys,
  CORE_PACKAGE_READY,
  getBundleIdentityKey,
  getBundleRefKey,
  isBundleRefInstalled,
} from '../src/index';

describe('@ai-primitives-hub/core placeholder', () => {
  it('exports a truthy readiness marker', () => {
    expect(CORE_PACKAGE_READY).toBe(true);
  });
});

describe('bundle installation overlay keys', () => {
  it('matches exact versioned bundle refs', () => {
    const keys = new Set(buildInstalledBundleLookupKeys({
      sourceId: 'src-1',
      bundleId: 'bundle-a',
      bundleVersion: '1.0.0'
    }));

    expect(keys.has(getBundleRefKey({ sourceId: 'src-1', bundleId: 'bundle-a', bundleVersion: '1.0.0' }))).toBe(true);
    expect(keys.has(getBundleIdentityKey({ sourceId: 'src-1', bundleId: 'bundle-a' }))).toBe(true);
    expect(isBundleRefInstalled({
      sourceId: 'src-1',
      bundleId: 'bundle-a',
      bundleVersion: '1.0.0'
    }, keys)).toBe(true);
  });

  it('matches when indexed bundleVersion is a commit SHA or newer semver than installed version', () => {
    const keys = new Set(buildInstalledBundleLookupKeys({
      sourceId: 'awesome-src',
      bundleId: 'collection-a',
      bundleVersion: '1.0.1'
    }));

    expect(isBundleRefInstalled({
      sourceId: 'awesome-src',
      bundleId: 'collection-a',
      bundleVersion: '9f8e7d6c5b4a32109f8e7d6c5b4a32109f8e7d6c'
    }, keys)).toBe(true);

    expect(isBundleRefInstalled({
      sourceId: 'awesome-src',
      bundleId: 'collection-a',
      bundleVersion: '1.0.2'
    }, keys)).toBe(true);

    expect(isBundleRefInstalled({
      sourceId: 'awesome-src',
      bundleId: 'collection-b',
      bundleVersion: '1.0.1'
    }, keys)).toBe(false);
  });

  it('matches legacy 3-part getBundleRefKey entries against SHA-versioned index refs', () => {
    const rawKeys = [getBundleRefKey({
      sourceId: 'github-src',
      bundleId: 'my-bundle',
      bundleVersion: '1.0.0'
    })];

    expect(isBundleRefInstalled({
      sourceId: 'github-src',
      bundleId: 'my-bundle',
      bundleVersion: 'abcdef1234567890abcdef1234567890abcdef12'
    }, rawKeys)).toBe(true);
  });

  it('matches source-level GitHub bundle refs (bundleId === sourceId) when any bundle from that source is installed', () => {
    const keys = new Set(buildInstalledBundleLookupKeys({
      sourceId: 'github-repo-source',
      bundleId: 'owner-repo-v1.2.0',
      bundleVersion: '1.2.0',
      sourceType: 'github'
    }));

    expect(isBundleRefInstalled({
      sourceId: 'github-repo-source',
      bundleId: 'github-repo-source',
      bundleVersion: 'abcdef1234567890abcdef1234567890abcdef12'
    }, keys)).toBe(true);
  });

  it('marks normalized sets and handles overlong bundle IDs without throwing', () => {
    const overlongId = `${'a'.repeat(210)}-v1.0.0`;
    const keys = buildInstalledBundleLookupKeys({
      sourceId: 'src-long',
      bundleId: overlongId,
      bundleVersion: '1.0.0'
    });
    expect(keys.length).toBeGreaterThan(0);

    expect(isBundleRefInstalled({
      sourceId: 'src-long',
      bundleId: overlongId,
      bundleVersion: '1.0.0'
    }, keys)).toBe(true);
  });
});
