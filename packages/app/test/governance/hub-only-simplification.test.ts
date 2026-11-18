import {
  CONFIG_RULES,
  evaluateGovernance,
  FLOOR_RULE_IDS,
  HUB_RULES,
  isFloorRule,
} from '@ai-primitives-hub/core';
import * as infra from '@ai-primitives-hub/infra';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  type RenderableGovernanceReport,
  renderGovernanceMarkdown,
} from '../../src/governance/report';

describe('hub-only simplification', () => {
  const scopedReport: RenderableGovernanceReport = {
    ...evaluateGovernance('hub', [], {}, { mode: 'sources' }),
    scope: {
      sources: { added: ['resbi-prompt-registry'], modified: [], removed: [] },
      profiles: { added: [], modified: [], removed: [] },
      sourceIds: ['resbi-prompt-registry'], profileIds: [], noOp: false,
      mergeBase: '5878b998be1b4c4de4993a9b2cd4af9e094fa64d',
      headRef: 'a67b3706c96a59a320061764a8c464dbd0935771'
    }
  };

  it('preserves the exact source-checked hub PR report', () => {
    expect(renderGovernanceMarkdown(scopedReport)).toBe([
      '<!-- hub-validation-report -->',
      '## ✅ Hub validation passed',
      '',
      '<details><summary>All checks: 2 passed, 0 failed</summary>',
      '',
      '| Rule | Check | Result |',
      '| --- | --- | --- |',
      '| HUB001 | Hub syntax, schema, references and source policies | ✅ Pass |',
      '| HUB002 | Hub validation advisories | ✅ Pass |',
      '',
      '### PR scope',
      '',
      'Compared 5878b998be1b (merge base) with a67b3706c96a.',
      '',
      '- Added sources: resbi&#45;prompt&#45;registry',
      '- Validated sources: resbi&#45;prompt&#45;registry',
      '',
      '</details>',
      ''
    ].join('\n'));
  });

  it('preserves offline and no-op scope explanations', () => {
    const markdown = renderGovernanceMarkdown({
      ...scopedReport, mode: 'offline', scope: { ...scopedReport.scope!, noOp: true }
    });
    expect(markdown).toContain('All checks: 2 passed, 0 failed');
    expect(markdown).toContain('Offline; source repositories were not contacted.');
    expect(markdown).toContain('No source or profile changes; nothing to validate beyond the hub file.');
    expect(markdown).not.toContain('Added sources:');
  });

  it('preserves grouped rule IDs and safe repository text', () => {
    const report = evaluateGovernance('hub', [
      { ruleId: 'HUB001', severity: 'error', message: 'name: name must exist.', file: '<script>@owner|x.md', detail: '<!-- hub-validation-report -->' },
      { ruleId: 'HUB001', severity: 'error', message: 'name: name must exist.', file: '<script>@owner|x.md', detail: '<!-- hub-validation-report -->' },
      { ruleId: 'HUB002', severity: 'warning', message: 'Review source.', file: 'source.yml' }
    ], {}, { mode: 'sources' });
    const markdown = renderGovernanceMarkdown(report);
    expect(markdown).toContain('## ❌ Hub validation failed: 1 problem');
    expect(markdown).toContain('| 1 | HUB001 | Name must exist | &lt;script&gt;&#64;owner&#124;x&#46;md (&lt;&#33;&#45;&#45; hub&#45;validation&#45;report &#45;&#45;&gt;) |');
    expect(markdown).toContain('### Warnings (do not block)');
    expect(markdown).toContain('| HUB001 | Hub syntax, schema, references and source policies | ❌ Fail (2 errors) |');
    expect(markdown).toContain('| HUB002 | Hub validation advisories | ⚠️ Pass with 1 warning |');
    expect(markdown.match(/<!-- hub-validation-report -->/g)).toHaveLength(1);
    expect(markdown.indexOf('| # | Rule | Problem | Affected |')).toBeLessThan(markdown.indexOf('<details>'));
  });

  it('shows configuration checks only on configuration failures', () => {
    const policy = { rules: { HUB001: { enabled: false } } };
    const markdown = renderGovernanceMarkdown(evaluateGovernance('hub', [], policy, { mode: 'sources' }));
    expect(markdown).toContain('hub&#45;governance&#46;yml has errors, so it was ignored for this run.');
    expect(markdown).toContain('| CFG003 |');
    expect(markdown).toContain('All checks: 4 passed, 1 failed');
    expect(renderGovernanceMarkdown(evaluateGovernance('hub', [], policy))).toContain('All checks: 2 passed, 0 failed, 3 not run');
    expect(renderGovernanceMarkdown(scopedReport)).not.toContain('| CFG');
  });

  it('preserves policy overrides and the public floor lookup', () => {
    const markdown = renderGovernanceMarkdown(evaluateGovernance('hub', [], { rules: { HUB002: { enabled: false, reason: 'Team policy' } } }));
    expect(markdown).toContain('- **HUB002**: disabled — Team policy');
    expect(markdown).toContain('| HUB002 | Hub validation advisories | ⏭️ Disabled by configuration |');
    expect(FLOOR_RULE_IDS).toContain('HUB001');
    expect(isFloorRule('HUB001')).toBe(true);
    expect(isFloorRule('HUB002')).toBe(false);
    expect(isFloorRule('CFG001')).toBe(false);
    expect(CONFIG_RULES.map((rule) => rule.id)).toEqual(['CFG001', 'CFG002', 'CFG003']);
    expect(HUB_RULES.map((rule) => rule.id)).toEqual(['HUB001', 'HUB002']);
  });

  it('publishes the changed-file reader now owned by collection validation', () => {
    expect(infra).toHaveProperty('readGitChangedFiles');
  });
});
