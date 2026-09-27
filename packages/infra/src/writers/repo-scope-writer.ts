/**
 * RepositoryScopeWriter.
 *
 * Writer for repository-scoped installations. Places bundle files into
 * .github/ directories (prompts, agents, instructions, skills) under the
 * workspace root. Supports commit mode (tracked by Git) and local-only
 * mode (excluded via .git/info/exclude).
 *
 * Mirrors the extension's RepositoryScopeService functionality but uses
 * the library's FileSystem port and ExtractedFiles types for testability.
 *
 * Includes RepositoryScopeWriterAdapter to bridge the TargetWriter
 * interface with RepositoryScopeWriter.
 * @module writers/repo-scope-writer
 */
import * as path from 'node:path';
import type {
  ExtractedFiles,
  FileSystem,
  PrimitiveKind,
  Target,
  TargetWritePlan,
  TargetWriter,
  TargetWriteResult,
} from '@ai-primitives-hub/core';
import {
  assertSafeRepositoryDirectoryPath,
  assertSafeRepositoryInstallPath,
  assertSafeRepositoryRemovalPath,
  FileWriteJournal,
  getKnowledgeRelativePath,
  getSelectedManifestPlacementItems,
  normalizePrimitiveKind,
  UnsafeRepositoryPathError,
  verifyWrittenBytes,
} from '@ai-primitives-hub/core';
import {
  load as parseYaml,
} from 'js-yaml';

/**
 * Section header for AI Primitives Hub entries in .git/info/exclude
 */
const GIT_EXCLUDE_SECTION_HEADER = '# Prompt Registry (local)';

const toGitIgnorePath = (workspaceRoot: string, filePath: string): string =>
  path.relative(workspaceRoot, filePath).replaceAll('\\', '/');

/**
 * Commit mode for repository-scoped installations.
 */
export type RepositoryCommitMode = 'commit' | 'local-only';

/**
 * Options for RepositoryScopeWriter.
 */
export interface RepositoryScopeWriterOptions {
  /** Filesystem abstraction. */
  fs: FileSystem;
  /** Workspace root (repository root). */
  workspaceRoot: string;
  /** Commit mode for this installation. */
  commitMode: RepositoryCommitMode;
}

/**
 * Deployment manifest structure (matches test format).
 */
interface DeploymentManifest {
  formatVersion?: number;
  id?: string;
  version?: string;
  name?: string;
  description?: string;
  items?: { path: string; kind: string; id?: string }[];
  prompts?: { id: string; file: string; type: string }[];
  agents?: { id: string; file: string; type: string }[];
  instructions?: { id: string; file: string; type: string }[];
  skills?: { id: string; file: string; type: string }[];
  hooks?: { id: string; file: string; type: string }[];
  plugins?: { id: string; file: string; type: string }[];
}

/**
 * Result of a write operation.
 */
interface WriteResult {
  written: string[];
  skipped: string[];
  skillDirs: string[];
  writtenBundlePaths: string[];
}

/**
 * Repository-scope writer for bundle installations.
 *
 * Places files in .github/ subdirectories based on type:
 * - prompts → .github/copilot/prompts/
 * - instructions → .github/copilot/instructions/
 * - agents → .github/copilot/agents/
 * - skills → .github/skills/<skill-name>/
 */
export class RepositoryScopeWriter {
  private readonly fs: FileSystem;
  private readonly workspaceRoot: string;
  private readonly commitMode: RepositoryCommitMode;
  private writeJournal: FileWriteJournal | null = null;

  /**
   * Construct a RepositoryScopeWriter.
   * @param opts Writer options including filesystem, workspace root, and commit mode.
   */
  public constructor(opts: RepositoryScopeWriterOptions) {
    this.fs = opts.fs;
    this.workspaceRoot = opts.workspaceRoot;
    this.commitMode = opts.commitMode;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- Intentionally async for interface compatibility
  private async parseManifest(manifestBytes: Uint8Array): Promise<DeploymentManifest> {
    const text = new TextDecoder().decode(manifestBytes);
    const manifest = parseYaml(text) as DeploymentManifest;
    return manifest;
  }

  /**
   * Write raw bundle bytes verbatim and verify the on-disk result.
   *
   * Binary-safe (issue #357): the previous string round-trip
   * (`TextDecoder` + `writeFile`) replaced invalid UTF-8 sequences with
   * U+FFFD and corrupted binary assets such as PPTX files. Writing
   * bytes and re-reading them turns any residual corruption into a
   * loud `FileIntegrityError` instead of a silent broken artifact.
   * @param targetPath Absolute destination path.
   * @param bytes Exact bytes to install.
   */
  private async writeBytesVerified(targetPath: string, bytes: Uint8Array): Promise<void> {
    await this.validateInstallPaths([targetPath]);
    const journal = this.writeJournal;
    if (journal === null) {
      throw new Error('repository write journal is not initialized');
    }
    await journal.write(targetPath, bytes, async () => {
      await this.fs.mkdir(path.dirname(targetPath), { recursive: true });
      await this.fs.writeFileBytes(targetPath, bytes);
      await verifyWrittenBytes(this.fs, targetPath, bytes);
    });
  }

  private getTargetPath(item: { type: string; file: string }): string | null {
    if (item.type.toLowerCase() === 'knowledge') {
      const relativePath = getKnowledgeRelativePath(item.file);
      return relativePath === null
        ? null
        : path.join(this.workspaceRoot, '.github', 'knowledge', relativePath);
    }
    const subdirectory = this.getSubdirectory(item.type);
    if (!subdirectory) {
      return null;
    }

    const fileName = this.getFileName(item.file);
    const targetPath = path.join(this.workspaceRoot, '.github', subdirectory, fileName);
    return targetPath;
  }

  private getKnowledgeBundlePath(filePath: string, files: ExtractedFiles): string {
    const relativePath = getKnowledgeRelativePath(filePath);
    if (relativePath === null) {
      throw new Error(`manifest declares an unsafe knowledge path: ${filePath}`);
    }
    const canonicalPath = `knowledge/${relativePath}`;
    const bundlePath = files.has(canonicalPath) ? canonicalPath : filePath;
    if (!files.has(bundlePath)) {
      throw new Error(`manifest declares a missing knowledge file: ${filePath}`);
    }
    return bundlePath;
  }

  private getSubdirectory(type: string): string | null {
    const typeLower = type.toLowerCase();
    if (typeLower === 'prompt') {
      return 'copilot/prompts';
    }
    if (typeLower === 'instruction' || typeLower === 'instructions') {
      return 'copilot/instructions';
    }
    if (typeLower === 'agent' || typeLower === 'chatmode' || typeLower === 'chat-mode') {
      return 'copilot/agents';
    }
    if (typeLower === 'skill') {
      return 'skills';
    }
    if (typeLower === 'hook') {
      return 'hooks';
    }
    if (typeLower === 'plugin') {
      return 'plugins';
    }
    return null;
  }

  private getFileName(filePath: string): string {
    const parts = filePath.split('/');
    return parts.at(-1) ?? '';
  }

  /**
   * Collect paths to remove for a list of manifest items.
   * Skill items add skill directories; regular items add file paths.
   * @param items Manifest items to collect paths for.
   * @param pathsToRemove Accumulates file paths to remove.
   * @param skillDirsToRemove Accumulates skill directory paths to remove.
   */
  private collectRemovePaths(
    items: { type: string; file: string; id?: string }[],
    pathsToRemove: string[],
    skillDirsToRemove: string[]
  ): void {
    for (const p of items) {
      if (p.type.toLowerCase() === 'skill') {
        const sourceSkillId = this.extractSkillId(p.file);
        const targetSkillId = p.id ?? sourceSkillId;
        const skillDir = path.join(this.workspaceRoot, '.github', `skills/${targetSkillId}`);
        skillDirsToRemove.push(skillDir);
      } else {
        if (p.type.toLowerCase() === 'knowledge' && getKnowledgeRelativePath(p.file) === null) {
          throw new Error(`manifest declares an unsafe knowledge path: ${p.file}`);
        }
        const targetPath = this.getTargetPath({ type: p.type, file: p.file });
        if (targetPath) {
          pathsToRemove.push(targetPath);
        }
      }
    }
  }

  /**
   * Install a single skill item by copying its entire directory from the bundle.
   * @param p Skill item with file and optional id.
   * @param p.file Skill manifest file path.
   * @param p.id Optional target skill ID override.
   * @param files Extracted bundle files.
   * @param written Accumulates written file paths.
   * @param skillDirs Accumulates skill directory paths.
   * @param writtenBundlePaths
   */
  private async installSkillItem(
    p: { file: string; id?: string },
    files: ExtractedFiles,
    written: string[],
    skillDirs: string[],
    writtenBundlePaths: string[]
  ): Promise<void> {
    const sourceSkillId = this.extractSkillId(p.file);
    const sourcePrefix = `skills/${sourceSkillId}`;
    const targetSkillId = p.id ?? sourceSkillId;
    const skillDir = path.join(this.workspaceRoot, '.github', `skills/${targetSkillId}`);
    for (const [bundlePath, bytes] of files) {
      if (bundlePath.startsWith(sourcePrefix)) {
        const relativePath = bundlePath.slice(sourcePrefix.length);
        const targetPath = path.join(skillDir, relativePath);
        await this.writeBytesVerified(targetPath, bytes);
        written.push(targetPath);
        writtenBundlePaths.push(bundlePath);
      }
    }
    skillDirs.push(skillDir);
  }

  /**
   * Install a single plugin item by copying its entire directory from the bundle.
   * @param p Plugin item with file and optional id.
   * @param p.file Plugin manifest file path.
   * @param p.id Optional target plugin ID override.
   * @param files Extracted bundle files.
   * @param written Accumulates written file paths.
   * @param skillDirs Accumulates plugin directory paths (reusing skillDirs for cleanup).
   * @param writtenBundlePaths
   */
  private async installPluginItem(
    p: { file: string; id?: string },
    files: ExtractedFiles,
    written: string[],
    skillDirs: string[],
    writtenBundlePaths: string[]
  ): Promise<void> {
    const sourcePluginId = this.extractPluginId(p.file);
    const sourcePrefix = `plugins/${sourcePluginId}`;
    const targetPluginId = p.id ?? sourcePluginId;
    const pluginDir = path.join(this.workspaceRoot, '.github', `plugins/${targetPluginId}`);
    for (const [bundlePath, bytes] of files) {
      if (bundlePath.startsWith(sourcePrefix)) {
        const relativePath = bundlePath.slice(sourcePrefix.length);
        const targetPath = path.join(pluginDir, relativePath);
        await this.writeBytesVerified(targetPath, bytes);
        written.push(targetPath);
        writtenBundlePaths.push(bundlePath);
      }
    }
    skillDirs.push(pluginDir);
  }

  private async processManifestItems(
    items: { type: string; file: string; id?: string }[],
    files: ExtractedFiles,
    written: string[],
    skipped: string[],
    skillDirs: string[],
    writtenBundlePaths: string[],
    allowedKinds: ReadonlySet<PrimitiveKind> | null
  ): Promise<void> {
    for (const p of items) {
      const kind = normalizePrimitiveKind(p.type);
      if (allowedKinds !== null && (kind === null || !allowedKinds.has(kind))) {
        skipped.push(p.file);
        continue;
      }
      if (p.type.toLowerCase() === 'skill') {
        await this.installSkillItem(p, files, written, skillDirs, writtenBundlePaths);
      } else if (p.type.toLowerCase() === 'plugin') {
        await this.installPluginItem(p, files, written, skillDirs, writtenBundlePaths);
      } else {
        const bundlePath = kind === 'knowledge' ? this.getKnowledgeBundlePath(p.file, files) : p.file;
        const bytes = files.get(bundlePath);
        if (bytes !== undefined) {
          const targetPath = this.getTargetPath({ type: p.type, file: p.file });
          if (targetPath) {
            await this.writeBytesVerified(targetPath, bytes);
            written.push(targetPath);
            writtenBundlePaths.push(bundlePath);
          } else {
            skipped.push(p.file);
          }
        }
      }
    }
  }

  private extractSkillId(filePath: string): string {
    const parts = filePath.split('/');
    const skillIndex = parts.indexOf('skills');
    if (skillIndex !== -1 && skillIndex + 1 < parts.length) {
      return this.sanitizeId(parts[skillIndex + 1]);
    }
    return 'unknown';
  }

  private extractPluginId(filePath: string): string {
    const parts = filePath.split('/');
    const pluginIndex = parts.indexOf('plugins');
    if (pluginIndex !== -1 && pluginIndex + 1 < parts.length) {
      return this.sanitizeId(parts[pluginIndex + 1]);
    }
    return 'unknown';
  }

  private sanitizeId(id: string): string {
    return id.toLowerCase().replaceAll(/[^a-z0-9-]/g, '-');
  }

  private async addToGitExclude(paths: string[]): Promise<void> {
    const excludePath = path.join(this.workspaceRoot, '.git', 'info', 'exclude');
    try {
      const existing = await this.fs.readFile(excludePath);
      const lines = existing.split('\n');

      // Find or create section
      let sectionIndex = lines.indexOf(GIT_EXCLUDE_SECTION_HEADER);
      if (sectionIndex === -1) {
        sectionIndex = lines.length;
        lines.push(GIT_EXCLUDE_SECTION_HEADER);
      }

      // Add paths to section
      for (const p of paths) {
        const relativePath = toGitIgnorePath(this.workspaceRoot, p);
        if (!lines.includes(relativePath)) {
          lines.splice(sectionIndex + 1, 0, relativePath);
        }
      }

      await this.fs.writeFile(excludePath, lines.join('\n'));
    } catch {
      // Create .git/info directory if it doesn't exist
      const infoDir = path.join(this.workspaceRoot, '.git', 'info');
      await this.fs.mkdir(infoDir, { recursive: true });

      const lines = [GIT_EXCLUDE_SECTION_HEADER];
      for (const p of paths) {
        const relativePath = toGitIgnorePath(this.workspaceRoot, p);
        lines.push(relativePath);
      }

      await this.fs.writeFile(excludePath, lines.join('\n'));
    }
  }

  private async removeFromGitExclude(paths: string[]): Promise<void> {
    const excludePath = path.join(this.workspaceRoot, '.git', 'info', 'exclude');
    try {
      const existing = await this.fs.readFile(excludePath);
      const lines = existing.split('\n');

      const sectionIndex = lines.indexOf(GIT_EXCLUDE_SECTION_HEADER);
      if (sectionIndex === -1) {
        return; // No section, nothing to remove
      }

      // Remove paths from section
      const toRemove = new Set(paths.map((p) => toGitIgnorePath(this.workspaceRoot, p)));
      const filtered = lines.filter((l, i) => {
        if (i <= sectionIndex) {
          return true;
        } // Keep header and before
        return !toRemove.has(l);
      });

      await this.fs.writeFile(excludePath, filtered.join('\n'));
    } catch {
      // File doesn't exist, nothing to remove
    }
  }

  private async updateGitExclude(paths: string[]): Promise<void> {
    await this.addToGitExclude(paths);
  }

  private async cleanupEmptyDirectories(dirs: string[]): Promise<void> {
    const parentDirs = new Set<string>();
    const resolvedRoot = path.resolve(this.workspaceRoot);
    for (const dir of dirs) {
      let parent = path.dirname(path.resolve(dir));
      while (parent !== resolvedRoot && path.dirname(parent) !== parent) {
        // The host root can contain unrelated files; never remove .github itself.
        if (parent === path.join(resolvedRoot, '.github')) {
          break;
        }
        parentDirs.add(parent);
        parent = path.dirname(parent);
      }
    }

    for (const dir of [...parentDirs].toSorted((a, b) => b.length - a.length)) {
      try {
        const realpath = this.getRealpath(dir);
        await assertSafeRepositoryDirectoryPath(this.workspaceRoot, dir, realpath);
        const entries = await this.fs.readDir(dir);
        if (entries.length === 0) {
          await this.removePaths([dir]);
        }
      } catch {
        // Directory doesn't exist or can't be read
      }
    }
  }

  private getRealpath(filePath: string): (p: string) => Promise<string> {
    if (this.fs.realpath === undefined) {
      throw new UnsafeRepositoryPathError(filePath, 'cannot be checked against repository root');
    }
    return this.fs.realpath.bind(this.fs);
  }

  private getLstat(filePath: string): (p: string) => Promise<{ isSymbolicLink: boolean }> {
    if (this.fs.lstat === undefined) {
      throw new UnsafeRepositoryPathError(filePath, 'cannot be checked against repository root');
    }
    return this.fs.lstat.bind(this.fs);
  }

  private async validateInstallPaths(paths: readonly string[]): Promise<void> {
    for (const filePath of paths) {
      await assertSafeRepositoryInstallPath(
        this.workspaceRoot,
        filePath,
        this.getRealpath(filePath),
        this.getLstat(filePath)
      );
    }
  }

  private async validateRemovalPaths(paths: readonly string[]): Promise<void> {
    for (const p of paths) {
      await assertSafeRepositoryRemovalPath(this.workspaceRoot, p, this.getRealpath(p));
    }
  }

  private getBundleRemovalPath(filePath: string): string {
    const normalized = filePath.replaceAll('\\', '/');
    if ((normalized.startsWith('knowledge/') || normalized.startsWith('.github/knowledge/'))
      && getKnowledgeRelativePath(normalized) === null) {
      throw new UnsafeRepositoryPathError(filePath);
    }
    const route = [
      ['prompts/', 'copilot/prompts/'],
      ['instructions/', 'copilot/instructions/'],
      ['chat-modes/', 'copilot/agents/'],
      ['chatmodes/', 'copilot/agents/'],
      ['agents/', 'copilot/agents/'],
      ['knowledge/', 'knowledge/'],
      ['skills/', 'skills/'],
      ['hooks/', 'hooks/'],
      ['plugins/', 'plugins/']
    ].find(([sourcePrefix]) => normalized.startsWith(sourcePrefix));

    return route === undefined
      ? path.join(this.workspaceRoot, normalized)
      : path.join(this.workspaceRoot, '.github', route[1], normalized.slice(route[0].length));
  }

  /**
   * Map a lockfile's bundle path to the exact destination used by remove.
   * @param filePath
   */
  private resolveLockfileRemovalPath(filePath: string): string {
    const normalized = filePath.replaceAll('\\', '/');
    if (normalized.startsWith('.github/') || /^(prompts|instructions|chat-modes|chatmodes|agents|knowledge|skills|hooks|plugins)\//.test(normalized)) {
      return this.getBundleRemovalPath(normalized);
    }
    return path.join(this.workspaceRoot, '.github', normalized);
  }

  private async removePaths(paths: string[]): Promise<void> {
    // Check every path before removing any, including paths that do not exist.
    await this.validateRemovalPaths(paths);
    for (const p of paths) {
      try {
        await this.validateRemovalPaths([p]);
        // Keep the original path spelling: in-memory and Windows adapters may
        // not recognize the drive-qualified path used only for validation.
        await this.fs.remove(p);
      } catch (error) {
        if (error instanceof UnsafeRepositoryPathError) {
          throw error;
        }
        // Ignore errors if file doesn't exist
      }
    }
  }

  private getManifestItems(manifest: DeploymentManifest): { file: string; type: string; id?: string }[] {
    const selected = getSelectedManifestPlacementItems(manifest as unknown as Record<string, unknown>);
    const placementItems = selected.flatMap((item) => {
      if (typeof item.file !== 'string' || typeof item.type !== 'string') {
        return [];
      }
      const placement: { file: string; type: string; id?: string } = {
        file: item.file,
        type: item.type
      };
      if (typeof item.id === 'string' || typeof item.id === 'number') {
        placement.id = String(item.id);
      }
      return [placement];
    });
    if (manifest.formatVersion === 1 && manifest.items !== undefined) {
      return placementItems;
    }
    const items: { file: string; type: string; id?: string }[] = [
      ...placementItems,
      ...(manifest.agents ?? []),
      ...(manifest.instructions ?? []),
      ...(manifest.hooks ?? []),
      ...(manifest.plugins ?? []),
      // Legacy skill IDs were descriptive metadata rather than installation
      // destination overrides. Preserve the historical source-directory route
      // for unversioned manifests; canonical `items[]` remains authoritative
      // for governed releases above.
      ...(manifest.skills?.map((item) => ({ file: item.file, type: item.type })) ?? [])
    ];
    return items.filter((item, index) => {
      const kind = normalizePrimitiveKind(item.type) ?? item.type.toLowerCase();
      const key = `${item.file.replaceAll('\\', '/')}\u0000${kind}`;
      return items.findIndex((other) => {
        const otherKind = normalizePrimitiveKind(other.type) ?? other.type.toLowerCase();
        return `${other.file.replaceAll('\\', '/')}\u0000${otherKind}` === key;
      }) === index;
    });
  }

  /**
   * Validate a bundle's entire lockfile entry before removing any files.
   * @param filePaths
   */
  public async preflightRemoval(filePaths: readonly string[]): Promise<void> {
    await this.validateRemovalPaths(filePaths.map((filePath) => this.resolveLockfileRemovalPath(filePath)));
  }

  /**
   * Plan a repository write without changing the filesystem.
   * @param files Extracted bundle files.
   * @param allowedKinds Optional canonical target allowlist.
   * @returns Bundle-relative writable and skipped paths.
   */
  public async preflight(
    files: ExtractedFiles,
    allowedKinds?: readonly PrimitiveKind[]
  ): Promise<TargetWritePlan> {
    const manifestBytes = files.get('deployment-manifest.yml');
    if (manifestBytes === undefined) {
      return { writable: [], skipped: [] };
    }
    const manifest = await this.parseManifest(manifestBytes);
    const allowed = allowedKinds === undefined ? null : new Set(allowedKinds);
    const writable: string[] = [];
    const skipped: string[] = [];
    const destinations: string[] = [];

    for (const item of this.getManifestItems(manifest)) {
      const kind = normalizePrimitiveKind(item.type);
      if (kind === null || (allowed !== null && !allowed.has(kind))) {
        skipped.push(item.file);
        continue;
      }
      if (kind === 'skill' || kind === 'plugin') {
        const sourceId = kind === 'skill' ? this.extractSkillId(item.file) : this.extractPluginId(item.file);
        const targetId = item.id ?? sourceId;
        const prefix = `${path.posix.dirname(item.file)}/`;
        const matches = [...files.keys()].filter((file) => file.startsWith(prefix));
        if (matches.length === 0) {
          skipped.push(item.file);
        } else {
          const targetDir = path.join(this.workspaceRoot, '.github', kind === 'skill' ? 'skills' : 'plugins', targetId);
          for (const file of matches) {
            const relativePath = file.slice(prefix.length);
            writable.push(file);
            destinations.push(path.join(targetDir, relativePath));
          }
        }
        continue;
      }
      const bundlePath = kind === 'knowledge' ? this.getKnowledgeBundlePath(item.file, files) : item.file;
      const targetPath = this.getTargetPath({ type: item.type, file: item.file });
      if (files.has(bundlePath) && targetPath !== null) {
        writable.push(bundlePath);
        destinations.push(targetPath);
      } else {
        skipped.push(item.file);
      }
    }

    await this.validateInstallPaths(destinations);
    return { writable, skipped };
  }

  /**
   * Write bundle files to repository scope.
   * @param files - Extracted bundle files.
   * @param allowedKinds
   * @returns Write result with written paths.
   */
  public async write(files: ExtractedFiles, allowedKinds?: readonly PrimitiveKind[]): Promise<WriteResult> {
    const written: string[] = [];
    const skipped: string[] = [];
    const skillDirs: string[] = [];
    const writtenBundlePaths: string[] = [];
    const allowed = allowedKinds === undefined ? null : new Set(allowedKinds);

    const manifestBytes = files.get('deployment-manifest.yml');
    if (!manifestBytes) {
      return { written, skipped, skillDirs, writtenBundlePaths };
    }

    await this.preflight(files, allowedKinds);
    const manifest = await this.parseManifest(manifestBytes);
    const journal = new FileWriteJournal(this.fs);
    this.writeJournal = journal;

    try {
      await this.processManifestItems(
        this.getManifestItems(manifest),
        files,
        written,
        skipped,
        skillDirs,
        writtenBundlePaths,
        allowed
      );

      // Update git exclude for local-only mode
      if (this.commitMode === 'local-only') {
        await this.updateGitExclude(written);
      }
    } catch (cause) {
      const rollbackErrors: unknown[] = [];
      try {
        await this.validateRemovalPaths(journal.getPaths());
        await journal.rollback();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (this.commitMode === 'local-only') {
        try {
          await this.removeFromGitExclude(written);
        } catch (excludeError) {
          rollbackErrors.push(excludeError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError([cause, ...rollbackErrors], 'Repository write failed and rollback was incomplete', { cause });
      }
      throw cause;
    }

    return { written, skipped, skillDirs, writtenBundlePaths };
  }

  /**
   * Remove paths written by a rejected repository installation.
   * @param written Absolute paths returned by `write`.
   */
  public async rollback(written: readonly string[]): Promise<void> {
    await this.validateRemovalPaths(written);
    await this.writeJournal?.rollback(written);
    if (this.commitMode === 'local-only') {
      await this.removeFromGitExclude([...written]);
    }
  }

  /**
   * Remove a single file path (for uninstall pipeline).
   * @param filePath - Relative file path to remove (from bundle root).
   */
  public async removeFile(filePath: string): Promise<void> {
    const targetPath = path.join(this.workspaceRoot, '.github', filePath);
    await this.removePaths([targetPath]);
  }

  /**
   * Remove a bundle-relative file using the same route mapping as `write()`.
   * Lockfiles record source paths from the bundle, whereas repository output
   * lives below `.github/` and may use a different subdirectory.
   * @param filePath - Bundle-relative path recorded in the lockfile.
   */
  public async removeBundleFile(filePath: string): Promise<void> {
    const targetPath = this.getBundleRemovalPath(filePath);
    await this.removePaths([targetPath]);
    if (this.commitMode === 'local-only') {
      await this.removeFromGitExclude([targetPath]);
    }
  }

  /**
   * Remove files for a bundle from repository scope.
   * @param bundleId - Bundle identifier (used for logging).
   * @param manifest - Deployment manifest to determine which files to remove.
   */
  public async remove(bundleId: string, manifest: DeploymentManifest): Promise<void> {
    const pathsToRemove: string[] = [];
    const skillDirsToRemove: string[] = [];

    if (manifest.formatVersion === 1 && manifest.items !== undefined) {
      this.collectRemovePaths(this.getManifestItems(manifest), pathsToRemove, skillDirsToRemove);
    } else {
      if (manifest.items !== undefined) {
        this.collectRemovePaths(manifest.items.map((item) => ({
          file: item.path,
          type: item.kind,
          id: item.id
        })), pathsToRemove, skillDirsToRemove);
      }

      // Collect paths to remove for prompts, agents, and instructions
      if (manifest.prompts) {
        this.collectRemovePaths(manifest.prompts, pathsToRemove, skillDirsToRemove);
      }
      if (manifest.agents) {
        this.collectRemovePaths(manifest.agents, pathsToRemove, skillDirsToRemove);
      }
      if (manifest.instructions) {
        this.collectRemovePaths(manifest.instructions, pathsToRemove, skillDirsToRemove);
      }

      // Process legacy skills using their historic source-directory route.
      if (manifest.skills) {
        for (const skillFile of manifest.skills) {
          const skillId = this.extractSkillId(skillFile.file);
          const skillPrefix = `skills/${skillId}`;
          const skillDir = path.join(this.workspaceRoot, '.github', skillPrefix);
          skillDirsToRemove.push(skillDir);
        }
      }
    }

    // Manifest removal bypasses removePaths for recursive skill directories.
    // Validate all destinations here before any filesystem mutation.
    await this.validateRemovalPaths([...skillDirsToRemove, ...pathsToRemove]);

    // Remove skill directories
    for (const skillDir of skillDirsToRemove) {
      try {
        await this.validateRemovalPaths([skillDir]);
        await this.fs.remove(skillDir, { recursive: true });
      } catch (error) {
        if (error instanceof UnsafeRepositoryPathError) {
          throw error;
        }
        // Ignore errors if directory doesn't exist
      }
    }

    // Remove files
    for (const p of pathsToRemove) {
      try {
        await this.validateRemovalPaths([p]);
        await this.fs.remove(p);
      } catch (error) {
        if (error instanceof UnsafeRepositoryPathError) {
          throw error;
        }
        // Ignore errors if file doesn't exist
      }
    }

    // Remove from git exclude for local-only mode
    if (this.commitMode === 'local-only') {
      await this.removeFromGitExclude([...pathsToRemove, ...skillDirsToRemove]);
    }

    // Clean up empty directories
    await this.cleanupEmptyDirectories([...pathsToRemove, ...skillDirsToRemove]);
  }

  /**
   * Switch commit mode for installed files.
   * @param paths - List of installed file paths.
   * @param newMode - New commit mode.
   */
  public async switchCommitMode(paths: string[], newMode: RepositoryCommitMode): Promise<void> {
    await (newMode === 'local-only' ? this.addToGitExclude(paths) : this.removeFromGitExclude(paths));
  }
}

/**
 * Adapter to bridge RepositoryScopeWriter with TargetWriter interface.
 *
 * Allows RepositoryScopeWriter to be used in the install pipeline's
 * writer factory.
 */
export class RepositoryScopeWriterAdapter implements TargetWriter {
  constructor(private readonly writer: RepositoryScopeWriter) {}

  /**
   * TargetWriter.write implementation - ignores target parameter since
   * RepositoryScopeWriter already has workspaceRoot and commitMode.
   * @param _target
   * @param files
   */
  public async write(_target: Target, files: ExtractedFiles): Promise<TargetWriteResult> {
    const result = await this.writer.write(files, _target.allowedKinds);
    return {
      written: result.written,
      skipped: result.skipped,
      writtenBundlePaths: result.writtenBundlePaths
    };
  }

  public async preflight(target: Target, files: ExtractedFiles): Promise<TargetWritePlan> {
    return this.writer.preflight(files, target.allowedKinds);
  }

  public async rollback(_target: Target, written: readonly string[]): Promise<void> {
    await this.writer.rollback(written);
  }

  public async preflightRemoval(_target: Target, filePaths: readonly string[]): Promise<void> {
    await this.writer.preflightRemoval(filePaths);
  }

  /**
   * TargetWriter.remove implementation - translates bundle-relative lockfile
   * paths back through the repository writer's output routes. Legacy paths
   * already relative to `.github/` retain the old behavior.
   * @param _target
   * @param filePath
   */
  public async remove(_target: Target, filePath: string): Promise<void> {
    const normalized = filePath.replaceAll('\\', '/');
    if (normalized.startsWith('.github/')) {
      await this.writer.removeBundleFile(normalized);
      return;
    }
    const knownBundlePrefix = /^(prompts|instructions|chat-modes|chatmodes|agents|knowledge|skills|hooks|plugins)\//;
    if (knownBundlePrefix.test(normalized)) {
      await this.writer.removeBundleFile(normalized);
      return;
    }
    await this.writer.removeFile(normalized);
  }
}
