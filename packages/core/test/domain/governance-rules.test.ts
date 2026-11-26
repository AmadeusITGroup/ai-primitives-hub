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

  it('allows disabling a non-floor rule and lists the suppression', () => {
    const report = evaluateGovernance('collection', [{ ruleId: 'COL003', severity: 'error', message: 'no author' }],
      { rules: { COL003: { enabled: false, reason: 'legacy repo' } } });
    expect(report).toMatchObject({ verdict: 'pass', findings: [], suppressions: [{ ruleId: 'COL003', action: 'disabled', reason: 'legacy repo' }] });
  });
});

describe('not-checked network rules', () => {
  it('lists enabled network rules for offline runs without failing', () => {
    const report = evaluateGovernance('collection', [], { rules: { COL004: { enabled: false } } });
    expect(report).toMatchObject({ verdict: 'pass', notChecked: [{ ruleId: 'COL002' }] });
  });

  it('lists nothing when sources were checked', () => {
    expect(evaluateGovernance('hub', [], {}, { mode: 'sources' }).notChecked).toEqual([]);
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
      inputs: [{ id: 'token', type: 'promptString', description: 'Access token' }],
      servers: { gh: { command: 'npx', env: { GITHUB_TOKEN: '${input:token}' } } }
    }))).toEqual([]);
  });

  it('reports invalid agents, prompts and instructions as warnings', () => {
    expect(primitiveFindings('a.agent.md', '---\ntools: search\n---\nReview code.')).toEqual([
      expect.objectContaining({ ruleId: 'AGT001', severity: 'warning', message: expect.stringContaining('description') }),
      expect.objectContaining({ ruleId: 'AGT001', message: expect.stringContaining('tools') })
    ]);
    expect(ids(primitiveFindings('a.prompt.md', 'no frontmatter'))).toEqual(['PRM001']);
    expect(primitiveFindings('a.prompt.md', '---\ndescription: x\nmode: chat\n---\n')[0].message).toContain('mode');
    expect(primitiveFindings('a.instructions.md', '---\napplyTo: ../secrets/*\n---\n')[0]).toMatchObject({ ruleId: 'INS001' });
  });

  it('keeps skill findings as SKL001 errors, including folder/name mismatch', () => {
    expect(primitiveFindings('skills/other/SKILL.md', '---\nname: demo\ndescription: A demo skill for tests.\n---\nUseful instructions.'))
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
      expect.stringMatching(/^MCP002:.*API_KEY/),
      expect.stringMatching(/^MCP002:.*args/),
      expect.stringMatching(/^MCP001:.*input:auth/),
      expect.stringMatching(/^MCP003:.*noCommand/),
      expect.stringMatching(/^MCP003:.*leaky/)
    ]);
    expect(primitiveFindings('mcp.json', '{not json')).toEqual([
      expect.objectContaining({ ruleId: 'MCP003', severity: 'error', message: 'MCP configuration is not valid JSON or JSONC.' })
    ]);
  });

  it.each([
    ['mcpServers root with a header secret', 'mcp.json', JSON.stringify({ mcpServers: { gh: { url: 'https://example.com', headers: { Authorization: 'Bearer abc123' } } } }), undefined, ['MCP002']],
    ['non-string env values', 'mcp.json', JSON.stringify({ servers: { gh: { command: 'npx', env: { DEBUG: 1 } } } }), undefined, ['MCP003']],
    ['non-string header values', 'mcp.json', JSON.stringify({ servers: { gh: { url: 'https://example.com', headers: { X: true } } } }), undefined, ['MCP003']],
    ['an out-of-range URL port', 'mcp.json', JSON.stringify({ servers: { remote: { url: 'https://example.com:70000/mcp' } } }), undefined, ['MCP003']],
    ['a valid URL port', 'mcp.json', JSON.stringify({ servers: { remote: { url: 'https://example.com:8443/mcp' } } }), undefined, []],
    ['JSONC comments and trailing commas', 'mcp.json', '{\n  // local server\n  "servers": { "gh": { "command": "npx", }, },\n}', undefined, []],
    ['forced agent kind on a misnamed file', 'notes.md', '---\ndescription: Reviews code\n---\nBody', 'agent', ['AGT001']],
    ['forced prompt kind on a misnamed file', 'notes.md', '---\ndescription: Summarise\n---\nBody', 'prompt', ['PRM001']],
    ['forced instruction kind on a misnamed file', 'notes.md', '---\napplyTo: "**"\n---\nBody', 'instruction', ['INS001']],
    ['an empty prompt agent', 'a.prompt.md', '---\ndescription: Summarise\nagent: ""\n---\nBody', undefined, ['PRM001']],
    ['an absolute applyTo glob', 'a.instructions.md', '---\napplyTo: /etc/**\n---\nBody', undefined, ['INS001']],
    ['CRLF frontmatter', 'a.agent.md', '---\r\ndescription: Reviews code\r\n---\r\nBody', undefined, []]
  ] as const)('reports %s', (_label, file, content, kind, expected) => {
    expect(ids(primitiveFindings(file, content, kind))).toEqual(expected);
  });

  it('detects skills only from an exact SKILL.md name', () => {
    expect(['SKILL.md', 'skill.md', 'Skill.md'].map((file) => detectPrimitiveKind(file))).toEqual(['skill', undefined, undefined]);
  });

  it('flags literal secrets even when the value also contains a placeholder', () => {
    const findings = primitiveFindings('mcp.json', JSON.stringify({
      inputs: [{ id: 'token', type: 'promptString', description: 'Access token' }],
      servers: { gh: {
        command: 'npx',
        env: { MIXED: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789${env:X}', GITHUB_TOKEN: '${input:token}' },
        args: ['ghp_abcdefghijklmnopqrstuvwxyz0123456789${env:X}']
      } }
    }));
    expect(findings.map((f) => `${f.ruleId}:${f.message}`)).toEqual([
      expect.stringMatching(/^MCP002:.*MIXED/),
      expect.stringMatching(/^MCP002:.*args/)
    ]);
  });

  it.each([
    ['a __proto__ server', '{"servers":{"__proto__":{"command":"run","args":["${input:missing}"]}}}'],
    ['a cwd reference', '{"servers":{"local":{"command":"server","cwd":"${input:missing}"}}}']
  ])('reports undeclared inputs in %s', (_label, content) => {
    expect(primitiveFindings('mcp.json', content).map((f) => `${f.ruleId}:${f.message}`))
      .toContainEqual(expect.stringMatching(/^MCP001:.*input:missing/));
  });

  it('does not report credential-file paths as literal MCP secrets', () => {
    const content = JSON.stringify({ servers: { local: { command: 'server', args: ['--credentials-file', '~/.aws/credentials'] } } });
    expect(primitiveFindings('mcp.json', content)).toEqual([]);
  });

  it('ignores non-string command and url values when collecting input references', () => {
    const content = JSON.stringify({ servers: { odd: { command: { toString: null }, url: 42, args: ['${input:a}'] } } });
    expect(() => primitiveFindings('mcp.json', content)).not.toThrow();
    expect(primitiveFindings('mcp.json', content).map((f) => f.message)).toContainEqual(expect.stringContaining('input:a'));
  });

  it('uses the supplied folder name for a root-level SKILL.md', () => {
    const content = '---\nname: demo\ndescription: A demo skill for tests.\n---\nUseful instructions.';
    expect(primitiveFindings('SKILL.md', content, 'skill', 'demo')).toEqual([]);
    expect(primitiveFindings('skills/demo/SKILL.md', content)).toEqual([]);
  });

  it('reports new primitive rules as warnings so they do not fail the gate', () => {
    const report = evaluateGovernance('primitive', primitiveFindings('a.agent.md', '---\n---\nReview code.'));
    expect(report).toMatchObject({ verdict: 'pass' });
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
