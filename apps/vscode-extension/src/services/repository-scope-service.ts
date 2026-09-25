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
  getKnowledgeRelativePath,
  KIND_TO_ROUTE_KEY,
  resolveLayout,
} from '@ai-primitives-hub/app';
import type {
  ManifestPlacementItem,
  WriterFs,
} from '@ai-primitives-hub/app';
import type {
  ManifestPlacementType,
  Target,
  TargetType,
} from '@ai-primitives-hub/core';
import {
  assertSafeRepositoryDirectoryPath,
  assertSafeRepositoryRemovalPath,
  toCopilotFileType,
  UnsafeRepositoryPathError,
} from '@ai-primitives-hub/core';
import * as yaml from 'js-yaml';
import {
  RegistryStorage,
} from '../storage/registry-storage';
import type {
  Lockfile,
} from '../types/lockfile';
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
  calculateFileChecksum,
  ensureDirectory,
} from '../utils/file-integrity-service';
import {
  detectHostApp,
} from '../utils/host-app';
import {
  normalizeFilesystemPath,
  normalizeLockfilePath,
  normalizeLockfilePaths,
  resolveLockfilePath,
} from '../utils/lockfile-path-utils';
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
const rm = promisify(fs.rm);

/**
 * `WriterFs` adapter backed by Node's `fs` module, so
 * `RepositoryScopeService` can drive the shared
 * `FileTreeTargetWriter.writeManifestItems()` placement/naming logic
 * instead of duplicating it.
 */
class NodeWriterFs implements WriterFs {
  private readonly writes = new Map<string, { before: Buffer | null; after: Buffer }>();

  private async writeTracked(p: string, bytes: Uint8Array): Promise<void> {
    let before = this.writes.get(p)?.before;
    if (!this.writes.has(p)) {
      try {
        before = await fs.promises.readFile(p);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
        before = null;
      }
    }
    await fs.promises.writeFile(p, bytes);
    this.writes.set(p, { before: before ?? null, after: Buffer.from(bytes) });
  }

  public getWrittenFiles(): { path: string; before: Buffer | null; after: Buffer }[] {
    return [...this.writes].map(([filePath, contents]) => ({ path: filePath, ...contents }));
  }

  public async writeFile(p: string, contents: string): Promise<void> {
    await this.writeTracked(p, Buffer.from(contents, 'utf8'));
  }

  public async writeFileBytes(p: string, bytes: Uint8Array): Promise<void> {
    await this.writeTracked(p, bytes);
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
const MANAGED_KINDS: readonly ManifestPlacementType[] = ['prompt', 'instructions', 'agent', 'skill', 'knowledge'];

/**
 * Tracks installed files during bundle installation for rollback support
 */
interface InstallationTracker {
  relativePaths: string[];
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
   * Check the parent of a repository destination and refuse writing through a
   * final symlink. Removal can safely unlink a final symlink; writing follows it.
   * @param targetPath - Absolute destination about to be written.
   */
  private async assertSafeInstallPath(targetPath: string): Promise<void> {
    await assertSafeRepositoryRemovalPath(this.workspaceRoot, targetPath, fs.promises.realpath);
    try {
      if ((await fs.promises.lstat(targetPath)).isSymbolicLink()) {
        throw new UnsafeRepositoryPathError(targetPath, 'is a symlink and cannot be written safely');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      if (error instanceof UnsafeRepositoryPathError) {
        throw error;
      }
      throw new UnsafeRepositoryPathError(targetPath, 'cannot be checked against repository root');
    }
  }

  /**
   * Install files from a bundle to the host-appropriate directories
   * @param bundlePath - Path to bundle directory
   * @param manifest - Deployment manifest
   * @param commitMode - Whether to track in git or exclude
   * @param afterSync
   * @returns Array of installed file paths (relative to workspace)
   */
  private async installFiles(
    bundlePath: string,
    manifest: DeploymentManifest,
    commitMode: RepositoryCommitMode,
    afterSync?: () => Promise<void>
  ): Promise<string[]> {
    const tracker: InstallationTracker = {
      relativePaths: [],
      skillDirs: []
    };
    const writerFs = new NodeWriterFs();

    try {
      // Copy all bundle files to target directories
      await this.copyBundleFiles(bundlePath, manifest, tracker, writerFs);

      // Lockfile failures must rollback the same files as placement failures.
      // Exclude changes happen only after tracking has been persisted.
      await afterSync?.();

      // Handle git exclude for local-only mode
      if (commitMode === 'local-only' && tracker.relativePaths.length > 0) {
        await this.updateGitExcludeForLocalOnly(tracker.relativePaths);
      }

      return tracker.relativePaths;
    } catch (error) {
      await this.rollbackInstallation(tracker, writerFs);
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
   * @param writerFs - Tracks written files for a safe rollback.
   */
  private async copyBundleFiles(
    bundlePath: string,
    manifest: DeploymentManifest,
    tracker: InstallationTracker,
    writerFs: NodeWriterFs
  ): Promise<void> {
    const target: Target = this.getTarget();
    const writer = new FileTreeTargetWriter({ fs: writerFs, env: process.env });

    // The extractor keys source files with POSIX separators. Convert Windows
    // manifest paths to the same form, but reject ambiguous POSIX backslashes
    // before writing any repository files.
    const prompts = (manifest.prompts || []).map((promptDef) => ({
      ...promptDef,
      file: normalizeFilesystemPath(promptDef.file)
    }));

    for (const promptDef of prompts) {
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

    const sourceDir = path.join(bundlePath, path.posix.dirname(skillFile));
    if (!fs.existsSync(sourceDir)) {
      this.logger.warn(`[RepositoryScopeService] Skill directory not found: ${sourceDir}`);
      return;
    }
    if (!fs.statSync(sourceDir).isDirectory()) {
      this.logger.warn(`[RepositoryScopeService] Skill path is not a directory: ${sourceDir}`);
      return;
    }

    const files = await this.readDirectoryIntoMap(sourceDir, path.posix.dirname(skillFile));
    const sourcePrefix = `${path.posix.dirname(skillFile)}/`;
    const skillDir = path.join(this.workspaceRoot, this.getTargetDirectory('skill'), skillId);
    // Preflight every asset before the writer creates any destination files.
    for (const sourceFile of files.keys()) {
      if (sourceFile.startsWith(sourcePrefix)) {
        await this.assertSafeInstallPath(path.join(skillDir, sourceFile.slice(sourcePrefix.length)));
      }
    }

    const item: ManifestPlacementItem = { id: skillId, file: skillFile, type: 'skill' };
    const result = await writer.writeManifestItems(target, files, [item]);

    if (result.written.length > 0) {
      tracker.skillDirs.push(skillDir);
      tracker.relativePaths.push(...result.written.map((p) => this.getRelativePath(p)));
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
    promptDef: { file: string; type?: ManifestPlacementType; tags?: string[] },
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

    const fileType = promptDef.type ?? determineFileType(promptDef.file, promptDef.tags);
    const knowledgeRelativePath = fileType === 'knowledge' ? getKnowledgeRelativePath(promptDef.file) : null;
    const copilotType = fileType === 'knowledge' ? null : toCopilotFileType(fileType);
    const targetPath = knowledgeRelativePath === null
      ? (copilotType === null
        ? null
        : path.join(this.workspaceRoot, this.getTargetDirectory(fileType), getTargetFileName(promptId, copilotType)))
      : path.join(this.workspaceRoot, this.getTargetDirectory('knowledge'), knowledgeRelativePath);
    if (targetPath === null) {
      this.logger.warn(`[RepositoryScopeService] No repository route for: ${promptDef.file}`);
      return;
    }
    await this.assertSafeInstallPath(targetPath);

    const files = new Map<string, Uint8Array>([[promptDef.file, await readFile(sourcePath)]]);
    const item: ManifestPlacementItem = { id: promptId, file: promptDef.file, type: fileType, tags: promptDef.tags };
    const result = await writer.writeManifestItems(target, files, [item]);

    if (result.written.length === 0) {
      this.logger.warn(`[RepositoryScopeService] Failed to place file: ${sourcePath}`);
      return;
    }

    const writtenPath = result.written[0];
    this.logger.info(`[RepositoryScopeService] File type: ${fileType}, Target path: ${writtenPath}`);
    this.logger.info(`[RepositoryScopeService] ✅ Copied: ${sourcePath} → ${writtenPath}`);

    tracker.relativePaths.push(this.getRelativePath(writtenPath));
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
   * Rollback installation by removing new files and restoring overwritten ones.
   * @param tracker
   * @param writerFs - Journal of successfully written file contents.
   */
  private async rollbackInstallation(tracker: InstallationTracker, writerFs: NodeWriterFs): Promise<void> {
    this.logger.error(`[RepositoryScopeService] Installation failed, rolling back...`);

    // Leave files that changed since the write untouched. Never delete a
    // pre-existing file just because an install or lockfile write failed.
    for (const { path: absolutePath, before, after } of writerFs.getWrittenFiles().toReversed()) {
      try {
        await this.assertSafeInstallPath(absolutePath);
        if (!fs.existsSync(absolutePath)) {
          continue;
        }
        if (!(await fs.promises.readFile(absolutePath)).equals(after)) {
          this.logger.warn(`[RepositoryScopeService] Preserving modified file during rollback: ${absolutePath}`);
          continue;
        }
        await (before === null ? unlink(absolutePath) : writeFile(absolutePath, before));
        this.logger.debug(`[RepositoryScopeService] Rolled back: ${absolutePath}`);
      } catch {
        this.logger.warn(`[RepositoryScopeService] Failed to rollback file: ${absolutePath}`);
      }
    }

    // Remove only empty directories created for the skill, never recursively
    // delete a potentially shared or user-owned skill tree.
    for (const skillDir of tracker.skillDirs.toReversed()) {
      try {
        await assertSafeRepositoryDirectoryPath(this.workspaceRoot, skillDir, fs.promises.realpath);
        if ((await readdir(skillDir)).length === 0) {
          await fs.promises.rmdir(skillDir);
          this.logger.debug(`[RepositoryScopeService] Rolled back empty skill directory: ${skillDir}`);
        }
      } catch {
        this.logger.warn(`[RepositoryScopeService] Failed to clean up skill directory: ${skillDir}`);
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
      normalizeFilesystemPath(entry.name);

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
            usedFiles.add(normalizeLockfilePath(file.path));
          }
        }
      }
    }

    // Check local lockfile
    if (localLockfile?.bundles) {
      for (const [bundleId, entry] of Object.entries(localLockfile.bundles)) {
        if (bundleId !== excludeBundleId && entry.files) {
          for (const file of entry.files) {
            usedFiles.add(normalizeLockfilePath(file.path));
          }
        }
      }
    }

    return usedFiles;
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
      let relativeDir: string;
      try {
        relativeDir = this.getTargetDirectory(kind).replace(/\/+$/, '');
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('No repository route defined')) {
          throw error;
        }
        continue;
      }
      if (seen.has(relativeDir)) {
        continue;
      }
      seen.add(relativeDir);

      const dirPath = path.join(this.workspaceRoot, relativeDir);
      if (!fs.existsSync(dirPath)) {
        continue;
      }

      try {
        await assertSafeRepositoryDirectoryPath(this.workspaceRoot, dirPath, fs.promises.realpath);
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
      await assertSafeRepositoryDirectoryPath(this.workspaceRoot, skillsDir, fs.promises.realpath);
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
      await assertSafeRepositoryDirectoryPath(this.workspaceRoot, dir, fs.promises.realpath);
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
   * @param type - The manifest placement type being placed.
   * @returns The workspace-relative directory (e.g. `.kiro/agents/`).
   */
  public getTargetDirectory(type: ManifestPlacementType): string {
    const layout = resolveLayout(this.getTarget());
    const routeKey = KIND_TO_ROUTE_KEY[type];
    if (routeKey === undefined) {
      throw new Error(
        `No repository route defined for file type "${type}" in layout "${this.targetType}". Add it to default-layouts.json.`
      );
    }
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
      const installedPaths = await this.installFiles(bundlePath, manifest, commitMode, options?.afterSync);

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
      let localLockfile: Lockfile | null = null;
      if (fs.existsSync(localLockfilePath)) {
        try {
          const content = await readFile(localLockfilePath, 'utf8');
          localLockfile = normalizeLockfilePaths(JSON.parse(content) as Lockfile);
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

      // Check every recorded path before deleting any. The parent, not the
      // final file, is resolved so a final symlink can be unlinked safely.
      const filesToUnsync = await Promise.all(bundleFiles.map(async (fileEntry) => {
        const relativePath = normalizeLockfilePath(fileEntry.path);
        const targetPath = resolveLockfilePath(this.workspaceRoot, relativePath);
        await assertSafeRepositoryRemovalPath(this.workspaceRoot, targetPath, fs.promises.realpath);
        return { fileEntry, relativePath, targetPath };
      }));

      const removedPaths: string[] = [];
      const skippedPaths: { path: string; reason: string }[] = [];

      // Remove each file tracked in the lockfile
      for (const { fileEntry, relativePath, targetPath } of filesToUnsync) {
        // Skip if file doesn't exist
        if (!fs.existsSync(targetPath)) {
          this.logger.debug(`[RepositoryScopeService] File already removed: ${relativePath}`);
          continue;
        }

        // Skip if file is used by another bundle
        if (filesUsedByOtherBundles.has(relativePath)) {
          skippedPaths.push({ path: relativePath, reason: 'used by another bundle' });
          this.logger.debug(`[RepositoryScopeService] Skipping file used by another bundle: ${relativePath}`);
          continue;
        }

        // Check if file has been modified by user (checksum mismatch)
        try {
          const currentChecksum = await calculateFileChecksum(targetPath);
          if (currentChecksum !== fileEntry.checksum) {
            skippedPaths.push({ path: relativePath, reason: 'modified by user' });
            this.logger.info(`[RepositoryScopeService] Preserving user-modified file: ${relativePath}`);
            continue;
          }
        } catch {
          this.logger.warn(`[RepositoryScopeService] Failed to calculate checksum for: ${relativePath}`);
          continue;
        }

        // Safe to remove - file is tracked, unmodified, and not shared
        try {
          await unlink(targetPath);
          removedPaths.push(relativePath);
          this.logger.debug(`[RepositoryScopeService] Removed: ${relativePath}`);
        } catch {
          this.logger.warn(`[RepositoryScopeService] Failed to remove file: ${relativePath}`);
        }
      }

      // Remove from git exclude if needed
      if (removedPaths.length > 0) {
        // Consolidate skill file paths to skill directory paths for git exclude
        // (mirrors the logic in updateGitExcludeForLocalOnly)
        const pathsForExclude = this.consolidateSkillPathsForGitExclude(removedPaths);
        await this.removeFromGitExclude(pathsForExclude);

        // Clean up empty AI Primitives Hub subdirectories
        // Only removes directories that are completely empty
        await this.cleanupEmptyPromptRegistryDirectories();
      }

      if (skippedPaths.length > 0) {
        this.logger.info(`[RepositoryScopeService] Preserved ${skippedPaths.length} files: ${skippedPaths.map((s) => `${s.path} (${s.reason})`).join(', ')}`);
      }

      this.logger.info(`[RepositoryScopeService] ✅ Removed ${removedPaths.length} files for bundle: ${bundleId}`);
    } catch (error) {
      this.logger.error(`[RepositoryScopeService] Failed to unsync bundle ${bundleId}`, error as Error);
      throw error;
    }
  }

  /**
   * Switch the commit mode for a bundle
   * @param bundleId - Bundle identifier
   * @param newMode - New commit mode
   *
   * Git-exclude updates are intentionally limited to paths recorded for this
   * bundle in the repository lockfile. This method does not scan managed
   * directories or infer ownership from files that are not recorded there.
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

      const filePaths = bundle.manifest.common.files;
      const pathsForExclude = this.consolidateSkillPathsForGitExclude(filePaths);
      this.logger.debug(`[RepositoryScopeService] Found ${filePaths.length} tracked files to update git exclude for`);

      await (newMode === 'local-only'
        ? this.addToGitExclude(pathsForExclude)
        : this.removeFromGitExclude(pathsForExclude));

      this.logger.info(`[RepositoryScopeService] ✅ Switched ${bundleId} to ${newMode} mode`);
    } catch (error) {
      this.logger.error(`[RepositoryScopeService] Failed to switch commit mode for ${bundleId}`, error as Error);
    }
  }
}
