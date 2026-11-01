import {
  execFileSync,
} from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
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
  CollectionValidateCommand,
} from '../../src/commands/collection-validate';
import {
  PrimitiveValidateCommand,
} from '../../src/commands/primitive-validate';
import {
  createTestContext,
  runCli,
} from '../../src/framework';

describe('PR mode for collection and primitive validation', () => {
  let root: string;
  let base: string;
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = (message: string): string => {
    git('add', '-A');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const run = async (args: string[], cwd = root) => {
    const ctx = createTestContext({ cwd, fs: new NodeFileSystem(), env: {} });
    const exitCode = await runCli([...args, '-o', 'json'], {
      ctx, name: 'ai-primitives-hub', version: 'test', commands: [], commandClasses: [CollectionValidateCommand, PrimitiveValidateCommand]
    });
    return { exitCode, data: JSON.parse(ctx.stdout.captured() || '{}').data, stderr: ctx.stderr.captured() };
  };
  const collection = (id: string, author: string) =>
    `id: ${id}\nname: ${id}\ndescription: Test collection\nauthor: ${author}\nversion: 1.0.0\nitems:\n  - path: prompts/${id}.prompt.md\n    kind: prompt\n`;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'cli-pr-mode-'));
    git('init', '--quiet');
    git('config', 'user.name', 'PR Test');
    git('config', 'user.email', 'pr@example.invalid');
    await mkdir(path.join(root, 'collections'));
    await mkdir(path.join(root, 'prompts'));
    // Baseline: one collection with an empty author, which only a full run would report.
    await writeFile(path.join(root, 'collections/old.collection.yml'), collection('old', '""'));
    await writeFile(path.join(root, 'prompts/old.prompt.md'), '---\ndescription: Old\n---\n');
    await writeFile(path.join(root, 'prompts/legacy.prompt.md'), 'no frontmatter');
    base = commit('base');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('collection validate reports only collections the PR touched', async () => {
    await writeFile(path.join(root, 'collections/new.collection.yml'), collection('new', '""'));
    await writeFile(path.join(root, 'prompts/new.prompt.md'), '---\ndescription: New\n---\n');
    const head = commit('add collection');
    const result = await run(['collection', 'validate', '--base-ref', base, '--head-ref', head]);
    expect(result.exitCode).toBe(1);
    expect(result.data.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL003', file: 'collections/new.collection.yml' }));
    // The baseline collection's empty author is not reported: the PR did not touch it.
    expect(JSON.stringify(result.data.findings)).not.toContain('old.collection.yml');
    expect(result.data.prScope).toMatchObject({ validated: ['collections/new.collection.yml'] });
  });

  it('collection validate passes when the PR touches no collection', async () => {
    await writeFile(path.join(root, 'README.md'), 'docs');
    const head = commit('docs');
    const result = await run(['collection', 'validate', '--base-ref', base, '--head-ref', head]);
    expect(result).toMatchObject({ exitCode: 0, data: { verdict: 'pass', findings: [], prScope: { validated: [] } } });
  });

  it('collection validate accepts --root for a repository elsewhere', async () => {
    const result = await run(['collection', 'validate', '--governance', '--root', root], os.tmpdir());
    expect(result.data.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL003', file: 'collections/old.collection.yml' }));
  });

  it('primitive validate checks only changed primitives', async () => {
    await writeFile(path.join(root, 'prompts/broken.prompt.md'), 'no frontmatter');
    const head = commit('add prompt');
    const result = await run(['primitive', 'validate', '--base-ref', base, '--head-ref', head]);
    expect(result.data.findings.map((f: { file: string }) => f.file)).toEqual(['prompts/broken.prompt.md']);
    expect(result.data.prScope.validated).toEqual(['prompts/broken.prompt.md']);
  });

  it('refuses PR mode when the checkout is not at --head-ref', async () => {
    await writeFile(path.join(root, 'prompts/x.prompt.md'), 'x');
    const head = commit('head');
    git('checkout', '--quiet', base);
    const result = await run(['primitive', 'validate', '--base-ref', base, '--head-ref', head]);
    expect(result.exitCode).toBe(1);
    expect(result.data.findings[0].message).toContain('not at --head-ref');
  });

  it('requires a path outside PR mode', async () => {
    const result = await run(['primitive', 'validate']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--base-ref');
  });
});
