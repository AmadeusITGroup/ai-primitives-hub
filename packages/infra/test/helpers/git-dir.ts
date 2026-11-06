/**
 * A `.git` directory git accepts as a repository, for in-memory tests.
 *
 * Git reads a `.git` directory only when it holds `HEAD`, `objects` and
 * `refs`. A file below a directory makes it one in the in-memory filesystem.
 */
import * as path from 'node:path';
import type {
  InMemoryFileSystem,
} from './in-memory-filesystem';

/**
 * Seed `HEAD`, `objects` and `refs` below `gitDir`.
 * @param fs - In-memory filesystem.
 * @param gitDir - The `.git` directory.
 */
export const seedGitDir = (fs: InMemoryFileSystem, gitDir: string): void => {
  fs.seed(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  fs.seed(path.join(gitDir, 'objects', 'info', 'packs'), '');
  fs.seed(path.join(gitDir, 'refs', 'heads', 'main'), `${'0'.repeat(40)}\n`);
};
