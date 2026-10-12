import {
  evaluateGovernanceV1,
} from '@ai-primitives-hub/core/dist/domain/governance/governance-v1';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  renderGovernanceMarkdownV1,
} from '../../src/governance/report-v1';

describe('provider-owned governance Markdown report', () => {
  it('renders the same verdict, score and threshold as the structured result', () => {
    const report = evaluateGovernanceV1('hub', [{ ruleId: 'HUB002', severity: 'warning', message: 'Advisory' }], { minScore: 100 });
    const markdown = renderGovernanceMarkdownV1(report);
    expect(markdown).toContain('**FAIL**');
    expect(markdown).toContain('97/100');
    expect(markdown).toContain('| Minimum score | 100 |');
    expect(markdown).toContain('HUB002');
  });

  it('escapes repository content rather than interpreting HTML, mentions or report markers', () => {
    const report = evaluateGovernanceV1('hub', [{ ruleId: 'HUB001', severity: 'error', message: '<!-- hub-validation-report -->\n<script>@reviewers | [link](https://evil.invalid)</script>' }]);
    const markdown = renderGovernanceMarkdownV1(report);
    expect(markdown.match(/<!-- hub-validation-report -->/g)).toHaveLength(1);
    expect(markdown).not.toContain('<script>');
    expect(markdown).not.toContain('@reviewers');
    expect(markdown).not.toContain('[link]');
  });

  it('reports disabled rules even when they generated no findings', () => {
    const report = evaluateGovernanceV1('collection', [], { rules: { COL003: { enabled: false, reason: 'Migration' } } });
    expect(renderGovernanceMarkdownV1(report)).toContain('**COL003**: disabled — Migration');
  });
});
