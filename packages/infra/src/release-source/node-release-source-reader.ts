/**
 * Git- and filesystem-backed implementation of core's `ReleaseSourceReader`
 * port, used by `bundle build` release planning.
 *
 * Ported from the git/fs helpers of the legacy
 * `lib/src/release-manifest.ts` (left unchanged). It deliberately uses
 * synchronous `spawnSync` / `node:fs` calls wrapped in promises instead of
 * `NodeProcessExecutor` / `NodeFileSystem`, to keep that implementation's
 * exact semantics: raw `buffer` stdout for blobs, exit-status checks,
 * stderr-suffixed error messages, and `Dirent#isFile()` filtering (symlinks
 * are not listed from the working tree).
 *
 * Committed reads follow gitlinks at their pinned commits, not the submodule's
 * checkout. `isExecutable` reports Git mode `100755` for a revision (from one
 * `git ls-tree` per repository and commit) and the owner execute bit for the working
 * tree. Committed symlinks (`120000`) are still listed and read as regular
 * files holding the link target, and are never executable.
 *
 * Deliberate divergence from lib: git output is not capped at Node's 1 MiB
 * default `maxBuffer` (lib failed on larger committed assets with a misleading
 * "not present at revision" error), and spawn errors are reported as such.
 * @module release-source/node-release-source-reader
 */
import {
  spawnSync,
} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  assertImmutableRevision,
  normalizeRepoRelativePath,
  type ReleaseSourceReader,
  type ReleaseSourceTree,
  type RevisionedReleaseSourceTree,
} from '@ai-primitives-hub/core';

/**
 * Run a synchronous operation, turning a throw into a rejection.
 * @param operation - Synchronous operation.
 */
const settle = <T>(operation: () => T): Promise<T> =>
  new Promise((resolve) => resolve(operation()));

/** Upper bound for git stdout (blobs and `ls-tree` listings); Node's default is 1 MiB. */
const GIT_MAX_BUFFER_BYTES = 512 * 1024 * 1024;
const gitEnv = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' };

const runGit = (repoRoot: string, args: string[]): string => {
  const result = spawnSync('git', args, {
    cwd: repoRoot, env: gitEnv, encoding: 'buffer', maxBuffer: GIT_MAX_BUFFER_BYTES
  });
  if (result.error) {
    throw new Error(`Git command failed: git ${args.join(' ')}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8').trim() : '';
    throw new Error(`Git command failed: git ${args.join(' ')}${stderr ? `: ${stderr}` : ''}`);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : '';
};

const readGitBlob = (repoRoot: string, revision: string, normalizedPath: string): Buffer => {
  const result = spawnSync('git', ['cat-file', 'blob', `${revision}:${normalizedPath}`], {
    cwd: repoRoot,
    env: gitEnv,
    encoding: 'buffer',
    maxBuffer: GIT_MAX_BUFFER_BYTES
  });
  if (result.error) {
    throw new Error(`Failed to read ${normalizedPath} at revision ${revision}: ${result.error.message}`);
  }
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8').trim() : '';
    throw new Error(`Source file is not present at revision ${revision}: ${normalizedPath}${stderr ? ` (${stderr})` : ''}`);
  }
  return result.stdout;
};

const GIT_EXECUTABLE_MODE = '100755';
const GIT_SUBMODULE_MODE = '160000';

interface GitTreeEntry {
  mode: string;
  oid: string;
}

const readGitTreeEntries = (repoRoot: string, revision: string): Map<string, GitTreeEntry> => {
  const entries = new Map<string, GitTreeEntry>();
  for (const record of runGit(repoRoot, ['ls-tree', '-r', '-z', revision]).split('\0')) {
    const tab = record.indexOf('\t');
    if (tab > 0) {
      const [mode, , oid] = record.slice(0, tab).split(' ');
      entries.set(record.slice(tab + 1), { mode, oid });
    }
  }
  return entries;
};

class PinnedGitTree {
  private entries?: Map<string, GitTreeEntry>;
  private readonly submodules = new Map<string, PinnedGitTree>();

  public constructor(private readonly root: string, public readonly revision: string) {}

  private getEntries(): Map<string, GitTreeEntry> {
    this.entries ??= readGitTreeEntries(this.root, this.revision);
    return this.entries;
  }

  private openSubmodule(name: string, oid: string): PinnedGitTree {
    const cached = this.submodules.get(name);
    if (cached) {
      return cached;
    }
    const root = path.join(this.root, name);
    const revision = assertImmutableRevision(oid);
    try {
      // Do not follow a replacement symlink or let Git discover the enclosing repo.
      if (fs.realpathSync(root) !== path.join(fs.realpathSync(this.root), name)
        || !fs.existsSync(path.join(root, '.git'))
        || runGit(root, ['rev-parse', '--show-prefix']).trim() !== '') {
        throw new Error('No initialized submodule checkout at this path');
      }
      if (runGit(root, ['cat-file', '-t', revision]).trim() !== 'commit') {
        throw new Error('The pinned object is not a commit');
      }
    } catch (error) {
      throw new Error(
        `Cannot read submodule "${name}" at pinned commit ${revision}. `
        + 'Run `git submodule update --init --recursive` from the collection repository '
        + 'and ensure the pinned commit is available locally.',
        { cause: error }
      );
    }
    const tree = new PinnedGitTree(root, revision);
    this.submodules.set(name, tree);
    return tree;
  }

  public resolveFile(file: string): { tree: PinnedGitTree; file: string } {
    for (let ancestor = path.posix.dirname(file); ancestor !== '.'; ancestor = path.posix.dirname(ancestor)) {
      const entry = this.getEntries().get(ancestor);
      if (entry?.mode === GIT_SUBMODULE_MODE) {
        return this.openSubmodule(ancestor, entry.oid).resolveFile(file.slice(ancestor.length + 1));
      }
    }
    return { tree: this, file };
  }

  public readFile(file: string): Buffer {
    const resolved = this.resolveFile(file);
    return readGitBlob(resolved.tree.root, resolved.tree.revision, resolved.file);
  }

  public isExecutable(file: string): boolean {
    const resolved = this.resolveFile(file);
    return resolved.tree.getEntries().get(resolved.file)?.mode === GIT_EXECUTABLE_MODE;
  }

  public listFiles(directory: string, recursive: boolean): string[] {
    const files: string[] = [];
    for (const [file, { mode, oid }] of this.getEntries()) {
      const inDirectory = directory === '.' || file.startsWith(`${directory}/`);
      if (mode === GIT_SUBMODULE_MODE) {
        // Descend only when the listing is inside the gitlink or recursively covers it.
        if (file === directory || directory.startsWith(`${file}/`) || (recursive && inDirectory)) {
          const subdirectory = directory.startsWith(`${file}/`) ? directory.slice(file.length + 1) : '.';
          for (const child of this.openSubmodule(file, oid).listFiles(subdirectory, recursive)) {
            files.push(`${file}/${child}`);
          }
        }
      } else if (recursive ? inDirectory || file === directory : path.posix.dirname(file) === directory) {
        files.push(file);
      }
    }
    return files;
  }
}

const listWorkingTreeFiles = (directory: string, repoRoot: string, recursive: boolean): string[] => {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (recursive && entry.isDirectory()) {
      files.push(...listWorkingTreeFiles(fullPath, repoRoot, recursive));
    } else if (entry.isFile()) {
      files.push(normalizeRepoRelativePath(path.relative(repoRoot, fullPath)));
    }
  }
  return files;
};

/** Reads release sources from a local Git repository and its working tree. */
export class NodeReleaseSourceReader implements ReleaseSourceReader {
  public openRevision(repoRoot: string, revision = 'HEAD'): Promise<RevisionedReleaseSourceTree> {
    return settle(() => {
      const output = runGit(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]);
      const commit = assertImmutableRevision(output.trim());
      const tree = new PinnedGitTree(repoRoot, commit);
      return {
        revision: commit,
        readFile: (repositoryPath) => settle(() => tree.readFile(normalizeRepoRelativePath(repositoryPath))),
        listFiles: (repositoryDirectory, { recursive = true } = {}) => settle(() =>
          tree.listFiles(normalizeRepoRelativePath(repositoryDirectory).replace(/\/$/, ''), recursive)),
        isExecutable: (repositoryPath) => settle(() => tree.isExecutable(normalizeRepoRelativePath(repositoryPath)))
      };
    });
  }

  public openWorkingTree(repoRoot: string): ReleaseSourceTree {
    return {
      readFile: (repositoryPath) => settle(() =>
        fs.readFileSync(path.join(repoRoot, normalizeRepoRelativePath(repositoryPath)))),
      listFiles: (repositoryDirectory, { recursive = true } = {}) => settle(() => {
        const directory = path.join(repoRoot, normalizeRepoRelativePath(repositoryDirectory));
        if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
          return [];
        }
        return listWorkingTreeFiles(directory, repoRoot, recursive);
      }),
      // Git's rule for recording 100755: the owner execute bit of a regular
      // file. `lstat` keeps symlinks non-executable; absent paths are false.
      // Windows has no execute bit, so nothing there is executable.
      isExecutable: (repositoryPath) => settle(() => {
        if (process.platform === 'win32') {
          return false;
        }
        const stats = fs.lstatSync(path.join(repoRoot, normalizeRepoRelativePath(repositoryPath)), {
          throwIfNoEntry: false
        });
        // eslint-disable-next-line no-bitwise -- POSIX permission bits
        return stats?.isFile() === true && (stats.mode & 0o100) !== 0;
      })
    };
  }

  public readRemoteUrl(repoRoot: string): Promise<string> {
    const result = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot, encoding: 'utf8' });
    return Promise.resolve(result.status === 0 ? result.stdout.trim() : '');
  }
}
