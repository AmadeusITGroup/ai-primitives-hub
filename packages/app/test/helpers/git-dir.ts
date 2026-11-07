/**
 * A `.git` directory git accepts as a repository.
 *
 * Git reads a `.git` directory only when it holds `HEAD`, `objects` and
 * `refs`; the exclusion adapter applies the same rule.
 */
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import type {
  InMemoryFileSystem,
} from './in-memory-filesystem';

/**
 * Create `<workspace>/.git` with `HEAD`, `objects` and `refs` on disk.
 * @param workspace - Work tree root.
 */
export const makeGitDir = (workspace: string): void => {
  const gitDir = path.join(workspace, '.git');
  mkdirSync(path.join(gitDir, 'objects'), { recursive: true });
  mkdirSync(path.join(gitDir, 'refs'), { recursive: true });
  writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
};

/**
 * Seed `HEAD`, `objects` and `refs` below `gitDir` in memory: a file below
 * a directory makes it one in the in-memory filesystem.
 * @param fs - In-memory filesystem.
 * @param gitDir - The `.git` directory.
 */
export const seedGitDir = (fs: InMemoryFileSystem, gitDir: string): void => {
  fs.seed(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  fs.seed(path.join(gitDir, 'objects', 'info', 'packs'), '');
  fs.seed(path.join(gitDir, 'refs', 'heads', 'main'), `${'0'.repeat(40)}\n`);
};
