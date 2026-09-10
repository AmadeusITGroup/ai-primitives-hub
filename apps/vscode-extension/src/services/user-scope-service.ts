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
import {
  randomUUID,
} from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  promisify,
} from 'node:util';
import {
  createTargetWritePlan,
  expandPath,
  resolveLayout,
  TransformerRegistry,
} from '@ai-primitives-hub/app';
import {
  createBundleInstallPlan,
  installedChecksum,
  normalizePromptId,
  prunableSkillDirectories,
  validateManifest,
} from '@ai-primitives-hub/core';
import type {
  CopilotFileType,
  InstalledFileRecord,
  PrimitiveKind,
  Target,
  TargetType,
  TargetWriteOperation,
  TargetWritePlan,
  TargetWriteResult,
} from '@ai-primitives-hub/core';
import * as yaml from 'js-yaml';
import * as vscode from 'vscode';
import {
  detectHostApp,
} from '../utils/host-app';
import {
  Logger,
} from '../utils/logger';
import {
  checkPathExists,
} from '../utils/symlink-utils';
import {
  IScopeService,
  SyncBundleOptions,
  UnsyncBundleOptions,
  UnsyncBundleResult,
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
  transformedContent?: string;
}

/**
 * Service to sync bundle prompts to GitHub Copilot's native directories at user level.
 * Implements IScopeService for consistent scope handling.
 */
export class UserScopeService implements IScopeService {
  private readonly logger: Logger;
  private readonly homeDir: string;
  private readonly targetType: TargetType;
  private readonly transformerRegistry = TransformerRegistry.withBuiltIns();
  private windowsHomeInWSL: string | undefined;
  private warnedWslFallback = false;
  private cachedPromptsDir: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext, homeDir = os.homedir(), targetType?: TargetType) {
    this.logger = Logger.getInstance();
    this.homeDir = homeDir;
    this.targetType = targetType ?? this.detectTargetType();
  }

  private detectTargetType(): TargetType {
    // Delegate to the single shared host-app detector (utils/host-app.ts) so
    // the user-scope and repository-scope install paths resolve the host app
    // identically. It reads both vscode.env.appName and vscode.env.uriScheme.
    const target = detectHostApp();
    this.logger.debug(`[UserScopeService] detectTargetType: appName=${vscode.env.appName}, uriScheme=${vscode.env.uriScheme} -> ${target}`);
    return target;
  }

  private getTarget(): Target {
    return {
      name: this.targetType,
      type: this.targetType,
      scope: 'user'
    };
  }

  private getTargetBaseDirectory(): string {
    const env = { HOME: this.resolveWslUserDir() ?? this.homeDir };
    return expandPath(resolveLayout(this.getTarget()).baseDir, env);
  }

  private getTargetPrimitiveDirectory(type: CopilotFileType): string {
    const kind = type === 'instructions'
      ? 'instruction'
      : (type === 'chatmode' ? 'chat-mode' : type);
    const route = resolveLayout(this.getTarget()).routes[kind];
    if (route === undefined) {
      throw new Error(`No ${type} route defined for target ${this.targetType}`);
    }
    return path.join(this.getTargetBaseDirectory(), route);
  }

  private transformContent(filePath: string, content: string): string {
    return this.transformerRegistry.getTransformer(this.targetType).transform({
      target: this.getTarget(),
      filePath,
      content
    }).content;
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
   * Get the Windows home directory when running in WSL.
   * Generic Copilot primitives are stored under the user's home, independently
   * of whether the connected editor is VS Code stable or Insiders.
   * @returns The Windows home directory path in WSL, or undefined if detection fails.
   */
  private getWindowsWslUserDir(): string | undefined {
    if (!this.isRunningInWSL()) {
      return undefined;
    }
    return this.getWindowsHomeDirectoryInWSL();
  }

  /**
   * Resolve the user-scope home directory, redirecting to the Windows home when
   * running in a WSL remote.
   *
   * This is the single entry point every consumer must use: it owns the
   * one-shot "unable to resolve Windows path from WSL" diagnostic, so the
   * warning is emitted no matter which code path resolves the directory
   * (`resolveTarget`, `getTargetBaseDirectory`, or a historical-uninstall plan).
   * @returns The Windows home directory in WSL, or `undefined` outside WSL and
   *   when the Windows home cannot be resolved.
   */
  private resolveWslUserDir(): string | undefined {
    const wslUserDir = this.getWindowsWslUserDir();
    if (this.isRunningInWSL() && wslUserDir === undefined && !this.warnedWslFallback) {
      this.warnedWslFallback = true;
      this.logger.warn('[UserScopeService] Unable to resolve Windows path from WSL. Generic Copilot primitives may not be visible.');
      void vscode.window.showWarningMessage('AI Primitives Hub: Unable to resolve Windows path from WSL. Generic Copilot primitives may not be visible.');
    }
    return wslUserDir;
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

    const resolved = this.getTargetPrimitiveDirectory('prompt');
    this.logger.debug(`[UserScopeService] Resolved ${this.targetType} user primitive directory: ${resolved}`);
    this.cachedPromptsDir = resolved;
    return resolved;
  }

  /**
   * Create symlink (or copy if symlink fails) to Copilot directory
   *
   * Always removes and recreates symlinks to ensure they point to the correct target.
   * Uses lstat() to detect symlinks (including broken ones) since fs.existsSync()
   * returns false for broken symlinks.
   * @param file
   */
  private async createCopilotFile(file: CopilotFile): Promise<Uint8Array | undefined> {
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
          return undefined;
        }
      }

      // Ensure parent directory exists before creating symlink/file
      const targetDir = path.dirname(file.targetPath);
      await this.ensureDirectory(targetDir);

      // WSL: symlinks from Windows → WSL paths are broken from Windows' perspective,
      // so always copy when running in WSL. On non-WSL, prefer symlinks.
      if (file.transformedContent !== undefined) {
        const installedBytes = new TextEncoder().encode(file.transformedContent);
        await writeFile(file.targetPath, file.transformedContent, 'utf8');
        this.logger.debug(`Copied file (transformed): ${path.basename(file.targetPath)}`);
        this.logger.info(`✅ Synced ${file.type}: ${file.name} → ${path.basename(file.targetPath)}`);
        return installedBytes;
      } else if (this.isRunningInWSL()) {
        // Binary-safe copy (issue #357): a utf8 string round-trip corrupts
        // any non-UTF-8 payload (e.g. PPTX/zip assets), so copy raw bytes.
        const installedBytes = await readFile(file.sourcePath);
        await writeFile(file.targetPath, installedBytes);
        this.logger.debug(`Copied file (WSL): ${path.basename(file.targetPath)}`);
        this.logger.info(`✅ Synced ${file.type}: ${file.name} → ${path.basename(file.targetPath)}`);
        return new Uint8Array(installedBytes);
      } else {
        try {
          await symlink(file.sourcePath, file.targetPath, 'file');
          this.logger.debug(`Created symlink: ${path.basename(file.targetPath)}`);
          const installedBytes = await readFile(file.sourcePath);
          this.logger.info(`✅ Synced ${file.type}: ${file.name} → ${path.basename(file.targetPath)}`);
          return new Uint8Array(installedBytes);
        } catch {
          // Symlink failed (maybe Windows or permissions), fall back to a
          // byte-for-byte copy (issue #357: no lossy utf8 round-trip).
          this.logger.debug('Symlink failed, copying file instead');
          const installedBytes = await readFile(file.sourcePath);
          await writeFile(file.targetPath, installedBytes);
          this.logger.debug(`Copied file: ${path.basename(file.targetPath)}`);
          this.logger.info(`✅ Synced ${file.type}: ${file.name} → ${path.basename(file.targetPath)}`);
          return new Uint8Array(installedBytes);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Failed to create Copilot file: ${file.targetPath}`, {
        message: errorMessage,
        stack: errorStack,
        bundleId: file.bundleId,
        fileType: file.type
      } as any);
      throw error;
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

  private getCopilotFileTypeForKind(kind: PrimitiveKind): CopilotFileType {
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
        throw new Error(`Unsupported target write kind for user scope: ${kind}`);
      }
    }
  }

  private async stageExistingPath(targetPath: string): Promise<{ targetPath: string; backupPath: string }> {
    const backupPath = `${targetPath}.ai-primitives-hub-backup-${randomUUID()}`;
    await fs.promises.rename(targetPath, backupPath);
    return { targetPath, backupPath };
  }

  private async rollbackTargetPaths(
    mutablePaths: readonly string[],
    backups: readonly { targetPath: string; backupPath: string }[]
  ): Promise<void> {
    for (const targetPath of mutablePaths.toReversed()) {
      try {
        await fs.promises.rm(targetPath, { recursive: true, force: true });
      } catch {
        // Preserve the original installation error.
      }
    }
    for (const backup of backups.toReversed()) {
      try {
        await fs.promises.rename(backup.backupPath, backup.targetPath);
      } catch {
        // Preserve the original installation error.
      }
    }
  }

  private async removeBackups(backups: readonly { backupPath: string }[]): Promise<void> {
    for (const backup of backups) {
      try {
        await fs.promises.rm(backup.backupPath, { recursive: true, force: true });
      } catch (error) {
        this.logger.warn(`Failed to remove installation backup ${backup.backupPath}: ${String(error)}`);
      }
    }
  }

  private async isModifiedInstalledRecord(file: InstalledFileRecord): Promise<boolean> {
    try {
      const bytes = await fs.promises.readFile(file.destinationPath);
      const expected = file.installedChecksum.startsWith('sha256:')
        ? file.installedChecksum
        : `sha256:${file.installedChecksum}`;
      return installedChecksum(bytes) !== expected;
    } catch {
      return false;
    }
  }

  /**
   * Execute a shared `TargetWritePlan` at user scope.
   *
   * User scope deliberately does **not** reuse `FileTreeTargetWriter` (which the
   * CLI and repository scope share), because four of its behaviours are
   * user-scope policy that the shared writer does not model:
   *
   *  1. Symlinks are preferred over copies, so an updated bundle in the cache is
   *     picked up without a reinstall; the shared writer always copies bytes.
   *  2. Under WSL it copies instead (a WSL-target symlink is broken from
   *     Windows), and it stages/restores the **filesystem entry** rather than
   *     bytes — the shared writer's rollback snapshots bytes, which cannot
   *     recreate a symlink.
   *  3. An existing unmanaged file is skipped with a warning; the shared writer
   *     fails the whole install. A user's own `~/.copilot/prompts/x.md` must not
   *     make an unrelated install fail.
   *  4. A user-modified managed file is preserved and its previous record
   *     re-emitted; the shared writer fails.
   *
   * Everything observable is nevertheless required to match the shared writer —
   * destinations, item ids, kinds, installed checksums, which files land on
   * disk, and which skill directories a removal reclaims. That contract is
   * pinned by `test/services/target-write-executor-parity.test.ts`, and the two
   * rules most likely to drift (`installedChecksum` and
   * `prunableSkillDirectories`) are imported from `core` rather than
   * reimplemented here.
   * @param bundleId - Bundle being installed.
   * @param bundlePath - Extracted bundle directory, used as the symlink source.
   * @param targetPlan - Shared plan from the install pipeline.
   * @param previousFiles - Records of the installation being replaced, if any.
   * @returns The records actually installed (or preserved) at user scope.
   */
  private async executeTargetPlan(
    bundleId: string,
    bundlePath: string,
    targetPlan: TargetWritePlan,
    previousFiles: readonly InstalledFileRecord[] = []
  ): Promise<TargetWriteResult> {
    const installed = [] as { itemId: string; kind: PrimitiveKind; sourcePath: string; destinationPath: string; destinationRelativePath: string; installedChecksum: string }[];
    const skillOperations = new Map<string, TargetWriteOperation[]>();
    const previousByDestination = new Map(previousFiles.map((file) => [file.destinationPath, file]));

    for (const operation of targetPlan.operations) {
      if (operation.kind === 'skill') {
        const existing = skillOperations.get(operation.itemId) ?? [];
        existing.push(operation);
        skillOperations.set(operation.itemId, existing);
      }
    }

    const skillInstalls = [] as {
      skillName: string;
      targetDir: string;
      existingEntry: Awaited<ReturnType<typeof checkPathExists>>;
      operations: TargetWriteOperation[];
    }[];
    for (const [skillName, operations] of skillOperations) {
      const previousSkillFiles = operations
        .map((operation) => previousByDestination.get(operation.destinationPath))
        .filter((file): file is InstalledFileRecord => file !== undefined);
      const modified = await Promise.all(previousSkillFiles.map(async (file) => this.isModifiedInstalledRecord(file)));
      if (modified.some(Boolean)) {
        installed.push(...previousSkillFiles);
        continue;
      }
      const targetDir = path.join(this.getCopilotSkillsDirectory('user'), normalizePromptId(skillName));
      const existingEntry = await checkPathExists(targetDir);
      if (previousSkillFiles.length === 0 && existingEntry.exists && !existingEntry.isBroken) {
        const shouldOverwrite = await this.promptOverwriteSkill(skillName, targetDir, existingEntry.isSymbolicLink);
        if (!shouldOverwrite) {
          throw new Error(`Installation cancelled: skill '${skillName}' already exists`);
        }
      }
      skillInstalls.push({ skillName, targetDir, existingEntry, operations });
    }

    const mutablePaths: string[] = [];
    const backups: { targetPath: string; backupPath: string }[] = [];
    try {
      for (const operation of targetPlan.operations) {
        if (operation.kind === 'skill') {
          continue;
        }
        const sourcePath = path.join(bundlePath, operation.sourcePath);
        const type = this.getCopilotFileTypeForKind(operation.kind);
        const targetPath = operation.destinationPath;
        const existingEntry = await checkPathExists(targetPath);
        const previousFile = previousByDestination.get(targetPath);
        if (previousFile !== undefined && await this.isModifiedInstalledRecord(previousFile)) {
          installed.push(previousFile);
          continue;
        }
        if (!existingEntry.exists) {
          mutablePaths.push(targetPath);
        } else if (previousFile !== undefined || existingEntry.isSymbolicLink || this.isRunningInWSL()) {
          backups.push(await this.stageExistingPath(targetPath));
          mutablePaths.push(targetPath);
        }
        const sourceContent = Buffer.from(operation.bytes).toString('utf8');
        const transformedContent = this.transformContent(operation.sourcePath, sourceContent);
        const writtenBytes = await this.createCopilotFile({
          bundleId,
          type,
          name: operation.itemId,
          sourcePath,
          targetPath,
          transformedContent: transformedContent === sourceContent ? undefined : transformedContent
        });

        if (writtenBytes === undefined) {
          continue;
        }

        installed.push({
          itemId: operation.itemId,
          kind: operation.kind,
          sourcePath: operation.sourcePath,
          destinationPath: targetPath,
          destinationRelativePath: operation.destinationRelativePath,
          installedChecksum: installedChecksum(writtenBytes)
        });
      }

      for (const { targetDir, existingEntry, operations } of skillInstalls) {
        if (existingEntry.exists) {
          const backup = await this.stageExistingPath(targetDir);
          backups.push(backup);
          if (!existingEntry.isSymbolicLink) {
            await fs.promises.cp(backup.backupPath, targetDir, { recursive: true });
          }
        }
        mutablePaths.push(targetDir);

        for (const operation of operations) {
          const targetPath = operation.destinationPath;
          await this.ensureDirectory(path.dirname(targetPath));
          await writeFile(targetPath, Buffer.from(operation.bytes));
          installed.push({
            itemId: operation.itemId,
            kind: operation.kind,
            sourcePath: operation.sourcePath,
            destinationPath: targetPath,
            destinationRelativePath: operation.destinationRelativePath,
            installedChecksum: installedChecksum(operation.bytes)
          });
        }
        this.logger.info(`✅ Synced skill to: ${targetDir}`);
      }
      await this.removeBackups(backups);
    } catch (error) {
      await this.rollbackTargetPaths(mutablePaths, backups);
      throw error;
    }

    return { installed };
  }

  private async readDirectoryIntoMap(sourceDir: string, relativePrefix: string): Promise<Map<string, Uint8Array>> {
    const files = new Map<string, Uint8Array>();
    const entries = await readdir(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(sourceDir, entry.name);
      const entryPrefix = relativePrefix.length === 0 ? entry.name : `${relativePrefix}/${entry.name}`;

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

  private async promptOverwriteSkill(skillName: string, existingPath: string, existingIsSymlink: boolean): Promise<boolean> {
    const symlinkInfo = existingIsSymlink ? ' (symlink)' : '';
    const message = `A skill named '${skillName}' already exists${symlinkInfo}. Do you want to overwrite it?`;

    const result = await vscode.window.showWarningMessage(
      message,
      { modal: true },
      'Overwrite',
      'Cancel'
    );

    return result === 'Overwrite';
  }

  private async removeInstalledFiles(
    bundleId: string,
    installedFiles: readonly InstalledFileRecord[]
  ): Promise<UnsyncBundleResult> {
    let removedCount = 0;
    const retained: InstalledFileRecord[] = [];
    const removed: InstalledFileRecord[] = [];

    for (const installedFile of installedFiles) {
      const existingEntry = await checkPathExists(installedFile.destinationPath);
      if (!existingEntry.exists) {
        continue;
      }

      if (existingEntry.isSymbolicLink) {
        await unlink(installedFile.destinationPath);
        removedCount++;
        removed.push(installedFile);
        continue;
      }

      try {
        const currentBytes = await readFile(installedFile.destinationPath);
        if (installedChecksum(currentBytes) === installedFile.installedChecksum) {
          await unlink(installedFile.destinationPath);
          removedCount++;
          removed.push(installedFile);
        } else {
          this.logger.warn(`Skipping modified file: ${path.basename(installedFile.destinationPath)}`);
          retained.push(installedFile);
        }
      } catch (error) {
        this.logger.warn(`Failed to compare/remove file ${path.basename(installedFile.destinationPath)}: ${error}`);
        retained.push(installedFile);
      }
    }
    await this.pruneRemovedSkillDirectories(removed);

    this.logger.info(`✅ Removed ${removedCount} Copilot file(s) for bundle: ${bundleId}`);
    return { retained };
  }

  /**
   * Remove the skill directories left empty by the given removals.
   *
   * Candidate directories come from `prunableSkillDirectories` in `core`, the
   * same helper `FileTreeTargetWriter` uses, so both executors of a
   * `TargetWritePlan` agree on which directories a removal can reclaim.
   * @param files - Installed records that were just removed.
   */
  private async pruneRemovedSkillDirectories(files: readonly InstalledFileRecord[]): Promise<void> {
    for (const directory of prunableSkillDirectories(files)) {
      try {
        await fs.promises.rmdir(directory);
      } catch {
        // Missing or non-empty directories must be preserved.
      }
    }
  }

  private async removeHistoricalFile(operation: TargetWriteOperation, bundlePath: string): Promise<boolean> {
    const existingEntry = await checkPathExists(operation.destinationPath);
    if (!existingEntry.exists) {
      return false;
    }
    if (existingEntry.isSymbolicLink) {
      await unlink(operation.destinationPath);
      return true;
    }

    const sourcePath = path.join(bundlePath, operation.sourcePath);
    try {
      if (!fs.existsSync(sourcePath)) {
        this.logger.warn(`Skipping non-symlink file (source not found): ${path.basename(operation.destinationPath)}`);
        return false;
      }
      const targetContent = await readFile(operation.destinationPath, 'utf8');
      const sourceContent = await readFile(sourcePath, 'utf8');
      const transformedContent = this.transformContent(operation.sourcePath, sourceContent);
      if (targetContent.replaceAll('\r\n', '\n') !== transformedContent.replaceAll('\r\n', '\n')) {
        this.logger.warn(`Skipping modified file: ${path.basename(operation.destinationPath)}`);
        return false;
      }
      await unlink(operation.destinationPath);
      return true;
    } catch (error) {
      this.logger.warn(`Failed to compare/remove file ${path.basename(operation.destinationPath)}: ${error}`);
      return false;
    }
  }

  private async removeHistoricalInstallation(bundleId: string, bundlePath: string): Promise<void> {
    const files = await this.readDirectoryIntoMap(bundlePath, '');
    const parsedManifest = yaml.load(new TextDecoder().decode(files.get('deployment-manifest.yml'))) as Record<string, unknown>;
    if (typeof parsedManifest.name !== 'string' || parsedManifest.name.length === 0) {
      parsedManifest.name = bundleId;
      files.set('deployment-manifest.yml', new TextEncoder().encode(yaml.dump(parsedManifest)));
    }
    const target = this.getTarget();
    const targetPlan = createTargetWritePlan(
      createBundleInstallPlan(files, validateManifest(files, {})),
      target,
      resolveLayout(target),
      { ...process.env, HOME: this.resolveWslUserDir() ?? this.homeDir }
    );
    const skillIds = new Set(targetPlan.operations
      .filter((operation) => operation.kind === 'skill')
      .map((operation) => normalizePromptId(operation.itemId)));
    for (const skillId of skillIds) {
      await this.unsyncSkill(skillId, 'user');
    }
    let removedCount = skillIds.size;
    for (const operation of targetPlan.operations) {
      if (operation.kind !== 'skill' && await this.removeHistoricalFile(operation, bundlePath)) {
        removedCount++;
      }
    }
    this.logger.info(`✅ Removed ${removedCount} Copilot file(s) for bundle: ${bundleId}`);
  }

  /**
   * Remove a skill directory installed by a historical (pre-`installedFiles`)
   * installation.
   * @param skillName - Name of the skill to remove
   * @param scope - Installation scope
   */
  private async unsyncSkill(skillName: string, scope: 'user' | 'workspace' = 'user'): Promise<void> {
    try {
      this.logger.info(`Removing skill: ${skillName}`);

      const skillsDir = this.getCopilotSkillsDirectory(scope);
      const targetDir = path.join(skillsDir, skillName);

      if (fs.existsSync(targetDir)) {
        await this.removeSkillDirectory(targetDir);
        this.logger.info(`✅ Removed skill from: ${targetDir}`);
      }
    } catch (error) {
      this.logger.error(`Failed to remove skill ${skillName}`, error as Error);
    }
  }

  public resolveTarget(target: Target): Target {
    return { ...target, path: this.getTargetBaseDirectory() };
  }

  /**
   * Sync a single bundle to the host's user-scope directories.
   * Implements IScopeService.syncBundle
   * @param bundleId - The unique identifier of the bundle
   * @param bundlePath - The path to the installed bundle directory
   * @param options - Sync options. `targetPlan` is required: destinations are
   *   planned by the shared install pipeline, and this service never parses a
   *   manifest or infers a destination itself.
   */
  public async syncBundle(bundleId: string, bundlePath: string, options?: SyncBundleOptions): Promise<TargetWriteResult> {
    try {
      this.logger.debug(`Syncing bundle: ${bundleId}`);

      if (options?.targetPlan === undefined) {
        throw new Error(
          `syncBundle requires SyncBundleOptions.targetPlan for bundle "${bundleId}": `
          + 'destinations are planned by the shared install pipeline, and this service never parses a manifest.'
        );
      }

      return await this.executeTargetPlan(bundleId, bundlePath, options.targetPlan, options.installedFiles);
    } catch (error) {
      this.logger.error(`Failed to sync bundle ${bundleId}`, error as Error);
      throw error;
    }
  }

  /**
   * Remove synced files for a bundle
   * Implements IScopeService.unsyncBundle
   * Since we use a flat structure, we need to read the bundle's manifest to know which files to remove
   * @param bundleId
   * @param options
   */
  public async unsyncBundle(bundleId: string, options?: UnsyncBundleOptions): Promise<UnsyncBundleResult> {
    try {
      this.logger.debug(`Removing Copilot files for bundle: ${bundleId}`);

      if (options?.installedFiles) {
        return this.removeInstalledFiles(bundleId, options.installedFiles);
      }

      const promptsDir = this.getCopilotPromptsDirectory();
      if (!fs.existsSync(promptsDir)) {
        return { retained: [] };
      }

      // @migration-cleanup(manifest-driven-install): historical records do not have installedFiles.
      // Read the bundle's manifest to find which files were synced.
      const bundlePath = path.join(this.context.globalStorageUri.fsPath, 'bundles', bundleId);
      const manifestPath = path.join(bundlePath, 'deployment-manifest.yml');

      if (!fs.existsSync(manifestPath)) {
        this.logger.warn(`No manifest found for bundle: ${bundleId}, cannot determine files to remove`);
        return { retained: [] };
      }

      await this.removeHistoricalInstallation(bundleId, bundlePath);
      return { retained: [] };
    } catch (error) {
      this.logger.error(`Failed to unsync bundle ${bundleId}`, error as Error);
      return { retained: options?.installedFiles ?? [] };
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

    return this.getTargetPrimitiveDirectory('skill');
  }
}

// Re-export CopilotFileType for convenience
export type { CopilotFileType } from '@ai-primitives-hub/core';
