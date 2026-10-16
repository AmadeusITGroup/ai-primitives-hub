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
    ? runGit(repoRoot, ['ls-tree', '-r', '--name-only', revision])
    : runGit(repoRoot, ['ls-tree', '-r', '--name-only', revision, '--', normalizedDirectory]);
  return output
    .split('\n')
    .filter((entry): entry is string => entry.length > 0)
    .map((entry) => normalizeRepoRelativePath(entry))
    .filter((entry) => normalizedDirectory === '.' || entry === normalizedDirectory || entry.startsWith(`${normalizedDirectory}/`));
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
      return {
        revision: commit,
        readFile: (repositoryPath: string) => settle(() => readGitBlob(repoRoot, commit, repositoryPath)),
        listFiles: (repositoryDirectory: string) =>
          settle(() => listGitTreeFiles(repoRoot, commit, repositoryDirectory))
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
      })
    };
  }

  public readRemoteUrl(repoRoot: string): Promise<string> {
    const result = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot, encoding: 'utf8' });
    return Promise.resolve(result.status === 0 ? result.stdout.trim() : '');
  }
}
