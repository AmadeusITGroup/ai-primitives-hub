/**
 * Resolve the exact `Bundle` to install for a given bundle ID + install
 * options — ported from the extension's
 * `src/services/registry-manager.ts` (`RegistryManager`'s private
 * `resolveInstallationBundle`/`tryGetExactVersionedBundle`/
 * `resolveByIdentity`/`determineSearchId`/`applyVersionOverride` chain).
 *
 * Handles three request shapes:
 * - A plain bundle ID, no version: resolved as-is via `getBundleDetails`.
 * - An already-versioned bundle ID (e.g. a GitHub `owner-repo-v1.2.3`)
 *   with a matching `options.version`: returned directly once found and
 *   confirmed to match, without a second lookup.
 * - A version-specific request against an identity (e.g. install
 *   `owner-repo` at `1.2.3` specifically): resolved via the owning
 *   source's cached bundle list (to determine its `SourceType` for
 *   identity extraction), then `getBundleVersion` for that exact
 *   version's download/manifest URLs.
 * @module registry/resolve-installation-bundle
 */
import type {
  Bundle,
  InstallOptions,
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  bundleIdHasVersionSuffix,
  extractBundleIdentity,
} from '@ai-primitives-hub/core';
import type {
  LogEvent,
  OnLogEvent,
} from '../update/log-event';
import type {
  BundleVersion,
} from './version-consolidator';

/**
 * Read access `resolveInstallationBundle` needs: bundle lookup by ID,
 * source listing (to resolve a `SourceType` for identity extraction),
 * each source's cached bundle list (to locate which source a plain
 * bundle ID belongs to), and specific-version metadata lookup (backed
 * by the caller's `VersionConsolidator` instance — kept as an opaque,
 * synchronous port here rather than depending on that class directly).
 */
export interface ResolveInstallationBundlePorts {
  getBundleDetails(bundleId: string): Promise<Bundle>;
  listSources(): Promise<RegistrySource[]>;
  getCachedSourceBundles(sourceId: string): Promise<Bundle[]>;
  getBundleVersion(bundleIdentity: string, version: string): BundleVersion | undefined;
}

/**
 * Resolve the bundle to install, handling version-specific requests.
 * @param bundleId - Requested bundle ID (may already include a version suffix).
 * @param options - Install options; notably `options.version` if a specific version was requested.
 * @param ports - Injected read access to bundle/source data and version metadata.
 * @param onLog - Optional sink for diagnostic log events.
 * @returns The resolved `Bundle` to install.
 */
export async function resolveInstallationBundle(
  bundleId: string,
  options: InstallOptions,
  ports: ResolveInstallationBundlePorts,
  onLog?: OnLogEvent
): Promise<Bundle> {
  // Try exact versioned bundle first if applicable
  if (options.version && bundleIdHasVersionSuffix(bundleId)) {
    const exactBundle = await tryGetExactVersionedBundle(bundleId, options.version, ports, onLog);
    if (exactBundle) {
      return exactBundle;
    }
  }

  // Fall back to identity-based search
  return resolveByIdentity(bundleId, options, ports, onLog);
}

function log(onLog: OnLogEvent | undefined, level: LogEvent['level'], message: string, error?: Error): void {
  onLog?.({ level, message, error });
}

/**
 * Try to get an exact versioned bundle. Returns `null` (not a rejected
 * promise) if not found or the version doesn't match, so the caller can
 * fall back to identity-based search without a try/catch of its own.
 * @param bundleId
 * @param version
 * @param ports
 * @param onLog
 */
async function tryGetExactVersionedBundle(
  bundleId: string,
  version: string,
  ports: ResolveInstallationBundlePorts,
  onLog: OnLogEvent | undefined
): Promise<Bundle | null> {
  try {
    const bundle = await ports.getBundleDetails(bundleId);
    if (bundle.version === version) {
      return bundle;
    }
    log(onLog, 'debug', `Bundle ${bundleId} found but version mismatch: ${bundle.version} !== ${version}`);
    return null;
  } catch {
    log(onLog, 'debug', `Exact bundle ${bundleId} not found, trying identity-based search`);
    return null;
  }
}

async function resolveByIdentity(
  bundleId: string,
  options: InstallOptions,
  ports: ResolveInstallationBundlePorts,
  onLog: OnLogEvent | undefined
): Promise<Bundle> {
  const searchId = await determineSearchId(bundleId, options, ports);
  let bundle = await ports.getBundleDetails(searchId);

  if (options.version) {
    bundle = await applyVersionOverride(bundle, bundleId, options.version, ports, onLog);
  }

  return bundle;
}

async function determineSearchId(
  bundleId: string,
  options: InstallOptions,
  ports: ResolveInstallationBundlePorts
): Promise<string> {
  if (!options.version) {
    return bundleId;
  }

  // For version-specific requests, try to extract identity
  const sources = await ports.listSources();
  for (const source of sources) {
    const cachedBundles = await ports.getCachedSourceBundles(source.id);
    const matchingBundle = cachedBundles.find((b) => b.id === bundleId);
    if (matchingBundle) {
      return extractBundleIdentity(bundleId, source.type);
    }
  }

  return bundleId;
}

async function applyVersionOverride(
  bundle: Bundle,
  originalBundleId: string,
  requestedVersion: string,
  ports: ResolveInstallationBundlePorts,
  onLog: OnLogEvent | undefined
): Promise<Bundle> {
  const sources = await ports.listSources();
  const source = sources.find((s) => s.id === bundle.sourceId);

  if (!source) {
    log(onLog, 'warn', 'Source not found for version override, using latest');
    return bundle;
  }

  const identity = extractBundleIdentity(originalBundleId, source.type);
  const specificVersion = ports.getBundleVersion(identity, requestedVersion);

  if (specificVersion) {
    log(onLog, 'info', `Installing specific version ${requestedVersion} instead of latest ${bundle.version}`);
    // Use the original bundle ID from the version cache to preserve the correct format
    // (e.g., owner-repo-v1.0.0 instead of owner-repo-1.0.0)
    return {
      ...bundle,
      id: specificVersion.bundleId,
      version: specificVersion.version,
      downloadUrl: specificVersion.downloadUrl,
      manifestUrl: specificVersion.manifestUrl,
      lastUpdated: specificVersion.publishedAt
    };
  }

  log(onLog, 'warn', `Requested version ${requestedVersion} not found, using latest ${bundle.version}`);
  return bundle;
}
