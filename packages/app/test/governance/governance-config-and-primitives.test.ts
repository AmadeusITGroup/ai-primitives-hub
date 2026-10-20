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
    await writeFile(path.join(root, 'prims/skills/demo/SKILL.md'), '---\nname: demo\ndescription: A demo skill for tests.\n---\n');
    await writeFile(path.join(root, 'prims/review.agent.md'), '---\ntools: search\n---\n');
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
    expect(forced.findings).toEqual([expect.objectContaining({ ruleId: 'MCP001', file: 'servers.json' })]);
  });
});

describe('report', () => {
  it('lists every rule that applies with its result, marking offline network rules as not run', () => {
    const markdown = renderGovernanceMarkdown(evaluateGovernance('collection', []));
    for (const id of ['COL001', 'COL003', 'COL005', 'COL006']) {
      expect(markdown).toContain(`| ${id} |`);
    }
    expect(markdown).toMatch(/\| COL002 \| [^|]+ \| ⏭️ Not run/);
    expect(markdown).toContain('### Collection validation: ✅ PASS');
  });

  it('highlights failures with the exact error text per level', () => {
    const markdown = renderGovernanceMarkdown(evaluateGovernance('hub', [
      { ruleId: 'HUB001', severity: 'error', message: 'profile[1] references non-existent source: x', file: 'hub-config.yml' },
      { ruleId: 'COL004', severity: 'error', message: 'Collection ID shared', verified: true, hint: 'Rename the collection in one of the sources.' }
    ], {}, undefined, { mode: 'sources' }));
    expect(markdown).toContain('### Hub validation: ❌ FAIL (1 rule failed)');
    expect(markdown).toMatch(/\| HUB001 \| [^|]+ \| ❌ Fail \(1 error\) \|/);
    expect(markdown).toContain('**Errors (1)**');
    expect(markdown).toContain('- ❌ **HUB001** · hub&#45;config&#46;yml\n  - **Rule:** Hub syntax, schema, references and source policies\n'
      + '  - **What failed:** profile&#91;1&#93; references non&#45;existent source: x');
    expect(markdown).toContain('  - **How to fix:** Rename the collection in one of the sources');
    // Each command reports its own level: a hub run has no primitive section.
    expect(markdown).toContain('### Hub-wide collection checks: ❌ FAIL (1 rule failed)');
    expect(markdown).not.toContain('Primitive validation');
  });
});

describe('rule catalogue', () => {
  it('matches the committed docs/author-guide/rule-catalogue.md', async () => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    expect(await generateRuleCatalogue(fs, repoRoot, { check: true })).toBe(true);
  });
});
