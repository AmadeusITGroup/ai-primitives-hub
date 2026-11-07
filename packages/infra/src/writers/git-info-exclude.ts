/**
 * GitInfoExclude.
 *
 * `RepositoryExclusion` adapter that keeps the paths of a `local-only`
 * repository installation in a dedicated section of the repository's
 * `info/exclude` file: `.git/info/exclude` in a plain repository, the main
 * repository's in a linked worktree, `.git/modules/<name>/info/exclude` in
 * a submodule.
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

/**
 * A path relative to the work tree, `/`-separated.
 * @param workspaceRoot Work tree root.
 * @param filePath Absolute path below it.
 * @returns The relative path; a `\` inside a POSIX file name is kept.
 */
const workTreeRelative = (workspaceRoot: string, filePath: string): string =>
  path.relative(workspaceRoot, filePath).split(path.sep).join('/');

/** Characters a gitignore pattern reads as glob syntax or as an escape. */
const GLOB_CHARACTERS = /[\\*?[\]]/g;

/**
 * The exclude line that matches exactly one path: glob characters, a
 * leading `!` or `#` and trailing spaces are escaped with `\`. Git keeps
 * leading spaces as they are. A path with a `/` before its last segment
 * (every installed file) is matched from the work tree root.
 * @param workspaceRoot Work tree root.
 * @param filePath Absolute path below it.
 * @returns The exclude line.
 */
const toGitIgnorePattern = (workspaceRoot: string, filePath: string): string =>
  workTreeRelative(workspaceRoot, filePath)
    .replaceAll(GLOB_CHARACTERS, String.raw`\$&`)
    .replace(/^[!#]/, String.raw`\$&`)
    .replace(/ +$/, (spaces) => String.raw`\ `.repeat(spaces.length));

/**
 * The lines {@link GitInfoExclude.remove} removes for one path: its
 * pattern and, when it differs, the unescaped line earlier versions wrote.
 * A path with a `\` in a file name gets no unescaped line: earlier versions
 * turned that `\` into `/`, so their line may name another path.
 * @param workspaceRoot Work tree root.
 * @param filePath Absolute path below it.
 * @returns The lines to remove.
 */
const linesFor = (workspaceRoot: string, filePath: string): string[] => {
  const pattern = toGitIgnorePattern(workspaceRoot, filePath);
  const unescaped = workTreeRelative(workspaceRoot, filePath);
  return unescaped === pattern || unescaped.includes('\\') ? [pattern] : [pattern, unescaped];
};

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
 * The first line of a `.git` file that links a worktree or submodule to
 * its git directory.
 */
const GITDIR_LINE = /^gitdir:\s*(.+?)\s*$/;

/**
 * Lists excluded paths, relative to the workspace root, below the
 * `# Prompt Registry (local)` header of the repository's exclude file.
 *
 * The exclude file is resolved on each call from `<workspaceRoot>/.git`:
 * a directory with `HEAD`, `objects` and `refs` means `.git/info/exclude`;
 * a file `gitdir: <dir>` (linked
 * worktree, submodule) means `<commondir or dir>/info/exclude`. Anything
 * else is not a git work tree: the adapter is unavailable and never
 * creates a `.git`. Paths stay relative to the workspace root in every
 * case, since git reads exclude patterns relative to the work tree.
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
   * Whether a `.git` directory holds a repository: git reads it only when
   * it has `HEAD`, `objects` and `refs`.
   * @param gitDir Absolute `.git` directory.
   * @returns True when all three exist.
   */
  private async holdsRepository(gitDir: string): Promise<boolean> {
    for (const entry of ['HEAD', 'objects', 'refs']) {
      if (!(await this.fs.exists(path.join(gitDir, entry)))) {
        return false;
      }
    }
    return true;
  }

  /**
   * Locate the exclude file git reads for this work tree.
   * @returns Absolute exclude file path, or `null` when the workspace is
   *   not a git work tree (no `.git`, unreadable, a `.git` directory
   *   without `HEAD`, `objects` or `refs`, no `gitdir:` line, or a
   *   `gitdir:` or `commondir` link to a missing directory).
   */
  private async resolveExcludeFile(): Promise<string | null> {
    const dotGit = path.join(this.workspaceRoot, '.git');
    try {
      const stat = await this.fs.stat(dotGit);
      if (stat.isDirectory) {
        return (await this.holdsRepository(dotGit)) ? path.join(dotGit, 'info', 'exclude') : null;
      }
      if (!stat.isFile) {
        return null;
      }
      const firstLine = (await this.fs.readFile(dotGit)).split('\n')[0];
      const match = GITDIR_LINE.exec(firstLine);
      if (match === null) {
        return null;
      }
      const gitDir = path.resolve(this.workspaceRoot, match[1]);
      if (!(await this.fs.exists(gitDir))) {
        // A pruned worktree or a deleted module directory: git reads no exclude file there.
        return null;
      }
      const commonDirFile = path.join(gitDir, 'commondir');
      const commonDir = (await this.fs.exists(commonDirFile))
        ? (await this.fs.readFile(commonDirFile)).trim()
        : '';
      const commonRoot = commonDir === '' ? gitDir : path.resolve(gitDir, commonDir);
      if (!(await this.fs.exists(commonRoot))) {
        // A moved or deleted main repository: git reads no exclude file there.
        return null;
      }
      return path.join(commonRoot, 'info', 'exclude');
    } catch {
      return null;
    }
  }

  /**
   * Whether the workspace is a git work tree with an exclude file location.
   * @returns True when `add` and `remove` have a file to update.
   */
  public async isAvailable(): Promise<boolean> {
    return (await this.resolveExcludeFile()) !== null;
  }

  /**
   * Add paths to the section as escaped patterns, creating the file and
   * the header when the file is absent. Does nothing outside a git work tree. Read and write
   * errors on an existing file reject; the file is never replaced.
   * @param paths Absolute paths below the workspace root.
   */
  public async add(paths: readonly string[]): Promise<void> {
    const excludePath = await this.resolveExcludeFile();
    if (excludePath === null) {
      return;
    }
    if (!(await this.fs.exists(excludePath))) {
      await this.fs.mkdir(path.dirname(excludePath), { recursive: true });
      const created = [GIT_EXCLUDE_SECTION_HEADER];
      for (const p of paths) {
        created.push(toGitIgnorePattern(this.workspaceRoot, p));
      }
      await this.fs.writeFile(excludePath, created.join('\n'));
      return;
    }

    const lines = (await this.fs.readFile(excludePath)).split('\n');

    // Find or create section
    let sectionIndex = lines.indexOf(GIT_EXCLUDE_SECTION_HEADER);
    if (sectionIndex === -1) {
      sectionIndex = lines.length;
      lines.push(GIT_EXCLUDE_SECTION_HEADER);
    }

    // Add paths to section
    for (const p of paths) {
      const relativePath = toGitIgnorePattern(this.workspaceRoot, p);
      if (!lines.includes(relativePath)) {
        lines.splice(sectionIndex + 1, 0, relativePath);
      }
    }

    await this.fs.writeFile(excludePath, lines.join('\n'));
  }

  /**
   * Remove paths from the section, with the unescaped lines earlier
   * versions wrote for them. Does nothing outside a git work tree or
   * when the file or the header is absent; other read and write errors
   * reject.
   * @param paths Absolute paths below the workspace root.
   */
  public async remove(paths: readonly string[]): Promise<void> {
    const excludePath = await this.resolveExcludeFile();
    if (excludePath === null || !(await this.fs.exists(excludePath))) {
      return;
    }
    const lines = (await this.fs.readFile(excludePath)).split('\n');

    const sectionIndex = lines.indexOf(GIT_EXCLUDE_SECTION_HEADER);
    if (sectionIndex === -1) {
      return; // No section, nothing to remove
    }

    // Remove paths from section
    const toRemove = new Set(paths.flatMap((p) => linesFor(this.workspaceRoot, p)));
    const filtered = lines.filter((l, i) => {
      if (i <= sectionIndex) {
        return true;
      } // Keep header and before
      return !toRemove.has(l);
    });

    await this.fs.writeFile(excludePath, filtered.join('\n'));
  }
}

/**
 * A `RepositoryExclusion` that excludes nothing and reports itself
 * unavailable. Given to a writer when its caller owns the exclusion calls.
 *
 * `@migration-cleanup(writer-owned-exclusion)`: remove once no writer
 * updates the exclusion list itself.
 */
export const NO_EXCLUSION: RepositoryExclusion = Object.freeze({
  add: (): Promise<void> => Promise.resolve(),
  remove: (): Promise<void> => Promise.resolve(),
  isAvailable: (): Promise<boolean> => Promise.resolve(false)
});
