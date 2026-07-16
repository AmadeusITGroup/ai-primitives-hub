/**
 * Raw update detection — ported from the extension's
 * `src/services/registry-manager.ts` (`RegistryManager.checkUpdates`).
 * Compares each installed bundle's version against its source's latest
 * known version, falling back to GitHub bundle-identity resolution when
 * a versioned bundle ID is no longer directly resolvable (e.g. a
 * source's cached bundle list has moved on to a newer version).
 *
 * Distinct from `../update/check-updates.ts`'s `UpdateCheckerCore`,
 * which wraps *this* raw diff with caching and per-bundle preference
 * enrichment: `RegistryManager.checkUpdates()` (the very method
 * `UpdateCheckerCore` calls through its `registry: UpdateRegistryReader`
 * port) is now a thin delegator to `detectBundleUpdates` below.
 * @module registry/detect-updates
 */
import {
  extractBundleIdentity,
} from '@ai-primitives-hub/core';
import type {
  Bundle,
  BundleUpdate,
  UpdateDetectionReader,
} from '@ai-primitives-hub/core';
import type {
  LogEvent,
  OnLogEvent,
} from '../update/log-event';

/**
 * Compare every installed bundle's version against its source's latest
 * known version, returning only the ones that differ. Per-bundle
 * failures (network errors, a bundle no longer resolvable at all) are
 * logged and skipped rather than failing the whole check.
 * @param ports - Read access to bundle details, sources, and installation records.
 * @param onLog - Optional sink for diagnostic log events.
 */
export async function detectBundleUpdates(
  ports: UpdateDetectionReader,
  onLog?: OnLogEvent
): Promise<BundleUpdate[]> {
  const log = (level: LogEvent['level'], message: string, error?: Error): void => {
    onLog?.({ level, message, error });
  };

  log('info', 'Checking for bundle updates');

  const installed = await ports.getInstalledBundles();
  const updates: BundleUpdate[] = [];

  for (const bundle of installed) {
    try {
      // Try to get bundle details, handling versioned IDs that may not exist in consolidated list
      let latest: Bundle;
      try {
        latest = await ports.getBundleDetails(bundle.bundleId);
      } catch (error) {
        // If versioned ID not found, try extracting identity for GitHub bundles
        const sources = await ports.listSources();
        // Try both scopes to find the installed bundle
        let installedBundle = await ports.getInstalledBundle(bundle.bundleId, 'user');
        if (!installedBundle) {
          installedBundle = await ports.getInstalledBundle(bundle.bundleId, 'workspace');
        }
        const source = sources.find((s) => s.id === installedBundle?.sourceId);

        if (source?.type === 'github') {
          const identity = extractBundleIdentity(bundle.bundleId, 'github');
          log('debug', `Versioned bundle '${bundle.bundleId}' not found, trying identity '${identity}'`);
          latest = await ports.getBundleDetails(identity);
        } else {
          throw error; // Re-throw if not a GitHub bundle
        }
      }

      if (latest.version !== bundle.version) {
        updates.push({
          bundleId: bundle.bundleId,
          currentVersion: bundle.version,
          latestVersion: latest.version
        });
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log('error', `Failed to check update for '${bundle.bundleId}'`, err);
    }
  }

  log('info', `Found ${updates.length} bundle updates`);
  return updates;
}
