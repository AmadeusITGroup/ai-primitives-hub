/**
 * Domain layer — hub profile bundle requirements.
 *
 * A profile bundle marked `required: true` must be installed for the
 * profile to count as activated; optional bundles may be missing.
 * @module domain/hub/profile-requirements
 */
import type {
  HubProfileBundle,
} from './types';

/**
 * List the required profile bundles that were not installed.
 * @param bundles - Bundles declared by the profile.
 * @param installedBundleIds - Ids of the bundles that are installed after the activation attempt.
 * @returns Ids of required bundles missing from `installedBundleIds`, in profile order.
 */
export function findMissingRequiredBundles(
  bundles: readonly HubProfileBundle[],
  installedBundleIds: Iterable<string>
): string[] {
  const installed = new Set(installedBundleIds);
  return bundles
    .filter((bundle) => bundle.required && !installed.has(bundle.id))
    .map((bundle) => bundle.id);
}
