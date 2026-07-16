/**
 * Uninstall an installed bundle — ported from the extension's
 * `src/services/registry-manager.ts` (`RegistryManager.uninstallBundle`).
 *
 * Named `uninstallInstalledBundle`, not `uninstallBundle`, to avoid
 * colliding with `install/uninstall-bundle.ts`'s `uninstallBundle` at
 * this package's barrel: that one drives the generic multi-target
 * `UninstallPipeline` (`BundleSpec`/`Target`/`FileSystem`), this one is
 * the extension's own `Bundle`/`RegistrySource`/`BundleInstaller`-shaped
 * orchestration — the two are unrelated despite the similar name.
 *
 * Repository-scoped installs are lockfile-backed (via `LockfileManager`,
 * not yet ported) so, like `list-installed-bundles.ts`, this module
 * keeps that resolution as a caller-supplied, deliberately opaque port
 * (`getRepositoryInstalledBundles`) rather than depending on it directly.
 * @module registry/uninstall-installed-bundle
 */
import type {
  InstallationScope,
  InstalledBundle,
  RegistrySource,
} from '@ai-primitives-hub/core';
import type {
  LogEvent,
  OnLogEvent,
} from '../update/log-event';

/**
 * Read/write access `uninstallInstalledBundle` needs: locating the
 * installation record (repository scope via the lockfile-backed port,
 * user/workspace via the storage port), resolving the owning source (to
 * detect the local-skills symlink special case), performing the actual
 * removal, and clearing the installation record.
 */
export interface UninstallInstalledBundlePorts {
  getInstalledBundle(bundleId: string, scope: InstallationScope): Promise<InstalledBundle | undefined>;
  getRepositoryInstalledBundles(): Promise<InstalledBundle[]>;
  listSources(): Promise<RegistrySource[]>;
  uninstall(installed: InstalledBundle): Promise<void>;
  uninstallSkillSymlink(installed: InstalledBundle): Promise<void>;
  removeInstallation(bundleId: string, scope: InstallationScope): Promise<void>;
}

/**
 * Uninstall a single installed bundle: locate its installation record,
 * remove its files (symlink removal for local-skills, the generic
 * uninstall port otherwise), and clear the installation record (skipped
 * for repository scope, whose lockfile is already updated by the
 * `uninstall`/`uninstallSkillSymlink` port call itself).
 * @param bundleId - The bundle to uninstall.
 * @param scope - Installation scope to uninstall from.
 * @param ports - Injected read/write access to storage, sources, and the installer.
 * @param onLog - Optional sink for diagnostic log events.
 * @returns The installation record that was removed.
 */
export async function uninstallInstalledBundle(
  bundleId: string,
  scope: InstallationScope,
  ports: UninstallInstalledBundlePorts,
  onLog?: OnLogEvent
): Promise<InstalledBundle> {
  const log = (level: LogEvent['level'], message: string, error?: Error): void => {
    onLog?.({ level, message, error });
  };

  log('info', `Uninstalling bundle: ${bundleId}`);

  const installed = scope === 'repository'
    ? (await ports.getRepositoryInstalledBundles()).find((b) => b.bundleId === bundleId)
    : await ports.getInstalledBundle(bundleId, scope);

  if (!installed) {
    throw new Error(`Bundle '${bundleId}' is not installed in ${scope} scope`);
  }

  let source: RegistrySource | undefined;
  if (installed.sourceId) {
    const sources = await ports.listSources();
    source = sources.find((s) => s.id === installed.sourceId);
  }

  if (installed.sourceType === 'local-skills' || source?.type === 'local-skills') {
    log('debug', `Uninstalling local skill symlink: ${bundleId}`);
    await ports.uninstallSkillSymlink(installed);
  } else {
    await ports.uninstall(installed);
  }

  if (scope !== 'repository') {
    await ports.removeInstallation(installed.bundleId, scope);
  }

  log('info', `Bundle '${installed.bundleId}' uninstalled successfully`);
  return installed;
}
