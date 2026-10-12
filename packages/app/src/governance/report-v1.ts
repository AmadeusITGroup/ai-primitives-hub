/** Provider-owned report formatting shared by local CLI and CI. */
import type {
  GovernanceReportV1,
} from '@ai-primitives-hub/core/dist/domain/governance/governance-v1';

/**
 * Treat repository content as text, not Markdown/HTML or a report marker.
 * @param value
 */
const escape = (value: string): string => value
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/[\\`*_{}[\]()#+.!|~-]/g, (character) => `&#${character.charCodeAt(0)};`)
  .replace(/@/g, '&#64;').replace(/\r?\n/g, '<br>');

/**
 * Render one safe provider-owned report for the job summary and PR comment.
 * @param report Structured verdict including findings and policy adjustments.
 */
export function renderGovernanceMarkdownV1(report: GovernanceReportV1): string {
  const marker = report.subject === 'hub' ? 'hub-validation-report' : `${report.subject}-validation-report`;
  const lines = [
    `<!-- ${marker} -->`,
    `## AI Primitives Hub — ${report.subject} validation`,
    '',
    '| Check | Result |',
    '| --- | --- |',
    `| Verdict | **${report.verdict.toUpperCase()}** |`,
    `| Advisory score | ${report.score}/100 |`,
    `| Minimum score | ${report.minScore ?? 'Not enforced'} |`,
    '| Source access | Offline; source repositories were not contacted |',
    '',
    '### Findings',
    ''
  ];
  if (report.findings.length === 0) {
    lines.push('No validation findings.');
  } else {
    lines.push('| Rule | Severity | File | Finding |', '| --- | --- | --- | --- |');
    for (const finding of report.findings) {
      lines.push(`| ${escape(finding.ruleId)} | ${finding.severity}${finding.verified === false ? ' (unverified)' : ''} | ${escape(finding.file ?? '—')} | ${escape(finding.message)} |`);
    }
  }
  lines.push('', '### Policy adjustments', '');
  if (report.suppressions.length === 0) {
    lines.push('No rules disabled or overridden.');
  } else {
    for (const suppression of report.suppressions) {
      lines.push(`- **${escape(suppression.ruleId)}**: ${escape(suppression.action)}${suppression.reason ? ` — ${escape(suppression.reason)}` : ''}`);
    }
  }
  lines.push('', '> Scope: offline validation only. Published releases, hub-wide collection uniqueness, and arbitrary primitive security analysis are not checked by this version.', '');
  return lines.join('\n');
}
