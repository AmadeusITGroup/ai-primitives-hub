/**
 * RepositoryScopeWriter.
 *
 * Writer for repository-scoped installations. Places bundle files into
 * .github/ directories (prompts, agents, instructions, skills) under the
 * workspace root. Supports commit mode (tracked by Git) and local-only
 * mode (excluded via .git/info/exclude).
 *
 * Mirrors the extension's RepositoryScopeService functionality but uses
 * the library's FsAbstraction and ExtractedFiles types for testability.
 *
 * Added RepositoryScopeWriterAdapter to bridge the
 * TargetWriter interface with RepositoryScopeWriter.
 *
 * Added removeFile method for uninstall pipeline.
 */
import * as path from 'node:path';
import {
  load as parseYaml,
} from 'js-yaml';
import type {
  Target,
} from '@prompt-registry/core';
import type {
  ExtractedFiles,
} from '@prompt-registry/core';
import type {
  FileSystem,
} from '@prompt-registry/core';
import type {
  TargetWriter,
  TargetWriteResult,
} from '@prompt-registry/core';

/**
 * Section header for Prompt Registry entries in .git/info/exclude
 */
const GIT_EXCLUDE_SECTION_HEADER = '# Prompt Registry (local)';

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
  id?: string;
  version?: string;
  name?: string;
  description?: string;
  prompts?: { id: string; file: string; type: string }[];
  agents?: { id: string; file: string; type: string }[];
  instructions?: { id: string; file: string; type: string }[];
  skills?: { id: string; file: string; type: string }[];
}

/**
 * Result of a write operation.
 */
interface WriteResult {
  written: string[];
  skipped: string[];
  skillDirs: string[];
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
      return 'copilot/prompts';
    }
    if (typeLower === 'instruction') {
      return 'copilot/instructions';
    }
    if (typeLower === 'agent') {
      return 'copilot/agents';
    }
    if (typeLower === 'skill') {
      return 'skills';
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
        const targetPath = this.getTargetPath({ type: p.type, file: p.file });
        if (targetPath) {
          pathsToRemove.push(targetPath);
        }
      }
    }
  }

  /**
   * Process a list of manifest items (prompts, agents, or instructions),
   * writing skill directories or regular files as appropriate.
   * @param items Manifest items to process.
   * @param files Extracted bundle files.
   * @param written Accumulates written file paths.
   * @param skipped Accumulates skipped file paths.
   * @param skillDirs Accumulates skill directory paths.
   */

  /**
   * Install a single skill item by copying its entire directory from the bundle.
   * @param p Skill item with file and optional id.
   * @param p.file Skill manifest file path.
   * @param p.id Optional target skill ID override.
   * @param files Extracted bundle files.
   * @param written Accumulates written file paths.
   * @param skillDirs Accumulates skill directory paths.
   */
  private async installSkillItem(
    p: { file: string; id?: string },
    files: ExtractedFiles,
    written: string[],
    skillDirs: string[]
  ): Promise<void> {
    const sourceSkillId = this.extractSkillId(p.file);
    const sourcePrefix = `skills/${sourceSkillId}`;
    const targetSkillId = p.id ?? sourceSkillId;
    const skillDir = path.join(this.workspaceRoot, '.github', `skills/${targetSkillId}`);
    for (const [bundlePath, bytes] of files) {
      if (bundlePath.startsWith(sourcePrefix)) {
        const relativePath = bundlePath.slice(sourcePrefix.length);
        const targetPath = path.join(skillDir, relativePath);
        await this.fs.mkdir(path.dirname(targetPath), { recursive: true });
        await this.fs.writeFile(targetPath, new TextDecoder().decode(bytes));
        written.push(targetPath);
      }
    }
    skillDirs.push(skillDir);
  }

  private async processManifestItems(
    items: { type: string; file: string; id?: string }[],
    files: ExtractedFiles,
    written: string[],
    skipped: string[],
    skillDirs: string[]
  ): Promise<void> {
    for (const p of items) {
      if (p.type.toLowerCase() === 'skill') {
        await this.installSkillItem(p, files, written, skillDirs);
      } else {
        const bytes = files.get(p.file);
        if (bytes) {
          const targetPath = this.getTargetPath({ type: p.type, file: p.file });
          if (targetPath) {
            await this.fs.mkdir(path.dirname(targetPath), { recursive: true });
            await this.fs.writeFile(targetPath, new TextDecoder().decode(bytes));
            written.push(targetPath);
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
        const relativePath = path.relative(this.workspaceRoot, p);
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
        const relativePath = path.relative(this.workspaceRoot, p);
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
      const toRemove = new Set(paths.map((p) => path.relative(this.workspaceRoot, p)));
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

  /**
   * Write bundle files to repository scope.
   * @param files - Extracted bundle files.
   * @returns Write result with written paths.
   */
  public async write(files: ExtractedFiles): Promise<WriteResult> {
    const written: string[] = [];
    const skipped: string[] = [];
    const skillDirs: string[] = [];

    const manifestBytes = files.get('deployment-manifest.yml');
    if (!manifestBytes) {
      return { written, skipped, skillDirs };
    }

    const manifest = await this.parseManifest(manifestBytes);

    // Process prompts, agents, and instructions (skill items get directory install)
    if (manifest.prompts) {
      await this.processManifestItems(manifest.prompts, files, written, skipped, skillDirs);
    }
    if (manifest.agents) {
      await this.processManifestItems(manifest.agents, files, written, skipped, skillDirs);
    }
    if (manifest.instructions) {
      await this.processManifestItems(manifest.instructions, files, written, skipped, skillDirs);
    }

    // Process skills
    if (manifest.skills) {
      for (const skillFile of manifest.skills) {
        const skillId = this.extractSkillId(skillFile.file);
        const skillPrefix = `skills/${skillId}`;
        const skillDir = path.join(this.workspaceRoot, '.github', skillPrefix);

        // Install all files in the skill directory
        for (const [bundlePath, bytes] of files) {
          if (bundlePath.startsWith(skillPrefix)) {
            const relativePath = bundlePath.slice(skillPrefix.length);
            const targetPath = path.join(skillDir, relativePath);

            await this.fs.mkdir(path.dirname(targetPath), { recursive: true });
            await this.fs.writeFile(targetPath, new TextDecoder().decode(bytes));
            written.push(targetPath);
          }
        }

        skillDirs.push(skillDir);
      }
    }

    // Update git exclude for local-only mode
    if (this.commitMode === 'local-only') {
      await this.updateGitExclude(written);
    }

    return { written, skipped, skillDirs };
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
   * Remove files for a bundle from repository scope.
   * @param bundleId - Bundle identifier (used for logging).
   * @param manifest - Deployment manifest to determine which files to remove.
   */
  public async remove(bundleId: string, manifest: DeploymentManifest): Promise<void> {
    const pathsToRemove: string[] = [];
    const skillDirsToRemove: string[] = [];

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

    // Process skills
    if (manifest.skills) {
      for (const skillFile of manifest.skills) {
        const skillId = this.extractSkillId(skillFile.file);
        const skillPrefix = `skills/${skillId}`;
        const skillDir = path.join(this.workspaceRoot, '.github', skillPrefix);
        skillDirsToRemove.push(skillDir);
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
 * Created to allow RepositoryScopeWriter to be used
 * in the install pipeline's writer factory.
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
    const result = await this.writer.write(files);
    return {
      written: result.written,
      skipped: result.skipped
    };
  }

  /**
   * TargetWriter.remove implementation - delegates to RepositoryScopeWriter.removeFile.
   * @param _target
   * @param filePath
   */
  public async remove(_target: Target, filePath: string): Promise<void> {
    await this.writer.removeFile(filePath);
  }
}
