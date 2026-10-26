/**
 * GitInfoExclude.
 *
 * `RepositoryExclusion` adapter that keeps the paths of a `local-only`
 * repository installation in a dedicated section of `.git/info/exclude`.
 * @module writers/git-info-exclude
 */
import * as path from 'node:path';
import type {
  FileSystem,
  RepositoryExclusion,
} from '@ai-primitives-hub/core';

/**
 * Section header for AI Primitives Hub entries in .git/info/exclude
 */
const GIT_EXCLUDE_SECTION_HEADER = '# Prompt Registry (local)';

const toGitIgnorePath = (workspaceRoot: string, filePath: string): string =>
  path.relative(workspaceRoot, filePath).replaceAll('\\', '/');

/**
 * Options for GitInfoExclude.
 */
export interface GitInfoExcludeOptions {
  /** Filesystem abstraction. */
  fs: FileSystem;
  /** Workspace root (repository root). */
  workspaceRoot: string;
}

/**
 * Lists excluded paths, relative to the workspace root, below the
 * `# Prompt Registry (local)` header of `<workspaceRoot>/.git/info/exclude`.
 */
export class GitInfoExclude implements RepositoryExclusion {
  private readonly fs: FileSystem;
  private readonly workspaceRoot: string;

  /**
   * Construct a GitInfoExclude.
   * @param opts Filesystem and workspace root.
   */
  public constructor(opts: GitInfoExcludeOptions) {
    this.fs = opts.fs;
    this.workspaceRoot = opts.workspaceRoot;
  }

  /**
   * Add paths to the section, creating the file and the header when absent.
   * @param paths Absolute paths below the workspace root.
   */
  public async add(paths: readonly string[]): Promise<void> {
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

  /**
   * Remove paths from the section. Does nothing when the file or the
   * header is absent.
   * @param paths Absolute paths below the workspace root.
   */
  public async remove(paths: readonly string[]): Promise<void> {
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
}
