/**
 * Git helpers for tests that build real repositories.
 *
 * Run from a git hook or `git rebase --exec`, the inherited environment
 * carries `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and other
 * repository-location variables that would point git at the developer's
 * repository instead of the fixture. Every `GIT_*` variable is dropped.
 */
import {
  execFileSync,
} from 'node:child_process';
import * as path from 'node:path';

/**
 * Copy an environment without any `GIT_*` variable.
 * @param env - Environment to copy; defaults to the test process's.
 * @returns The environment with every `GIT_*` key removed.
 */
export const gitFixtureEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));

/**
 * Run git in a fixture directory with a fixed identity, no commit signing
 * and an environment scrubbed by {@link gitFixtureEnv}.
 * @param cwd - Fixture directory git runs in.
 * @param args - Git arguments after the identity options.
 */
export const runGit = (cwd: string, args: readonly string[]): void => {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: gitFixtureEnv(),
    stdio: 'ignore'
  });
};

/**
 * Create a git repository with one commit and a linked worktree of it.
 * @param baseDir - Existing directory both are created in.
 * @returns The main repository and the worktree directories.
 */
export const createRepositoryWithWorktree = (baseDir: string): { mainRepo: string; worktree: string } => {
  const mainRepo = path.join(baseDir, 'main');
  const worktree = path.join(baseDir, 'linked');
  execFileSync('git', ['init', '-q', mainRepo], { env: gitFixtureEnv(), stdio: 'ignore' });
  runGit(mainRepo, ['commit', '-q', '--allow-empty', '-m', 'init']);
  runGit(mainRepo, ['worktree', 'add', '-q', worktree]);
  return { mainRepo, worktree };
};
