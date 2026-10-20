import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  COLLECTION_ID_PATTERN,
} from '../../src/domain/collection/validate';
import {
  detectPrimitiveKind,
  evaluateGovernance,
  FLOOR_RULE_IDS,
  GOVERNANCE_RULES,
  hubScopeLocationMapper,
  primitiveFindings,
  renderRuleCatalogue,
} from '../../src/domain/governance';
import collectionSchema from '../../src/public/schemas/collection.schema.json';

const ids = (findings: { ruleId: string }[]): string[] => findings.map((finding) => finding.ruleId);

describe('rule registry', () => {
  it('has unique ids and keeps COL001/COL002 on the floor', () => {
    expect(new Set(GOVERNANCE_RULES.map((rule) => rule.id)).size).toBe(GOVERNANCE_RULES.length);
    expect(FLOOR_RULE_IDS).toEqual(expect.arrayContaining(['COL001', 'COL002']));
    expect(FLOOR_RULE_IDS).not.toContain('COL003');
    expect(FLOOR_RULE_IDS).not.toContain('COL004');
  });

  it('renders a deterministic catalogue listing every rule', () => {
    const catalogue = renderRuleCatalogue(GOVERNANCE_RULES);
    expect(renderRuleCatalogue(GOVERNANCE_RULES)).toBe(catalogue);
    for (const rule of GOVERNANCE_RULES) {
      expect(catalogue).toContain(`| ${rule.id} |`);
    }
  });
});

describe('collection id pattern', () => {
  it('matches the pattern published in collection.schema.json', () => {
    expect(COLLECTION_ID_PATTERN.source).toBe(collectionSchema.properties.id.pattern);
  });
});

describe('configuration rules', () => {
  it('reports unknown and non-configurable rules as CFG002 and ignores the policy', () => {
    const report = evaluateGovernance('collection', [{ ruleId: 'COL006', severity: 'warning', message: 'advisory' }],
      { rules: { NOPE01: { enabled: false }, CFG001: { enabled: false }, COL006: { enabled: false } } });
    expect(ids(report.findings)).toEqual(['CFG002', 'CFG002', 'COL006']);
    expect(report.suppressions).toEqual([]);
  });

  it('reports floor overrides as CFG003', () => {
    const report = evaluateGovernance('collection', [], { rules: { COL001: { severity: 'warning' } } });
    expect(ids(report.findings)).toEqual(['CFG003']);
  });

  it('reports invalid policy and CLI scores as CFG004 and does not enforce them', () => {
    const report = evaluateGovernance('hub', [], { minScore: 150 }, Number.NaN);
    expect(ids(report.findings)).toEqual(['CFG004', 'CFG004']);
    expect(report.minScore).toBeUndefined();
  });

  it('allows disabling a non-floor rule and lists the suppression', () => {
    const report = evaluateGovernance('collection', [{ ruleId: 'COL003', severity: 'error', message: 'no author' }],
      { rules: { COL003: { enabled: false, reason: 'legacy repo' } } });
    expect(report).toMatchObject({ verdict: 'pass', findings: [], suppressions: [{ ruleId: 'COL003', action: 'disabled', reason: 'legacy repo' }] });
  });
});

describe('not-checked network rules', () => {
  it('lists enabled network rules for offline runs without score weight', () => {
    const report = evaluateGovernance('hub', [], { rules: { COL004: { enabled: false } } });
    expect(report).toMatchObject({ score: 100, verdict: 'pass', notChecked: [{ ruleId: 'COL002' }] });
  });

  it('lists nothing when sources were checked', () => {
    expect(evaluateGovernance('hub', [], {}, undefined, { mode: 'sources' }).notChecked).toEqual([]);
  });
});

describe('primitive rules', () => {
  it('infers the kind from the file name', () => {
    expect(['skills/a/SKILL.md', 'x.agent.md', 'x.prompt.md', 'x.instructions.md', '.vscode/mcp.json', 'a.mcp.json', 'README.md']
      .map((file) => detectPrimitiveKind(file))).toEqual(['skill', 'agent', 'prompt', 'instruction', 'mcp-server', 'mcp-server', undefined]);
  });

  it('accepts valid files of every kind', () => {
    expect(primitiveFindings('skills/demo/SKILL.md', '---\nname: demo\ndescription: A demo skill for tests.\n---\nBody')).toEqual([]);
    expect(primitiveFindings('a.agent.md', '---\ndescription: Reviews code\ntools: [search, edit]\n---\nBody')).toEqual([]);
    expect(primitiveFindings('a.prompt.md', '---\ndescription: Summarise\nmode: agent\n---\nBody')).toEqual([]);
    expect(primitiveFindings('a.instructions.md', '---\napplyTo: "**/*.ts, **/*.tsx"\n---\nBody')).toEqual([]);
    expect(primitiveFindings('mcp.json', JSON.stringify({
      inputs: [{ id: 'token', type: 'promptString' }],
      servers: { gh: { command: 'npx', env: { GITHUB_TOKEN: '${input:token}' } } }
    }))).toEqual([]);
  });

  it('reports invalid agents, prompts and instructions as warnings', () => {
    expect(primitiveFindings('a.agent.md', '---\ntools: search\n---\n')).toEqual([
      expect.objectContaining({ ruleId: 'AGT001', severity: 'warning', message: expect.stringContaining('description') }),
      expect.objectContaining({ ruleId: 'AGT001', message: expect.stringContaining('tools') })
    ]);
    expect(ids(primitiveFindings('a.prompt.md', 'no frontmatter'))).toEqual(['PRM001']);
    expect(primitiveFindings('a.prompt.md', '---\ndescription: x\nmode: chat\n---\n')[0].message).toContain('mode');
    expect(primitiveFindings('a.instructions.md', '---\napplyTo: ../secrets/*\n---\n')[0]).toMatchObject({ ruleId: 'INS001' });
  });

  it('keeps skill findings as SKL001 errors, including folder/name mismatch', () => {
    expect(primitiveFindings('skills/other/SKILL.md', '---\nname: demo\ndescription: A demo skill for tests.\n---\n'))
      .toEqual([expect.objectContaining({ ruleId: 'SKL001', severity: 'error', message: expect.stringContaining('does not match') })]);
  });

  it('flags MCP structure problems, undeclared inputs and literal secrets', () => {
    const findings = primitiveFindings('mcp.json', JSON.stringify({
      servers: {
        noCommand: {},
        leaky: { command: 'node', env: { API_KEY: 'abc123' }, headers: { Authorization: '${input:auth}' }, args: ['--token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'] }
      }
    }));
    expect(findings.map((f) => `${f.ruleId}:${f.message}`)).toEqual([
      expect.stringMatching(/^MCP001:.*noCommand.*command or a url/),
      expect.stringMatching(/^MCP002:.*API_KEY/),
      expect.stringMatching(/^MCP002:.*args/),
      expect.stringMatching(/^MCP001:.*input:auth/)
    ]);
    expect(ids(primitiveFindings('mcp.json', '{not json'))).toEqual(['MCP001']);
  });

  it('scores new primitive rules as warnings so they do not fail the gate', () => {
    const report = evaluateGovernance('primitive', primitiveFindings('a.agent.md', '---\n---\n'));
    expect(report).toMatchObject({ verdict: 'pass', score: 97 });
  });
});

describe('scoped location mapping', () => {
  it('maps projected source, profile and bundle indexes to the real hub configuration', () => {
    const keep = { source: 'b', id: 'x', version: '1.0.0' };
    const head = {
      sources: [{ id: 'a' }, { id: 'b' }],
      profiles: [{ id: 'old', bundles: [] }, { id: 'new', bundles: [{ source: 'a', id: 'y', version: '1.0.0' }, keep] }]
    };
    const projected = { sources: [head.sources[1]], profiles: [{ id: 'new', bundles: [keep] }] };
    const map = hubScopeLocationMapper(projected, head);
    expect(map('/profiles/0: missing required property')).toBe('/profiles/1: missing required property');
    expect(map('/profiles/0/bundles/0: bad')).toBe('/profiles/1/bundles/1: bad');
    expect(map('profile[0].bundle[0] references non-existent source: z')).toBe('profile[1].bundle[1] references non-existent source: z');
    expect(map('source[0].type is required; /sources/0')).toBe('source[1].type is required; /sources/1');
    expect(map("Profile 'new' bundle #1 must reference")).toBe("Profile 'new' bundle #2 must reference");
  });
});
