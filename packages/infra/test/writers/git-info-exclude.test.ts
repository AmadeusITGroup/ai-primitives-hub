/**
 * Tests for infra/writers/git-info-exclude.ts.
 *
 * The exact `.git/info/exclude` bytes match the repository-scope writer
 * characterisation (repo-scope-writer.characterisation.test.ts), now
 * asserted against the adapter directly.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import type {
  RepositoryExclusion,
} from '@ai-primitives-hub/core';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  NodeFileSystem,
} from '../../src/fs/node-filesystem';
import {
  GitInfoExclude,
  NO_EXCLUSION,
} from '../../src/writers/git-info-exclude';
import {
  RepositoryScopeWriter,
} from '../../src/writers/repo-scope-writer';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';
import {
  createTempDir,
} from '../helpers/temp-dir';

const WORKSPACE_ROOT = '/workspace';
const EXCLUDE_PATH = '/workspace/.git/info/exclude';
const HEADER = '# Prompt Registry (local)';
const PATHS = [
  '/workspace/.github/prompts/x.prompt.md',
  '/workspace/.github/skills/foo/SKILL.md',
  '/workspace/.github/skills/foo/references/ref.md'
];

const readExclude = async (fs: InMemoryFileSystem): Promise<string | null> =>
  (await fs.exists(EXCLUDE_PATH)) ? fs.readFile(EXCLUDE_PATH) : null;

const setup = (seed?: string): { fs: InMemoryFileSystem; exclusion: GitInfoExclude } => {
  const fs = new InMemoryFileSystem();
  // A file below `.git` makes it a directory in the in-memory filesystem.
  fs.seed('/workspace/.git/HEAD', 'ref: refs/heads/main\n');
  if (seed !== undefined) {
    fs.seed(EXCLUDE_PATH, seed);
  }
  return { fs, exclusion: new GitInfoExclude({ fs, workspaceRoot: WORKSPACE_ROOT }) };
};

describe('GitInfoExclude', () => {
  it('creates the file with the section header and the relative paths', async () => {
    const { fs, exclusion } = setup();
    await exclusion.add(PATHS);
    expect(await readExclude(fs)).toBe(
      `${HEADER}\n.github/prompts/x.prompt.md\n.github/skills/foo/SKILL.md\n.github/skills/foo/references/ref.md`
    );
  });

  it('keeps the header when every path is removed again', async () => {
    const { fs, exclusion } = setup();
    await exclusion.add(PATHS);
    await exclusion.remove(PATHS);
    expect(await readExclude(fs)).toBe(HEADER);
  });

  it('appends a section to an existing file without the header', async () => {
    const { fs, exclusion } = setup('node_modules\n');
    await exclusion.add(PATHS);
    expect(await readExclude(fs)).toBe(
      `node_modules\n\n${HEADER}\n.github/skills/foo/references/ref.md\n.github/skills/foo/SKILL.md\n.github/prompts/x.prompt.md`
    );
  });

  it('inserts below an existing header, keeping earlier entries', async () => {
    const { fs, exclusion } = setup(`node_modules\n${HEADER}\n.github/prompts/old.prompt.md\n`);
    await exclusion.add(PATHS);
    expect(await readExclude(fs)).toBe(
      `node_modules\n${HEADER}\n.github/skills/foo/references/ref.md\n.github/skills/foo/SKILL.md\n`
      + '.github/prompts/x.prompt.md\n.github/prompts/old.prompt.md\n'
    );
  });

  it('does not list a path twice', async () => {
    const { fs, exclusion } = setup();
    await exclusion.add(PATHS.slice(0, 1));
    await exclusion.add(PATHS.slice(0, 1));
    expect(await readExclude(fs)).toBe(`${HEADER}\n.github/prompts/x.prompt.md`);
  });

  it('creates the header for an empty add', async () => {
    const { fs, exclusion } = setup();
    await exclusion.add([]);
    expect(await readExclude(fs)).toBe(HEADER);
  });

  it('leaves a missing file or a file without the header untouched on remove', async () => {
    const missing = setup();
    await missing.exclusion.remove(PATHS);
    expect(await readExclude(missing.fs)).toBeNull();

    const noHeader = setup('node_modules\n.github/prompts/x.prompt.md\n');
    await noHeader.exclusion.remove(PATHS);
    expect(await readExclude(noHeader.fs)).toBe('node_modules\n.github/prompts/x.prompt.md\n');
  });
});

describe('GitInfoExclude exclude file resolution', () => {
  let tmp: string;
  let cleanup: () => void;

  beforeEach(() => {
    [tmp, cleanup] = createTempDir('git-info-exclude-');
  });

  afterEach(() => {
    cleanup();
  });

  const write = (file: string, text: string): void => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };

  it('uses the exclude file of a plain repository', async () => {
    const workspace = path.join(tmp, 'repo');
    write(path.join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const exclusion = new GitInfoExclude({ fs: new NodeFileSystem(), workspaceRoot: workspace });

    expect(await exclusion.isAvailable()).toBe(true);
    await exclusion.add([path.join(workspace, '.github', 'prompts', 'x.prompt.md')]);

    expect(readFileSync(path.join(workspace, '.git', 'info', 'exclude'), 'utf8'))
      .toBe(`${HEADER}\n.github/prompts/x.prompt.md`);
  });

  it('uses the main repository exclude file from a linked worktree, with worktree-relative lines', async () => {
    const main = path.join(tmp, 'main');
    const gitDir = path.join(main, '.git', 'worktrees', 'w');
    write(path.join(gitDir, 'HEAD'), 'ref: refs/heads/feature\n');
    write(path.join(gitDir, 'commondir'), '../..\n');
    const worktree = path.join(tmp, 'w');
    write(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);
    const exclusion = new GitInfoExclude({ fs: new NodeFileSystem(), workspaceRoot: worktree });

    expect(await exclusion.isAvailable()).toBe(true);
    const file = path.join(worktree, '.github', 'prompts', 'x.prompt.md');
    await exclusion.add([file]);

    const mainExclude = path.join(main, '.git', 'info', 'exclude');
    expect(readFileSync(mainExclude, 'utf8')).toBe(`${HEADER}\n.github/prompts/x.prompt.md`);
    expect(existsSync(path.join(gitDir, 'info'))).toBe(false);

    await exclusion.remove([file]);
    expect(readFileSync(mainExclude, 'utf8')).toBe(HEADER);
  });

  it('uses the module exclude file from a submodule', async () => {
    const superproject = path.join(tmp, 'super');
    const moduleDir = path.join(superproject, '.git', 'modules', 'sub');
    write(path.join(moduleDir, 'HEAD'), 'ref: refs/heads/main\n');
    const submodule = path.join(superproject, 'sub');
    write(path.join(submodule, '.git'), 'gitdir: ../.git/modules/sub\n');
    const exclusion = new GitInfoExclude({ fs: new NodeFileSystem(), workspaceRoot: submodule });

    expect(await exclusion.isAvailable()).toBe(true);
    await exclusion.add([path.join(submodule, '.github', 'skills', 'foo', 'SKILL.md')]);

    expect(readFileSync(path.join(moduleDir, 'info', 'exclude'), 'utf8'))
      .toBe(`${HEADER}\n.github/skills/foo/SKILL.md`);
    expect(existsSync(path.join(superproject, '.git', 'info'))).toBe(false);
  });

  it('is unavailable and never creates a .git outside a git repository', async () => {
    const workspace = path.join(tmp, 'plain');
    mkdirSync(workspace, { recursive: true });
    const exclusion = new GitInfoExclude({ fs: new NodeFileSystem(), workspaceRoot: workspace });

    expect(await exclusion.isAvailable()).toBe(false);
    await exclusion.add([path.join(workspace, '.github', 'prompts', 'x.prompt.md')]);
    await exclusion.remove([path.join(workspace, '.github', 'prompts', 'x.prompt.md')]);

    expect(existsSync(path.join(workspace, '.git'))).toBe(false);
  });

  it('is unavailable when .git is a file without a gitdir line', async () => {
    const workspace = path.join(tmp, 'odd');
    write(path.join(workspace, '.git'), 'not a git link\n');
    const exclusion = new GitInfoExclude({ fs: new NodeFileSystem(), workspaceRoot: workspace });

    expect(await exclusion.isAvailable()).toBe(false);
    await exclusion.add([path.join(workspace, '.github', 'prompts', 'x.prompt.md')]);

    expect(readFileSync(path.join(workspace, '.git'), 'utf8')).toBe('not a git link\n');
  });

  it('is unavailable and creates nothing when the gitdir link points to a missing directory', async () => {
    const gitDir = path.join(tmp, 'main', '.git', 'worktrees', 'pruned');
    const worktree = path.join(tmp, 'stale');
    write(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);
    const exclusion = new GitInfoExclude({ fs: new NodeFileSystem(), workspaceRoot: worktree });

    expect(await exclusion.isAvailable()).toBe(false);
    await exclusion.add([path.join(worktree, '.github', 'prompts', 'x.prompt.md')]);

    expect(existsSync(path.join(tmp, 'main'))).toBe(false);
  });

  it('is unavailable and creates nothing when the commondir names a missing directory', async () => {
    const gitDir = path.join(tmp, 'gone', '.git', 'worktrees', 'w');
    write(path.join(gitDir, 'HEAD'), 'ref: refs/heads/feature\n');
    write(path.join(gitDir, 'commondir'), '../../../moved/.git\n');
    const worktree = path.join(tmp, 'w');
    write(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);
    const exclusion = new GitInfoExclude({ fs: new NodeFileSystem(), workspaceRoot: worktree });

    expect(await exclusion.isAvailable()).toBe(false);
    await exclusion.add([path.join(worktree, '.github', 'prompts', 'x.prompt.md')]);

    expect(existsSync(path.join(tmp, 'gone', 'moved'))).toBe(false);
  });
});

describe('GitInfoExclude I/O failures on an existing exclude file', () => {
  class FailingWriteFileSystem extends InMemoryFileSystem {
    public override writeFile(): Promise<void> {
      return Promise.reject(new Error('EACCES: permission denied'));
    }
  }

  const existing = `node_modules\n${HEADER}\n.github/prompts/x.prompt.md`;

  const setupFailing = (): { fs: FailingWriteFileSystem; exclusion: GitInfoExclude } => {
    const fs = new FailingWriteFileSystem();
    fs.seed('/workspace/.git/HEAD', 'ref: refs/heads/main\n');
    fs.seed(EXCLUDE_PATH, existing);
    return { fs, exclusion: new GitInfoExclude({ fs, workspaceRoot: WORKSPACE_ROOT }) };
  };

  it('add rejects and keeps the file content', async () => {
    const { fs, exclusion } = setupFailing();
    await expect(exclusion.add(PATHS)).rejects.toThrow('EACCES');
    expect(await fs.readFile(EXCLUDE_PATH)).toBe(existing);
  });

  it('remove rejects and keeps the file content', async () => {
    const { fs, exclusion } = setupFailing();
    await expect(exclusion.remove(PATHS)).rejects.toThrow('EACCES');
    expect(await fs.readFile(EXCLUDE_PATH)).toBe(existing);
  });

  it('add never replaces an existing file it cannot read', async () => {
    class FailingReadFileSystem extends InMemoryFileSystem {
      public override readFile(): Promise<string> {
        return Promise.reject(new Error('EACCES: permission denied'));
      }
    }
    const fs = new FailingReadFileSystem();
    fs.seed('/workspace/.git/HEAD', 'ref: refs/heads/main\n');
    fs.seed(EXCLUDE_PATH, existing);
    const exclusion = new GitInfoExclude({ fs, workspaceRoot: WORKSPACE_ROOT });

    await expect(exclusion.add(PATHS)).rejects.toThrow('EACCES');
    expect(new TextDecoder().decode(await fs.readFileBytes(EXCLUDE_PATH))).toBe(existing);
  });
});

describe('NO_EXCLUSION', () => {
  it('is unavailable and changes nothing', async () => {
    expect(await NO_EXCLUSION.isAvailable?.()).toBe(false);
    await expect(NO_EXCLUSION.add(PATHS)).resolves.toBeUndefined();
    await expect(NO_EXCLUSION.remove(PATHS)).resolves.toBeUndefined();
  });
});

describe('RepositoryScopeWriter exclusion option', () => {
  const MANIFEST = `formatVersion: 1
id: small
version: 1.0.0
name: Small
items:
  - { path: prompts/x.prompt.md, kind: prompt, id: x.prompt }
`;
  const files = (): Map<string, Uint8Array> => new Map([
    ['deployment-manifest.yml', new TextEncoder().encode(MANIFEST)],
    ['prompts/x.prompt.md', new TextEncoder().encode('# Prompt\n')]
  ]);

  class RecordingExclusion implements RepositoryExclusion {
    public readonly added: string[][] = [];
    public readonly removed: string[][] = [];
    public add(paths: readonly string[]): Promise<void> {
      this.added.push([...paths]);
      return Promise.resolve();
    }

    public remove(paths: readonly string[]): Promise<void> {
      this.removed.push([...paths]);
      return Promise.resolve();
    }
  }

  it('sends written paths to the injected exclusion in local-only mode', async () => {
    const fs = new InMemoryFileSystem();
    const exclusion = new RecordingExclusion();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'local-only', exclusion });
    const result = await writer.write(files());
    await writer.rollback(result.written);
    // The writer joins paths with the platform's separator.
    const toPosix = (calls: string[][]): string[][] => calls.map((paths) => paths.map((p) => p.replaceAll('\\', '/')));
    expect(toPosix(exclusion.added)).toEqual([['/workspace/.github/prompts/x.prompt.md']]);
    expect(toPosix(exclusion.removed)).toEqual([['/workspace/.github/prompts/x.prompt.md']]);
    expect(await readExclude(fs)).toBeNull();
  });

  it('sends nothing to the injected exclusion in commit mode', async () => {
    const fs = new InMemoryFileSystem();
    const exclusion = new RecordingExclusion();
    const writer = new RepositoryScopeWriter({ fs, workspaceRoot: WORKSPACE_ROOT, commitMode: 'commit', exclusion });
    const result = await writer.write(files());
    await writer.rollback(result.written);
    expect(exclusion.added).toEqual([]);
    expect(exclusion.removed).toEqual([]);
  });
});
