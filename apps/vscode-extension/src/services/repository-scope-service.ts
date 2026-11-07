/**
 * Repository Scope Service
 *
 * Installs and uninstalls repository-scope bundles through the shared
 * `app` use cases (`applyBundleInstall`, `applyBundleUninstall`), so the
 * files land where the CLI puts them, under the CLI's names, and the
 * lockfile entries match the CLI's. Placement, naming, entry building and
 * the uninstall guards live in `app`; this service only wires the host's
 * target, the workspace lockfiles and its git exclusion list.
 * Supports both commit mode (tracked by Git) and local-only mode (excluded via .git/info/exclude).
 *
 * Requirements: 1.2-1.7, 3.1-3.7, 7.8-7.10, 10.1-10.6
 */

import {
  applyBundleInstall,
  applyBundleUninstall,
  planBundleInstall,
  switchRecordedCommitMode,
} from '@ai-primitives-hub/app';
import type {
  ApplyBundleInstallResult,
  ApplyBundleUninstallResult,
} from '@ai-primitives-hub/app';
import type {
  TargetType,
} from '@ai-primitives-hub/core';
import {
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import {
  RegistryStorage,
} from '../storage/registry-storage';
import {
  RepositoryCommitMode,
} from '../types/registry';
import {
  detectHostApp,
} from '../utils/host-app';
import {
  Logger,
} from '../utils/logger';
import {
  createExtensionWriterFactory,
  repositoryExclusion,
  repositoryTarget,
} from './app-install-context';
import {
  LockfileManager,
} from './lockfile-manager';
import {
  LockfileManagerRecordStore,
} from './lockfile-record-store';
import {
  IScopeService,
  SyncBundleInstall,
  SyncBundleOptions,
  UnsyncBundleOptions,
} from './scope-service';

const LOG_PREFIX = '[RepositoryScopeService]';

/**
 * Service to sync bundle files to the host-appropriate repository directories
 * (`.github/` for VS Code, `.kiro/` for Kiro, `.windsurf/` for Windsurf, …).
 * Implements IScopeService for consistent scope handling.
 */
export class RepositoryScopeService implements IScopeService {
  private readonly logger: Logger;
  private readonly workspaceRoot: string;
  private readonly storage: RegistryStorage;
  private readonly targetType: TargetType;

  /**
   * Create a new RepositoryScopeService
   * @param workspaceRoot - The root directory of the workspace/repository
   * @param storage - RegistryStorage instance for looking up bundle metadata
   * @param targetType - Host editor target type; detected from the running
   *   editor by default, injectable for tests. Determines the host-appropriate
   *   destination layout (VS Code -> .github, Kiro -> .kiro, etc.).
   */
  constructor(workspaceRoot: string, storage: RegistryStorage, targetType?: TargetType) {
    this.workspaceRoot = workspaceRoot;
    this.storage = storage;
    this.logger = Logger.getInstance();
    this.targetType = targetType ?? detectHostApp();
    this.logger.debug(`${LOG_PREFIX} Detected host app target type: ${this.targetType}`);
  }

  private requireInstall(options: SyncBundleOptions | undefined): SyncBundleInstall {
    if (options?.install === undefined) {
      throw new Error('Repository-scope sync needs the extracted bundle; reinstall the bundle');
    }
    return options.install;
  }

  private async commitModeOf(bundleId: string, options: SyncBundleOptions | undefined): Promise<RepositoryCommitMode> {
    if (options?.commitMode) {
      return options.commitMode;
    }
    const installedBundle = await this.storage.getInstalledBundle(bundleId, 'repository');
    return installedBundle?.commitMode ?? 'commit';
  }

  private warnNoRepository(): void {
    this.logger.warn(`${LOG_PREFIX} No git repository at ${this.workspaceRoot}; local-only files are not excluded from git`);
  }

  /**
   * Install a bundle from its extracted archive through the shared install.
   * A bundle with content the host cannot install is rejected
   * (`BUNDLE.UNSUPPORTED_CONTENT`) before anything is written.
   * Implements IScopeService.syncBundle
   * @param bundleId - The unique identifier of the bundle
   * @param _bundlePath - The bundle cache directory (unused: the install reads `options.install`)
   * @param options - Commit mode and the extracted bundle
   * @returns The shared install's outcome
   * @throws {Error} when `options.install` is missing, the content is rejected, or the lockfile can't be written
   */
  public async syncBundle(bundleId: string, _bundlePath: string, options?: SyncBundleOptions): Promise<ApplyBundleInstallResult> {
    const install = this.requireInstall(options);
    const commitMode = await this.commitModeOf(bundleId, options);
    this.logger.debug(`${LOG_PREFIX} Installing ${bundleId} (${commitMode}) into ${this.workspaceRoot}`);

    const result = await applyBundleInstall({
      writerFactory: createExtensionWriterFactory(this.workspaceRoot),
      target: repositoryTarget(this.workspaceRoot, commitMode, this.targetType),
      files: install.files,
      manifest: install.manifest,
      key: bundleId,
      origin: install.origin,
      source: install.source,
      store: new LockfileManagerRecordStore(LockfileManager.getInstance(this.workspaceRoot)),
      exclusion: repositoryExclusion(this.workspaceRoot),
      fs: new NodeFileSystem(),
      preserveModified: true,
      skipUnsupported: install.skipUnsupported === true
    });

    for (const written of result.written) {
      this.logger.debug(`${LOG_PREFIX} Written: ${written}`);
    }
    for (const superseded of result.superseded) {
      this.logger.debug(`${LOG_PREFIX} Removed superseded file: ${superseded}`);
    }
    for (const kept of result.supersededKept) {
      this.logger.info(`${LOG_PREFIX} Kept superseded file ${kept.path} (${kept.reason})`);
    }
    if (result.supersededUnresolvable !== undefined) {
      this.logger.warn(`${LOG_PREFIX} Files of the previous install of ${bundleId} were kept: ${result.supersededUnresolvable}`);
    }
    for (const error of result.errors) {
      this.logger.warn(`${LOG_PREFIX} Failed to remove superseded file ${error.path}: ${error.message}`);
    }
    if (result.exclusionSkipped) {
      this.warnNoRepository();
    }
    for (const message of result.exclusionErrors) {
      this.logger.warn(`${LOG_PREFIX} Failed to update git exclude for ${bundleId}: ${message}`);
    }
    if (result.entry.files.length === 0) {
      this.logger.warn(`${LOG_PREFIX} ${bundleId}: no installable items for ${this.targetType}`);
    }

    this.logger.info(`${LOG_PREFIX} ✅ Installed ${result.written.length} files for bundle: ${bundleId}`);
    return result;
  }

  /**
   * Check that the bundle can be installed on this host, writing nothing.
   * @param bundleId - The unique identifier of the bundle
   * @param options - The options `syncBundle` will get
   * @throws {Error} as `syncBundle` would for content the host cannot install
   */
  public async preflightBundle(bundleId: string, options: SyncBundleOptions): Promise<void> {
    const install = this.requireInstall(options);
    const target = repositoryTarget(this.workspaceRoot, await this.commitModeOf(bundleId, options), this.targetType);
    await planBundleInstall(
      createExtensionWriterFactory(this.workspaceRoot)(target),
      target,
      install.files,
      install.manifest,
      { skipUnsupported: install.skipUnsupported === true }
    );
  }

  /**
   * Remove the files the lockfile records for a bundle through the shared
   * uninstall: a file another bundle holds or the user modified is kept, a
   * path outside the workspace is refused, empty directories are pruned and
   * local-only lines leave git exclude. The entry is removed in every case.
   * Implements IScopeService.unsyncBundle
   * @param bundleId - The unique identifier of the bundle to unsync
   * @param _options - Unused at repository scope
   * @returns The shared uninstall's outcome
   * @throws {Error} when the lockfile entry cannot be removed
   */
  public async unsyncBundle(bundleId: string, _options?: UnsyncBundleOptions): Promise<ApplyBundleUninstallResult> {
    this.logger.debug(`${LOG_PREFIX} Removing files for bundle: ${bundleId}`);

    const result = await applyBundleUninstall({
      writerFactory: createExtensionWriterFactory(this.workspaceRoot),
      target: repositoryTarget(this.workspaceRoot, 'commit', this.targetType),
      key: bundleId,
      store: new LockfileManagerRecordStore(LockfileManager.getInstance(this.workspaceRoot)),
      exclusion: repositoryExclusion(this.workspaceRoot),
      fs: new NodeFileSystem(),
      preserveModified: true
    });

    for (const removed of result.removed) {
      this.logger.debug(`${LOG_PREFIX} Removed: ${removed}`);
    }
    for (const missing of result.missing) {
      this.logger.debug(`${LOG_PREFIX} Already removed: ${missing}`);
    }
    for (const pruned of result.pruned) {
      this.logger.debug(`${LOG_PREFIX} Removed empty directory: ${pruned}`);
    }
    for (const kept of result.kept) {
      this.logger.info(`${LOG_PREFIX} Preserved ${kept.path} (${kept.reason === 'shared' ? 'used by another bundle' : 'modified by user'})`);
    }
    if (result.unresolvable !== undefined) {
      this.logger.warn(`${LOG_PREFIX} Files of ${bundleId} cannot be located: ${result.unresolvable}`);
    }
    for (const refused of result.refused) {
      this.logger.warn(`${LOG_PREFIX} Not removing ${refused}: its location is outside ${this.workspaceRoot}`);
    }
    for (const error of result.errors) {
      this.logger.warn(`${LOG_PREFIX} Failed to remove ${error.path}: ${error.message}`);
    }
    if (result.exclusionSkipped) {
      this.warnNoRepository();
    }
    for (const message of result.exclusionErrors) {
      this.logger.warn(`${LOG_PREFIX} Failed to update git exclude for ${bundleId}: ${message}`);
    }

    this.logger.info(`${LOG_PREFIX} ✅ Removed ${result.removed.length} files for bundle: ${bundleId}`);
    return result;
  }

  /**
   * Switch the commit mode of a repository bundle: move its lockfile entry
   * to the other lockfile, then add its recorded files to (local-only) or
   * remove them from (commit) git exclude. A failed lockfile move is
   * thrown; exclusion problems are logged.
   * @param bundleId - Bundle identifier
   * @param newMode - New commit mode
   * @throws {Error} if the lockfile entry cannot be moved
   */
  public async switchCommitMode(bundleId: string, newMode: RepositoryCommitMode): Promise<void> {
    this.logger.debug(`${LOG_PREFIX} Switching commit mode for ${bundleId} to ${newMode}`);

    const lockfileManager = LockfileManager.getInstance(this.workspaceRoot);
    const record = await new LockfileManagerRecordStore(lockfileManager).get(bundleId);
    if (!record) {
      this.logger.warn(`${LOG_PREFIX} Bundle ${bundleId} not found in any lockfile`);
      return;
    }
    if (record.commitMode === newMode) {
      this.logger.warn(`${LOG_PREFIX} Bundle ${bundleId} already in ${newMode} mode`);
      return;
    }

    await lockfileManager.updateCommitMode(bundleId, newMode);

    const result = await switchRecordedCommitMode({
      writerFactory: createExtensionWriterFactory(this.workspaceRoot),
      target: repositoryTarget(this.workspaceRoot, newMode, this.targetType),
      record,
      exclusion: repositoryExclusion(this.workspaceRoot),
      newMode
    });
    if (result.unresolvable !== undefined) {
      this.logger.warn(`${LOG_PREFIX} Git exclude not updated for ${bundleId}: ${result.unresolvable}`);
    }
    if (result.exclusionSkipped) {
      this.logger.warn(`${LOG_PREFIX} No git repository at ${this.workspaceRoot}; the files of ${bundleId} are not ${newMode === 'local-only' ? 'excluded from' : 'restored to'} git`);
    }
    for (const message of result.exclusionErrors) {
      this.logger.warn(`${LOG_PREFIX} Failed to update git exclude for ${bundleId}: ${message}`);
    }

    this.logger.info(`${LOG_PREFIX} ✅ Switched ${bundleId} to ${newMode} mode`);
  }
}
