/**
 * User Scope Service
 * Syncs installed prompts to GitHub Copilot's native locations at user level
 *
 * Instead of using a custom chat participant, we create symlinks/copies
 * of prompt files to locations where GitHub Copilot naturally discovers them.
 *
 * This works in:
 * - VSCode stable (no proposed APIs needed!)
 * - VSCode Insiders
 * - Windsurf and other forks
 *
 * Based on: https://github.com/github/awesome-copilot
 *
 * Requirements: 9.1-9.5
 */

import {
  execSync,
} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  promisify,
} from 'node:util';
import * as yaml from 'js-yaml';
import * as vscode from 'vscode';
import {
  DeploymentManifest,
} from '../types/registry';
import {
  CopilotFileType,
  determineFileType,
  getTargetFileName,
} from '../utils/copilot-file-type-utils';
import {
  Logger,
} from '../utils/logger';
import {
  escapeRegex,
} from '../utils/regex-utils';
import {
  checkPathExists,
} from '../utils/symlink-utils';
import {
  IScopeService,
  SyncBundleOptions,
} from './scope-service';

const readFile = promisify(fs.readFile);
const readdir = promisify(fs.readdir);
const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);
const symlink = promisify(fs.symlink);
const lstat = promisify(fs.lstat);

export interface CopilotFile {
  bundleId: string;
  type: CopilotFileType;
  name: string;
  sourcePath: string;
  targetPath: string;
}

type CodeFlavourFolder = 'Code' | 'Code - Insiders';

/**
 * Service to sync bundle prompts to GitHub Copilot's native directories at user level.
 * Implements IScopeService for consistent scope handling.
 */
export class UserScopeService implements IScopeService {
  private readonly logger: Logger;
  private readonly appNameMap: Map<string, CodeFlavourFolder> = new Map([
    ['vscode', 'Code'],
    ['vscode-insiders', 'Code - Insiders']
  ]);

  private windowsHomeInWSL: string | undefined;
  private cachedPromptsDir: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.logger = Logger.getInstance();
  }

  /**
   * Function to detect if the extension is running in a WSL remote context
   * We need this to determine if we should sync to Windows filesystem instead of WSL filesystem
   * @returns True if running in WSL, false otherwise
   */
  private isRunningInWSL(): boolean {
    return vscode.env.remoteName === 'wsl';
  }

  /**
   * When running on wsl, get the Windows home directory
   * @returns The Windows home directory path in WSL as mnt/c/Users/<User>
   */
  private getWindowsHomeDirectoryInWSL(): string | undefined {
    if (this.windowsHomeInWSL) {
      return this.windowsHomeInWSL;
    }
    try {
      const wslWindowsHome = execSync(`wslpath -u "$(cmd.exe /c echo %USERPROFILE% 2>/dev/null)"`, { encoding: 'utf8', timeout: 5000 }).trim();
      this.logger.info(`[UserScopeService] Detected Windows home directory in WSL: ${wslWindowsHome}`);
      this.windowsHomeInWSL = wslWindowsHome;
      return wslWindowsHome;
    } catch (error) {
      this.logger.error('Failed to get Windows home directory in WSL', error as Error);
      return undefined;
    }
  }

  /**
   * Get the Windows User directory when running in WSL.
   * Since we construct the path ourselves, we return the User dir directly
   * instead of globalStorage (avoiding redundant path parsing downstream).
   * @returns The User directory path in WSL, or undefined if not in WSL or detection fails.
   */
  private getWindowsWslUserDir(): string | undefined {
    if (!this.isRunningInWSL()) {
      return undefined;
    }
    try {
      const windowsHome = this.getWindowsHomeDirectoryInWSL();
      if (windowsHome) {
        const folderName = this.appNameMap.get(vscode.env.uriScheme) || 'Code';
        const userDir = path.join(windowsHome, 'AppData', 'Roaming', folderName, 'User');
        this.logger.debug(`[UserScopeService] Resolved WSL User directory: ${userDir}`);
        return userDir;
      }
    } catch {
      this.logger.warn('[UserScopeService] Failed to resolve Windows path, falling back to WSL path');
    }
    return undefined;
  }

  /**
   * Get the Copilot prompts directory for current VSCode flavor
   * Uses the extension's globalStorageUri to dynamically determine the IDE's data directory
   *
   * Supports both standard and profile-based paths:
   * - Standard: ~/Library/Application Support/<IDE>/User/globalStorage/<publisher>.<extension>
   * - Profile:  ~/Library/Application Support/<IDE>/User/profiles/<profile-id>/globalStorage/<publisher>.<extension>
   *
   * WORKAROUND: If extension is installed globally but user is in a profile,
   * we detect the active profile using combined detection methods
   *
   * WSL Support: When running in WSL remote context, GitHub Copilot runs in the Windows UI,
   * so we need to sync prompts to the Windows filesystem, not the WSL filesystem.
   */
  private getCopilotPromptsDirectory(): string {
    if (this.cachedPromptsDir) {
      return this.cachedPromptsDir;
    }

    const resolved = this.resolveCopilotPromptsDirectory();

    // Sanity check: the resolved path should end with 'prompts' and not be a filesystem root
    const basename = path.basename(resolved);
    if (basename !== 'prompts' || resolved === path.dirname(resolved)) {
      this.logger.warn(`[UserScopeService] Resolved prompts directory looks suspicious: ${resolved}`);
    }

    this.cachedPromptsDir = resolved;
    return resolved;
  }

  private resolveCopilotPromptsDirectory(): string {
    const globalStoragePath = this.context.globalStorageUri.fsPath;
    this.logger.debug(`[UserScopeService] Original globalStorage path: ${globalStoragePath}`);

    // WSL: we construct the path ourselves, so we know the User dir directly
    const wslUserDir = this.getWindowsWslUserDir();
    if (wslUserDir) {
      return this.resolvePromptsFromUserDir(wslUserDir);
    }

    if (this.isRunningInWSL()) {
      this.logger.warn('[UserScopeService] Unable to resolve Windows path from WSL. Prompts may not be visible to Copilot.');
      vscode.window.showWarningMessage('Prompt Registry: Unable to resolve Windows path from WSL. Prompts may not be visible to Copilot.');
    }

    // Non-WSL: parse the User dir from the globalStorage path
    const userIndex = globalStoragePath.lastIndexOf(path.sep + 'User' + path.sep);
    const userDir = userIndex === -1
      ? path.dirname(path.dirname(globalStoragePath))
      : globalStoragePath.substring(0, userIndex + path.sep.length + 'User'.length);

    // Check if the globalStorage path itself contains a profile segment
    // Path structure: .../User/profiles/<profile-id>/globalStorage/...
    const remainingPath = globalStoragePath.substring(userDir.length);
    const escapedSep = escapeRegex(path.sep);
    const profilesMatch = remainingPath.match(new RegExp(`^${escapedSep}profiles${escapedSep}([^${escapedSep}]+)`));
    if (profilesMatch) {
      const profileId = profilesMatch[1];
      const profileName = this.getActiveProfileName(userDir) || profileId;
      this.logger.info(`[UserScopeService] Using profile: ${profileName}`);
      return path.join(userDir, 'profiles', profileId, 'prompts');
    }

    return this.resolvePromptsFromUserDir(userDir);
  }

  /**
   * Given a known User directory, resolve the prompts directory
   * (handles profile detection for both WSL and non-WSL paths).
   * @param userDir
   */
  private resolvePromptsFromUserDir(userDir: string): string {
    this.logger.debug(`[UserScopeService] Resolved User directory: ${userDir}`);

    // Extension installed globally but user might be in a profile
    // Use combined detection method (storage.json + filesystem heuristic)
    const detectedProfile = this.detectActiveProfile(userDir);
    if (detectedProfile) {
      this.logger.info(`[UserScopeService] Using profile: ${detectedProfile.name}`);
      return path.join(userDir, 'profiles', detectedProfile.id, 'prompts');
    }

    // Standard path: User/prompts
    this.logger.info(`[UserScopeService] Using default profile`);
    return path.join(userDir, 'prompts');
  }

  /**
   * Detect active profile using combined workarounds
   *
   * Uses two complementary methods:
   * 1. storage.json parsing (most reliable when available)
   * 2. Filesystem heuristic (fallback based on recent activity)
   *
   * Returns profile ID and human-readable name, or null if no profile detected
   * @param userDir
   */
  private detectActiveProfile(userDir: string): { id: string; name: string } | null {
    try {
      const storageJsonPath = path.join(userDir, 'globalStorage', 'storage.json');
      const profilesDir = path.join(userDir, 'profiles');

      // Check if profiles directory exists
      if (!fs.existsSync(profilesDir)) {
        return null;
      }

      let profileId: string | null = null;
      let profileName: string | null = null;

      // WORKAROUND #1: Try storage.json first (most reliable)
      if (fs.existsSync(storageJsonPath)) {
        const storageData = JSON.parse(fs.readFileSync(storageJsonPath, 'utf8'));
        const items = storageData?.lastKnownMenubarData?.menus?.Preferences?.items;

        if (Array.isArray(items)) {
          const profilesMenu = items.find((i: any) => i?.id === 'submenuitem.Profiles');

          if (profilesMenu) {
            // Extract human-readable name from parent label
            // Format: "Profile (MyProfile)" or just "Profile"
            const parentLabel: string | undefined = profilesMenu.label;
            if (parentLabel) {
              const match = parentLabel.match(/\((.+)\)$/);
              if (match && match[1] && match[1] !== 'Default') {
                profileName = match[1];
              }
            }

            // Find corresponding profile ID from submenu items
            const submenuItems = profilesMenu.submenu?.items;
            if (Array.isArray(submenuItems)) {
              for (const item of submenuItems) {
                if (item?.command?.startsWith('workbench.profiles.actions.profileEntry.')) {
                  const candidateId = item.command.replace('workbench.profiles.actions.profileEntry.', '');
                  const profileDir = path.join(profilesDir, candidateId);
                  if (fs.existsSync(profileDir)) {
                    profileId = candidateId;
                    break;
                  }
                }
              }
            }
          }
        }

        if (profileId) {
          this.logger.debug(`[UserScopeService] Profile detected from storage.json: ${profileId}`);
          return { id: profileId, name: profileName || profileId };
        }
      }

      // WORKAROUND #2: Fallback to filesystem heuristic
      // Check profiles directory for recent activity
      const profiles = fs.readdirSync(profilesDir);

      for (const candidateId of profiles) {
        const profileGlobalStorage = path.join(profilesDir, candidateId, 'globalStorage');

        if (fs.existsSync(profileGlobalStorage)) {
          const stats = fs.statSync(profileGlobalStorage);
          const ageMinutes = (Date.now() - stats.mtimeMs) / 1000 / 60;

          // If modified in last 5 minutes, likely the active profile
          if (ageMinutes < 5) {
            this.logger.debug(`[UserScopeService] Profile detected from filesystem heuristic: ${candidateId}`);
            return { id: candidateId, name: candidateId };
          }
        }
      }

      return null;
    } catch {
      // Silent failure - this is a best-effort workaround
      return null;
    }
  }

  /**
   * Get the active profile display name from storage.json
   * Returns the human-readable profile name (e.g., "Work", "Personal")
   * Used for paths that already have a profile ID embedded
   * @param userDir
   */
  private getActiveProfileName(userDir: string): string | null {
    try {
      const storageJsonPath = path.join(userDir, 'globalStorage', 'storage.json');

      if (!fs.existsSync(storageJsonPath)) {
        return null;
      }

      const storageData = JSON.parse(fs.readFileSync(storageJsonPath, 'utf8'));
      const items = storageData?.lastKnownMenubarData?.menus?.Preferences?.items;

      if (!Array.isArray(items)) {
        return null;
      }

      const profilesMenu = items.find((i: any) => i?.id === 'submenuitem.Profiles');

      // Extract profile name from parent label
      // Format: "Profile (MyProfile)" or just "Profile"
      const parentLabel: string | undefined = profilesMenu?.label;
      if (parentLabel) {
        const match = parentLabel.match(/\((.+)\)$/);
        if (match && match[1] && match[1] !== 'Default') {
          return match[1];
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Sync a skill from a bundle
   * Skills are directories containing SKILL.md and optional subdirectories
   * @param bundleId
   * @param bundlePath
   * @param promptDef
   */
  private async syncSkillFromBundle(bundleId: string, bundlePath: string, promptDef: any): Promise<void> {
    try {
      // Extract skill name from the path (e.g., skills/my-skill/SKILL.md -> my-skill)
      const skillPath = promptDef.file;
      const skillMatch = skillPath.match(/skills\/([^/]+)\/SKILL\.md/);

      if (!skillMatch) {
        this.logger.warn(`Invalid skill path: ${skillPath}`);
        return;
      }

      const skillName = skillMatch[1];
      const skillSourceDir = path.join(bundlePath, 'skills', skillName);

      if (!fs.existsSync(skillSourceDir)) {
        this.logger.warn(`Skill directory not found: ${skillSourceDir}`);
        return;
      }

      // Sync skill to ~/.copilot/skills
      await this.syncSkill(skillName, skillSourceDir, 'user');

      this.logger.info(`✅ Synced skill: ${skillName}`);
    } catch (error) {
      this.logger.error(`Failed to sync skill from bundle ${bundleId}`, error as Error);
    }
  }

  /**
   * Determine Copilot file type and target path
   * Uses shared utility for file type detection
   * @param promptDef
   * @param sourcePath
   * @param bundleId
   */
  private determineCopilotFileType(
    promptDef: any,
    sourcePath: string,
    bundleId: string
  ): CopilotFile {
    // Check if tags or filename indicate type
    const tags = promptDef.tags || [];

    // Use manifest type if provided, otherwise detect from file
    const type: CopilotFileType = promptDef.type ? promptDef.type as CopilotFileType : determineFileType(sourcePath, tags);

    // Create target path: promptId.type.md directly in prompts directory
    const targetFileName = getTargetFileName(promptDef.id, type);
    const promptsDir = this.getCopilotPromptsDirectory();
    const targetPath = path.join(promptsDir, targetFileName);

    return {
      bundleId,
      type,
      name: promptDef.name,
      sourcePath,
      targetPath
    };
  }

  /**
   * Create symlink (or copy if symlink fails) to Copilot directory
   *
   * Always removes and recreates symlinks to ensure they point to the correct target.
   * Uses lstat() to detect symlinks (including broken ones) since fs.existsSync()
   * returns false for broken symlinks.
   * @param file
   */
  private async createCopilotFile(file: CopilotFile): Promise<void> {
    try {
      // Check if target already exists using lstat() to detect broken symlinks
      // fs.existsSync() returns false for broken symlinks, but lstat() can still read them
      const existingEntry = await checkPathExists(file.targetPath);

      if (existingEntry.exists) {
        if (existingEntry.isSymbolicLink) {
          // Always remove existing symlink and recreate - simpler and more robust
          await unlink(file.targetPath);
          this.logger.debug(`Removed existing symlink: ${file.targetPath}`);
        } else if (this.isRunningInWSL()) {
          // WSL uses copies (not symlinks), so existing regular files are ours — overwrite
          await unlink(file.targetPath);
          this.logger.debug(`Removed existing copy for re-sync (WSL): ${file.targetPath}`);
        } else {
          // It's a regular file on non-WSL - might be user's custom file, skip
          this.logger.warn(`File already exists (not managed): ${file.targetPath}`);
          return;
        }
      }

      // Ensure parent directory exists before creating symlink/file
      const targetDir = path.dirname(file.targetPath);
      await this.ensureDirectory(targetDir);

      // WSL: symlinks from Windows → WSL paths are broken from Windows' perspective,
      // so always copy when running in WSL. On non-WSL, prefer symlinks.
      if (this.isRunningInWSL()) {
        const content = await readFile(file.sourcePath, 'utf8');
        await writeFile(file.targetPath, content, 'utf8');
        this.logger.debug(`Copied file (WSL): ${path.basename(file.targetPath)}`);
      } else {
        try {
          await symlink(file.sourcePath, file.targetPath, 'file');
          this.logger.debug(`Created symlink: ${path.basename(file.targetPath)}`);
        } catch {
          // Symlink failed (maybe Windows or permissions), fall back to copy
          this.logger.debug('Symlink failed, copying file instead');
          const content = await readFile(file.sourcePath, 'utf8');
          await writeFile(file.targetPath, content, 'utf8');
          this.logger.debug(`Copied file: ${path.basename(file.targetPath)}`);
        }
      }

      this.logger.info(`✅ Synced ${file.type}: ${file.name} → ${path.basename(file.targetPath)}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Failed to create Copilot file: ${file.targetPath}`, {
        message: errorMessage,
        stack: errorStack,
        bundleId: file.bundleId,
        fileType: file.type
      } as any);
    }
  }

  /**
   * Ensure directory exists
   * @param dir
   */
  private async ensureDirectory(dir: string): Promise<void> {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      this.logger.debug(`Created directory: ${dir}`);
    }
  }

  /**
   * Copy skill directory recursively
   * @param sourceDir
   * @param targetDir
   */
  private async copySkillDirectory(sourceDir: string, targetDir: string): Promise<void> {
    await this.ensureDirectory(targetDir);

    const entries = await readdir(sourceDir);

    for (const entry of entries) {
      const sourcePath = path.join(sourceDir, entry);
      const targetPath = path.join(targetDir, entry);

      const stats = fs.statSync(sourcePath);

      if (stats.isDirectory()) {
        await this.copySkillDirectory(sourcePath, targetPath);
      } else {
        const fileContent = await readFile(sourcePath);
        await writeFile(targetPath, fileContent);
      }
    }
  }

  /**
   * Remove skill directory recursively
   * @param dir
   */
  private async removeSkillDirectory(dir: string): Promise<void> {
    if (!fs.existsSync(dir)) {
      return;
    }

    const entries = await readdir(dir);

    for (const entry of entries) {
      const entryPath = path.join(dir, entry);
      const stats = await lstat(entryPath);

      if (stats.isSymbolicLink()) {
        await unlink(entryPath);
      } else if (stats.isDirectory()) {
        await this.removeSkillDirectory(entryPath);
      } else {
        await unlink(entryPath);
      }
    }

    fs.rmdirSync(dir);
  }

  /**
   * Sync a single bundle to Copilot directory
   * Implements IScopeService.syncBundle
   * @param bundleId - The unique identifier of the bundle
   * @param bundlePath - The path to the installed bundle directory
   * @param _options - Ignored for user scope (commitMode only applies to repository scope)
   */
  public async syncBundle(bundleId: string, bundlePath: string, _options?: SyncBundleOptions): Promise<void> {
    try {
      this.logger.debug(`Syncing bundle: ${bundleId}`);

      // Get prompts directory
      const promptsDir = this.getCopilotPromptsDirectory();

      // Ensure base Copilot prompts directory exists
      await this.ensureDirectory(promptsDir);

      // Read deployment manifest
      const manifestPath = path.join(bundlePath, 'deployment-manifest.yml');

      if (!fs.existsSync(manifestPath)) {
        this.logger.warn(`No manifest found for bundle: ${bundleId}`);
        return;
      }

      const manifestContent = await readFile(manifestPath, 'utf8');
      const manifest = yaml.load(manifestContent) as DeploymentManifest;

      if (!manifest.prompts || manifest.prompts.length === 0) {
        this.logger.debug(`Bundle ${bundleId} has no prompts to sync`);
        return;
      }

      // Sync each prompt/skill
      for (const promptDef of manifest.prompts) {
        // Handle skills differently - they are directories
        if (promptDef.type === 'skill') {
          await this.syncSkillFromBundle(bundleId, bundlePath, promptDef);
          continue;
        }

        const sourcePath = path.join(bundlePath, promptDef.file);

        if (!fs.existsSync(sourcePath)) {
          this.logger.warn(`Prompt file not found: ${sourcePath}`);
          continue;
        }

        // Detect file type and create appropriate filename
        const copilotFile = this.determineCopilotFileType(promptDef, sourcePath, bundleId);

        // Create symlink or copy
        await this.createCopilotFile(copilotFile);
      }
    } catch (error) {
      this.logger.error(`Failed to sync bundle ${bundleId}`, error as Error);
    }
  }

  /**
   * Remove synced files for a bundle
   * Implements IScopeService.unsyncBundle
   * Since we use a flat structure, we need to read the bundle's manifest to know which files to remove
   * @param bundleId
   */
  public async unsyncBundle(bundleId: string): Promise<void> {
    try {
      this.logger.debug(`Removing Copilot files for bundle: ${bundleId}`);

      const promptsDir = this.getCopilotPromptsDirectory();
      if (!fs.existsSync(promptsDir)) {
        return;
      }

      // Read the bundle's manifest to find which files were synced
      const bundlePath = path.join(this.context.globalStorageUri.fsPath, 'bundles', bundleId);
      const manifestPath = path.join(bundlePath, 'deployment-manifest.yml');

      if (!fs.existsSync(manifestPath)) {
        this.logger.warn(`No manifest found for bundle: ${bundleId}, cannot determine files to remove`);
        return;
      }

      const manifestContent = await readFile(manifestPath, 'utf8');
      const manifest = yaml.load(manifestContent) as any;

      if (!manifest.prompts || manifest.prompts.length === 0) {
        this.logger.debug(`Bundle ${bundleId} has no prompts to unsync`);
        return;
      }

      // Remove each synced file/skill
      let removedCount = 0;
      for (const promptDef of manifest.prompts) {
        // Handle skills differently - they are directories
        if (promptDef.type === 'skill') {
          const skillMatch = promptDef.file.match(/skills\/([^/]+)\/SKILL\.md/);
          if (skillMatch) {
            const skillName = skillMatch[1];
            await this.unsyncSkill(skillName, 'user');
            removedCount++;
          }
          continue;
        }

        const sourcePath = path.join(bundlePath, promptDef.file);
        const copilotFile = this.determineCopilotFileType(promptDef, sourcePath, bundleId);

        // Use checkPathExists to detect broken symlinks (fs.existsSync returns false for broken symlinks)
        const existingEntry = await checkPathExists(copilotFile.targetPath);

        if (existingEntry.exists) {
          // Only remove if it's a symlink (to avoid deleting user's custom files)
          if (existingEntry.isSymbolicLink) {
            await unlink(copilotFile.targetPath);
            if (existingEntry.isBroken) {
              this.logger.debug(`Removed broken symlink: ${path.basename(copilotFile.targetPath)}`);
            } else {
              this.logger.debug(`Removed: ${path.basename(copilotFile.targetPath)}`);
            }
            removedCount++;
          } else {
            // In some environments (like WSL -> Windows), symlinks might fail and fall back to copy
            // Check if file content matches source before deleting
            try {
              if (fs.existsSync(copilotFile.sourcePath)) {
                this.logger.debug(`Target is a regular file, checking content before removal: ${path.basename(copilotFile.targetPath)}`);
                const targetContent = await readFile(copilotFile.targetPath, 'utf8');
                const sourceContent = await readFile(copilotFile.sourcePath, 'utf8');

                // Normalize line endings (CRLF -> LF) for comparison
                const normalizedTarget = targetContent.replace(/\r\n/g, '\n');
                const normalizedSource = sourceContent.replace(/\r\n/g, '\n');

                if (normalizedTarget === normalizedSource) {
                  await unlink(copilotFile.targetPath);
                  this.logger.debug(`Removed copied file: ${path.basename(copilotFile.targetPath)}`);
                  removedCount++;
                } else {
                  this.logger.warn(`Skipping modified file: ${path.basename(copilotFile.targetPath)}`);
                }
              } else {
                this.logger.warn(`Skipping non-symlink file (source not found): ${path.basename(copilotFile.targetPath)}`);
              }
            } catch (err) {
              this.logger.warn(`Failed to compare/remove file ${path.basename(copilotFile.targetPath)}: ${err}`);
            }
          }
        }
      }

      this.logger.info(`✅ Removed ${removedCount} Copilot file(s) for bundle: ${bundleId}`);
    } catch (error) {
      this.logger.error(`Failed to unsync bundle ${bundleId}`, error as Error);
    }
  }

  /**
   * Get the Copilot skills directory
   * Skills are stored in ~/.copilot/skills (user-level) following the Agent Skills specification
   * https://code.visualstudio.com/docs/copilot/customization/agent-skills
   * @param scope - Installation scope ('user' or 'workspace')
   * @returns Path to the skills directory
   */
  public getCopilotSkillsDirectory(scope: 'user' | 'workspace' = 'user'): string {
    if (scope === 'workspace') {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error('No workspace folder open. Skills require an open workspace for workspace scope.');
      }
      return path.join(workspaceFolders[0].uri.fsPath, '.copilot', 'skills');
    }

    // User-level skills go to ~/.copilot/skills
    return path.join(os.homedir(), '.copilot', 'skills');
  }

  /**
   * Get the Claude skills directory (alternative location)
   * Some users may prefer ~/.claude/skills
   * @param scope - Installation scope ('user' or 'workspace')
   * @returns Path to the Claude skills directory
   */
  public getClaudeSkillsDirectory(scope: 'user' | 'workspace' = 'user'): string {
    if (scope === 'workspace') {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error('No workspace folder open. Skills require an open workspace for workspace scope.');
      }
      return path.join(workspaceFolders[0].uri.fsPath, '.claude', 'skills');
    }

    // User-level skills go to ~/.claude/skills
    return path.join(os.homedir(), '.claude', 'skills');
  }

  /**
   * Sync a skill directory to the Copilot skills location
   * Skills are directories containing SKILL.md and optional scripts/, references/, assets/ subdirectories
   * @param skillName - Name of the skill (directory name)
   * @param sourceDir - Source directory containing the skill files
   * @param scope - Installation scope ('user' or 'workspace')
   * @param syncToClaude - Also sync to ~/.claude/skills
   */
  public async syncSkill(skillName: string, sourceDir: string, scope: 'user' | 'workspace' = 'user', syncToClaude = false): Promise<void> {
    try {
      this.logger.info(`Syncing skill: ${skillName} (scope: ${scope})`);

      // Get target skills directory
      const skillsDir = this.getCopilotSkillsDirectory(scope);
      await this.ensureDirectory(skillsDir);

      const targetDir = path.join(skillsDir, skillName);

      // Remove existing skill if present
      if (fs.existsSync(targetDir)) {
        await this.removeSkillDirectory(targetDir);
      }

      // Copy skill directory recursively
      await this.copySkillDirectory(sourceDir, targetDir);

      this.logger.info(`✅ Synced skill to: ${targetDir}`);

      // Optionally sync to Claude location too
      if (syncToClaude) {
        const claudeSkillsDir = this.getClaudeSkillsDirectory(scope);
        await this.ensureDirectory(claudeSkillsDir);
        const claudeTargetDir = path.join(claudeSkillsDir, skillName);

        if (fs.existsSync(claudeTargetDir)) {
          await this.removeSkillDirectory(claudeTargetDir);
        }

        await this.copySkillDirectory(sourceDir, claudeTargetDir);
        this.logger.info(`✅ Also synced skill to Claude: ${claudeTargetDir}`);
      }
    } catch (error) {
      this.logger.error(`Failed to sync skill ${skillName}`, error as Error);
      throw error;
    }
  }

  /**
   * Remove a synced skill
   * @param skillName - Name of the skill to remove
   * @param scope - Installation scope
   * @param removeFromClaude - Also remove from ~/.claude/skills
   */
  public async unsyncSkill(skillName: string, scope: 'user' | 'workspace' = 'user', removeFromClaude = false): Promise<void> {
    try {
      this.logger.info(`Removing skill: ${skillName}`);

      const skillsDir = this.getCopilotSkillsDirectory(scope);
      const targetDir = path.join(skillsDir, skillName);

      if (fs.existsSync(targetDir)) {
        await this.removeSkillDirectory(targetDir);
        this.logger.info(`✅ Removed skill from: ${targetDir}`);
      }

      if (removeFromClaude) {
        const claudeSkillsDir = this.getClaudeSkillsDirectory(scope);
        const claudeTargetDir = path.join(claudeSkillsDir, skillName);

        if (fs.existsSync(claudeTargetDir)) {
          await this.removeSkillDirectory(claudeTargetDir);
          this.logger.info(`✅ Also removed skill from Claude: ${claudeTargetDir}`);
        }
      }
    } catch (error) {
      this.logger.error(`Failed to remove skill ${skillName}`, error as Error);
    }
  }
}

// Re-export CopilotFileType for convenience
export { CopilotFileType } from '../utils/copilot-file-type-utils';
