/**
 * Test helpers for MarketplaceViewProvider tests
 * Provides utilities for testing button states and bundle identity matching
 */

import {
  SourceType,
} from '../../src/types/registry';
import {
  BundleIdentityMatcher,
} from '../../src/utils/bundle-identity-matcher';
import {
  VersionManager,
} from '../../src/utils/version-manager';

/**
 * Determine button state based on installation status and version comparison
 * Mirrors the logic in MarketplaceViewProvider
 * @param installedVersion
 * @param availableVersion
 */
export function determineButtonState(
    installedVersion: string | undefined,
    availableVersion: string
): 'install' | 'update' | 'uninstall' {
  if (!installedVersion) {
    return 'install';
  }

  try {
    if (VersionManager.isUpdateAvailable(installedVersion, availableVersion)) {
      return 'update';
    }
  } catch {
    // If version comparison fails, fall back to string comparison
    if (installedVersion !== availableVersion) {
      return 'update';
    }
  }

  return 'uninstall';
}

/**
 * Check if installed bundle matches marketplace bundle identity
 * Mirrors the logic in MarketplaceViewProvider
 * @param installedId
 * @param bundleId
 * @param sourceType
 */
export function matchesBundleIdentity(
    installedId: string,
    bundleId: string,
    sourceType: SourceType
): boolean {
  return BundleIdentityMatcher.matches(installedId, bundleId, sourceType);
}

/**
 * Filter bundles by search text
 * @param bundles
 * @param searchText
 */
export function filterBundlesBySearch(bundles: any[], searchText: string): any[] {
  if (!searchText || searchText.trim() === '') {
    return bundles;
  }

  const term = searchText.toLowerCase();
  return bundles.filter((bundle) =>
    bundle.name.toLowerCase().includes(term)
    || bundle.description.toLowerCase().includes(term)
    || (bundle.tags && bundle.tags.some((tag: string) => tag.toLowerCase().includes(term)))
    || (bundle.author && bundle.author.toLowerCase().includes(term))
  );
}
