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
  ExtractedFile,
  ExtractedFiles,
  FileSystem,
  PrimitiveKind,
  RepositoryExclusion,
  Target,
  TargetWritePlan,
  TargetWriter,
  TargetWriteResult,
} from '@ai-primitives-hub/core';
import {
  applyFileMode,
  categoryOf,
  isPrimitiveKind,
  normalizePrimitiveKind,
  verifyWrittenBytes,
} from '@ai-primitives-hub/core';
import {
  load as parseYaml,
} from 'js-yaml';
import {
  GitInfoExclude,
} from './git-info-exclude';

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
  /**
   * Where `local-only` paths are excluded from version control. Defaults
   * to `.git/info/exclude` below `workspaceRoot` ({@link GitInfoExclude}).
   */
  exclusion?: RepositoryExclusion;
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
 * - prompts → .github/prompts/
 * - instructions → .github/instructions/
 * - agents → .github/agents/
 * - hooks → .github/hooks/
 *
 * Items of a `directory` install category (skills, plugins) are installed
 * whole: every bundle file below the item's directory is copied to
 * .github/<subdirectory>/<id>/.
 */
export class RepositoryScopeWriter {
  private readonly fs: FileSystem;
  private readonly workspaceRoot: string;
  private readonly commitMode: RepositoryCommitMode;
  private readonly exclusion: RepositoryExclusion;

  /**
   * Construct a RepositoryScopeWriter.
   * @param opts Writer options including filesystem, workspace root, and commit mode.
   */
  public constructor(opts: RepositoryScopeWriterOptions) {
    this.fs = opts.fs;
    this.workspaceRoot = opts.workspaceRoot;
    this.commitMode = opts.commitMode;
    this.exclusion = opts.exclusion ?? new GitInfoExclude({ fs: opts.fs, workspaceRoot: opts.workspaceRoot });
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
   * The executable bit the source recorded is then applied (issue #577).
   * @param targetPath Absolute destination path.
   * @param bytes Exact bytes to install.
   */
  private async writeBytesVerified(targetPath: string, bytes: ExtractedFile): Promise<void> {
    await this.fs.mkdir(path.dirname(targetPath), { recursive: true });
    await this.fs.writeFileBytes(targetPath, bytes);
    await verifyWrittenBytes(this.fs, targetPath, bytes);
    await applyFileMode(this.fs, targetPath, bytes);
  }

  private getTargetPath(item: { type: string; file: string }): string | null {
    const subdirectory = this.getSubdirectory(item.type);
    if (!subdirectory) {
      return null;
    }

    const fileName = this.getFileName(item.file);
    const targetPath = path.join(this.workspaceRoot, '.github', subdirectory, fileName);
    return targetPath;
  }

  private getSubdirectory(type: string): string | null {
    const typeLower = type.toLowerCase();
    if (typeLower === 'prompt') {
      return 'prompts';
    }
    if (typeLower === 'instruction' || typeLower === 'instructions') {
      return 'instructions';
    }
    if (typeLower === 'agent' || typeLower === 'chatmode' || typeLower === 'chat-mode') {
      return 'agents';
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
        const sourceSkillId = this.extractDirectoryId(p.file, 'skills');
        const targetSkillId = p.id ?? sourceSkillId;
        const skillDir = path.join(this.workspaceRoot, '.github', `skills/${targetSkillId}`);
        skillDirsToRemove.push(skillDir);
      } else {
        const targetPath = this.getTargetPath({ type: p.type, file: p.file });
        if (targetPath) {
          pathsToRemove.push(targetPath);
        }
      }
    }
  }

  /**
   * Install a directory-category item by copying its entire directory from
   * the bundle into `.github/<subdirectory>/<id>/`.
   * @param p Item with file and optional id.
   * @param p.file Item manifest file path.
   * @param p.id Optional target directory id override.
   * @param subdirectory Bundle and `.github/` subdirectory of the item's kind.
   * @param files Extracted bundle files.
   * @param written Accumulates written file paths.
   * @param directories Accumulates installed directory paths.
   * @param writtenBundlePaths Accumulates bundle-relative paths written.
   */
  private async installDirectoryItem(
    p: { file: string; id?: string },
    subdirectory: string,
    files: ExtractedFiles,
    written: string[],
    directories: string[],
    writtenBundlePaths: string[]
  ): Promise<void> {
    const sourceId = this.extractDirectoryId(p.file, subdirectory);
    const sourcePrefix = `${subdirectory}/${sourceId}`;
    const targetId = p.id ?? sourceId;
    const directory = path.join(this.workspaceRoot, '.github', `${subdirectory}/${targetId}`);
    for (const [bundlePath, bytes] of files) {
      if (bundlePath.startsWith(sourcePrefix)) {
        const relativePath = bundlePath.slice(sourcePrefix.length);
        const targetPath = path.join(directory, relativePath);
        await this.writeBytesVerified(targetPath, bytes);
        written.push(targetPath);
        writtenBundlePaths.push(bundlePath);
      }
    }
    directories.push(directory);
  }

  private async processManifestItems(
    items: { type: string; file: string; id?: string }[],
    files: ExtractedFiles,
    written: string[],
    skipped: string[],
    directories: string[],
    writtenBundlePaths: string[],
    allowedKinds: ReadonlySet<PrimitiveKind> | null
  ): Promise<void> {
    for (const p of items) {
      const kind = normalizePrimitiveKind(p.type);
      if (allowedKinds !== null && (kind === null || !allowedKinds.has(kind))) {
        skipped.push(p.file);
        continue;
      }
      const declared = p.type.toLowerCase();
      if (isPrimitiveKind(declared) && categoryOf(declared) === 'directory') {
        const subdirectory = this.getSubdirectory(declared);
        if (subdirectory === null) {
          skipped.push(p.file);
          continue;
        }
        await this.installDirectoryItem(p, subdirectory, files, written, directories, writtenBundlePaths);
      } else {
        const bytes = files.get(p.file);
        if (bytes) {
          const targetPath = this.getTargetPath({ type: p.type, file: p.file });
          if (targetPath) {
            await this.writeBytesVerified(targetPath, bytes);
            written.push(targetPath);
            writtenBundlePaths.push(p.file);
          } else {
            skipped.push(p.file);
          }
        }
      }
    }
  }

  /**
   * Id of a directory item: the sanitized path segment after the first
   * `subdirectory` segment of its file, or `unknown`.
   * @param filePath Item manifest file path.
   * @param subdirectory Bundle subdirectory of the item's kind.
   */
  private extractDirectoryId(filePath: string, subdirectory: string): string {
    const parts = filePath.split('/');
    const index = parts.indexOf(subdirectory);
    if (index !== -1 && index + 1 < parts.length) {
      return this.sanitizeId(parts[index + 1]);
    }
    return 'unknown';
  }

  private sanitizeId(id: string): string {
    return id.toLowerCase().replaceAll(/[^a-z0-9-]/g, '-');
  }

  private async cleanupEmptyDirectories(dirs: string[]): Promise<void> {
    const parentDirs = new Set<string>();
    for (const dir of dirs) {
      const parts = dir.split(path.sep);
      for (let i = 0; i < parts.length - 1; i++) {
        parentDirs.add(parts.slice(0, i + 1).join(path.sep));
      }
    }

    for (const dir of parentDirs) {
      try {
        const fullPath = path.join(this.workspaceRoot, dir);
        const entries = await this.fs.readDir(fullPath);
        if (entries.length === 0) {
          await this.fs.remove(fullPath);
        }
      } catch {
        // Directory doesn't exist or can't be read
      }
    }
  }

  private async removePaths(paths: string[]): Promise<void> {
    for (const p of paths) {
      try {
        await this.fs.remove(p);
      } catch {
        // Ignore errors if file doesn't exist
      }
    }
  }

  private getManifestItems(manifest: DeploymentManifest): { file: string; type: string; id?: string }[] {
    if (manifest.formatVersion === 1 && manifest.items !== undefined) {
      return manifest.items.map((item) => ({ file: item.path, type: item.kind, id: item.id }));
    }
    return [
      ...(manifest.items?.map((item) => ({ file: item.path, type: item.kind, id: item.id })) ?? []),
      ...(manifest.prompts ?? []),
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

    for (const item of this.getManifestItems(manifest)) {
      const kind = normalizePrimitiveKind(item.type);
      if (kind === null || (allowed !== null && !allowed.has(kind))) {
        skipped.push(item.file);
        continue;
      }
      if (categoryOf(kind) === 'directory') {
        if (this.getSubdirectory(kind) === null) {
          skipped.push(item.file);
          continue;
        }
        const prefix = `${path.posix.dirname(item.file)}/`;
        const matches = [...files.keys()].filter((file) => file.startsWith(prefix));
        if (matches.length === 0) {
          skipped.push(item.file);
        } else {
          writable.push(...matches);
        }
        continue;
      }
      if (files.has(item.file) && this.getTargetPath({ type: item.type, file: item.file }) !== null) {
        writable.push(item.file);
      } else {
        skipped.push(item.file);
      }
    }

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
    const directories: string[] = [];
    const writtenBundlePaths: string[] = [];
    const allowed = allowedKinds === undefined ? null : new Set(allowedKinds);

    const manifestBytes = files.get('deployment-manifest.yml');
    if (!manifestBytes) {
      return { written, skipped, skillDirs: directories, writtenBundlePaths };
    }

    const manifest = await this.parseManifest(manifestBytes);

    await this.processManifestItems(
      this.getManifestItems(manifest),
      files,
      written,
      skipped,
      directories,
      writtenBundlePaths,
      allowed
    );

    // Update git exclude for local-only mode
    if (this.commitMode === 'local-only') {
      await this.exclusion.add(written);
    }

    return { written, skipped, skillDirs: directories, writtenBundlePaths };
  }

  /**
   * Remove paths written by a rejected repository installation.
   * @param written Absolute paths returned by `write`.
   */
  public async rollback(written: readonly string[]): Promise<void> {
    await this.removePaths([...written]);
    if (this.commitMode === 'local-only') {
      await this.exclusion.remove([...written]);
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
    const normalized = filePath.replaceAll('\\', '/');
    const route = [
      ['prompts/', 'prompts/'],
      ['instructions/', 'instructions/'],
      ['chat-modes/', 'agents/'],
      ['chatmodes/', 'agents/'],
      ['agents/', 'agents/'],
      ['skills/', 'skills/'],
      ['hooks/', 'hooks/'],
      ['plugins/', 'plugins/']
    ].find(([sourcePrefix]) => normalized.startsWith(sourcePrefix));

    const targetPath = route === undefined
      ? path.join(this.workspaceRoot, normalized)
      : path.join(this.workspaceRoot, '.github', route[1], normalized.slice(route[0].length));
    await this.removePaths([targetPath]);
    if (this.commitMode === 'local-only') {
      await this.exclusion.remove([targetPath]);
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
          const skillId = this.extractDirectoryId(skillFile.file, 'skills');
          const skillPrefix = `skills/${skillId}`;
          const skillDir = path.join(this.workspaceRoot, '.github', skillPrefix);
          skillDirsToRemove.push(skillDir);
        }
      }
    }

    // Remove skill directories
    for (const skillDir of skillDirsToRemove) {
      try {
        await this.fs.remove(skillDir, { recursive: true });
      } catch {
        // Ignore errors if directory doesn't exist
      }
    }

    // Remove files
    for (const p of pathsToRemove) {
      try {
        await this.fs.remove(p);
      } catch {
        // Ignore errors if file doesn't exist
      }
    }

    // Remove from git exclude for local-only mode
    if (this.commitMode === 'local-only') {
      await this.exclusion.remove([...pathsToRemove, ...skillDirsToRemove]);
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
    await (newMode === 'local-only' ? this.exclusion.add(paths) : this.exclusion.remove(paths));
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
    const knownBundlePrefix = /^(prompts|instructions|chat-modes|chatmodes|agents|skills|hooks|plugins)\//;
    if (knownBundlePrefix.test(normalized)) {
      await this.writer.removeBundleFile(normalized);
      return;
    }
    await this.writer.removeFile(normalized);
  }
}
