/**
 * Tests for app/install/recorded-commit-mode.ts (`switchRecordedCommitMode`).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  RepositoryExclusion,
  Target,
} from '@ai-primitives-hub/core';
import {
  GitInfoExclude,
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  switchRecordedCommitMode,
} from '../../src/install/recorded-commit-mode';
import {
  createTargetWriterFactory,
} from '../../src/install/target-writer-factory';
import type {
  InstallRecord,
} from '../../src/stores/install-record-store';
import type {
  RepositoryCommitMode,
} from '../../src/stores/json-lockfile-store';
import {
  makeGitDir,
} from '../helpers/git-dir';

const HEADER = '# Prompt Registry (local)';

describe('switchRecordedCommitMode', () => {
  const nodeFs = new NodeFileSystem();
  let tmp: string;
  let ws: string;
  let excludeFile: string;
  let target: Target;
  let writerFactory: ReturnType<typeof createTargetWriterFactory>;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'switch-commit-mode-'));
    ws = path.join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    excludeFile = path.join(ws, '.git', 'info', 'exclude');
    target = { name: 'v', type: 'vscode', scope: 'repository', rootPath: ws, commitMode: 'commit' };
    writerFactory = createTargetWriterFactory({
      fs: nodeFs, env: { HOME: path.join(tmp, 'home') }, projectDir: null, userConfigDir: null, writerOwnsExclusion: false
    });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * A record shaped like a CLI vscode repository install.
   * @param targetType
   * @param commitMode
   */
  const cliRecord = (targetType = 'vscode', commitMode: RepositoryCommitMode = 'commit'): InstallRecord => ({
    entry: {
      version: '1.0.0',
      sourceId: 'local-demo',
      sourceType: 'local',
      installedAt: '2026-01-01T00:00:00.000Z',
      targetType,
      files: [
        { path: 'plugins/demo-plugin/plugin.json', checksum: '0'.repeat(64) },
        { path: 'prompts/hello.prompt.md', checksum: '1'.repeat(64), installedPath: 'prompts/hello.prompt.md' },
        { path: 'skills/helper/SKILL.md', checksum: '2'.repeat(64) }
      ]
    },
    commitMode
  });
  const located = [
    '.github/plugins/demo-plugin/plugin.json',
    '.github/prompts/hello.prompt.md',
    '.github/skills/helper/SKILL.md'
  ];
  const initGit = (exclude?: string[]): void => {
    makeGitDir(ws);
    mkdirSync(path.dirname(excludeFile), { recursive: true });
    if (exclude !== undefined) {
      writeFileSync(excludeFile, exclude.join('\n'));
    }
  };
  const excludeLines = (): string[] => readFileSync(excludeFile, 'utf8').split('\n');
  const switchTo = (newMode: RepositoryCommitMode, overrides: { record?: InstallRecord; exclusion?: RepositoryExclusion } = {}) =>
    switchRecordedCommitMode({
      writerFactory,
      target: { ...target, commitMode: newMode },
      record: overrides.record ?? cliRecord('vscode', newMode === 'local-only' ? 'commit' : 'local-only'),
      exclusion: overrides.exclusion ?? new GitInfoExclude({ fs: nodeFs, workspaceRoot: ws }),
      newMode
    });

  it('excludes exactly the located paths on a switch to local-only', async () => {
    initGit(['*.log', HEADER, '.github/prompts/other.prompt.md']);

    const result = await switchTo('local-only');

    expect(result).toEqual({ exclusionSkipped: false, exclusionErrors: [] });
    const lines = excludeLines();
    expect(lines.slice(0, 2)).toEqual(['*.log', HEADER]);
    expect(lines.slice(2).toSorted()).toEqual([...located, '.github/prompts/other.prompt.md'].toSorted());
  });

  it('removes the located paths and their legacy ancestor directory lines on a switch to commit', async () => {
    initGit(['*.log', HEADER, '.github/skills/helper', ...located, '.github/prompts/other.prompt.md']);

    const result = await switchTo('commit');

    expect(result).toEqual({ exclusionSkipped: false, exclusionErrors: [] });
    expect(excludeLines()).toEqual(['*.log', HEADER, '.github/prompts/other.prompt.md']);
  });

  it('round-trips local-only then commit back to an empty section', async () => {
    initGit();

    await switchTo('local-only');
    await switchTo('commit');

    expect(excludeLines()).toEqual([HEADER]);
  });

  it('skips the exclusion outside a git repository and creates no .git', async () => {
    const result = await switchTo('local-only');

    expect(result).toEqual({ exclusionSkipped: true, exclusionErrors: [] });
    expect(existsSync(path.join(ws, '.git'))).toBe(false);
  });

  it('reports a record of an unknown target type as unresolvable and leaves the exclude file untouched', async () => {
    initGit([HEADER, '.github/skills/helper']);

    const result = await switchTo('commit', { record: cliRecord('emacs', 'local-only') });

    expect(result).toEqual({ exclusionSkipped: false, exclusionErrors: [], unresolvable: 'unknown target type "emacs"' });
    expect(excludeLines()).toEqual([HEADER, '.github/skills/helper']);
  });

  it('reports an exclusion failure without throwing', async () => {
    initGit();
    const failing: RepositoryExclusion = { add: () => Promise.reject(new Error('exclude unwritable')), remove: () => Promise.resolve() };

    const result = await switchTo('local-only', { exclusion: failing });

    expect(result).toEqual({ exclusionSkipped: false, exclusionErrors: ['exclude unwritable'] });
  });
});
