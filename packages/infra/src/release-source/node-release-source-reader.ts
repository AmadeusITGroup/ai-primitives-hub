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
 * `isExecutable` reports Git mode `100755` for a revision (from one
 * `git ls-tree` per opened tree) and the owner execute bit for the working
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

const runGit = (repoRoot: string, args: string[]): string => {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'buffer', maxBuffer: GIT_MAX_BUFFER_BYTES });
  if (result.error) {
    throw new Error(`Git command failed: git ${args.join(' ')}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8').trim() : '';
    throw new Error(`Git command failed: git ${args.join(' ')}${stderr ? `: ${stderr}` : ''}`);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : '';
};

const readGitBlob = (repoRoot: string, revision: string, repositoryPath: string): Buffer => {
  const normalizedPath = normalizeRepoRelativePath(repositoryPath);
  const result = spawnSync('git', ['show', `${revision}:${normalizedPath}`], {
    cwd: repoRoot,
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

const listGitTreeFiles = (repoRoot: string, revision: string, repositoryDirectory: string): string[] => {
  const normalizedDirectory = normalizeRepoRelativePath(repositoryDirectory);
  const output = normalizedDirectory === '.'
    ? runGit(repoRoot, ['ls-tree', '-r', '-z', '--name-only', revision])
    : runGit(repoRoot, ['ls-tree', '-r', '-z', '--name-only', revision, '--', normalizedDirectory]);
  return output
    .split('\0')
    .filter((entry): entry is string => entry.length > 0)
    .map((entry) => normalizeRepoRelativePath(entry))
    .filter((entry) => normalizedDirectory === '.' || entry === normalizedDirectory || entry.startsWith(`${normalizedDirectory}/`));
};

/** Git tree mode of an executable regular file. */
const GIT_EXECUTABLE_MODE = '100755';

/**
 * Read the Git mode of every file at a revision from one `git ls-tree` call.
 * Records are `<mode> SP <type> SP <oid> TAB <path>`, NUL-terminated
 * (`--format` needs Git 2.36+, so the default layout is parsed).
 * @param repoRoot - Repository root.
 * @param revision - Immutable commit id.
 * @returns Mode (`100644`, `100755`, `120000`, ...) keyed by normalized path.
 */
const readGitTreeModes = (repoRoot: string, revision: string): Map<string, string> => {
  const modes = new Map<string, string>();
  for (const record of runGit(repoRoot, ['ls-tree', '-r', '-z', revision]).split('\0')) {
    const tab = record.indexOf('\t');
    if (tab > 0) {
      const mode = record.slice(0, tab).split(' ')[0];
      modes.set(normalizeRepoRelativePath(record.slice(tab + 1)), mode);
    }
  }
  return modes;
};

const listWorkingTreeFiles = (directory: string, repoRoot: string): string[] => {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listWorkingTreeFiles(fullPath, repoRoot));
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
      const output = runGit(repoRoot, ['rev-parse', '--verify', `${revision}^{commit}`]);
      const commit = assertImmutableRevision(output.trim());
      // One `ls-tree` per opened revision, read on first use.
      let modes: Map<string, string> | undefined;
      return {
        revision: commit,
        readFile: (repositoryPath: string) => settle(() => readGitBlob(repoRoot, commit, repositoryPath)),
        listFiles: (repositoryDirectory: string) =>
          settle(() => listGitTreeFiles(repoRoot, commit, repositoryDirectory)),
        isExecutable: (repositoryPath: string) => settle(() => {
          modes ??= readGitTreeModes(repoRoot, commit);
          return modes.get(normalizeRepoRelativePath(repositoryPath)) === GIT_EXECUTABLE_MODE;
        })
      };
    });
  }

  public openWorkingTree(repoRoot: string): ReleaseSourceTree {
    return {
      readFile: (repositoryPath) => settle(() =>
        fs.readFileSync(path.join(repoRoot, normalizeRepoRelativePath(repositoryPath)))),
      listFiles: (repositoryDirectory) => settle(() => {
        const directory = path.join(repoRoot, normalizeRepoRelativePath(repositoryDirectory));
        if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
          return [];
        }
        return listWorkingTreeFiles(directory, repoRoot);
      }),
      // Git's rule for recording 100755: the owner execute bit. Windows has no
      // execute bit, so nothing there is executable.
      isExecutable: (repositoryPath) => settle(() => process.platform !== 'win32'
        // eslint-disable-next-line no-bitwise -- POSIX permission bits
        && (fs.statSync(path.join(repoRoot, normalizeRepoRelativePath(repositoryPath))).mode & 0o100) !== 0)
    };
  }

  public readRemoteUrl(repoRoot: string): Promise<string> {
    const result = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot, encoding: 'utf8' });
    return Promise.resolve(result.status === 0 ? result.stdout.trim() : '');
  }
}
