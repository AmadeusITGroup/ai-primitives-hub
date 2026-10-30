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

describe('governance report layout v2', () => {
  it.each(['hub', 'collection', 'primitive'] as const)('omits source execution notes and incomplete-data boilerplate for %s', (subject) => {
    const ruleId = subject === 'hub' ? 'HUB001' : (subject === 'collection' ? 'COL004' : 'SKL001');
    const report = evaluateGovernance(subject, [
      { ruleId, severity: 'error', verified: false, message: 'Source unavailable' }
    ], {}, undefined, { mode: 'sources' });
    const markdown = renderGovernanceMarkdown(report);
    expect(markdown).not.toContain('Source repositories were contacted');
    expect(markdown).not.toContain('Some data could not be read');
    expect(markdown).not.toContain('Sources changed by the hub PR were downloaded');
    expect(markdown).toContain('Source unavailable');
    expect(markdown).toContain('could not verify');
  });

  it('places collection checks before problems, warnings, policy overrides and PR scope', () => {
    const report = evaluateGovernance('collection', [
      { ruleId: 'COL004', severity: 'error', verified: false, message: 'Source unavailable' },
      { ruleId: 'COL006', severity: 'warning', message: 'Review metadata' }
    ], { rules: { COL003: { enabled: false, reason: 'Migration' } } }, undefined, { mode: 'sources' });
    const markdown = renderGovernanceMarkdown({ ...report, prScope: {
      mergeBase: 'base', headRef: 'head', changedFiles: [], validated: [], sources: ['example']
    } });
    const checks = markdown.indexOf('<details><summary>All checks:');
    const endChecks = markdown.indexOf('</details>');
    expect(checks).toBeGreaterThan(markdown.indexOf('## ❌ Collection validation failed'));
    expect(markdown.indexOf('| COL004 | Collection ID')).toBeGreaterThan(checks);
    for (const section of ['| # | Rule | Problem | Affected |', '### Warnings', '**Policy overrides:**', '### PR scope']) {
      expect(markdown.indexOf(section)).toBeGreaterThan(endChecks);
    }
    expect(markdown.match(/<details>/g)).toHaveLength(1);
    expect(markdown.match(/<\/details>/g)).toHaveLength(1);
  });
});
