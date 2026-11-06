/**
 * Repository Scope Service
 *
 * Handles repository-level bundle installation by placing files in the
 * host-appropriate directories (VS Code -> .github, Kiro -> .kiro,
 * Windsurf -> .windsurf, Claude Code -> .claude; unknown hosts fall back
 * to VS Code's .github layout).
 * Supports both commit mode (tracked by Git) and local-only mode (excluded via .git/info/exclude).
 *
 * The files of an install are recorded by the caller in the shared install
 * record (`ExtensionRecordAdapter`): `syncBundle` returns the paths it wrote,
 * and `unsyncBundle` / `switchCommitMode` take their file lists from the
 * host tool's record entry (`uninstallEntry`, `moveEntry`), or from the old
 * `prompt-registry` lockfile for a bundle only it holds (BR11.1, BR11.5, BR12.1).
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
  KIND_TO_ROUTE_KEY,
  resolveLayout,
} from '@ai-primitives-hub/app';
import type {
  ManifestPlacementItem,
  WriterFs,
} from '@ai-primitives-hub/app';
import {
  isRecordError,
  type Target,
  type TargetType,
} from '@ai-primitives-hub/core';
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
  getSkillName,
  getTargetFileName,
  normalizePromptId,
} from '../utils/copilot-file-type-utils';
import {
  ensureDirectory,
} from '../utils/file-integrity-service';
import {
  detectHostApp,
} from '../utils/host-app';
import {
  Logger,
} from '../utils/logger';
import {
  resolveExistingPathInside,
} from '../utils/path-safety';
import {
  ExtensionRecordAdapter,
} from './extension-record-adapter';
import {
  IScopeService,
  SyncBundleOptions,
} from './scope-service';

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const readdir = promisify(fs.readdir);
const unlink = promisify(fs.unlink);
const rm = promisify(fs.rm);

/**
 * `WriterFs` adapter backed by Node's `fs` module, so
 * `RepositoryScopeService` can drive the shared
 * `FileTreeTargetWriter.writeManifestItems()` placement/naming logic
 * instead of duplicating it.
 */
class NodeWriterFs implements WriterFs {
  public async writeFile(p: string, contents: string): Promise<void> {
    await writeFile(p, contents, 'utf8');
  }

  public async writeFileBytes(p: string, bytes: Uint8Array): Promise<void> {
    await fs.promises.writeFile(p, bytes);
  }

  public async readFileBytes(p: string): Promise<Uint8Array> {
    const buffer = await fs.promises.readFile(p);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  public async mkdir(p: string, opts?: { recursive?: boolean }): Promise<void> {
    await fs.promises.mkdir(p, opts);
  }

  public async remove(p: string): Promise<void> {
    await rm(p, { recursive: true, force: true });
  }

  public exists(p: string): Promise<boolean> {
    return Promise.resolve(fs.existsSync(p));
  }
}

/**
 * Section header for AI Primitives Hub entries in .git/info/exclude
 */
const GIT_EXCLUDE_SECTION_HEADER = '# Prompt Registry (local)';

/**
 * Primitive kinds AI Primitives Hub manages at repository scope. Their on-disk
 * directories are resolved per host from the layout (e.g. `.github/prompts` on
 * VS Code, `.kiro/steering` on Kiro), so cleanup only ever touches folders this
 * tool created — never the host root (`.github`/`.kiro`) itself.
 */
const MANAGED_KINDS: readonly CopilotFileType[] = ['prompt', 'instructions', 'agent', 'skill'];

/**
 * Tracks installed files during bundle installation for rollback support
 */
interface InstallationTracker {
  relativePaths: string[];
  absolutePaths: string[];
  skillDirs: string[];
}

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
  private readonly records: ExtensionRecordAdapter;

  /**
   * Create a new RepositoryScopeService
   * @param workspaceRoot - The root directory of the workspace/repository
   * @param storage - RegistryStorage instance for looking up bundle metadata
   * @param targetType - Host editor target type; detected from the running
   *   editor by default, injectable for tests. Determines the host-appropriate
   *   destination layout (VS Code -> .github, Kiro -> .kiro, etc.).
   * @param records - Shared install record adapter; one over `storage`'s
   *   sources with `targetType` as host tool by default.
   */
  constructor(workspaceRoot: string, storage: RegistryStorage, targetType?: TargetType, records?: ExtensionRecordAdapter) {
    this.workspaceRoot = workspaceRoot;
    this.storage = storage;
    this.logger = Logger.getInstance();
    this.targetType = targetType ?? detectHostApp();
    this.records = records ?? new ExtensionRecordAdapter({ sources: { listSources: () => storage.getSources() }, hostTool: this.targetType });
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
   * Install files from a bundle to the host-appropriate directories
   * @param bundlePath - Path to bundle directory
   * @param manifest - Deployment manifest
   * @param commitMode - Whether to track in git or exclude
   * @returns Absolute paths of the files written
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

      return tracker.absolutePaths;
    } catch (error) {
      await this.rollbackInstallation(tracker);
      throw error;
    }
  }

  /**
   * Copy all files from a bundle to their target host-appropriate directories.
   *
   * Placement/naming is delegated to the shared
   * `FileTreeTargetWriter.writeManifestItems()`,
   * called once per manifest item so this service's own
   * per-item rollback tracking (see `InstallationTracker`) is preserved
   * exactly as before.
   * @param bundlePath
   * @param manifest
   * @param tracker
   */
  private async copyBundleFiles(
    bundlePath: string,
    manifest: DeploymentManifest,
    tracker: InstallationTracker
  ): Promise<void> {
    const target: Target = this.getTarget();
    const writer = new FileTreeTargetWriter({ fs: new NodeWriterFs(), env: process.env });

    for (const promptDef of manifest.prompts || []) {
      const promptId = normalizePromptId(promptDef.id);

      await (promptDef.type === 'skill'
        ? this.installSkillAndTrack(writer, target, bundlePath, promptDef.file, promptId, tracker)
        : this.installFileAndTrack(writer, target, bundlePath, promptDef, promptId, tracker));
    }
  }

  /**
   * Install a skill directory and track for potential rollback
   * @param writer - Shared writer that places the skill's files.
   * @param target - Target describing this workspace's repository scope.
   * @param bundlePath
   * @param skillFile
   * @param skillId
   * @param tracker
   */
  private async installSkillAndTrack(
    writer: FileTreeTargetWriter,
    target: Target,
    bundlePath: string,
    skillFile: string,
    skillId: string,
    tracker: InstallationTracker
  ): Promise<void> {
    const sourceSkillName = getSkillName(skillFile);
    if (!sourceSkillName) {
      this.logger.warn(`[RepositoryScopeService] Invalid skill path format: ${skillFile}`);
      return;
    }

    const sourceDir = await resolveExistingPathInside(bundlePath, path.dirname(skillFile), true);
    if (!sourceDir || !fs.existsSync(sourceDir)) {
      this.logger.warn(`[RepositoryScopeService] Skill directory is missing or outside the bundle: ${skillFile}`);
      return;
    }
    if (!fs.statSync(sourceDir).isDirectory()) {
      this.logger.warn(`[RepositoryScopeService] Skill path is not a directory: ${sourceDir}`);
      return;
    }

    const files = await this.readDirectoryIntoMap(sourceDir, path.dirname(skillFile));
    const item: ManifestPlacementItem = { id: skillId, file: skillFile, type: 'skill' };
    const result = await writer.writeManifestItems(target, files, [item]);

    if (result.written.length > 0) {
      const skillDir = path.join(
        this.workspaceRoot,
        this.getTargetDirectory('skill'),
        skillId
      );
      tracker.skillDirs.push(skillDir);
      tracker.relativePaths.push(...result.written.map((p) => this.getRelativePath(p)));
      tracker.absolutePaths.push(...result.written);
    }

    this.logger.debug(`[RepositoryScopeService] Installed skill ${skillId}: ${result.written.length} files`);
  }

  /**
   * Install a single file and track for potential rollback
   * @param writer - Shared writer that places the file.
   * @param target - Target describing this workspace's repository scope.
   * @param bundlePath
   * @param promptDef
   * @param promptDef.file
   * @param promptDef.type
   * @param promptDef.tags
   * @param promptId
   * @param tracker
   */
  private async installFileAndTrack(
    writer: FileTreeTargetWriter,
    target: Target,
    bundlePath: string,
    promptDef: { file: string; type?: string; tags?: string[] },
    promptId: string,
    tracker: InstallationTracker
  ): Promise<void> {
    this.logger.debug(`[RepositoryScopeService] installFileAndTrack: bundlePath=${bundlePath}, file=${promptDef.file}, promptId=${promptId}`);
    const sourcePath = await resolveExistingPathInside(bundlePath, promptDef.file);
    if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      this.logger.warn(`[RepositoryScopeService] Source file is missing or outside the bundle: ${promptDef.file}`);
      return;
    }
    this.logger.debug(`[RepositoryScopeService] Source path: ${sourcePath}`);

    const fileType = promptDef.type as CopilotFileType || determineFileType(promptDef.file, promptDef.tags);
    const files = new Map<string, Uint8Array>([[promptDef.file, await readFile(sourcePath)]]);
    const item: ManifestPlacementItem = { id: promptId, file: promptDef.file, type: fileType, tags: promptDef.tags };
    const result = await writer.writeManifestItems(target, files, [item]);

    if (result.written.length === 0) {
      this.logger.warn(`[RepositoryScopeService] Failed to place file: ${sourcePath}`);
      return;
    }

    const targetPath = result.written[0];
    this.logger.info(`[RepositoryScopeService] File type: ${fileType}, Target path: ${targetPath}`);
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
   * Recursively read a directory's files into an in-memory map keyed by
   * bundle-relative path (e.g. `skills/my-skill/scripts/run.sh`), for
   * `FileTreeTargetWriter.writeManifestItems()`'s skill-copy mode, which
   * expects every file under the skill's bundle-relative prefix to be
   * present in the `ExtractedFiles` map it's given.
   * @param sourceDir - Absolute source directory path.
   * @param relativePrefix - Bundle-relative path prefix used for map keys.
   * @returns Map of bundle-relative path to file bytes.
   */
  private async readDirectoryIntoMap(sourceDir: string, relativePrefix: string): Promise<Map<string, Uint8Array>> {
    const files = new Map<string, Uint8Array>();
    const entries = await readdir(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(sourceDir, entry.name);
      const entryPrefix = `${relativePrefix}/${entry.name}`;

      if (entry.isDirectory()) {
        const nested = await this.readDirectoryIntoMap(entryPath, entryPrefix);
        for (const [key, value] of nested) {
          files.set(key, value);
        }
      } else if (entry.isFile()) {
        files.set(entryPrefix, await readFile(entryPath));
      }
    }

    return files;
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
   * Clean up empty AI Primitives Hub subdirectories for the current host.
   *
   * Removes only the directories this tool manages, resolved per host from the
   * layout — e.g. `.github/prompts|agents|instructions|skills` on VS Code, or
   * `.kiro/steering|agents|skills` on Kiro — and only when they are empty.
   *
   * Never removes the host root folder itself (`.github`/`.kiro`), which may
   * hold unrelated files (workflows, CODEOWNERS, other steering docs, etc.).
   */
  private async cleanupEmptyPromptRegistryDirectories(): Promise<void> {
    const seen = new Set<string>();

    for (const kind of MANAGED_KINDS) {
      // Host-appropriate managed dir (deduped: e.g. prompt+instructions both
      // resolve to .kiro/steering on Kiro).
      const relativeDir = this.getTargetDirectory(kind).replace(/\/+$/, '');
      if (seen.has(relativeDir)) {
        continue;
      }
      seen.add(relativeDir);

      const dirPath = path.join(this.workspaceRoot, relativeDir);
      if (!fs.existsSync(dirPath)) {
        continue;
      }

      try {
        // Skills are nested directories; clean their empty subdirs first.
        if (kind === 'skill') {
          await this.cleanupEmptySkillDirectories(dirPath);
        }

        const files = await readdir(dirPath);

        // Only remove if directory is empty
        if (files.length === 0) {
          await rm(dirPath, { recursive: true, force: true });
          this.logger.debug(`[RepositoryScopeService] Removed empty directory: ${this.getRelativePath(dirPath)}`);
        }
      } catch {
        this.logger.warn(`[RepositoryScopeService] Failed to check/remove directory: ${dirPath}`);
      }
    }
  }

  /**
   * Clean up empty skill directories within the host's skills folder
   * (e.g. `.github/skills/` or `.kiro/skills/`). Skills are directories, so we
   * recursively check and remove empty ones.
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

  /**
   * Remove a bundle's entry from the old `prompt-registry` lockfile, with its
   * files (BR12.1).
   * @param bundleId - Bundle id.
   * @returns Whether an old entry existed.
   */
  private async unsyncOldEntry(bundleId: string): Promise<boolean> {
    const retired = await this.records.retireOldEntry(this.workspaceRoot, bundleId);
    if (retired === undefined) {
      return false;
    }
    retired.warnings.forEach((warning) => this.logger.warn(`[RepositoryScopeService] ${warning}`));
    await this.afterFilesRemoved(true, retired.deleted, retired.kept);
    this.logger.info(`[RepositoryScopeService] ✅ Removed ${retired.deleted.length} old-lockfile files for bundle: ${bundleId}`);
    return true;
  }

  /**
   * Exclude cleanup, empty-folder cleanup and the log line after an uninstall.
   * @param wasLocalOnly - Whether removed paths may be in `info/exclude`.
   * @param deleted - Workspace-relative removed paths.
   * @param kept - Paths kept (shared or modified).
   */
  private async afterFilesRemoved(wasLocalOnly: boolean, deleted: readonly string[], kept: readonly string[]): Promise<void> {
    if (deleted.length > 0) {
      if (wasLocalOnly) {
        await this.removeFromGitExclude(this.consolidateSkillPathsForGitExclude([...deleted]));
      }
      await this.cleanupEmptyPromptRegistryDirectories();
    }
    if (kept.length > 0) {
      this.logger.info(`[RepositoryScopeService] Preserved ${kept.length} files (shared or modified): ${kept.join(', ')}`);
    }
  }

  /**
   * A record-root-relative path as a workspace-relative one, forward slashes.
   * @param root - Record root (git root).
   * @param recordedPath - Path relative to `root`.
   */
  private fromRootRelative(root: string, recordedPath: string): string {
    return path.relative(this.workspaceRoot, path.join(root, ...recordedPath.split('/'))).split(path.sep).join('/');
  }

  /**
   * Today's commit-mode switch for a bundle only the old lockfile holds:
   * exclude entries for the host's managed folders.
   * @param bundleId - Bundle identifier
   * @param newMode - New commit mode
   */
  private async switchOldCommitMode(bundleId: string, newMode: RepositoryCommitMode): Promise<void> {
    const bundle = (await this.records.listOldBundles(this.workspaceRoot)).find((b) => b.bundleId === bundleId);
    if (!bundle) {
      this.logger.warn(`[RepositoryScopeService] Bundle ${bundleId} not found in any record or lockfile`);
      return;
    }
    if ((bundle.commitMode ?? 'commit') === newMode) {
      this.logger.debug(`[RepositoryScopeService] Bundle ${bundleId} already in ${newMode} mode`);
      return;
    }

    // The old entry's files point to the bundle cache, not the installed
    // location, so the host-aware destination folders are scanned (e.g.
    // .github/* for VS Code, .kiro/* for Kiro). Kinds are deduped because
    // several may resolve to the same folder (prompt + instructions -> .kiro/steering/).
    const filePaths: string[] = [];
    const scannedDirs = new Set<string>();
    for (const kind of MANAGED_KINDS) {
      const relativeDir = this.getTargetDirectory(kind).replace(/[/\\]+$/, '');
      if (scannedDirs.has(relativeDir)) {
        continue;
      }
      scannedDirs.add(relativeDir);
      const absoluteDir = path.join(this.workspaceRoot, relativeDir);
      if (!fs.existsSync(absoluteDir)) {
        continue;
      }
      for (const entry of await readdir(absoluteDir)) {
        filePaths.push(path.join(relativeDir, entry));
      }
    }

    // VS Code-specific convention file (harmless no-op on other hosts).
    if (fs.existsSync(path.join(this.workspaceRoot, '.github', 'copilot-instructions.md'))) {
      filePaths.push('.github/copilot-instructions.md');
    }

    await (newMode === 'local-only' ? this.addToGitExclude(filePaths) : this.removeFromGitExclude(filePaths));
    // Move the entry between the two old lockfiles (app `json-lockfile-store`).
    await this.records.moveOldEntry(this.workspaceRoot, bundleId, newMode);
    this.logger.info(`[RepositoryScopeService] ✅ Switched ${bundleId} to ${newMode} mode`);
  }

  /**
   * Get the target path for a file of a given type.
   * Implements IScopeService.getTargetPath
   * @param fileType - The Copilot file type
   * @param fileName - The name of the file (without extension)
   * @returns The full target path where the file should be placed
   */
  public getTargetPath(fileType: CopilotFileType, fileName: string): string {
    const relativeDir = this.getTargetDirectory(fileType);
    const targetFileName = getTargetFileName(fileName, fileType);
    return path.join(this.workspaceRoot, relativeDir, targetFileName);
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
    const routeKey = KIND_TO_ROUTE_KEY[type];
    const route = layout.kindRoutes[routeKey];
    if (route === undefined) {
      throw new Error(
        `No repository route defined for file type "${type}" (route key "${routeKey}") in layout "${this.targetType}". Add it to default-layouts.json.`
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
   * @param options - Optional sync options including commitMode
   * @returns Absolute paths of the files written, for the install record (BR1.7); empty without a manifest.
   */
  public async syncBundle(bundleId: string, bundlePath: string, options?: SyncBundleOptions): Promise<string[]> {
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
        return [];
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
      return installedPaths;
    } catch (error) {
      this.logger.error(`[RepositoryScopeService] Failed to sync bundle ${bundleId}`, error as Error);
      throw error;
    }
  }

  /**
   * Remove synced files for a bundle (W10).
   * Implements IScopeService.unsyncBundle
   *
   * With a host-tool entry in the install record, app's `uninstallEntry`
   * removes the entry and deletes its files, keeping every path another entry
   * still lists and files whose content no longer matches the recorded
   * checksum, or that are missing (NFR4.13).
   * A bundle only the old `prompt-registry` lockfile holds is removed from it
   * the same way (BR12.1), keeping paths any record entry lists; after a
   * record uninstall, an old entry for the same bundle is retired as well.
   * @param bundleId - The unique identifier of the bundle to unsync
   * @throws {RegistryError} Any `RECORD.*` error; the record and files are unchanged when loading fails.
   */
  public async unsyncBundle(bundleId: string): Promise<void> {
    try {
      this.logger.debug(`[RepositoryScopeService] Removing files for bundle: ${bundleId}`);
      const located = await this.records.findHostEntry(this.workspaceRoot, bundleId);
      if (located === undefined) {
        if (!await this.unsyncOldEntry(bundleId)) {
          this.logger.debug(`[RepositoryScopeService] Bundle ${bundleId} not found in any record or lockfile`);
        }
        return;
      }
      const { location } = located;
      const removed = await this.records.service.uninstallEntry({ location, bundleId, tool: this.records.hostTool });
      for (const warning of removed.warnings) {
        this.logger.warn(`[RepositoryScopeService] ${warning}`);
      }
      await this.afterFilesRemoved(location.commitMode === 'local-only', removed.deleted.map((file) => this.fromRootRelative(location.root, file)), removed.kept);
      this.logger.info(`[RepositoryScopeService] ✅ Removed ${removed.deleted.length} files for bundle: ${bundleId}`);
      // Uninstall removes both (BR12.1): an old entry for the same bundle is
      // retired too, keeping every path a record entry still lists or that was modified.
      await this.unsyncOldEntry(bundleId);
    } catch (error) {
      if (isRecordError(error)) {
        throw error;
      }
      this.logger.error(`[RepositoryScopeService] Failed to unsync bundle ${bundleId}`, error as Error);
    }
  }

  /**
   * Switch the commit mode for a bundle (BR11.5).
   *
   * A host-tool record entry moves unchanged to the other record file
   * (`moveEntry`). Its paths are added to `info/exclude` only when no
   * committed entry lists them, and removed only when no local-only entry
   * lists them. A bundle only the old lockfile holds keeps today's
   * folder-scan exclude update; the caller updates the old file.
   * @param bundleId - Bundle identifier
   * @param newMode - New commit mode
   * @throws {RegistryError} Any `RECORD.*` error.
   */
  public async switchCommitMode(bundleId: string, newMode: RepositoryCommitMode): Promise<void> {
    try {
      this.logger.debug(`[RepositoryScopeService] Switching commit mode for ${bundleId} to ${newMode}`);
      const located = await this.records.findHostEntry(this.workspaceRoot, bundleId);
      if (located === undefined) {
        await this.switchOldCommitMode(bundleId, newMode);
        return;
      }
      if ((located.location.commitMode ?? 'commit') === newMode) {
        this.logger.debug(`[RepositoryScopeService] Bundle ${bundleId} already in ${newMode} mode`);
        return;
      }
      const moved = await this.records.service.moveEntry({ location: located.location, bundleId, tool: this.records.hostTool });
      moved.warnings.forEach((warning) => this.logger.warn(`[RepositoryScopeService] ${warning}`));
      const [committed, localOnly] = await this.records.locations(this.workspaceRoot);
      const otherMode = await this.records.listedPathsIn(newMode === 'local-only' ? committed : localOnly);
      const paths = located.entry.files.map((file) => file.path).filter((file) => !otherMode.has(file))
        .map((file) => this.fromRootRelative(located.location.root, file));
      const forExclude = this.consolidateSkillPathsForGitExclude(paths);
      await (newMode === 'local-only' ? this.addToGitExclude(forExclude) : this.removeFromGitExclude(forExclude));
      this.logger.info(`[RepositoryScopeService] ✅ Switched ${bundleId} to ${newMode} mode`);
    } catch (error) {
      if (isRecordError(error)) {
        throw error;
      }
      this.logger.error(`[RepositoryScopeService] Failed to switch commit mode for ${bundleId}`, error as Error);
    }
  }

  /**
   * Bundle sub-path kinds (`kindRoutes` keys such as `prompts/`) the
   * manifest's items write, for the writer group (BR11.6).
   * @param manifest - Deployment manifest of the installed bundle.
   */
  public routeKeysFor(manifest: DeploymentManifest): string[] {
    const keys = new Set<string>();
    for (const promptDef of manifest.prompts ?? []) {
      const fileType = promptDef.type as CopilotFileType || determineFileType(promptDef.file, promptDef.tags);
      keys.add(KIND_TO_ROUTE_KEY[fileType]);
    }
    return [...keys];
  }
}
