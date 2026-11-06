import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GOVERNANCE_RULES,
} from '@ai-primitives-hub/core';
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
  ALL_COMMAND_CLASSES,
} from '../../src/commands/registry';
import {
  runCommand,
} from '../../src/framework';

describe('governance stack command boundary', () => {
  let root: string;
  const run = (args: string[]) => runCommand(args, {
    commandClasses: ALL_COMMAND_CLASSES,
    context: { cwd: root, fs: new NodeFileSystem(), env: {} }
  });
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'governance-stack-'));
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

  it('exposes all three stages without scoring or CFG004', () => {
    expect([...new Set(GOVERNANCE_RULES.map((rule) => rule.id.slice(0, 3)))].toSorted()).toEqual(['AGT', 'BOD', 'CFG', 'COL', 'HUB', 'INS', 'MCP', 'PRM', 'PTH', 'SKL']);
    expect(GOVERNANCE_RULES.some((rule) => rule.id === 'CFG004')).toBe(false);
  });

  it('validates through the registered hub command and writes the shared report', async () => {
    const result = await run(['hub', 'validate', '--governance', '--report-path', 'report.md', '-o', 'json']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({ subject: 'hub', verdict: 'pass' });
    expect(JSON.parse(result.stdout).data).not.toHaveProperty('score');
    expect(await readFile(path.join(root, 'report.md'), 'utf8')).toContain('<!-- hub-validation-report -->');
  });

  it('rejects attempts to disable the hub floor', async () => {
    await writeFile(path.join(root, 'policy.yml'), 'rules:\n  HUB001:\n    enabled: false\n');
    const result = await run(['hub', 'validate', '--policy', 'policy.yml', '-o', 'json']);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).data.findings).toContainEqual(expect.objectContaining({ ruleId: 'CFG003' }));
  });

  it('keeps hub and collection validation separate from primitives and legacy skill validation', async () => {
    const collection = await run(['collection', 'validate', '--governance', '-o', 'json']);
    expect(JSON.parse(collection.stdout).data).toMatchObject({ subject: 'collection' });
    await writeFile(path.join(root, 'test.prompt.md'), '---\ndescription: Test prompt\n---\nExplain the result.\n');
    const primitive = await run(['primitive', 'validate', 'test.prompt.md', '-o', 'json']);
    expect(primitive.exitCode).toBe(0);
    expect(JSON.parse(primitive.stdout).data).toMatchObject({ subject: 'primitive', verdict: 'pass' });
    expect(JSON.parse(primitive.stdout).data.applicableRules.some((id: string) => id.startsWith('COL') || id.startsWith('HUB'))).toBe(false);
    expect((await run(['skill', 'validate', '--governance'])).exitCode).not.toBe(0);
  });
});
