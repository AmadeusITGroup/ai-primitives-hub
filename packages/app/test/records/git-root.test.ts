/**
 * Tests for app/records/git-root.ts (BR2.1, BR2.3, NFR4.6).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  LOCAL_RECORD_FILE_NAME,
} from '@ai-primitives-hub/core';
import {
  NodeRecordFs,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  ensureExcluded,
  EXCLUDE_SECTION_HEADER,
  findGitRoot,
  resolveExcludeDir,
  resolveRepositoryRoot,
} from '../../src/records/git-root';
import {
  FakeRecordFs,
} from './fake-record-fs';
import {
  createTempDir,
  makeGitDir,
} from './record-test-utils';

describe('git-root', () => {
  let base: string;
  let cleanup: () => void;
  const recordFs = new NodeRecordFs();

  beforeEach(() => {
    [base, cleanup] = createTempDir('git-root-');
  });

  afterEach(() => {
    cleanup();
  });

  describe('findGitRoot / resolveRepositoryRoot', () => {
    it('finds the nearest folder holding .git from a nested start folder', async () => {
      const repo = path.join(base, 'repo');
      makeGitDir(repo);
      fs.mkdirSync(path.join(repo, 'a', 'b', 'c'), { recursive: true });
      expect(await findGitRoot(recordFs, path.join(repo, 'a', 'b', 'c'))).toBe(repo);
      expect(await resolveRepositoryRoot(recordFs, path.join(repo, 'a'))).toBe(repo);
      expect(await findGitRoot(recordFs, repo)).toBe(repo);
    });

    it('stops at the nearest .git, so a nested repository wins over its parent', async () => {
      const outer = path.join(base, 'outer');
      makeGitDir(outer);
      const inner = path.join(outer, 'vendor', 'inner');
      fs.mkdirSync(inner, { recursive: true });
      fs.writeFileSync(path.join(inner, '.git'), 'gitdir: ../../.git/modules/inner\n');
      expect(await findGitRoot(recordFs, path.join(inner))).toBe(inner);
    });

    it('falls back to the start folder when no ancestor holds .git', async () => {
      const fake = new FakeRecordFs().addDir('/work/project/sub');
      const start = path.resolve('/work/project/sub');
      expect(await findGitRoot(fake, start)).toBeUndefined();
      expect(await resolveRepositoryRoot(fake, start)).toBe(start);
    });
  });

  describe('resolveExcludeDir', () => {
    it('uses a .git folder with HEAD', async () => {
      const repo = path.join(base, 'repo');
      const gitDir = makeGitDir(repo);
      expect(await resolveExcludeDir(recordFs, repo)).toEqual({ dir: gitDir });
    });

    it('refuses a .git folder without HEAD', async () => {
      const repo = path.join(base, 'repo');
      fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
      expect(await resolveExcludeDir(recordFs, repo)).toMatchObject({ warning: expect.stringContaining('does not look like a git directory') });
    });

    it('refuses a .git file without a gitdir line, and a root without .git', async () => {
      const repo = path.join(base, 'repo');
      fs.mkdirSync(repo);
      expect(await resolveExcludeDir(recordFs, repo)).toMatchObject({ warning: expect.stringContaining('no git directory') });
      fs.writeFileSync(path.join(repo, '.git'), 'not a pointer\n');
      expect(await resolveExcludeDir(recordFs, repo)).toMatchObject({ warning: expect.stringContaining('no "gitdir:" line') });
    });
  });

  describe('ensureExcluded', () => {
    it('adds the local-only record under the hub section in a normal repository, once', async () => {
      const repo = path.join(base, 'repo');
      const gitDir = makeGitDir(repo);
      const excludePath = path.join(gitDir, 'info', 'exclude');

      expect(await ensureExcluded(recordFs, repo, LOCAL_RECORD_FILE_NAME)).toEqual({ status: 'added', excludePath });
      expect(await ensureExcluded(recordFs, repo, LOCAL_RECORD_FILE_NAME)).toEqual({ status: 'present', excludePath });

      expect(fs.readFileSync(excludePath, 'utf8')).toBe(`${EXCLUDE_SECTION_HEADER}\n${LOCAL_RECORD_FILE_NAME}\n`);
    });

    it('appends after existing entries without a trailing newline and keeps them', async () => {
      const repo = path.join(base, 'repo');
      const gitDir = makeGitDir(repo);
      fs.mkdirSync(path.join(gitDir, 'info'));
      fs.writeFileSync(path.join(gitDir, 'info', 'exclude'), '# git ls-files --others --exclude-from=.git/info/exclude\n*.log');
      expect((await ensureExcluded(recordFs, repo, LOCAL_RECORD_FILE_NAME)).status).toBe('added');
      expect(fs.readFileSync(path.join(gitDir, 'info', 'exclude'), 'utf8')).toBe(
        `# git ls-files --others --exclude-from=.git/info/exclude\n*.log\n${EXCLUDE_SECTION_HEADER}\n${LOCAL_RECORD_FILE_NAME}\n`
      );
    });

    it('uses the same section header as the repository-scope writer and the extension', () => {
      expect(EXCLUDE_SECTION_HEADER).toBe('# Prompt Registry (local)');
    });

    it('adds the entry right below an existing section header, so the file keeps one section', async () => {
      const repo = path.join(base, 'repo');
      const gitDir = makeGitDir(repo);
      fs.mkdirSync(path.join(gitDir, 'info'));
      const excludePath = path.join(gitDir, 'info', 'exclude');
      fs.writeFileSync(excludePath, 'node_modules\n# Prompt Registry (local)\n.github/prompts/x.prompt.md\n\n# other tool\n*.tmp\n');

      expect(await ensureExcluded(recordFs, repo, LOCAL_RECORD_FILE_NAME)).toEqual({ status: 'added', excludePath });
      expect(await ensureExcluded(recordFs, repo, LOCAL_RECORD_FILE_NAME)).toEqual({ status: 'present', excludePath });

      const text = fs.readFileSync(excludePath, 'utf8');
      expect(text).toBe(
        `node_modules\n# Prompt Registry (local)\n${LOCAL_RECORD_FILE_NAME}\n.github/prompts/x.prompt.md\n\n# other tool\n*.tmp\n`
      );
      expect(text.split('\n').filter((line) => line === EXCLUDE_SECTION_HEADER)).toHaveLength(1);
      expect(fs.readdirSync(path.join(gitDir, 'info'))).toEqual(['exclude']);
    });

    it('treats a rooted entry as already present', async () => {
      const repo = path.join(base, 'repo');
      const gitDir = makeGitDir(repo);
      fs.mkdirSync(path.join(gitDir, 'info'));
      fs.writeFileSync(path.join(gitDir, 'info', 'exclude'), `/${LOCAL_RECORD_FILE_NAME}\n`);
      expect((await ensureExcluded(recordFs, repo, LOCAL_RECORD_FILE_NAME)).status).toBe('present');
    });

    it('writes to the common git directory for a worktree whose .git file has commondir', async () => {
      const main = path.join(base, 'main');
      const mainGit = makeGitDir(main);
      const worktreeGitDir = path.join(mainGit, 'worktrees', 'feature');
      fs.mkdirSync(worktreeGitDir, { recursive: true });
      fs.writeFileSync(path.join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/feature\n');
      fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
      const worktree = path.join(base, 'feature');
      fs.mkdirSync(worktree);
      fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${worktreeGitDir}\n`);

      const result = await ensureExcluded(recordFs, worktree, LOCAL_RECORD_FILE_NAME);

      expect(result).toEqual({ status: 'added', excludePath: path.join(mainGit, 'info', 'exclude') });
      expect(fs.readFileSync(path.join(mainGit, 'info', 'exclude'), 'utf8')).toContain(LOCAL_RECORD_FILE_NAME);
      expect(fs.existsSync(path.join(worktreeGitDir, 'info'))).toBe(false);
    });

    it('resolves a relative gitdir against the folder holding the .git file', async () => {
      const repo = path.join(base, 'repo');
      const realGit = path.join(base, 'elsewhere', 'repo.git');
      fs.mkdirSync(realGit, { recursive: true });
      fs.writeFileSync(path.join(realGit, 'HEAD'), 'ref: refs/heads/main\n');
      fs.mkdirSync(repo);
      fs.writeFileSync(path.join(repo, '.git'), 'gitdir: ../elsewhere/repo.git\n');
      expect(await ensureExcluded(recordFs, repo, LOCAL_RECORD_FILE_NAME)).toEqual({
        status: 'added',
        excludePath: path.join(realGit, 'info', 'exclude')
      });
    });

    it('writes nothing and warns when the .git file points at a plain folder', async () => {
      const repo = path.join(base, 'repo');
      const plain = path.join(base, 'plain');
      fs.mkdirSync(repo);
      fs.mkdirSync(plain);
      fs.writeFileSync(path.join(repo, '.git'), `gitdir: ${plain}\n`);

      const result = await ensureExcluded(recordFs, repo, LOCAL_RECORD_FILE_NAME);

      expect(result.status).toBe('skipped');
      expect(result.warning).toContain('does not look like a git directory');
      expect(fs.readdirSync(plain)).toEqual([]);
    });

    it('reports a write failure as a warning instead of throwing', async () => {
      const fake = new FakeRecordFs().addFile('/repo/.git/HEAD', 'ref: refs/heads/main\n');
      fake.appendFile = () => Promise.reject(new Error('disk full'));
      const result = await ensureExcluded(fake, path.resolve('/repo'), LOCAL_RECORD_FILE_NAME);
      expect(result.status).toBe('skipped');
      expect(result.warning).toContain('disk full');
    });
  });
});
