import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  evaluateGovernance,
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
  generateRuleCatalogue,
} from '../../src/governance/generate-catalogue';
import {
  loadGovernanceConfig,
  withDisplayPaths,
} from '../../src/governance/load-config';
import {
  renderGovernanceMarkdown,
} from '../../src/governance/report';
import {
  runGovernance,
} from '../../src/governance/run-governance';

const fs = new NodeFileSystem();
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'governance-config-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('governance configuration discovery', () => {
  it('uses defaults when hub-governance.yml is absent', async () => {
    expect(await loadGovernanceConfig(fs, root)).toEqual({ policy: {}, findings: [] });
  });

  it('discovers hub-governance.yml at the repository root', async () => {
    await writeFile(path.join(root, 'hub-governance.yml'), 'minScore: 90\n');
    expect(await loadGovernanceConfig(fs, root)).toEqual({ policy: { minScore: 90 }, findings: [], file: 'hub-governance.yml' });
  });

  it('reports a missing explicit file as CFG001', async () => {
    const loaded = await loadGovernanceConfig(fs, root, 'custom.yml');
    expect(loaded.findings).toEqual([expect.objectContaining({ ruleId: 'CFG001', file: 'custom.yml' })]);
  });
});

describe('display paths', () => {
  it('makes absolute paths repository-relative and hides paths outside the repository', () => {
    const findings = withDisplayPaths([
      { ruleId: 'COL002', severity: 'error', message: 'x', file: path.join(root, 'hub-config.yml') },
      { ruleId: 'COL002', severity: 'error', message: 'y', file: '/elsewhere/secret/runner.yml' },
      { ruleId: 'COL002', severity: 'error', message: 'z', file: 'source-id' }
    ], root);
    expect(findings.map((finding) => finding.file)).toEqual(['hub-config.yml', 'runner.yml', 'source-id']);
  });
});

describe('primitive subject', () => {
  it('validates a directory of mixed primitives and applies the discovered configuration', async () => {
    await mkdir(path.join(root, 'prims/skills/demo'), { recursive: true });
    await writeFile(path.join(root, 'prims/skills/demo/SKILL.md'), '---\nname: demo\ndescription: A demo skill for tests.\n---\nUseful instructions.');
    await writeFile(path.join(root, 'prims/review.agent.md'), '---\ntools: search\n---\nReview code.');
    await writeFile(path.join(root, 'prims/notes.md'), 'not a primitive');
    await writeFile(path.join(root, 'hub-governance.yml'), 'rules:\n  AGT001:\n    severity: error\n    reason: strict team\n');
    const report = await runGovernance(fs, { subject: 'primitive', repoRoot: root, primitivePaths: ['prims'] });
    expect(report).toMatchObject({
      subject: 'primitive', verdict: 'fail',
      suppressions: [{ ruleId: 'AGT001', action: 'severity: error', reason: 'strict team' }]
    });
    expect(report.findings.every((finding) => finding.file === 'prims/review.agent.md' && finding.severity === 'error')).toBe(true);
  });

  it('fails clearly for a file whose kind cannot be inferred', async () => {
    await writeFile(path.join(root, 'servers.json'), '{}');
    const report = await runGovernance(fs, { subject: 'primitive', repoRoot: root, primitivePaths: ['servers.json'] });
    expect(report.findings[0].message).toContain('--kind');
    const forced = await runGovernance(fs, { subject: 'primitive', repoRoot: root, primitivePaths: ['servers.json'], primitiveKind: 'mcp-server' });
    expect(forced.findings).toEqual([
      expect.objectContaining({ ruleId: 'MCP001', file: 'servers.json' }),
      expect.objectContaining({ ruleId: 'MCP003', severity: 'error', file: 'servers.json' })
    ]);
  });
});

describe('report', () => {
  it('lists every rule that applies with its result, marking offline network rules as not run', () => {
    const markdown = renderGovernanceMarkdown(evaluateGovernance('collection', []));
    for (const id of ['COL001', 'COL003', 'COL005', 'COL006']) {
      expect(markdown).toContain(`| ${id} |`);
    }
    expect(markdown).toMatch(/\| COL002 \| [^|]+ \| ⏭️ Not run/);
    expect(markdown).toContain('## ✅ Collection validation passed');
    expect(markdown).toContain('<details><summary>All checks: 4 passed, 0 failed, 2 not run</summary>');
  });

  it('lists each problem once with what it affects, and every check in the details', () => {
    const markdown = renderGovernanceMarkdown(evaluateGovernance('hub', [
      { ruleId: 'HUB001', severity: 'error', message: 'profile[1] references non-existent source: x', file: 'hub-config.yml' },
      { ruleId: 'COL004', severity: 'error', message: 'Collection ID shared', verified: true, hint: 'Rename the collection in one of the sources.' }
    ], {}, undefined, { mode: 'sources' }));
    expect(markdown).toContain('## ❌ Hub validation failed: 2 problems');
    expect(markdown).toContain('| # | Rule | Problem | Affected |');
    expect(markdown).toContain('| 1 | HUB001 | Profile&#91;1&#93; references non&#45;existent source: x | hub&#45;config&#46;yml |');
    expect(markdown).toContain('| 2 | COL004 | Collection ID shared | — |');
    expect(markdown).not.toContain('Rename the collection');
    expect(markdown).toMatch(/\| HUB001 \| [^|]+ \| ❌ Fail \(1 error\) \|/);
    // Each command reports its own level: a hub run has no primitive checks.
    expect(markdown).not.toContain('SKL001');
  });

  it('gives each unreadable source one row with its collection count, across rules', () => {
    const renamed = 'Source repository was renamed';
    const markdown = renderGovernanceMarkdown(evaluateGovernance('hub', [
      { ruleId: 'COL004', severity: 'error', verified: true, subject: { kind: 'collection', id: 'dup (a, b)' }, problem: 'The same collection ID is in more than one source', message: 'x' },
      { ruleId: 'COL002', severity: 'error', verified: false, subject: { kind: 'source', id: 'old' }, problem: renamed, message: 'x' },
      { ruleId: 'COL002', severity: 'error', verified: false, subject: { kind: 'collection', id: 'one', source: 'old' }, problem: renamed, message: 'x' },
      { ruleId: 'COL002', severity: 'error', verified: false, subject: { kind: 'collection', id: 'two', source: 'old' }, problem: renamed, message: 'x' },
      { ruleId: 'COL004', severity: 'error', verified: false, subject: { kind: 'source', id: 'old' }, problem: renamed, message: 'x' },
      { ruleId: 'COL002', severity: 'error', verified: false, subject: { kind: 'source', id: 'other' }, problem: renamed, message: 'x' },
      { ruleId: 'COL002', severity: 'error', verified: true, subject: { kind: 'collection', id: 'three', source: 'gh' }, problem: 'Collection has no published release', message: 'x' },
      { ruleId: 'COL002', severity: 'error', verified: true, subject: { kind: 'collection', id: 'four', source: 'gh' }, problem: 'Collection has no published release', message: 'x' }
    ], {}, undefined, { mode: 'sources' }));
    expect(markdown).toContain('## ❌ Hub validation failed: 4 problems');
    expect(markdown).toContain('| 1 | COL002, COL004 | Source repository was renamed | old (2 collections) |');
    expect(markdown).toContain('| 2 | COL002 | Source repository was renamed | other |');
    expect(markdown).toContain('| 3 | COL004 | The same collection ID is in more than one source | dup &#40;a, b&#41; |');
    expect(markdown).toContain('| 4 | COL002 | Collection has no published release | three, four |');
    expect(markdown).not.toContain('could not verify everything');
  });
});

describe('rule catalogue', () => {
  it('matches the committed docs/author-guide/rule-catalogue.md', async () => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    expect(await generateRuleCatalogue(fs, repoRoot, { check: true })).toBe(true);
  });
});
