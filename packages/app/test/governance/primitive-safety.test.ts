import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
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
  vi,
} from 'vitest';
import {
  renderGovernanceMarkdown,
} from '../../src/governance/report';
import {
  runGovernance,
} from '../../src/governance/run-governance';

describe('primitive safety and applicability v1', () => {
  let root: string;
  let outside: string;
  const fs = new NodeFileSystem();
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'primitive-safety-'));
    outside = await mkdtemp(path.join(os.tmpdir(), 'primitive-outside-'));
    await writeFile(path.join(outside, 'secret.prompt.md'), 'Do not read');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const run = (inputs: string[]) => runGovernance(fs, { subject: 'primitive', repoRoot: root, primitivePaths: inputs });

  it('rejects explicit paths outside the root before reading content', async () => {
    const read = vi.spyOn(fs, 'readFile');
    const report = await run([path.join(outside, 'secret.prompt.md')]);
    expect(report.verdict).toBe('fail');
    expect(report.findings).toContainEqual(expect.objectContaining({ ruleId: 'PTH001', severity: 'error' }));
    expect(read).not.toHaveBeenCalledWith(path.join(outside, 'secret.prompt.md'));
  });

  it('rejects file and directory symlink escapes during recursive validation', async () => {
    await mkdir(path.join(root, 'primitives'));
    await symlink(path.join(outside, 'secret.prompt.md'), path.join(root, 'primitives/link.prompt.md'));
    await symlink(outside, path.join(root, 'primitives/external'));
    const report = await run(['primitives']);
    expect(report.findings.filter((f) => f.ruleId === 'PTH001')).toHaveLength(2);
    expect(report.findings.some((f) => f.ruleId === 'PRM001')).toBe(false);
  });

  it('allows contained symlinks, avoids loops, and deduplicates canonical files', async () => {
    await mkdir(path.join(root, 'primitives'));
    await writeFile(path.join(root, 'primitives/test.prompt.md'), '---\ndescription: Test\n---\nReview code.');
    await symlink(root, path.join(root, 'primitives/loop'));
    await symlink(path.join(root, 'primitives/test.prompt.md'), path.join(root, 'alias.prompt.md'));
    const report = await run(['.']);
    expect(report.verdict).toBe('pass');
    expect(report.findings).toEqual([]);
  });

  it('fails closed for missing files and unavailable realpath support', async () => {
    expect((await run(['missing.prompt.md'])).findings).toContainEqual(expect.objectContaining({ ruleId: 'PTH001' }));
    await writeFile(path.join(root, 'a.prompt.md'), 'Body');
    const unsupported = Object.create(fs) as NodeFileSystem;
    Object.defineProperty(unsupported, 'realpath', { value: undefined });
    const report = await runGovernance(unsupported, { subject: 'primitive', repoRoot: root, primitivePaths: ['a.prompt.md'] });
    expect(report.findings).toContainEqual(expect.objectContaining({ ruleId: 'PTH001', verified: false }));
  });

  it('marks rules for uninspected kinds not applicable, including forced MCP filenames', async () => {
    await writeFile(path.join(root, 'a.prompt.md'), '---\ndescription: Test\n---\nReview code.');
    const report = await run(['a.prompt.md']);
    const markdown = renderGovernanceMarkdown(report);
    expect(markdown).toContain('| MCP001 |');
    expect(markdown).toMatch(/\| MCP001 \| [^|]+ \| — Not applicable \|/);
    expect(markdown).toMatch(/\| PRM001 \| [^|]+ \| ✅ Pass \|/);
    expect(markdown).toContain('not applicable');
    await writeFile(path.join(root, 'servers.json'), '{"servers":{"test":{"command":"node"}}}');
    const forced = await runGovernance(fs, { subject: 'primitive', repoRoot: root, primitivePaths: ['servers.json'], primitiveKind: 'mcp-server' });
    expect(renderGovernanceMarkdown(forced)).toMatch(/\| MCP001 \| [^|]+ \| ✅ Pass \|/);
    expect(renderGovernanceMarkdown(forced)).toMatch(/\| BOD001 \| [^|]+ \| — Not applicable \|/);
  });
});
