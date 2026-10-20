import {
  mkdir,
  mkdtemp,
  readFile,
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
} from '../src/commands/collection-validate';
import {
  HubValidateCommand,
} from '../src/commands/hub';
import {
  SkillValidateCommand,
} from '../src/commands/skill-validate';
import {
  createTestContext,
  runCli,
} from '../src/framework';

describe('existing validation commands with governance enabled', () => {
  let workspace: string;
  const run = async (args: string[]) => {
    const ctx = createTestContext({ cwd: workspace, fs: new NodeFileSystem(), env: {} });
    const exitCode = await runCli([...args, '--governance'], { ctx, commands: [],
      commandClasses: [HubValidateCommand, CollectionValidateCommand, SkillValidateCommand], defaultOutput: 'json' });
    return { exitCode, stdout: ctx.stdout.captured(), stderr: ctx.stderr.captured() };
  };

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'governance-'));
    await writeFile(path.join(workspace, 'hub-config.yml'), `version: 1.0.0
metadata:
  name: Offline Hub
  description: A test hub
  maintainer: test
  updatedAt: '2026-01-01T00:00:00Z'
sources:
  - id: unavailable
    name: Unavailable Source
    type: github
    url: https://github.com/test/nonexistent-repository
    enabled: true
    priority: 0
profiles: []
`);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('validates an inaccessible source offline and writes the same provider report', async () => {
    const result = await run(['hub', 'validate', '--output', 'json', '--report-path', 'report.md']);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout).data;
    expect(report).toMatchObject({ schemaVersion: 1, subject: 'hub', verdict: 'pass', score: 100, mode: 'offline' });
    expect(report.findings).toEqual([]);
    expect(await readFile(path.join(workspace, 'report.md'), 'utf8')).toContain('<!-- hub-validation-report -->');
    expect(result.stderr).toBe('');
  });

  it('reports malformed YAML as a failing structured verdict', async () => {
    await writeFile(path.join(workspace, 'hub-config.yml'), 'sources: [');
    const result = await run(['hub', 'validate', '--output', 'json']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).data).toMatchObject({ verdict: 'fail', findings: [expect.objectContaining({ ruleId: 'HUB001', severity: 'error' })] });
  });

  it.each([
    'rules:\n  HUB001:\n    enabled: false\n',
    'rules:\n  HUB001:\n    severity: warning\n',
    'rules:\n  TYPO001:\n    enabled: false\n',
    'rules:\n  toString:\n    enabled: false\n',
    'minScore: 101\n',
    'unexpected: true\n',
    'rules: [\n'
  ])('fails closed for invalid governance policy: %s', async (policy) => {
    await writeFile(path.join(workspace, 'policy.yml'), policy);
    const result = await run(['hub', 'validate', '--output', 'json', '--policy', 'policy.yml']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).data.findings).toContainEqual(expect.objectContaining({ ruleId: expect.stringMatching(/^CFG00[1-4]$/), severity: 'error' }));
  });

  it('does not silently ignore an explicitly requested missing policy', async () => {
    const result = await run(['hub', 'validate', '--output', 'json', '--policy', 'missing.yml']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).data.findings[0].ruleId).toBe('CFG001');
  });

  it('never lets a low score threshold override validation errors', async () => {
    await writeFile(path.join(workspace, 'hub-config.yml'), '{}');
    const result = await run(['hub', 'validate', '--output', 'json', '--min-score', '0']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).data.verdict).toBe('fail');
  });

  it('reports missing collection directories instead of passing vacuously', async () => {
    const result = await run(['collection', 'validate', '--output', 'json']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).data.findings[0].ruleId).toBe('COL005');
  });

  it('delegates collection validation and exposes explicit suppressions', async () => {
    await mkdir(path.join(workspace, 'collections'));
    await mkdir(path.join(workspace, 'prompts'));
    await writeFile(path.join(workspace, 'prompts/test.prompt.md'), 'Test prompt');
    await writeFile(path.join(workspace, 'collections/test.collection.yml'), `id: test
name: Test
author: test
items:
  - path: prompts/test.prompt.md
    kind: prompt
`);
    const result = await run(['collection', 'validate', '--output', 'json']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data.score).toBe(97);
    const strict = await run(['collection', 'validate', '--output', 'json', '--min-score', '100']);
    expect(strict.exitCode).toBe(1);
    await writeFile(path.join(workspace, 'policy.yml'), 'rules:\n  COL006:\n    enabled: false\n    reason: README tracked separately\n');
    const suppressed = await run(['collection', 'validate', '--output', 'json', '--policy', 'policy.yml']);
    expect(suppressed.exitCode).toBe(0);
    expect(JSON.parse(suppressed.stdout).data).toMatchObject({ score: 100, suppressions: [expect.objectContaining({ ruleId: 'COL006', reason: 'README tracked separately' })] });
  });

  it('rejects unsupported subjects and deep-validation options', async () => {
    expect((await run(['primitive', 'validate'])).exitCode).not.toBe(0);
    expect((await run(['hub', 'validate', '--check-sources'])).exitCode).not.toBe(0);
    expect((await run(['hub', 'validate', '--output', 'xml'])).exitCode).not.toBe(0);
  });
});
