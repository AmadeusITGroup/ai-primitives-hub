import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  evaluateGovernance,
  primitiveFindings,
} from '../../src/domain/governance';

describe('additional primitive checks v1', () => {
  it('handles empty frontmatter and keeps path safety mandatory', () => {
    expect(primitiveFindings('demo.agent.md', '---\n---\n')).toContainEqual(expect.objectContaining({ ruleId: 'BOD001' }));
    expect(evaluateGovernance('primitive', [], { rules: { PTH001: { enabled: false } } }).findings)
      .toContainEqual(expect.objectContaining({ ruleId: 'CFG003' }));
  });
  it.each([
    ['skills/demo/SKILL.md', 'name: demo\ndescription: A useful demo skill.'],
    ['demo.agent.md', 'description: Review code'],
    ['demo.prompt.md', 'description: Review code'],
    ['demo.instructions.md', 'applyTo: "**/*.ts"']
  ])('warns for a frontmatter-only primitive: %s', (file, metadata) => {
    expect(primitiveFindings(file, `---\n${metadata}\n---\n  \n<!-- placeholder -->`))
      .toContainEqual(expect.objectContaining({ ruleId: 'BOD001', severity: 'warning' }));
    expect(primitiveFindings(file, `---\n${metadata}\n---\nUseful instructions.`).some((f) => f.ruleId === 'BOD001')).toBe(false);
  });

  it.each([
    { command: 42 },
    { command: 'node', args: '--help' },
    { command: 'node', args: [42] },
    { command: 'node', url: 'https://example.invalid/mcp' },
    { url: 'file:///etc/passwd' },
    { url: 'not-a-url' },
    { url: 'https://example.invalid/mcp', type: 'stdio' },
    { command: 'node', type: 'http' },
    { command: 'node', type: 'unsupported' },
    { url: 'https://example.invalid/mcp', args: ['--local'] }
  ])('blocks invalid MCP transport structure: %j', (server) => {
    const findings = primitiveFindings('mcp.json', JSON.stringify({ servers: { test: server } }));
    expect(findings).toContainEqual(expect.objectContaining({ ruleId: 'MCP003', severity: 'error' }));
    expect(evaluateGovernance('primitive', findings).verdict).toBe('fail');
  });

  it('checks MCP input definitions and duplicate IDs', () => {
    const findings = primitiveFindings('mcp.json', JSON.stringify({
      servers: { test: { command: 'node' } },
      inputs: [{ id: 'key', type: 'promptString', description: 'Key' }, { id: 'key', type: 'pickString', description: 'Key', options: [] }, { type: 'bad' }]
    }));
    expect(findings.filter((f) => f.ruleId === 'MCP003').map((f) => f.message).join('\n')).toMatch(/duplicate/i);
    expect(findings.filter((f) => f.ruleId === 'MCP003').length).toBeGreaterThanOrEqual(3);
  });

  it('accepts supported stdio, HTTP and SSE configurations and input types', () => {
    expect(primitiveFindings('mcp.json', JSON.stringify({
      servers: {
        local: { type: 'stdio', command: 'node', args: ['server.js'] },
        remote: { type: 'http', url: 'https://example.invalid/mcp' },
        events: { type: 'sse', url: 'http://localhost:3000/sse' }
      },
      inputs: [
        { id: 'key', type: 'promptString', description: 'API key', password: true },
        { id: 'env', type: 'pickString', description: 'Environment', options: ['dev', { label: 'Prod', value: 'prod' }] },
        { id: 'value', type: 'command', command: 'extension.resolveValue' }
      ]
    }))).toEqual([]);
  });
});
