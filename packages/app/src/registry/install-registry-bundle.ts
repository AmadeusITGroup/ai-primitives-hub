/**
 * Install a bundle into the registry — ported from the extension's
 * `src/services/registry-manager.ts` (`RegistryManager`'s public
 * `installBundle` plus its private `checkExistingInstallation`/
 * `getSourceForBundle`/`downloadAndInstall`/`cleanupOldVersions`
 * helpers). Builds on `resolveInstallationBundle` (Phase 4 item 4,
 * slice 2a) for the bundle-resolution half.
 *
 * Named `installRegistryBundle`, not `installBundle`, since
 * `install/install-bundle.ts` already exports an unrelated
 * `installBundle` (the generic multi-target `InstallPipeline` driver)
 * from the same package barrel — a name collision would be a compile
 * error.
 * @module registry/install-registry-bundle
 */
import type {
  Bundle,
  InstallationScope,
  InstalledBundle,
  InstallOptions,
  RegistrySource,
  SourceAdapter,
  SourceType,
} from '@ai-primitives-hub/core';
import {
  extractBundleIdentity,
  isSameBundleIdentity,
} from '@ai-primitives-hub/core';
import type {
  LogEvent,
  OnLogEvent,
} from '../update/log-event';
import type {
  ResolveInstallationBundlePorts,
} from './resolve-installation-bundle';
import {
  resolveInstallationBundle,
} from './resolve-installation-bundle';

/**
 * A `SourceAdapter` that may additionally support local-skills
 * symlink installation. `getSkillSourcePath`/`getSkillName` are
 * checked for at runtime (mirroring the extension's original duck-typed
 * `as any` check) rather than modeled as a separate adapter subtype,
 * since only one concrete adapter (`local-skills`) implements them.
 */
export type LocalSkillsCapableAdapter = SourceAdapter & {
  getSkillSourcePath?(bundle: Bundle): string;
  getSkillName?(bundle: Bundle): string;
};

/**
 * Read/write access `installRegistryBundle` needs, extending
 * `resolveInstallationBundle`'s own ports since installation always
 * starts by resolving the bundle to install.
 */
export interface InstallRegistryBundlePorts extends ResolveInstallationBundlePorts {
  getInstalledBundle(bundleId: string, scope: InstallationScope): Promise<InstalledBundle | undefined>;
  getAdapter(source: RegistrySource): LocalSkillsCapableAdapter;
  installFromBuffer(bundle: Bundle, buffer: Buffer, options: InstallOptions, sourceType: SourceType): Promise<InstalledBundle>;
  installLocalSkillAsSymlink(bundle: Bundle, skillName: string, sourcePath: string, options: InstallOptions): Promise<InstalledBundle>;
  recordInstallation(installation: InstalledBundle): Promise<void>;
  getInstalledBundles(scope: InstallationScope): Promise<InstalledBundle[]>;
  removeInstallation(bundleId: string, scope: InstallationScope): Promise<void>;
}

function log(onLog: OnLogEvent | undefined, level: LogEvent['level'], message: string, error?: Error): void {
  onLog?.({ level, message, error });
}

/**
 * Install a bundle: resolve it, check for an existing installation,
 * resolve its source, download and install (or symlink, for
 * local-skills), record the installation (skipped for repository
 * scope, lockfile-tracked instead), and clean up superseded versions.
 * @param bundleId - The bundle to install.
 * @param options - Install options (scope, version, force, profileId, commitMode).
 * @param ports - Injected read/write access to bundle/source data, adapters, and the installer.
 * @param onLog - Optional sink for diagnostic log events.
 * @returns The resulting installation record.
 */
export async function installRegistryBundle(
  bundleId: string,
  options: InstallOptions,
  ports: InstallRegistryBundlePorts,
  onLog?: OnLogEvent
): Promise<InstalledBundle> {
  log(onLog, 'info', `Installing bundle: ${bundleId}`);

  const bundle = await resolveInstallationBundle(bundleId, options, ports, onLog);
  const installOptions = await checkExistingInstallation(bundleId, bundle, options, ports, onLog);
  const source = await getSourceForBundle(bundle, ports);
  const installation = await downloadAndInstall(bundle, source, installOptions, ports, onLog);

  // Record installation FIRST (before cleanup) to ensure metadata is safe.
  // If anything fails here, old versions remain and can be used as fallback.
  // Note: Repository scope bundles are tracked via LockfileManager, not RegistryStorage;
  // the lockfile is already updated by the installer during installation.
  if (options.scope !== 'repository') {
    await ports.recordInstallation(installation);
  }

  // Clean up old versions AFTER successful recording, so a failed cleanup
  // never loses the newly-recorded installation.
  await cleanupOldVersions(bundle, options.scope, ports, onLog);

  log(onLog, 'info', `Bundle '${bundleId}' installed successfully`);

  return installation;
}

/**
 * Check existing installation and determine if installation should proceed.
 * Returns modified options if a version change is detected.
 * @param bundleId
 * @param bundle
 * @param options
 * @param ports
 * @param onLog
 */
async function checkExistingInstallation(
  bundleId: string,
  bundle: Bundle,
  options: InstallOptions,
  ports: InstallRegistryBundlePorts,
  onLog: OnLogEvent | undefined
): Promise<InstallOptions> {
  const existing = await ports.getInstalledBundle(bundleId, options.scope);

  if (!existing || options.force) {
    return options;
  }

  if (existing.version !== bundle.version) {
    log(onLog, 'info', `Version change detected: ${existing.version} → ${bundle.version}`);
    return { ...options, force: true };
  }

  throw new Error(`Bundle '${bundleId}' is already installed. Use force=true to reinstall.`);
}

async function getSourceForBundle(bundle: Bundle, ports: InstallRegistryBundlePorts): Promise<RegistrySource> {
  const sources = await ports.listSources();
  const source = sources.find((s) => s.id === bundle.sourceId);

  if (!source) {
    throw new Error(`Source '${bundle.sourceId}' not found`);
  }

  return source;
}

/**
 * Download and install a bundle (or symlink it, for local-skills).
 * @param bundle
 * @param source
 * @param options
 * @param ports
 * @param onLog
 */
async function downloadAndInstall(
  bundle: Bundle,
  source: RegistrySource,
  options: InstallOptions,
  ports: InstallRegistryBundlePorts,
  onLog: OnLogEvent | undefined
): Promise<InstalledBundle> {
  const adapter = ports.getAdapter(source);

  // For local-skills, use symlink installation instead of copying
  if (source.type === 'local-skills') {
    log(onLog, 'debug', `Installing local skill as symlink from ${source.type} adapter`);

    if (typeof adapter.getSkillSourcePath === 'function' && typeof adapter.getSkillName === 'function') {
      const skillSourcePath = adapter.getSkillSourcePath(bundle);
      const skillName = adapter.getSkillName(bundle);

      const localSkillSymlink = await ports.installLocalSkillAsSymlink(bundle, skillName, skillSourcePath, options);

      // Ensure sourceId and sourceType are set
      localSkillSymlink.sourceId = bundle.sourceId;
      localSkillSymlink.sourceType = source.type;

      if (options.profileId) {
        localSkillSymlink.profileId = options.profileId;
      }

      return localSkillSymlink;
    }
    // Fall through to standard installation if methods not available
    log(onLog, 'warn', 'LocalSkillsAdapter missing symlink methods, falling back to standard installation');
  }

  // Unified download path: all adapters use downloadBundle()
  log(onLog, 'debug', `Downloading bundle from ${source.type} adapter`);
  const bundleBuffer = await adapter.downloadBundle(bundle);
  log(onLog, 'debug', `Bundle downloaded: ${bundleBuffer.length} bytes`);

  // Install from buffer
  const installation = await ports.installFromBuffer(bundle, bundleBuffer, options, source.type);

  // Add profileId if provided
  if (options.profileId) {
    installation.profileId = options.profileId;
  }

  // Ensure sourceId and sourceType are set for identity matching
  installation.sourceId = bundle.sourceId;
  installation.sourceType = source.type;

  return installation;
}

/**
 * Clean up old versions of a bundle when a new version is installed.
 * Handles downgrades and version changes by removing previous
 * installation records. Failures are logged, not thrown - the new
 * version is already installed by the time this runs.
 * @param bundle
 * @param scope
 * @param ports
 * @param onLog
 */
async function cleanupOldVersions(
  bundle: Bundle,
  scope: InstallationScope,
  ports: InstallRegistryBundlePorts,
  onLog: OnLogEvent | undefined
): Promise<void> {
  // Repository scope cleanup is handled by LockfileManager
  if (scope === 'repository') {
    return;
  }
  try {
    const source = await getSourceForBundle(bundle, ports);
    const sourceType = source.type;

    const baseIdentity = extractBundleIdentity(bundle.id, sourceType);

    // Get all installed bundles in this scope, filtered early by sourceId
    const allInstalled = await ports.getInstalledBundles(scope);
    const candidateBundles = allInstalled.filter((installed) => installed.sourceId === bundle.sourceId);

    // Find all installations that match this bundle's identity
    const oldInstallations = candidateBundles.filter((installed) => {
      const installedSourceType = (installed.sourceType as SourceType) || 'github';
      return isSameBundleIdentity(installed.bundleId, installedSourceType, bundle.id, sourceType)
        && installed.version !== bundle.version;
    });

    for (const oldInstall of oldInstallations) {
      log(onLog, 'debug', `Removing old version ${oldInstall.version} of bundle ${baseIdentity}`);
      await ports.removeInstallation(oldInstall.bundleId, scope);
    }

    if (oldInstallations.length > 0) {
      log(onLog, 'info', `Cleaned up ${oldInstallations.length} old version(s) of bundle ${baseIdentity}`);
    }
  } catch (error) {
    log(onLog, 'warn', `Failed to cleanup old versions: ${error instanceof Error ? error.message : String(error)}`);
  }
}
