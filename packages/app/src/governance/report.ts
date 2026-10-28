/**
 * Provider-owned report formatting shared by local CLI and CI (job summary and PR comment).
 * Every rule that applies is listed with its result; failures and warnings are spelled out per level.
 * @module app/governance/report
 */
import {
  type GovernanceFinding,
  type GovernanceReport,
  type GovernanceRule,
  rulesForSubject,
} from '@ai-primitives-hub/core';
import type {
  PrScope,
} from './pr-scope';

/**
 * Treat repository content as text, not Markdown/HTML or a report marker.
 * @param value
 */
const escape = (value: string): string => value
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/[\\`*_{}[\]()#+.!|~-]/g, (character) => `&#${character.charCodeAt(0)};`)
  .replace(/@/g, '&#64;').replace(/\r?\n/g, '<br>');

type Level = 'hub' | 'collection' | 'primitive' | 'configuration';

const levelOf = (ruleId: string): Level => {
  if (ruleId.startsWith('HUB')) {
    return 'hub';
  }
  if (ruleId.startsWith('COL')) {
    return 'collection';
  }
  return ruleId.startsWith('CFG') ? 'configuration' : 'primitive';
};

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * The option that enables source checks: hub runs use `--check-sources`, collection runs `--check-releases`.
 * @param subject
 */
const sourceCheckOption = (subject: GovernanceReport['subject']): string => subject === 'hub' ? '--check-sources' : '--check-releases';

/** Minimal view of the hub PR scope attached by scoped hub runs. */
interface HubScopeView {
  sources: { added: string[]; modified: string[]; removed: string[] };
  profiles: { added: string[]; modified: string[]; removed: string[] };
  sourceIds: string[];
  profileIds: string[];
  noOp: boolean;
  mergeBase?: string;
  headRef?: string;
}

export type RenderableGovernanceReport = GovernanceReport & { prScope?: PrScope; scope?: HubScopeView };

interface RuleRow {
  rule: GovernanceRule;
  status: 'pass' | 'fail' | 'warn' | 'skipped';
  result: string;
  findings: GovernanceFinding[];
}

/**
 * Result of one rule from the findings, suppressions and whether its level ran.
 * @param rule
 * @param report
 * @param levelRan
 */
function ruleRow(rule: GovernanceRule, report: GovernanceReport, levelRan: boolean): RuleRow {
  const findings = report.findings.filter((finding) => finding.ruleId === rule.id);
  if (report.suppressions.some((s) => s.ruleId === rule.id && s.action === 'disabled')) {
    return { rule, status: 'skipped', result: '⏭️ Disabled by configuration', findings };
  }
  if (!levelRan || report.notChecked.some((entry) => entry.ruleId === rule.id)) {
    return { rule, status: 'skipped', result: `⏭️ Not run (offline; use ${sourceCheckOption(report.subject)})`, findings };
  }
  const errors = findings.filter((finding) => finding.severity === 'error');
  if (errors.length > 0) {
    const unverified = errors.every((finding) => finding.verified === false) ? ', could not verify' : '';
    return { rule, status: 'fail', result: `❌ Fail (${plural(errors.length, 'error')}${unverified})`, findings };
  }
  if (findings.length > 0) {
    return { rule, status: 'warn', result: `⚠️ Pass with ${plural(findings.length, 'warning')}`, findings };
  }
  return { rule, status: 'pass', result: '✅ Pass', findings };
}

/**
 * One line per finding with the exact error text; unverified means the data could not be read.
 * @param finding
 * @param rule
 */
const detail = (finding: GovernanceFinding, rule?: GovernanceRule): string => {
  const icon = finding.severity === 'error' ? '❌' : '⚠️';
  const where = finding.file === undefined ? '' : ` · ${escape(finding.file)}`;
  const unverified = finding.verified === false ? ' · could not verify' : '';
  return [
    `- ${icon} **${escape(finding.ruleId)}**${where}${unverified}`,
    ...(rule ? [`  - **Rule:** ${escape(rule.description)}`] : []),
    `  - **What failed:** ${escape(finding.message)}`,
    ...(finding.hint ? [`  - **How to fix:** ${escape(finding.hint)}`] : [])
  ].join('\n');
};

/**
 * Render one level: every rule with its result, then the details of each failure and warning.
 * @param title
 * @param rows
 * @param levelRan
 */
function renderLevel(title: string, rows: RuleRow[], levelRan: boolean): string[] {
  const failed = rows.filter((row) => row.status === 'fail').length;
  const warned = rows.filter((row) => row.status === 'warn').length;
  let summary = '✅ PASS';
  if (!levelRan) {
    summary = '⏭️ NOT RUN';
  } else if (failed > 0) {
    summary = `❌ FAIL (${plural(failed, 'rule')} failed)`;
  } else if (warned > 0) {
    summary = `⚠️ PASS (${plural(warned, 'rule')} with warnings)`;
  }
  const lines = ['', `### ${title}: ${summary}`, '', '| Rule | Check | Result |', '| --- | --- | --- |',
    ...rows.map((row) => `| ${row.rule.id} | ${escape(row.rule.description)} | ${row.result} |`)];
  const of = (severity: string) => rows.flatMap((row) => row.findings.filter((finding) => finding.severity === severity).map((finding) => detail(finding, row.rule)));
  const errors = of('error');
  const warnings = of('warning');
  if (errors.length > 0) {
    lines.push('', `**Errors (${errors.length})**`, '', ...errors);
  }
  if (warnings.length > 0) {
    lines.push('', `**Warnings (${warnings.length})**`, '', ...warnings);
  }
  return lines;
}

function renderHubScope(scope: HubScopeView): string[] {
  if (scope.noOp) {
    return ['', '### PR scope', '', 'No source or profile changes; nothing to validate beyond the hub file.'];
  }
  const list = (label: string, ids: string[]): string[] => ids.length === 0 ? [] : [`- ${label}: ${ids.map((id) => escape(id)).join(', ')}`];
  const compared = scope.mergeBase && scope.headRef
    ? `Compared ${escape(scope.mergeBase.slice(0, 12))} (merge base) with ${escape(scope.headRef.slice(0, 12))}.`
    : '';
  return ['', '### PR scope', '', ...(compared ? [compared, ''] : []),
    ...list('Added sources', scope.sources.added), ...list('Modified sources', scope.sources.modified), ...list('Removed sources', scope.sources.removed),
    ...list('Added profiles', scope.profiles.added), ...list('Modified profiles', scope.profiles.modified), ...list('Removed profiles', scope.profiles.removed),
    ...list('Validated sources', scope.sourceIds), ...list('Validated profiles', scope.profileIds)];
}

function renderPrScope(scope: PrScope): string[] {
  const compared = `Compared ${escape(scope.mergeBase.slice(0, 12))} (merge base) with ${escape(scope.headRef.slice(0, 12))}`;
  const lines = ['', '### PR scope', '',
    `${compared}: ${plural(scope.changedFiles.length, 'changed file')}, ${scope.validated.length} validated.`];
  if (scope.validated.length > 0) {
    lines.push('', ...scope.validated.map((file) => `- ${escape(file)}`));
  }
  return lines;
}

/**
 * Render one safe provider-owned report for the job summary and PR comment.
 * @param report Structured verdict including findings, policy adjustments and optional PR scope.
 */
export function renderGovernanceMarkdown(report: RenderableGovernanceReport): string {
  const marker = report.subject === 'hub' ? 'hub-validation-report' : `${report.subject}-validation-report`;
  // Each command reports its own level. A hub run adds the two hub-wide collection checks (COL002, COL004).
  const levels: Level[] = report.subject === 'hub' ? ['hub', 'collection'] : [report.subject];
  const rules = rulesForSubject(report.subject);
  const verdict = report.verdict === 'pass' ? '✅ **PASS**' : '❌ **FAIL**';
  const lines = [
    `<!-- ${marker} -->`,
    `## AI Primitives Hub — ${report.subject} validation: ${verdict}`,
    '',
    '| Check | Result |',
    '| --- | --- |',
    `| Verdict | ${verdict} |`
  ];
  const rendered: string[] = [];
  for (const level of levels) {
    const ran = !(report.subject === 'hub' && level !== 'hub' && report.mode === 'offline');
    const rows = rules.filter((rule) => levelOf(rule.id) === level).map((rule) => ruleRow(rule, report, ran));
    const title = report.subject === 'hub' && level === 'collection'
      ? 'Hub-wide collection checks'
      : `${level.charAt(0).toUpperCase()}${level.slice(1)} validation`;
    const section = renderLevel(title, rows, ran);
    lines.push(`| ${title} | ${section[1].slice(`### ${title}: `.length)} |`);
    rendered.push(...section);
  }
  lines.push(
    `| Advisory score | ${report.score}/100 |`,
    `| Minimum score | ${report.minScore ?? 'Not enforced'} |`,
    report.mode === 'sources'
      ? `| Source access | Source repositories were contacted (${sourceCheckOption(report.subject)}) |`
      : '| Source access | Offline; source repositories were not contacted |'
  );
  const configuration = report.findings.filter((finding) => levelOf(finding.ruleId) === 'configuration');
  if (configuration.length > 0) {
    lines.push('', `### Configuration (hub-governance.yml): ❌ FAIL`, '',
      'The configuration was ignored for this run.', '', ...configuration.map((finding) => detail(finding)));
  }
  lines.push(...rendered);
  if (report.scope) {
    lines.push(...renderHubScope(report.scope));
  }
  if (report.prScope) {
    lines.push(...renderPrScope(report.prScope));
  }
  lines.push('', '### Policy adjustments', '');
  if (report.suppressions.length === 0) {
    lines.push('No rules disabled or overridden.');
  } else {
    for (const suppression of report.suppressions) {
      lines.push(`- **${escape(suppression.ruleId)}**: ${escape(suppression.action)}${suppression.reason ? ` — ${escape(suppression.reason)}` : ''}`);
    }
  }
  lines.push('', '> Errors fail the PR; warnings only lower the advisory score. "Could not verify" means the data could not be read'
  + ' (access, rename or rate limit); it fails the PR without lowering the score.', '');
  return lines.join('\n');
}
