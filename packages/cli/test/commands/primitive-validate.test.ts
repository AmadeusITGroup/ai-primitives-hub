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
  PrimitiveValidateCommand,
} from '../../src/commands/primitive-validate';
import {
  createTestContext,
  runCli,
} from '../../src/framework';

describe('primitive validate', () => {
  let root: string;
  const run = async (args: string[]) => {
    const ctx = createTestContext({ cwd: root, fs: new NodeFileSystem(), env: {} });
    const exitCode = await runCli(['primitive', 'validate', ...args], {
      ctx, name: 'ai-primitives-hub', version: 'test', commands: [], commandClasses: [PrimitiveValidateCommand]
    });
    return { exitCode, stdout: ctx.stdout.captured(), stderr: ctx.stderr.captured() };
  };
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'cli-primitive-validate-'));
    await mkdir(path.join(root, 'skills/demo'), { recursive: true });
    await writeFile(path.join(root, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: A demo skill for tests.\n---\n');
    await writeFile(path.join(root, 'ask.prompt.md'), '---\ndescription: Ask a question\n---\nBody');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('passes valid primitives and reports the score', async () => {
    const result = await run(['skills', 'ask.prompt.md', '-o', 'json']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({ subject: 'primitive', verdict: 'pass', score: 100, findings: [] });
  });

  it('reports new primitive rules as warnings without failing', async () => {
    await writeFile(path.join(root, 'bad.agent.md'), 'no frontmatter');
    const result = await run(['bad.agent.md', '-o', 'json']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({ verdict: 'pass', score: 97, findings: [{ ruleId: 'AGT001', severity: 'warning' }] });
  });

  it('rejects an unknown --kind', async () => {
    const result = await run(['ask.prompt.md', '--kind', 'widget']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown --kind');
  });

  it('enforces --min-score', async () => {
    await writeFile(path.join(root, 'bad.agent.md'), 'no frontmatter');
    const result = await run(['bad.agent.md', '--min-score', '100', '-o', 'json']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).data.verdict).toBe('fail');
  });
});
