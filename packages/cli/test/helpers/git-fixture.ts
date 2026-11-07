/**
 * Git fixture helpers for tests that build real repositories.
 *
 * Tests spawn `git` to set up throwaway repositories. Run from a git hook
 * (pre-commit, pre-push) or a `git rebase --exec`, the inherited
 * environment carries `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
 * `GIT_OBJECT_DIRECTORY`, `GIT_COMMON_DIR`, `GIT_CONFIG_PARAMETERS` and
 * other repository-location variables, which point git at the
 * developer's repository instead of the fixture's `cwd`. Every `GIT_*`
 * variable is dropped, the same rule `buildDiagnosticEnv` in
 * `src/doctor/diagnostics.ts` applies to the doctor's child processes.
 */
import {
  execFileSync,
} from 'node:child_process';
import {
  mkdir,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Copy an environment without any `GIT_*` variable.
 * @param env - Environment to copy; defaults to the test process's.
 * @returns The environment with every `GIT_*` key removed.
 */
export const gitFixtureEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));

/**
 * Run git in a fixture directory with a fixed identity, no commit
 * signing and an environment scrubbed by {@link gitFixtureEnv}.
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
 * Create `<workspace>/.git` with the `HEAD`, `objects` and `refs` git
 * requires of a repository directory, without spawning git (so the
 * exclude file stays absent until an install creates it).
 * @param workspace - Work tree root.
 */
export const makeGitDir = async (workspace: string): Promise<void> => {
  const gitDir = path.join(workspace, '.git');
  await mkdir(path.join(gitDir, 'objects'), { recursive: true });
  await mkdir(path.join(gitDir, 'refs'), { recursive: true });
  await writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
};
