/**
 * Repository Scope Service
 *
 * Handles repository-level bundle installation by placing files in the
 * host-appropriate directories (VS Code -> .github, Kiro -> .kiro,
 * Windsurf -> .windsurf, Claude Code -> .claude; unknown hosts fall back
 * to VS Code's .github layout).
 * Supports both commit mode (tracked by Git) and local-only mode (excluded via .git/info/exclude).
 *
 * Requirements: 1.2-1.7, 3.1-3.7, 7.8-7.10, 10.1-10.6
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  promisify,
} from 'node:util';
import {
  FileTreeTargetWriter,
  resolveInstalledFilesForLockfileEntry,
  resolveLayout,
  resolveManagedFilesFromLockfile,
} from '@ai-primitives-hub/app';
import type {
  Lockfile,
  WriterFs,
} from '@ai-primitives-hub/app';
import type {
  InstalledFileRecord,
  PrimitiveKind,
  Target,
  TargetType,
  TargetWritePlan,
  TargetWriteResult,
} from '@ai-primitives-hub/core';
import {
  RegistryStorage,
} from '../storage/registry-storage';
import {
  RepositoryCommitMode,
} from '../types/registry';
import {
  CopilotFileType,
} from '../utils/copilot-file-type-utils';
import {
  calculateFileChecksum,
  ensureDirectory,
} from '../utils/file-integrity-service';
import {
  detectHostApp,
} from '../utils/host-app';
import {
  Logger,
} from '../utils/logger';
import {
  LockfileManager,
} from './lockfile-manager';
import {
  IScopeService,
  SyncBundleOptions,
  UnsyncBundleOptions,
  UnsyncBundleResult,
} from './scope-service';

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const rm = promisify(fs.rm);

/** `WriterFs` adapter backed by Node's `fs` module. */
class NodeWriterFs implements WriterFs {
  public async writeFile(p: string, contents: string): Promise<void> {
    await writeFile(p, contents, 'utf8');
  }

  public async writeFileBytes(p: string, bytes: Uint8Array): Promise<void> {
    await writeFile(p, bytes);
  }

  public async readFileBytes(p: string): Promise<Uint8Array> {
    return fs.promises.readFile(p);
  }

  public async mkdir(p: string, opts?: { recursive?: boolean }): Promise<void> {
    await fs.promises.mkdir(p, opts);
  }

  public async remove(p: string): Promise<void> {
    await rm(p, { recursive: true, force: true });
  }

  public async removeEmptyDirectory(p: string): Promise<void> {
    await fs.promises.rmdir(p);
  }

  public exists(p: string): Promise<boolean> {
    return Promise.resolve(fs.existsSync(p));
  }

  public realpath(p: string): Promise<string> {
    return fs.promises.realpath(p);
  }

  public async lstat(p: string): Promise<{ isSymbolicLink: boolean } | null> {
    try {
      const stats = await fs.promises.lstat(p);
      return { isSymbolicLink: stats.isSymbolicLink() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
}

/**
 * Section header for AI Primitives Hub entries in .git/info/exclude
 */
const GIT_EXCLUDE_SECTION_HEADER = '# Prompt Registry (local)';

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
    this.logger.debug(`[RepositoryScopeService] Detected host app target type: ${this.targetType}`);
  }

  /**
   * Build the repository-scope install Target for the detected host editor.
   * Mirrors `UserScopeService.getTarget()` (which uses `scope: 'user'`), so
   * both scope services resolve destinations the same way.
   */
  private getTarget(): Target {
    return {
      name: this.targetType,
      type: this.targetType,
      scope: 'repository',
      rootPath: this.workspaceRoot
    };
  }

  /**
   * Get the .git/info/exclude file path
   */
  private getGitExcludePath(): string {
    return path.join(this.workspaceRoot, '.git', 'info', 'exclude');
  }

  /**
   * Check if .git directory exists
   */
  private hasGitDirectory(): boolean {
    return fs.existsSync(path.join(this.workspaceRoot, '.git'));
  }

  /**
   * Ensure a directory exists, creating it if necessary.
   * Delegates to shared fileIntegrityService utility.
   * @param dir
   */
  private async ensureDir(dir: string): Promise<void> {
    await ensureDirectory(dir);
    this.logger.debug(`[RepositoryScopeService] Ensured directory exists: ${dir}`);
  }

  /**
   * Get the relative path from workspace root for git exclude
   * @param absolutePath
   */
  private getRelativePath(absolutePath: string): string {
    return path.relative(this.workspaceRoot, absolutePath);
  }

  /**
   * Update git exclude for local-only mode using exact installed paths.
   * @param relativePaths
   */
  private async updateGitExcludeForLocalOnly(relativePaths: string[]): Promise<void> {
    await this.addToGitExclude(relativePaths);
  }

  /**
   * Consolidate skill file paths to skill directory paths for git exclude.
   * Skill files like .github/skills/my-skill/SKILL.md are consolidated to .github/skills/my-skill
   * @param paths
   */
  private consolidateSkillPathsForGitExclude(paths: string[]): string[] {
    // Host-aware skills dir (e.g. ".github/skills" or ".kiro/skills"), no
    // trailing slash — derived from the layout, not hardcoded to .github.
    const skillsDir = this.getTargetDirectory('skill').replace(/\/+$/, '');
    const skillPrefix = `${skillsDir}/`;
    const result: string[] = [];
    const skillDirs = new Set<string>();

    for (const p of paths) {
      const normalized = p.replace(/\\/g, '/');
      if (normalized.startsWith(skillPrefix)) {
        // Collapse a skill's files (e.g. ".kiro/skills/my-skill/SKILL.md") to
        // the skill directory (".kiro/skills/my-skill") for one exclude entry.
        const skillName = normalized.slice(skillPrefix.length).split('/')[0];
        const skillDir = `${skillsDir}/${skillName}`;
        if (skillName && !skillDirs.has(skillDir)) {
          skillDirs.add(skillDir);
          result.push(skillDir);
        }
      } else {
        result.push(p);
      }
    }

    return result;
  }

  /**
   * Collect the destination paths owned by bundles OTHER than the specified one,
   * so `unsyncBundle` never removes a file another bundle still needs.
   *
   * Paths are resolved through `resolveInstalledFilesForLockfileEntry` rather
   * than read raw, so a legacy CLI 0.1.0 lockfile (source-prefix `files[].path`)
   * yields the same destination-relative form as the records being removed.
   * @param excludeBundleId - Bundle being uninstalled.
   * @param lockfiles - Commit-mode and local-only lockfiles.
   * @returns Destination-relative paths owned by other bundles.
   */
  private collectFilesUsedByOtherBundles(
    excludeBundleId: string,
    lockfiles: readonly (Lockfile | null)[]
  ): Set<string> {
    const usedFiles = new Set<string>();
    for (const lockfile of lockfiles) {
      for (const [bundleId, entry] of Object.entries(lockfile?.bundles ?? {})) {
        if (bundleId === excludeBundleId) {
          continue;
        }
        try {
          const resolved = resolveInstalledFilesForLockfileEntry(bundleId, entry, {
            repositoryPath: this.workspaceRoot
          });
          for (const file of resolved.files) {
            usedFiles.add(file.destinationRelativePath);
          }
        } catch (error) {
          this.logger.warn(`[RepositoryScopeService] Skipping unreadable lockfile entry "${bundleId}": ${error}`);
        }
      }
    }
    return usedFiles;
  }

  /**
   * Add paths to .git/info/exclude under the AI Primitives Hub section
   * @param paths - Relative paths to add
   */
  private async addToGitExclude(paths: string[]): Promise<void> {
    if (!this.hasGitDirectory()) {
      this.logger.warn('[RepositoryScopeService] No .git directory found, skipping git exclude');
      return;
    }

    try {
      const excludePath = this.getGitExcludePath();

      // Ensure .git/info directory exists
      await this.ensureDir(path.dirname(excludePath));

      // Read existing content
      let content = '';
      if (fs.existsSync(excludePath)) {
        content = await readFile(excludePath, 'utf8');
      }

      // Find or create our section
      const sectionIndex = content.indexOf(GIT_EXCLUDE_SECTION_HEADER);
      let beforeSection = content;
      let sectionContent = '';
      let afterSection = '';

      if (sectionIndex !== -1) {
        beforeSection = content.substring(0, sectionIndex);
        const afterHeaderIndex = sectionIndex + GIT_EXCLUDE_SECTION_HEADER.length;
        const remainingContent = content.substring(afterHeaderIndex);

        // Find the end of our section (next section header or end of file)
        const nextSectionMatch = remainingContent.match(/\n#[^\n]+/);
        if (nextSectionMatch && nextSectionMatch.index !== undefined) {
          sectionContent = remainingContent.substring(0, nextSectionMatch.index);
          afterSection = remainingContent.substring(nextSectionMatch.index);
        } else {
          sectionContent = remainingContent;
        }
      }

      // Parse existing entries in our section
      const existingEntries = new Set(
        sectionContent.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
      );

      // Add new paths (normalize to forward slashes for Git compatibility)
      for (const p of paths) {
        existingEntries.add(p.replace(/\\/g, '/'));
      }

      // Rebuild content
      const newSectionContent = Array.from(existingEntries).join('\n');
      const newContent = beforeSection.trimEnd()
        + (beforeSection.length > 0 ? '\n\n' : '')
        + GIT_EXCLUDE_SECTION_HEADER + '\n'
        + newSectionContent + '\n'
        + afterSection;

      await writeFile(excludePath, newContent.trim() + '\n', 'utf8');
      this.logger.debug(`[RepositoryScopeService] Added ${paths.length} paths to git exclude`);
    } catch (error) {
      this.logger.warn(`[RepositoryScopeService] Failed to update git exclude: ${error}`);
      // Don't throw - git exclude is optional
    }
  }

  /**
   * Remove paths from .git/info/exclude
   * @param paths - Relative paths to remove
   */
  private async removeFromGitExclude(paths: string[]): Promise<void> {
    if (!this.hasGitDirectory()) {
      return;
    }

    try {
      const excludePath = this.getGitExcludePath();
      if (!fs.existsSync(excludePath)) {
        return;
      }

      const content = await readFile(excludePath, 'utf8');

      // Find our section
      const sectionIndex = content.indexOf(GIT_EXCLUDE_SECTION_HEADER);
      if (sectionIndex === -1) {
        return;
      }

      const beforeSection = content.substring(0, sectionIndex);
      const afterHeaderIndex = sectionIndex + GIT_EXCLUDE_SECTION_HEADER.length;
      const remainingContent = content.substring(afterHeaderIndex);

      // Find the end of our section
      const nextSectionMatch = remainingContent.match(/\n#[^\n]+/);
      let sectionContent: string;
      let afterSection = '';

      if (nextSectionMatch && nextSectionMatch.index !== undefined) {
        sectionContent = remainingContent.substring(0, nextSectionMatch.index);
        afterSection = remainingContent.substring(nextSectionMatch.index);
      } else {
        sectionContent = remainingContent;
      }

      // Parse and filter entries (normalize paths to forward slashes for comparison)
      const pathsToRemove = new Set(paths.map((p) => p.replace(/\\/g, '/')));
      const remainingEntries = sectionContent
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !pathsToRemove.has(line));

      // Rebuild content
      const newContent: string = remainingEntries.length === 0
        ? beforeSection.trimEnd() + afterSection
        : beforeSection.trimEnd()
          + (beforeSection.length > 0 ? '\n\n' : '')
          + GIT_EXCLUDE_SECTION_HEADER + '\n'
          + remainingEntries.join('\n') + '\n'
          + afterSection;

      await writeFile(excludePath, newContent.trim() + '\n', 'utf8');
      this.logger.debug(`[RepositoryScopeService] Removed ${paths.length} paths from git exclude`);
    } catch (error) {
      this.logger.warn(`[RepositoryScopeService] Failed to update git exclude: ${error}`);
    }
  }

  private async writeTargetPlan(
    bundleId: string,
    writer: FileTreeTargetWriter,
    plan: TargetWritePlan,
    commitMode: RepositoryCommitMode
  ): Promise<TargetWriteResult> {
    const result = await writer.write(plan);
    const installedPaths = result.installed.map((file) => file.destinationRelativePath);
    if (commitMode === 'local-only' && installedPaths.length > 0) {
      await this.updateGitExcludeForLocalOnly(installedPaths);
    }

    this.logger.info(`[RepositoryScopeService] ✅ Synced ${installedPaths.length} files for bundle: ${bundleId}`);
    return result;
  }

  private async cleanupRemovedManagedDirectories(files: readonly InstalledFileRecord[]): Promise<void> {
    const directories = new Set(files.flatMap((file) => {
      const type = repositoryCopilotFileType(file.kind);
      return type === null ? [] : [path.join(this.workspaceRoot, this.getTargetDirectory(type))];
    }));
    for (const directory of directories) {
      try {
        await fs.promises.rmdir(directory);
      } catch {
        // Missing or non-empty managed directories must be preserved.
      }
    }
  }

  /**
   * Resolve every destination already recorded in this repository's lockfiles.
   *
   * A destination installed by another bundle is still tool-managed, so it must
   * be part of the writer's managed set — otherwise installing a second bundle
   * that legitimately shares a destination trips `FileTreeTargetWriter`'s
   * unmanaged-overwrite guard. This mirrors `collectFilesUsedByOtherBundles`
   * on the uninstall side.
   * @param options - Sync options; `installedFiles` (the records being replaced)
   *   are always treated as managed even when absent from the lockfiles.
   * @returns Managed installed records, deduplicated by destination path.
   */
  private async resolveManagedFiles(options?: SyncBundleOptions): Promise<InstalledFileRecord[]> {
    const managed = new Map<string, InstalledFileRecord>();
    for (const file of options?.installedFiles ?? []) {
      managed.set(file.destinationPath, file);
    }
    for (const lockfile of await this.readBothLockfiles()) {
      if (lockfile === null) {
        continue;
      }
      try {
        const resolved = resolveManagedFilesFromLockfile(lockfile, { repositoryPath: this.workspaceRoot });
        for (const file of resolved.files) {
          if (!managed.has(file.destinationPath)) {
            managed.set(file.destinationPath, file);
          }
        }
      } catch (error) {
        // A malformed lockfile must not block an install; the writer simply sees
        // a smaller managed set and still refuses unmanaged overwrites.
        this.logger.warn(`[RepositoryScopeService] Failed to resolve managed files from lockfile: ${error}`);
      }
    }
    return [...managed.values()];
  }

  /**
   * Read the commit-mode and local-only lockfiles for this repository.
   * @returns Both lockfiles; an entry is `null` when absent or unreadable.
   */
  private async readBothLockfiles(): Promise<(Lockfile | null)[]> {
    const lockfileManager = LockfileManager.getInstance(this.workspaceRoot);
    const main = await lockfileManager.read().catch(() => null);
    const localPath = lockfileManager.getLocalLockfilePath();
    let local: Lockfile | null = null;
    if (fs.existsSync(localPath)) {
      try {
        local = JSON.parse(await readFile(localPath, 'utf8')) as Lockfile;
      } catch {
        local = null;
      }
    }
    return [main, local];
  }

  /**
   * Resolve the workspace-relative output directory for a file type on the
   * detected host, straight from `default-layouts.json` (the same resolution
   * the writer performs). This is the single source of truth for repository
   * destinations — no hardcoded `.github` map.
   * @param type - The Copilot file type being placed.
   * @returns The workspace-relative directory (e.g. `.kiro/agents/`).
   */
  public getTargetDirectory(type: CopilotFileType): string {
    const layout = resolveLayout(this.getTarget());
    const kind: PrimitiveKind = type === 'instructions'
      ? 'instruction'
      : (type === 'chatmode' ? 'chat-mode' : type);
    const route = layout.routes[kind];
    if (route === undefined) {
      throw new Error(
        `No repository route defined for file type "${type}" in layout "${this.targetType}". Add it to default-layouts.json.`
      );
    }
    // baseDir is the resolved workspace folder (e.g. `<workspaceRoot>/.github`)
    // and routes are relative to it, mirroring user scope. Return the
    // workspace-relative directory (e.g. `.github/prompts/`) so callers can
    // join it onto the workspace root exactly as before.
    const absolute = path.join(layout.baseDir, route);
    const relative = path.relative(this.workspaceRoot, absolute).split(path.sep).join('/');
    return relative.endsWith('/') ? relative : `${relative}/`;
  }

  /**
   * Sync a bundle's files to the appropriate .github/ directories.
   * Implements IScopeService.syncBundle
   * @param bundleId - The unique identifier of the bundle
   * @param bundlePath - The path to the installed bundle directory
   * @param options - Sync options. `targetPlan` is required: destinations are
   *   planned by the shared install pipeline, never re-derived from a manifest.
   */
  public async syncBundle(bundleId: string, bundlePath: string, options?: SyncBundleOptions): Promise<TargetWriteResult> {
    try {
      this.logger.debug(`[RepositoryScopeService] Syncing bundle: ${bundleId}`);
      this.logger.debug(`[RepositoryScopeService] Bundle path: ${bundlePath}`);
      this.logger.debug(`[RepositoryScopeService] Workspace root: ${this.workspaceRoot}`);

      if (options?.targetPlan === undefined) {
        throw new Error(
          `syncBundle requires SyncBundleOptions.targetPlan for bundle "${bundleId}": `
          + 'destinations are planned by the shared install pipeline, and this service never parses a manifest.'
        );
      }

      // Get commit mode from options first, then fall back to storage lookup
      let commitMode: RepositoryCommitMode;
      if (options.commitMode) {
        commitMode = options.commitMode;
        this.logger.debug(`[RepositoryScopeService] Using commitMode from options: ${commitMode}`);
      } else {
        const installedBundle = await this.storage.getInstalledBundle(bundleId, 'repository');
        commitMode = installedBundle?.commitMode ?? 'commit';
        this.logger.debug(`[RepositoryScopeService] Using commitMode from storage: ${commitMode}`);
      }

      const writer = new FileTreeTargetWriter({
        fs: new NodeWriterFs(),
        env: process.env,
        managedFiles: await this.resolveManagedFiles(options)
      });

      return await this.writeTargetPlan(bundleId, writer, options.targetPlan, commitMode);
    } catch (error) {
      this.logger.error(`[RepositoryScopeService] Failed to sync bundle ${bundleId}`, error as Error);
      throw error;
    }
  }

  /**
   * Remove synced files for a bundle.
   * Implements IScopeService.unsyncBundle
   *
   * Only removes files that:
   * 1. Are tracked in the lockfile for this bundle
   * 2. Have matching checksums (not modified by user)
   * 3. Are not used by other bundles in the lockfile
   *
   * User-created files and modified files are preserved.
   * @param bundleId - The unique identifier of the bundle to unsync
   * @param options
   */
  public async unsyncBundle(bundleId: string, options?: UnsyncBundleOptions): Promise<UnsyncBundleResult> {
    try {
      this.logger.debug(`[RepositoryScopeService] Removing files for bundle: ${bundleId}`);

      // Read both lockfiles to get complete picture
      const [mainLockfile, localLockfile] = await this.readBothLockfiles();

      // Find the bundle entry in either lockfile
      const bundleEntry = mainLockfile?.bundles[bundleId] ?? localLockfile?.bundles[bundleId];

      if (bundleEntry === undefined && options?.installedFiles === undefined) {
        this.logger.debug(`[RepositoryScopeService] Bundle ${bundleId} not found in any lockfile`);
        return { retained: [] };
      }

      const installedFiles = options?.installedFiles
        ?? (bundleEntry === undefined
          ? []
          : resolveInstalledFilesForLockfileEntry(
            bundleId,
            bundleEntry,
            { repositoryPath: this.workspaceRoot }
          ).files);

      if (installedFiles.length === 0) {
        this.logger.debug(`[RepositoryScopeService] Bundle ${bundleId} has no tracked files in lockfile`);
        return { retained: [] };
      }

      // Collect files used by OTHER bundles (to avoid removing shared files)
      const filesUsedByOtherBundles = this.collectFilesUsedByOtherBundles(
        bundleId,
        [mainLockfile, localLockfile]
      );

      const removedPaths: string[] = [];
      const removedRecords: InstalledFileRecord[] = [];
      const skippedPaths: { path: string; reason: string }[] = [];
      const writer = new FileTreeTargetWriter({ fs: new NodeWriterFs(), env: process.env });

      for (const installedFile of installedFiles) {
        const targetPath = installedFile.destinationPath;
        const relativePath = installedFile.destinationRelativePath;

        if (!fs.existsSync(targetPath)) {
          this.logger.debug(`[RepositoryScopeService] File already removed: ${relativePath}`);
          continue;
        }

        if (filesUsedByOtherBundles.has(relativePath)) {
          skippedPaths.push({ path: relativePath, reason: 'used by another bundle' });
          this.logger.debug(`[RepositoryScopeService] Skipping file used by another bundle: ${relativePath}`);
          continue;
        }

        try {
          const currentChecksum = await calculateFileChecksum(targetPath);
          if (!checksumsMatch(currentChecksum, installedFile.installedChecksum)) {
            skippedPaths.push({ path: relativePath, reason: 'modified by user' });
            this.logger.info(`[RepositoryScopeService] Preserving user-modified file: ${relativePath}`);
            continue;
          }
        } catch {
          skippedPaths.push({ path: relativePath, reason: 'checksum unavailable' });
          this.logger.warn(`[RepositoryScopeService] Failed to calculate checksum for: ${relativePath}`);
          continue;
        }

        try {
          await writer.remove([installedFile]);
          removedPaths.push(relativePath);
          removedRecords.push(installedFile);
          this.logger.debug(`[RepositoryScopeService] Removed: ${relativePath}`);
        } catch {
          skippedPaths.push({ path: relativePath, reason: 'removal failed' });
          this.logger.warn(`[RepositoryScopeService] Failed to remove file: ${relativePath}`);
        }
      }

      // Remove from git exclude if needed
      if (removedPaths.length > 0) {
        const retainedPaths = skippedPaths.map(({ path: retainedPath }) => retainedPath);
        const legacySkillDirectories = this.consolidateSkillPathsForGitExclude(removedPaths)
          .filter((candidate) => !removedPaths.includes(candidate))
          .filter((candidate) => !retainedPaths.some((retainedPath) => retainedPath.startsWith(`${candidate}/`)))
          .filter((candidate) => !fs.existsSync(path.join(this.workspaceRoot, candidate)));
        await this.removeFromGitExclude([...removedPaths, ...legacySkillDirectories]);
      }
      await this.cleanupRemovedManagedDirectories(removedRecords);

      if (skippedPaths.length > 0) {
        this.logger.info(`[RepositoryScopeService] Preserved ${skippedPaths.length} files: ${skippedPaths.map((s) => `${s.path} (${s.reason})`).join(', ')}`);
      }

      this.logger.info(`[RepositoryScopeService] ✅ Removed ${removedPaths.length} files for bundle: ${bundleId}`);
      const installedByPath = new Map(installedFiles.map((file) => [file.destinationRelativePath, file]));
      return {
        retained: skippedPaths
          .filter(({ reason }) => reason !== 'used by another bundle')
          .map(({ path: retainedPath }) => installedByPath.get(retainedPath)!)
      };
    } catch (error) {
      this.logger.error(`[RepositoryScopeService] Failed to unsync bundle ${bundleId}`, error as Error);
      return { retained: options?.installedFiles ?? [] };
    }
  }

  /**
   * Switch the commit mode for a bundle
   * @param bundleId - Bundle identifier
   * @param newMode - New commit mode
   */
  public async switchCommitMode(bundleId: string, newMode: RepositoryCommitMode): Promise<void> {
    try {
      this.logger.debug(`[RepositoryScopeService] Switching commit mode for ${bundleId} to ${newMode}`);

      // Get installed bundle info from lockfile (repository scope bundles are tracked via lockfile)
      // Use getInstalledBundles() to search both main and local lockfiles
      const lockfileManager = LockfileManager.getInstance(this.workspaceRoot);
      const installedBundles = await lockfileManager.getInstalledBundles();
      const bundle = installedBundles.find((b) => b.bundleId === bundleId);

      if (!bundle) {
        this.logger.warn(`[RepositoryScopeService] Bundle ${bundleId} not found in any lockfile`);
        return;
      }

      const currentMode = bundle.commitMode ?? 'commit';
      if (currentMode === newMode) {
        this.logger.debug(`[RepositoryScopeService] Bundle ${bundleId} already in ${newMode} mode`);
        return;
      }

      const exactFilePaths = (bundle.installedFiles ?? []).map((file) => file.destinationRelativePath);
      const filePaths = newMode === 'local-only'
        ? exactFilePaths
        : [...exactFilePaths, ...this.consolidateSkillPathsForGitExclude(exactFilePaths)];

      this.logger.debug(`[RepositoryScopeService] Found ${filePaths.length} files to update git exclude for`);

      // Update git exclude based on new mode
      await (newMode === 'local-only' ? this.addToGitExclude(filePaths) : this.removeFromGitExclude(filePaths));

      this.logger.info(`[RepositoryScopeService] ✅ Switched ${bundleId} to ${newMode} mode`);
    } catch (error) {
      this.logger.error(`[RepositoryScopeService] Failed to switch commit mode for ${bundleId}`, error as Error);
    }
  }
}

function repositoryCopilotFileType(kind: PrimitiveKind): CopilotFileType | null {
  switch (kind) {
    case 'instruction': {
      return 'instructions';
    }
    case 'chat-mode': {
      return 'chatmode';
    }
    case 'prompt':
    case 'agent':
    case 'skill': {
      return kind;
    }
    default: {
      return null;
    }
  }
}

function checksumsMatch(actual: string, expected: string): boolean {
  const normalize = (value: string): string => value.startsWith('sha256:') ? value : `sha256:${value}`;
  return normalize(actual) === normalize(expected);
}
