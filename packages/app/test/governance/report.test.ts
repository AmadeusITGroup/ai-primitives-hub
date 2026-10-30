import {
  evaluateGovernance,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  renderGovernanceMarkdown,
} from '../../src/governance/report';

describe('provider-owned governance Markdown report', () => {
  it('lists every contributing rule once when problems are grouped', () => {
    const markdown = renderGovernanceMarkdown(evaluateGovernance('collection', [
      { ruleId: 'COL004', severity: 'error', verified: false, subject: { kind: 'source', id: 'old' }, problem: 'Source repository was renamed', message: 'Unavailable' },
      { ruleId: 'COL002', severity: 'error', verified: false, subject: { kind: 'source', id: 'old' }, problem: 'Source repository was renamed', message: 'Unavailable' },
      { ruleId: 'COL004', severity: 'error', verified: false, subject: { kind: 'source', id: 'old' }, problem: 'Source repository was renamed', message: 'Unavailable' }
    ], {}, undefined, { mode: 'sources' }));
    expect(markdown).toContain('| # | Rule | Problem | Affected |');
    expect(markdown).toContain('| 1 | COL002, COL004 | Source repository was renamed | old |');
  });

  it('identifies rules in grouped warning rows', () => {
    const markdown = renderGovernanceMarkdown(evaluateGovernance('collection', [
      { ruleId: 'COL006', severity: 'warning', message: 'Review metadata', file: 'second' },
      { ruleId: 'COL003', severity: 'warning', message: 'Review metadata', file: 'first' }
    ]));
    expect(markdown).toContain('### Warnings (do not block)');
    expect(markdown).toContain('| 1 | COL003, COL006 | Review metadata | second, first |');
  });

  it('renders policy failures without displaying scores or numeric thresholds', () => {
    const report = evaluateGovernance('hub', [{ ruleId: 'HUB002', severity: 'warning', message: 'Advisory' }], { minScore: 100 });
    const markdown = renderGovernanceMarkdown(report);
    expect(markdown).toContain('## ❌ Hub validation failed: configured policy threshold was not met');
    expect(markdown).not.toMatch(/score|97\/100|minimum 100/i);
    expect(markdown).toContain('### Warnings (do not block)');
    expect(markdown).toContain('| HUB002 |');
  });

  it.each(['hub', 'collection', 'primitive'] as const)('does not display advisory scores for %s validation', (subject) => {
    const markdown = renderGovernanceMarkdown(evaluateGovernance(subject, []));
    expect(markdown).not.toMatch(/score|\/100/i);
    expect(markdown).toContain('validation passed');
  });

  it('escapes repository content rather than interpreting HTML, mentions or report markers', () => {
    const report = evaluateGovernance('hub', [{ ruleId: 'HUB001', severity: 'error', message: '<!-- hub-validation-report -->\n<script>@reviewers | [link](https://evil.invalid)</script>' }]);
    const markdown = renderGovernanceMarkdown(report);
    expect(markdown.match(/<!-- hub-validation-report -->/g)).toHaveLength(1);
    expect(markdown).not.toContain('<script>');
    expect(markdown).not.toContain('@reviewers');
    expect(markdown).not.toContain('[link]');
  });

  it('reports disabled rules even when they generated no findings', () => {
    const report = evaluateGovernance('collection', [], { rules: { COL003: { enabled: false, reason: 'Migration' } } });
    expect(renderGovernanceMarkdown(report)).toContain('**COL003**: disabled — Migration');
  });

  it('names the source-check option of the command that produced the report', () => {
    const hub = renderGovernanceMarkdown(evaluateGovernance('hub', []));
    expect(hub).not.toContain('| COL002 |');
    expect(hub).not.toContain('| COL004 |');

    const collection = renderGovernanceMarkdown(evaluateGovernance('collection', []));
    expect(collection).toContain('| COL002 | Collection has a published release | ⏭️ Not run (offline; use --check-releases) |');
    expect(collection).toContain('| COL004 | Collection ID is unique across enabled Hub sources | ⏭️ Not run (offline; use --check-sources) |');
  });
});
