/**
 * Update an installed bundle — ported from the extension's
 * `src/services/registry-manager.ts` (`RegistryManager.updateBundle`).
 *
 * The interactive "local modifications" warning dialog
 * (`checkLocalModificationsBeforeUpdate` in the original) stays
 * entirely in the extension — it drives VS Code warning dialogs and
 * `LockfileManager`, neither of which are portable — and is injected
 * here as the optional `checkLocalModifications` port, called at the
 * exact point in the sequence the original called it: after resolving
 * the current installation, before resolving the new bundle version.
 * @module registry/update-registry-bundle
 */
import type {
  Bundle,
  InstallationScope,
  InstalledBundle,
  RegistrySource,
  SourceAdapter,
  SourceType,
} from '@ai-primitives-hub/core';
import {
  extractBundleIdentity,
} from '@ai-primitives-hub/core';
import type {
  LogEvent,
  OnLogEvent,
} from '../update/log-event';

/** Read/write access `updateRegistryBundle` needs. */
export interface UpdateRegistryBundlePorts {
  listInstalledBundles(): Promise<InstalledBundle[]>;
  checkLocalModifications?(bundleId: string, current: InstalledBundle): Promise<void>;
  getBundleDetails(bundleId: string): Promise<Bundle>;
  listSources(): Promise<RegistrySource[]>;
  getAdapter(source: RegistrySource): SourceAdapter;
  updateInstalledBundle(current: InstalledBundle, bundle: Bundle, bundleBuffer: Buffer, sourceType: SourceType): Promise<InstalledBundle>;
  recordInstallation(installation: InstalledBundle): Promise<void>;
  removeInstallation(bundleId: string, scope: InstallationScope): Promise<void>;
}

function log(onLog: OnLogEvent | undefined, level: LogEvent['level'], message: string, error?: Error): void {
  onLog?.({ level, message, error });
}

/**
 * Update an installed bundle to the latest (or a specific) version.
 * @param bundleId - The currently-installed bundle to update.
 * @param version - Optional specific version to update to; defaults to latest.
 * @param ports - Injected read/write access to installed bundles, sources, adapters, and the installer.
 * @param onLog - Optional sink for diagnostic log events.
 * @returns The resulting installation record.
 */
export async function updateRegistryBundle(
  bundleId: string,
  version: string | undefined,
  ports: UpdateRegistryBundlePorts,
  onLog?: OnLogEvent
): Promise<InstalledBundle> {
  log(onLog, 'info', `Updating bundle: ${bundleId} to version: ${version || 'latest'}`);

  // Get current installation - use listInstalledBundles to include repository-scoped bundles
  const allInstalled = await ports.listInstalledBundles();
  const current = allInstalled.find((b) => b.bundleId === bundleId);

  if (!current) {
    throw new Error(`Bundle '${bundleId}' is not installed`);
  }

  // For repository-scoped bundles, check for local modifications before updating
  await ports.checkLocalModifications?.(bundleId, current);

  const bundle = await resolveUpdateTargetBundle(bundleId, current, version, ports, onLog);

  // Check if update is needed
  if (current.version === bundle.version) {
    log(onLog, 'info', `Bundle '${bundleId}' is already at version ${bundle.version}, reinstalling...`);
    // Continue with reinstall instead of returning early
  }

  // Get source and adapter
  const sources = await ports.listSources();
  const source = sources.find((s) => s.id === bundle.sourceId);

  if (!source) {
    throw new Error(`Source '${bundle.sourceId}' not found`);
  }

  const adapter = ports.getAdapter(source);

  // Unified download path: use downloadBundle() for all sources
  log(onLog, 'debug', `Downloading bundle update from ${source.type} adapter`);
  const bundleBuffer = await adapter.downloadBundle(bundle);
  log(onLog, 'debug', `Bundle downloaded: ${bundleBuffer.length} bytes`);

  // Update using the installer
  const updated = await ports.updateInstalledBundle(current, bundle, bundleBuffer, source.type);

  // CRITICAL: Write new installation record first, then remove old record.
  // This ordering ensures crash-safety - if removal fails, we have the new
  // record; if the write fails, the old record remains intact.
  // Note: Repository scope bundles are tracked via LockfileManager, not
  // RegistryStorage; the lockfile is already updated by the installer during
  // update.
  log(onLog, 'debug', `Recording new installation for '${updated.bundleId}' v${updated.version}`);
  if (current.scope !== 'repository') {
    await ports.recordInstallation(updated);
  }

  // Only remove old record if bundleId changed (e.g., GitHub bundles with
  // version in ID). For Awesome Copilot bundles, the bundleId doesn't
  // include version, so old and new are the same - in that case,
  // recordInstallation already overwrote the old record.
  if (updated.bundleId !== bundleId && current.scope !== 'repository') {
    log(onLog, 'debug', `Removing old installation record for '${bundleId}' from ${current.scope} scope`);
    await ports.removeInstallation(bundleId, current.scope);
  } else {
    log(onLog, 'debug', `BundleId unchanged ('${bundleId}'), old record already overwritten`);
  }

  log(onLog, 'info', `Bundle '${bundleId}' updated from v${current.version} to v${bundle.version}`);

  return updated;
}

/**
 * Resolve the bundle to update to: a specific version if requested,
 * otherwise the latest — with a two-tier identity/exact-id fallback
 * at each step, mirroring the original's nested try/catch chain.
 * @param bundleId - The currently-installed bundle id (may itself embed a version suffix).
 * @param current - The current installation record, used to determine the identity-extraction strategy.
 * @param version - Optional specific version to resolve; defaults to latest.
 * @param ports - Injected bundle-lookup access.
 * @param onLog - Optional sink for diagnostic log events.
 */
async function resolveUpdateTargetBundle(
  bundleId: string,
  current: InstalledBundle,
  version: string | undefined,
  ports: UpdateRegistryBundlePorts,
  onLog: OnLogEvent | undefined
): Promise<Bundle> {
  // Extract identity for GitHub bundles to find the latest version
  const identity = current.sourceType === 'github'
    ? extractBundleIdentity(bundleId, 'github')
    : bundleId.replace(/-v?\d+\.\d+\.\d+(-[\w.]+)?$/, '');

  if (version) {
    // Search for the specific version
    const versionedId = `${identity}-${version}`;

    try {
      return await ports.getBundleDetails(versionedId);
    } catch {
      // If versioned ID not found, try the identity
      log(onLog, 'warn', `Bundle '${versionedId}' not found, trying identity '${identity}'`);
      const bundle = await ports.getBundleDetails(identity);
      // Verify the version matches
      if (bundle.version !== version) {
        throw new Error(`Requested version ${version} not found for bundle '${identity}'`);
      }
      return bundle;
    }
  }

  // Try to get bundle by identity first (for GitHub bundles with versions)
  try {
    const bundle = await ports.getBundleDetails(identity);
    log(onLog, 'debug', `Found bundle by identity: ${identity} -> ${bundle.id} v${bundle.version}`);
    return bundle;
  } catch {
    // Fall back to exact bundleId if identity lookup fails
    log(onLog, 'debug', `Identity lookup failed for '${identity}', trying exact bundleId '${bundleId}'`);
    return await ports.getBundleDetails(bundleId);
  }
}
