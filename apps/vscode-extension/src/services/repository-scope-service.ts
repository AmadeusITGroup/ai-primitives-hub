/**
 * Repository Scope Service
 *
 * Handles repository-level bundle installation by placing files in .github/ directories.
 * Supports both commit mode (tracked by Git) and local-only mode (excluded via .git/info/exclude).
 *
 * Requirements: 1.2-1.7, 3.1-3.7, 7.8-7.10, 10.1-10.6
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  promisify,
} from 'node:util';
import * as yaml from 'js-yaml';
import {
  RegistryStorage,
} from '../storage/registry-storage';
import {
  DeploymentManifest,
  RepositoryCommitMode,
} from '../types/registry';
import {
  CopilotFileType,
  determineFileType,
  getRepositoryTargetDirectory,
  getTargetFileName,
  normalizePromptId,
} from '../utils/copilot-file-type-utils';
import {
  calculateFileChecksum,
  ensureDirectory,
} from '../utils/file-integrity-service';
import {
  Logger,
} from '../utils/logger';
import {
  LockfileManager,
} from './lockfile-manager';
import {
  IScopeService,
  SyncBundleOptions,
} from './scope-service';

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const readdir = promisify(fs.readdir);
const unlink = promisify(fs.unlink);
const copyFile = promisify(fs.copyFile);
const stat = promisify(fs.stat);
const rm = promisify(fs.rm);

/**
 * Section header for Prompt Registry entries in .git/info/exclude
 */
const GIT_EXCLUDE_SECTION_HEADER = '# Prompt Registry (local)';

/**
 * Directories in .github/ that are managed by Prompt Registry.
 * Only these directories should be cleaned up during uninstallation.
 * Other directories (workflows, ISSUE_TEMPLATE, etc.) are not managed by Prompt Registry.
 */
const PROMPT_REGISTRY_MANAGED_DIRS = ['prompts', 'agents', 'instructions', 'skills'] as const;

/**
 * Regex pattern to extract skill directory path from a file path.
 * Matches paths like ".github/skills/my-skill/SKILL.md" and captures ".github/skills/my-skill"
 */
const SKILL_DIR_PATTERN = /^(\.github\/skills\/[^/]+)/;

/**
 * Tracks installed files during bundle installation for rollback support
 */
interface InstallationTracker {
  relativePaths: string[];
  absolutePaths: string[];
  skillDirs: string[];
}

/**
 * Service to sync bundle files to repository .github/ directories.
 * Implements IScopeService for consistent scope handling.
 */
export class RepositoryScopeService implements IScopeService {
  private readonly logger: Logger;
  private readonly workspaceRoot: string;
  private readonly storage: RegistryStorage;

  /**
   * Create a new RepositoryScopeService
   * @param workspaceRoot - The root directory of the workspace/repository
   * @param storage - RegistryStorage instance for looking up bundle metadata
   */
  constructor(workspaceRoot: string, storage: RegistryStorage) {
    this.workspaceRoot = workspaceRoot;
    this.storage = storage;
    this.logger = Logger.getInstance();
  }

  /**
   * Get the .github base directory path
   */
  private getGitHubDirectory(): string {
    return path.join(this.workspaceRoot, '.github');
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
   * Install files from a bundle to .github/ directories
   * @param bundlePath - Path to bundle directory
   * @param manifest - Deployment manifest
   * @param commitMode - Whether to track in git or exclude
   * @returns Array of installed file paths (relative to workspace)
   */
  private async installFiles(
    bundlePath: string,
    manifest: DeploymentManifest,
    commitMode: RepositoryCommitMode
  ): Promise<string[]> {
    const tracker: InstallationTracker = {
      relativePaths: [],
      absolutePaths: [],
      skillDirs: []
    };

    try {
      // Copy all bundle files to target directories
      await this.copyBundleFiles(bundlePath, manifest, tracker);

      // Handle git exclude for local-only mode
      if (commitMode === 'local-only' && tracker.relativePaths.length > 0) {
        await this.updateGitExcludeForLocalOnly(tracker.relativePaths);
      }

      return tracker.relativePaths;
    } catch (error) {
      await this.rollbackInstallation(tracker);
      throw error;
    }
  }

  /**
   * Copy all files from a bundle to their target .github/ directories
   * @param bundlePath
   * @param manifest
   * @param tracker
   */
  private async copyBundleFiles(
    bundlePath: string,
    manifest: DeploymentManifest,
    tracker: InstallationTracker
  ): Promise<void> {
    for (const promptDef of manifest.prompts || []) {
      const promptId = normalizePromptId(promptDef.id);

      await (promptDef.type === 'skill' ? this.installSkillAndTrack(bundlePath, promptDef.file, promptId, tracker) : this.installFileAndTrack(bundlePath, promptDef, promptId, tracker));
    }
  }

  /**
   * Install a skill directory and track for potential rollback
   * @param bundlePath
   * @param skillFile
   * @param skillId
   * @param tracker
   */
  private async installSkillAndTrack(
    bundlePath: string,
    skillFile: string,
    skillId: string,
    tracker: InstallationTracker
  ): Promise<void> {
    const skillPaths = await this.installSkillDirectory(bundlePath, skillFile, skillId);

    if (skillPaths.length > 0) {
      const skillDir = path.join(
        this.workspaceRoot,
        getRepositoryTargetDirectory('skill'),
        skillId
      );
      tracker.skillDirs.push(skillDir);
      tracker.relativePaths.push(...skillPaths.map((p) => this.getRelativePath(p)));
      tracker.absolutePaths.push(...skillPaths);
    }
  }

  /**
   * Install a single file and track for potential rollback
   * @param bundlePath
   * @param promptDef
   * @param promptDef.file
   * @param promptDef.type
   * @param promptDef.tags
   * @param promptId
   * @param tracker
   */
  private async installFileAndTrack(
    bundlePath: string,
    promptDef: { file: string; type?: string; tags?: string[] },
    promptId: string,
    tracker: InstallationTracker
  ): Promise<void> {
    this.logger.debug(`[RepositoryScopeService] installFileAndTrack: bundlePath=${bundlePath}, file=${promptDef.file}, promptId=${promptId}`);
    const sourcePath = path.join(bundlePath, promptDef.file);
    this.logger.debug(`[RepositoryScopeService] Source path: ${sourcePath}`);
    this.logger.debug(`[RepositoryScopeService] Source exists: ${fs.existsSync(sourcePath)}`);
    if (!fs.existsSync(sourcePath)) {
      this.logger.warn(`[RepositoryScopeService] Source file not found: ${sourcePath}`);
      return;
    }

    const fileType = promptDef.type as CopilotFileType || determineFileType(promptDef.file, promptDef.tags);
    const targetPath = this.getTargetPath(fileType, promptId);
    this.logger.info(`[RepositoryScopeService] File type: ${fileType}, Target path: ${targetPath}`);

    await this.ensureDir(path.dirname(targetPath));
    await copyFile(sourcePath, targetPath);
    this.logger.info(`[RepositoryScopeService] ✅ Copied: ${sourcePath} → ${targetPath}`);

    tracker.absolutePaths.push(targetPath);
    tracker.relativePaths.push(this.getRelativePath(targetPath));
  }

  /**
   * Update git exclude for local-only mode, consolidating skill directories
   * @param relativePaths
   */
  private async updateGitExcludeForLocalOnly(relativePaths: string[]): Promise<void> {
    const pathsForExclude = this.consolidateSkillPathsForGitExclude(relativePaths);
    await this.addToGitExclude(pathsForExclude);
  }

  /**
   * Rollback installation by removing all tracked files and directories
   * @param tracker
   */
  private async rollbackInstallation(tracker: InstallationTracker): Promise<void> {
    this.logger.error(`[RepositoryScopeService] Installation failed, rolling back...`);

    // Rollback skill directories first
    for (const skillDir of tracker.skillDirs) {
      try {
        if (fs.existsSync(skillDir)) {
          await rm(skillDir, { recursive: true, force: true });
          this.logger.debug(`[RepositoryScopeService] Rolled back skill directory: ${skillDir}`);
        }
      } catch {
        this.logger.warn(`[RepositoryScopeService] Failed to rollback skill directory: ${skillDir}`);
      }
    }

    // Rollback individual files (skip those in skill directories)
    for (const absolutePath of tracker.absolutePaths) {
      const isInSkillDir = tracker.skillDirs.some((dir) => absolutePath.startsWith(dir));
      if (isInSkillDir) {
        continue;
      }

      try {
        if (fs.existsSync(absolutePath)) {
          await unlink(absolutePath);
          this.logger.debug(`[RepositoryScopeService] Rolled back: ${absolutePath}`);
        }
      } catch {
        this.logger.warn(`[RepositoryScopeService] Failed to rollback file: ${absolutePath}`);
      }
    }
  }

  /**
   * Install a skill directory by copying all files recursively
   * @param bundlePath - Path to the bundle directory
   * @param skillFile - Relative path to the skill directory in the bundle
   * @param skillId - The skill identifier
   * @returns Array of absolute paths to installed files
   */
  private async installSkillDirectory(
    bundlePath: string,
    skillFile: string,
    skillId: string
  ): Promise<string[]> {
    // skillFile may be a file path (e.g., "skills/my-skill/SKILL.md")
    // Extract the skill directory similar to UserScopeService
    const skillMatch = skillFile.match(/skills\/([^/]+)/);
    if (!skillMatch) {
      this.logger.warn(`[RepositoryScopeService] Invalid skill path format: ${skillFile}`);
      return [];
    }

    const skillName = skillMatch[1];
    const sourcePath = path.join(bundlePath, 'skills', skillName);

    if (!fs.existsSync(sourcePath)) {
      this.logger.warn(`[RepositoryScopeService] Skill directory not found: ${sourcePath}`);
      return [];
    }

    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isDirectory()) {
      this.logger.warn(`[RepositoryScopeService] Skill path is not a directory: ${sourcePath}`);
      return [];
    }

    // Target directory: .github/skills/<skill-id>/
    const targetDir = path.join(
      this.workspaceRoot,
      getRepositoryTargetDirectory('skill'),
      skillId
    );

    // Ensure target directory exists
    await this.ensureDir(targetDir);

    // Copy all files recursively
    const installedFiles = await this.copyDirectoryRecursive(sourcePath, targetDir);

    this.logger.debug(`[RepositoryScopeService] Installed skill ${skillId}: ${installedFiles.length} files`);

    return installedFiles;
  }

  /**
   * Recursively copy a directory and all its contents
   * @param sourceDir - Source directory path
   * @param targetDir - Target directory path
   * @returns Array of absolute paths to copied files
   */
  private async copyDirectoryRecursive(sourceDir: string, targetDir: string): Promise<string[]> {
    const copiedFiles: string[] = [];

    const entries = await readdir(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);

      if (entry.isDirectory()) {
        // Create subdirectory and recurse
        await this.ensureDir(targetPath);
        const subFiles = await this.copyDirectoryRecursive(sourcePath, targetPath);
        copiedFiles.push(...subFiles);
      } else if (entry.isFile()) {
        // Copy file
        await copyFile(sourcePath, targetPath);
        copiedFiles.push(targetPath);
        this.logger.debug(`[RepositoryScopeService] Copied skill file: ${entry.name}`);
      }
    }

    return copiedFiles;
  }

  /**
   * Consolidate skill file paths to skill directory paths for git exclude.
   * Skill files like .github/skills/my-skill/SKILL.md are consolidated to .github/skills/my-skill
   * @param paths
   */
  private consolidateSkillPathsForGitExclude(paths: string[]): string[] {
    const result: string[] = [];
    const skillDirs = new Set<string>();

    for (const p of paths) {
      if (p.includes('.github/skills/')) {
        // Extract skill directory path instead of individual files
        const match = p.match(SKILL_DIR_PATTERN);
        if (match && !skillDirs.has(match[1])) {
          skillDirs.add(match[1]);
          result.push(match[1]);
        }
      } else {
        result.push(p);
      }
    }

    return result;
  }

  /**
   * Collect all file paths used by bundles OTHER than the specified bundle.
   * Used to prevent removing files that are shared between bundles.
   * @param excludeBundleId
   * @param mainLockfile
   * @param localLockfile
   */
  private collectFilesUsedByOtherBundles(
    excludeBundleId: string,
    mainLockfile: { bundles?: Record<string, { files?: { path: string }[] }> } | null,
    localLockfile: { bundles?: Record<string, { files?: { path: string }[] }> } | null
  ): Set<string> {
    const usedFiles = new Set<string>();

    // Check main lockfile
    if (mainLockfile?.bundles) {
      for (const [bundleId, entry] of Object.entries(mainLockfile.bundles)) {
        if (bundleId !== excludeBundleId && entry.files) {
          for (const file of entry.files) {
            usedFiles.add(file.path);
          }
        }
      }
    }

    // Check local lockfile
    if (localLockfile?.bundles) {
      for (const [bundleId, entry] of Object.entries(localLockfile.bundles)) {
        if (bundleId !== excludeBundleId && entry.files) {
          for (const file of entry.files) {
            usedFiles.add(file.path);
          }
        }
      }
    }

    return usedFiles;
  }

  /**
   * Clean up empty prompt registry subdirectories in .github/
   *
   * Only removes directories that prompt registry manages:
   * - .github/prompts
   * - .github/agents
   * - .github/instructions
   * - .github/skills
   *
   * Does NOT remove:
   * - .github folder itself (may contain unrelated files like workflows, CODEOWNERS)
   * - Any other directories in .github (workflows, ISSUE_TEMPLATE, etc.)
   */
  private async cleanupEmptyPromptRegistryDirectories(): Promise<void> {
    const githubDir = this.getGitHubDirectory();

    if (!fs.existsSync(githubDir)) {
      return;
    }

    for (const subdir of PROMPT_REGISTRY_MANAGED_DIRS) {
      const subdirPath = path.join(githubDir, subdir);

      if (!fs.existsSync(subdirPath)) {
        continue;
      }

      try {
        // For skills directory, also clean up empty skill subdirectories
        if (subdir === 'skills') {
          await this.cleanupEmptySkillDirectories(subdirPath);
        }

        const files = await readdir(subdirPath);

        // Only remove if directory is empty
        if (files.length === 0) {
          await rm(subdirPath, { recursive: true, force: true });
          this.logger.debug(`[RepositoryScopeService] Removed empty directory: ${this.getRelativePath(subdirPath)}`);
        }
      } catch {
        this.logger.warn(`[RepositoryScopeService] Failed to check/remove directory: ${subdirPath}`);
      }
    }
  }

  /**
   * Clean up empty skill directories within .github/skills/
   * Skills are directories, so we need to recursively check and remove empty ones.
   * @param skillsDir
   */
  private async cleanupEmptySkillDirectories(skillsDir: string): Promise<void> {
    if (!fs.existsSync(skillsDir)) {
      return;
    }

    try {
      const entries = await readdir(skillsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillDir = path.join(skillsDir, entry.name);
          await this.cleanupEmptyDirectoryRecursive(skillDir);
        }
      }
    } catch {
      this.logger.warn(`[RepositoryScopeService] Failed to clean up skill directories: ${skillsDir}`);
    }
  }

  /**
   * Recursively clean up empty directories from bottom up.
   * Removes a directory only if it's empty (after cleaning up its subdirectories).
   * @param dir
   */
  private async cleanupEmptyDirectoryRecursive(dir: string): Promise<boolean> {
    if (!fs.existsSync(dir)) {
      return true; // Already removed
    }

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      // First, recursively clean up subdirectories
      for (const entry of entries) {
        if (entry.isDirectory()) {
          await this.cleanupEmptyDirectoryRecursive(path.join(dir, entry.name));
        }
      }

      // Re-read directory after cleaning subdirectories
      const remainingEntries = await readdir(dir);

      // Remove if empty
      if (remainingEntries.length === 0) {
        await rm(dir, { recursive: true, force: true });
        this.logger.debug(`[RepositoryScopeService] Removed empty directory: ${this.getRelativePath(dir)}`);
        return true;
      }

      return false;
    } catch {
      this.logger.warn(`[RepositoryScopeService] Failed to clean up directory: ${dir}`);
      return false;
    }
  }

  /**
   * Add paths to .git/info/exclude under the Prompt Registry section
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

  /**
   * Get the target path for a file of a given type.
   * Implements IScopeService.getTargetPath
   * @param fileType - The Copilot file type
   * @param fileName - The name of the file (without extension)
   * @returns The full target path where the file should be placed
   */
  public getTargetPath(fileType: CopilotFileType, fileName: string): string {
    const relativeDir = getRepositoryTargetDirectory(fileType);
    const targetFileName = getTargetFileName(fileName, fileType);
    return path.join(this.workspaceRoot, relativeDir, targetFileName);
  }

  /**
   * Sync a bundle's files to the appropriate .github/ directories.
   * Implements IScopeService.syncBundle
   * @param bundleId - The unique identifier of the bundle
   * @param bundlePath - The path to the installed bundle directory
   * @param options - Optional sync options including commitMode
   */
  public async syncBundle(bundleId: string, bundlePath: string, options?: SyncBundleOptions): Promise<void> {
    try {
      this.logger.debug(`[RepositoryScopeService] Syncing bundle: ${bundleId}`);
      this.logger.debug(`[RepositoryScopeService] Bundle path: ${bundlePath}`);
      this.logger.debug(`[RepositoryScopeService] Workspace root: ${this.workspaceRoot}`);

      // Get commit mode from options first, then fall back to storage lookup
      let commitMode: RepositoryCommitMode;
      if (options?.commitMode) {
        commitMode = options.commitMode;
        this.logger.debug(`[RepositoryScopeService] Using commitMode from options: ${commitMode}`);
      } else {
        const installedBundle = await this.storage.getInstalledBundle(bundleId, 'repository');
        commitMode = installedBundle?.commitMode ?? 'commit';
        this.logger.debug(`[RepositoryScopeService] Using commitMode from storage: ${commitMode}`);
      }

      // Read deployment manifest
      const manifestPath = path.join(bundlePath, 'deployment-manifest.yml');
      this.logger.debug(`[RepositoryScopeService] Looking for manifest at: ${manifestPath}`);
      if (!fs.existsSync(manifestPath)) {
        this.logger.warn(`[RepositoryScopeService] No manifest found for bundle: ${bundleId}`);
        return;
      }
      this.logger.debug(`[RepositoryScopeService] Manifest found, reading content...`);

      const manifestContent = await readFile(manifestPath, 'utf8');
      const manifest = yaml.load(manifestContent) as DeploymentManifest;
      this.logger.debug(`[RepositoryScopeService] Manifest parsed. Keys: ${Object.keys(manifest).join(', ')}`);
      this.logger.debug(`[RepositoryScopeService] manifest.prompts exists: ${!!manifest.prompts}, length: ${manifest.prompts?.length ?? 'N/A'}`);

      if (!manifest.prompts || manifest.prompts.length === 0) {
        this.logger.info(`[RepositoryScopeService] Bundle ${bundleId} has no prompts to sync`);
      } else {
        this.logger.info(`[RepositoryScopeService] Found ${manifest.prompts.length} prompts to sync`);
        for (const p of manifest.prompts) {
          this.logger.info(`[RepositoryScopeService]   - Prompt: id=${p.id}, file=${p.file}, type=${p.type}`);
        }
      }

      // Install files (handles empty prompts array gracefully)
      const installedPaths = await this.installFiles(bundlePath, manifest, commitMode);

      this.logger.info(`[RepositoryScopeService] ✅ Synced ${installedPaths.length} files for bundle: ${bundleId}`);
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
   */
  public async unsyncBundle(bundleId: string): Promise<void> {
    try {
      this.logger.debug(`[RepositoryScopeService] Removing files for bundle: ${bundleId}`);

      const lockfileManager = LockfileManager.getInstance(this.workspaceRoot);

      // Read both lockfiles to get complete picture
      const mainLockfile = await lockfileManager.read();
      const localLockfilePath = lockfileManager.getLocalLockfilePath();
      let localLockfile = null;
      if (fs.existsSync(localLockfilePath)) {
        try {
          const content = await readFile(localLockfilePath, 'utf8');
          localLockfile = JSON.parse(content);
        } catch {
          // Ignore parse errors
        }
      }

      // Find the bundle entry in either lockfile
      const bundleEntry = mainLockfile?.bundles[bundleId] || localLockfile?.bundles[bundleId];

      if (!bundleEntry) {
        this.logger.debug(`[RepositoryScopeService] Bundle ${bundleId} not found in any lockfile`);
        return;
      }

      // Get files tracked by this bundle
      const bundleFiles = bundleEntry.files || [];

      if (bundleFiles.length === 0) {
        this.logger.debug(`[RepositoryScopeService] Bundle ${bundleId} has no tracked files in lockfile`);
        return;
      }

      // Collect files used by OTHER bundles (to avoid removing shared files)
      const filesUsedByOtherBundles = this.collectFilesUsedByOtherBundles(
        bundleId,
        mainLockfile,
        localLockfile
      );

      const removedPaths: string[] = [];
      const skippedPaths: { path: string; reason: string }[] = [];

      // Remove each file tracked in the lockfile
      for (const fileEntry of bundleFiles) {
        const targetPath = path.join(this.workspaceRoot, fileEntry.path);

        // Skip if file doesn't exist
        if (!fs.existsSync(targetPath)) {
          this.logger.debug(`[RepositoryScopeService] File already removed: ${fileEntry.path}`);
          continue;
        }

        // Skip if file is used by another bundle
        if (filesUsedByOtherBundles.has(fileEntry.path)) {
          skippedPaths.push({ path: fileEntry.path, reason: 'used by another bundle' });
          this.logger.debug(`[RepositoryScopeService] Skipping file used by another bundle: ${fileEntry.path}`);
          continue;
        }

        // Check if file has been modified by user (checksum mismatch)
        try {
          const currentChecksum = await calculateFileChecksum(targetPath);
          if (currentChecksum !== fileEntry.checksum) {
            skippedPaths.push({ path: fileEntry.path, reason: 'modified by user' });
            this.logger.info(`[RepositoryScopeService] Preserving user-modified file: ${fileEntry.path}`);
            continue;
          }
        } catch {
          this.logger.warn(`[RepositoryScopeService] Failed to calculate checksum for: ${fileEntry.path}`);
          continue;
        }

        // Safe to remove - file is tracked, unmodified, and not shared
        try {
          await unlink(targetPath);
          removedPaths.push(fileEntry.path);
          this.logger.debug(`[RepositoryScopeService] Removed: ${fileEntry.path}`);
        } catch {
          this.logger.warn(`[RepositoryScopeService] Failed to remove file: ${fileEntry.path}`);
        }
      }

      // Remove from git exclude if needed
      if (removedPaths.length > 0) {
        // Consolidate skill file paths to skill directory paths for git exclude
        // (mirrors the logic in updateGitExcludeForLocalOnly)
        const pathsForExclude = this.consolidateSkillPathsForGitExclude(removedPaths);
        await this.removeFromGitExclude(pathsForExclude);

        // Clean up empty prompt registry subdirectories
        // Only removes directories that are completely empty
        await this.cleanupEmptyPromptRegistryDirectories();
      }

      if (skippedPaths.length > 0) {
        this.logger.info(`[RepositoryScopeService] Preserved ${skippedPaths.length} files: ${skippedPaths.map((s) => `${s.path} (${s.reason})`).join(', ')}`);
      }

      this.logger.info(`[RepositoryScopeService] ✅ Removed ${removedPaths.length} files for bundle: ${bundleId}`);
    } catch (error) {
      this.logger.error(`[RepositoryScopeService] Failed to unsync bundle ${bundleId}`, error as Error);
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

      // Find installed files in .github/ directories
      // The lockfile files point to the bundle cache, not the installed location
      // We need to scan the .github/ directories for files that belong to this bundle
      const filePaths: string[] = [];

      // Check .github/prompts directory
      const githubPromptsDir = path.join(this.workspaceRoot, '.github', 'prompts');
      if (fs.existsSync(githubPromptsDir)) {
        const files = await readdir(githubPromptsDir);
        for (const file of files) {
          const relativePath = path.join('.github', 'prompts', file);
          filePaths.push(relativePath);
        }
      }

      // Check .github/agents directory
      const githubAgentsDir = path.join(this.workspaceRoot, '.github', 'agents');
      if (fs.existsSync(githubAgentsDir)) {
        const files = await readdir(githubAgentsDir);
        for (const file of files) {
          const relativePath = path.join('.github', 'agents', file);
          filePaths.push(relativePath);
        }
      }

      // Check .github/copilot-instructions.md
      const copilotInstructionsPath = path.join(this.workspaceRoot, '.github', 'copilot-instructions.md');
      if (fs.existsSync(copilotInstructionsPath)) {
        filePaths.push('.github/copilot-instructions.md');
      }

      this.logger.debug(`[RepositoryScopeService] Found ${filePaths.length} files to update git exclude for`);

      // Update git exclude based on new mode
      await (newMode === 'local-only' ? this.addToGitExclude(filePaths) : this.removeFromGitExclude(filePaths));

      this.logger.info(`[RepositoryScopeService] ✅ Switched ${bundleId} to ${newMode} mode`);
    } catch (error) {
      this.logger.error(`[RepositoryScopeService] Failed to switch commit mode for ${bundleId}`, error as Error);
    }
  }
}
