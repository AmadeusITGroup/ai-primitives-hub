/**
 * GitInfoExclude.
 *
 * `RepositoryExclusion` adapter that keeps the paths of a `local-only`
 * repository installation in a dedicated section of `.git/info/exclude`.
 * The text change is done by core's `addExcludeEntries` / `removeExcludeEntries`.
 * @module writers/git-info-exclude
 */
import * as path from 'node:path';
import {
  addExcludeEntries,
  type FileSystem,
  removeExcludeEntries,
  type RepositoryExclusion,
} from '@ai-primitives-hub/core';

const toGitIgnorePath = (workspaceRoot: string, filePath: string): string =>
  path.relative(workspaceRoot, filePath).replaceAll('\\', '/');

/**
 * Options for GitInfoExclude.
 */
export interface GitInfoExcludeOptions {
  /** Filesystem abstraction. */
  fs: FileSystem;
  /** Workspace root (repository root); listed paths are relative to it. */
  workspaceRoot: string;
  /** Absolute `info/exclude` file to edit; defaults to `<workspaceRoot>/.git/info/exclude`. */
  excludePath?: string;
}

/**
 * Lists excluded paths, relative to the workspace root, below the
 * `# Prompt Registry (local)` header of the exclude file
 * (`<workspaceRoot>/.git/info/exclude` unless another file is given).
 */
export class GitInfoExclude implements RepositoryExclusion {
  private readonly fs: FileSystem;
  private readonly workspaceRoot: string;
  private readonly excludePath: string;

  /**
   * Construct a GitInfoExclude.
   * @param opts Filesystem, workspace root and optional exclude file.
   */
  public constructor(opts: GitInfoExcludeOptions) {
    this.fs = opts.fs;
    this.workspaceRoot = opts.workspaceRoot;
    this.excludePath = opts.excludePath ?? path.join(opts.workspaceRoot, '.git', 'info', 'exclude');
  }

  /**
   * Add paths to the section, creating the file and the header when absent.
   * @param paths Absolute paths below the workspace root.
   */
  public async add(paths: readonly string[]): Promise<void> {
    const existing = (await this.fs.exists(this.excludePath)) ? await this.fs.readFile(this.excludePath) : '';
    const updated = addExcludeEntries(existing, paths.map((p) => toGitIgnorePath(this.workspaceRoot, p)));
    if (updated === undefined) {
      return;
    }
    await this.fs.mkdir(path.dirname(this.excludePath), { recursive: true });
    await this.fs.writeFile(this.excludePath, updated);
  }

  /**
   * Remove paths from the section. Does nothing when the file or the
   * header is absent.
   * @param paths Absolute paths below the workspace root.
   */
  public async remove(paths: readonly string[]): Promise<void> {
    try {
      const existing = await this.fs.readFile(this.excludePath);
      const updated = removeExcludeEntries(existing, paths.map((p) => toGitIgnorePath(this.workspaceRoot, p)));
      if (updated !== undefined) {
        await this.fs.writeFile(this.excludePath, updated);
      }
    } catch {
      // File doesn't exist, nothing to remove
    }
  }
}
