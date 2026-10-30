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
} from '../src/commands/collection-validate';
import {
  SkillValidateCommand,
} from '../src/commands/skill-validate';
import {
  createTestContext,
  runCli,
} from '../src/framework';

describe('governance collection and skill public entry points', () => {
  let root: string;

  const run = async (args: string[]) => {
    const ctx = createTestContext({ cwd: root, fs: new NodeFileSystem(), env: {} });
    const exitCode = await runCli([...args, '--governance'], { ctx, commands: [],
      commandClasses: [CollectionValidateCommand, SkillValidateCommand], defaultOutput: 'json' });
    return { exitCode, output: JSON.parse(ctx.stdout.captured()) };
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'governance-subjects-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps repository uniqueness findings without double-counting their score', async () => {
    await mkdir(path.join(root, 'collections'));
    await writeFile(path.join(root, 'test.prompt.md'), 'Test prompt');
    for (const name of ['one', 'two']) {
      await writeFile(path.join(root, 'collections', `${name}.collection.yml`), `id: duplicate
name: ${name}
author: test
items:
  - path: test.prompt.md
    kind: prompt
`);
    }
    const result = await run(['collection', 'validate']);
    expect(result.exitCode).toBe(1);
    expect(result.output.data.findings.filter((finding: { ruleId: string }) => finding.ruleId === 'COL001')).toHaveLength(1);
    expect(result.output.data.score).toBe(84);
  });

  it('allows an explicit author-rule downgrade without downgrading structure checks', async () => {
    await mkdir(path.join(root, 'collections'));
    await writeFile(path.join(root, 'test.prompt.md'), 'Test prompt');
    await writeFile(path.join(root, 'collections', 'test.collection.yml'), `id: test
name: Test
items:
  - path: test.prompt.md
    kind: prompt
`);
    expect((await run(['collection', 'validate'])).exitCode).toBe(1);
    await writeFile(path.join(root, 'policy.yml'), 'rules:\n  COL003:\n    severity: warning\n');
    const result = await run(['collection', 'validate', '--policy', 'policy.yml']);
    expect(result.exitCode).toBe(0);
    expect(result.output.data.findings).toContainEqual(expect.objectContaining({ ruleId: 'COL003', severity: 'warning' }));
  });

  it('validates a skill through the existing specification validator', async () => {
    await mkdir(path.join(root, 'skills', 'test-skill'), { recursive: true });
    await writeFile(path.join(root, 'skills', 'test-skill', 'SKILL.md'), `---
name: test-skill
description: A useful test skill description.
---

# Test Skill
`);
    const result = await run(['skill', 'validate']);
    expect(result.exitCode).toBe(0);
    expect(result.output.data).toMatchObject({ subject: 'primitive', verdict: 'pass', score: 100 });
  });

  it('fails an empty skills directory instead of passing vacuously', async () => {
    const result = await run(['skill', 'validate']);
    expect(result.exitCode).toBe(1);
    expect(result.output.data.findings).toContainEqual(expect.objectContaining({ ruleId: 'SKL001' }));
  });

  it('returns actionable specification findings for invalid skill metadata', async () => {
    await mkdir(path.join(root, 'skills', 'test-skill'), { recursive: true });
    await writeFile(path.join(root, 'skills', 'test-skill', 'SKILL.md'), '# Missing metadata');
    const result = await run(['skill', 'validate']);
    expect(result.exitCode).toBe(1);
    expect(result.output.data.findings).toContainEqual(expect.objectContaining({ ruleId: 'SKL001', file: path.join('skills', 'test-skill', 'SKILL.md') }));
  });

  it('reports invalid thresholds as configuration findings', async () => {
    const result = await run(['skill', 'validate', '--min-score', 'not-a-number']);
    expect(result.exitCode).toBe(1);
    expect(result.output.data.findings).toContainEqual(expect.objectContaining({ ruleId: 'CFG004' }));
  });
});
