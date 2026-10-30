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
} from '../../src/commands/collection-validate';
import {
  HubValidateCommand,
} from '../../src/commands/hub';
import {
  SkillValidateCommand,
} from '../../src/commands/skill-validate';
import {
  runCommand,
} from '../../src/framework';

describe('governance through existing validation commands', () => {
  let root: string;
  const run = (args: string[]) => runCommand(args, {
    commandClasses: [HubValidateCommand, CollectionValidateCommand, SkillValidateCommand],
    context: { cwd: root, fs: new NodeFileSystem(), env: {} }
  });
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'validation-governance-'));
    await writeFile(path.join(root, 'hub-config.yml'), `version: 1.0.0
metadata:
  name: Test
  description: Test hub
  maintainer: test
  updatedAt: '2026-01-01T00:00:00Z'
sources: []
profiles: []
`);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('preserves the existing hub output when no governance flags are supplied', async () => {
    const result = await run(['hub', 'validate', '-o', 'json']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({ valid: true, errors: [], file: path.join(root, 'hub-config.yml') });
  });

  it('adds governance and reports to the registered hub validate command', async () => {
    const result = await run(['hub', 'validate', '--governance', '--report-path', 'report.md', '-o', 'json']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({ verdict: 'pass', score: 100, subject: 'hub' });
    expect(await readFile(path.join(root, 'report.md'), 'utf8')).toContain('<!-- hub-validation-report -->');
  });

  it('fails closed for a policy that disables mandatory hub validation', async () => {
    await writeFile(path.join(root, 'policy.yml'), 'rules:\n  HUB001:\n    enabled: false\n');
    const result = await run(['hub', 'validate', '--policy', 'policy.yml', '-o', 'json']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).data.findings).toContainEqual(expect.objectContaining({ ruleId: 'CFG003' }));
  });

  it('accepts explicit source verification through the governed hub command', async () => {
    const result = await run(['hub', 'validate', '--governance', '--check-sources', '-o', 'json']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({ mode: 'sources', verdict: 'pass' });
  });

  it('keeps legacy collection flags and adds governance through the same command', async () => {
    await mkdir(path.join(root, 'collections'));
    await writeFile(path.join(root, 'test.prompt.md'), 'Test prompt');
    await writeFile(path.join(root, 'collections/test.collection.yml'), 'id: test\nname: Test\nauthor: test\nitems:\n  - path: test.prompt.md\n    kind: prompt\n');
    const legacy = await run(['collection', 'validate', '--markdown-path', 'legacy.md', '-o', 'json']);
    expect(legacy.exitCode).toBe(0);
    expect(JSON.parse(legacy.stdout).data).toMatchObject({ ok: true, totalFiles: 1 });
    const governed = await run(['collection', 'validate', '--governance', '--min-score', '100', '--markdown-path', 'report.md', '-o', 'json']);
    expect(governed.exitCode).toBe(1);
    expect(JSON.parse(governed.stdout).data).toMatchObject({ verdict: 'fail', score: 97 });
    expect(await readFile(path.join(root, 'report.md'), 'utf8')).toContain('<!-- collection-validation-report -->');
  });

  it('retains legacy empty skill behavior but fails an empty governance gate', async () => {
    expect((await run(['skill', 'validate', '-o', 'json'])).exitCode).toBe(0);
    const result = await run(['skill', 'validate', '--governance', '-o', 'json']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).data.findings).toContainEqual(expect.objectContaining({ ruleId: 'SKL001' }));
  });

  it('writes both collection report destinations through the standard command', async () => {
    await mkdir(path.join(root, 'collections'));
    const result = await run(['collection', 'validate', '--governance', '--report-path', 'provider.md', '--markdown-path', 'compatible.md', '--output', 'json']);
    expect(result.exitCode).toBe(1);
    expect(await readFile(path.join(root, 'compatible.md'), 'utf8')).toBe(await readFile(path.join(root, 'provider.md'), 'utf8'));
  });

  it('fails cleanly when a governance report destination is not writable', async () => {
    const result = await run(['hub', 'validate', '--report-path', '.', '--output', 'json']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unable to write governance report');
    expect(JSON.parse(result.stdout).status).toBe('error');
  });
});
