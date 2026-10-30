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
  status: 'pass' | 'fail' | 'warn' | 'skipped' | 'not-applicable';
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
    const option = rule.id === 'COL004' ? '--check-sources' : sourceCheckOption(report.subject);
    return { rule, status: 'skipped', result: `⏭️ Not run (offline; use ${option})`, findings };
  }
  const errors = findings.filter((finding) => finding.severity === 'error');
  if (errors.length > 0) {
    const unverified = errors.every((finding) => finding.verified === false) ? ', could not verify' : '';
    return { rule, status: 'fail', result: `❌ Fail (${plural(errors.length, 'error')}${unverified})`, findings };
  }
  if (findings.length > 0) {
    return { rule, status: 'warn', result: `⚠️ Pass with ${plural(findings.length, 'warning')}`, findings };
  }
  if (report.applicableRules !== undefined && !report.applicableRules.includes(rule.id)) {
    return { rule, status: 'not-applicable', result: '— Not applicable', findings };
  }
  return { rule, status: 'pass', result: '✅ Pass', findings };
}

interface ProblemRow { problem: string; ruleIds: Set<string>; source?: string; collections: Set<string>; items: Map<string, string[]> }

/**
 * Group findings into one row per problem. A source that could not be read gets its own row,
 * with the number of its collections that could not be checked as a result.
 * @param findings
 */
function groupProblems(findings: GovernanceFinding[]): ProblemRow[] {
  const rows = new Map<string, ProblemRow>();
  for (const finding of findings) {
    // Drop a field label that the text repeats, e.g. "name: name must ..." -> "name must ...".
    const text = (finding.problem ?? finding.message).replace(/^(\w+): (?=\1\b)/, '').replace(/\.$/, '');
    const problem = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
    const source = finding.verified === false
      ? (finding.subject?.kind === 'source' ? finding.subject.id : finding.subject?.source)
      : undefined;
    const key = `${problem}\u0000${source ?? ''}`;
    const row = rows.get(key) ?? { problem, ruleIds: new Set<string>(), source, collections: new Set<string>(), items: new Map<string, string[]>() };
    rows.set(key, row);
    row.ruleIds.add(finding.ruleId);
    if (source !== undefined) {
      if (finding.subject?.kind === 'collection') {
        row.collections.add(finding.subject.id);
      }
      continue;
    }
    const item = finding.subject?.id ?? finding.file ?? '';
    const details = row.items.get(item) ?? [];
    if (finding.detail !== undefined && !details.includes(finding.detail)) {
      details.push(finding.detail);
    }
    row.items.set(item, details);
  }
  // Unreadable sources first: fixing them may reveal more problems.
  return [...rows.values()].toSorted((a, b) => Number(a.source === undefined) - Number(b.source === undefined));
}

/**
 * One numbered row per problem with everything it affects.
 * @param rows
 */
function problemsTable(rows: ProblemRow[]): string[] {
  const affected = (row: ProblemRow): string => {
    if (row.source !== undefined) {
      return row.collections.size === 0 ? escape(row.source) : `${escape(row.source)} (${plural(row.collections.size, 'collection')})`;
    }
    const entries = [...row.items].filter(([item, details]) => item !== '' || details.length > 0);
    // Plain names fit on one line; names with details get a line each.
    const separator = entries.some(([, details]) => details.length > 0) ? '<br>' : ', ';
    return entries.map(([item, details]) => {
      const listed = details.map((detail) => escape(detail)).join(', ');
      if (item === '') {
        return listed;
      }
      return details.length === 0 ? escape(item) : `${escape(item)} (${listed})`;
    }).join(separator) || '\u2014';
  };
  return ['| # | Rule | Problem | Affected |', '| --- | --- | --- | --- |',
    ...rows.map((row, index) => `| ${index + 1} | ${[...row.ruleIds].toSorted().map((id) => escape(id)).join(', ')} | ${escape(row.problem)} | ${affected(row)} |`)];
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
  if (scope.sources?.length) {
    lines.push('', `Validated sources: ${scope.sources.map((id) => escape(id)).join(', ')}`);
  }
  return lines;
}

/**
 * Render one safe provider-owned report for the job summary and PR comment.
 * @param report Structured verdict including findings, policy adjustments and optional PR scope.
 */
export function renderGovernanceMarkdown(report: RenderableGovernanceReport): string {
  const marker = report.subject === 'hub' ? 'hub-validation-report' : `${report.subject}-validation-report`;
  // Each command reports only its own level.
  const levels: Level[] = [report.subject];
  const rules = rulesForSubject(report.subject);
  const name = `${report.subject.charAt(0).toUpperCase()}${report.subject.slice(1)} validation`;
  const errors = report.findings.filter((finding) => finding.severity === 'error');
  const configurationFailed = report.findings.some((finding) => levelOf(finding.ruleId) === 'configuration');
  const problems = groupProblems(errors);
  const warnings = groupProblems(report.findings.filter((finding) => finding.severity === 'warning'));
  let heading = `✅ ${name} passed`;
  if (report.verdict === 'fail') {
    heading = problems.length > 0
      ? `❌ ${name} failed: ${plural(problems.length, 'problem')}`
      : `❌ ${name} failed: configured policy threshold was not met`;
  } else if (warnings.length > 0) {
    heading += ` with ${plural(warnings.length, 'warning')}`;
  }
  const header = [`<!-- ${marker} -->`, `## ${heading}`];
  const lines: string[] = [];
  if (problems.length > 0) {
    lines.push('', ...problemsTable(problems));
  }
  if (configurationFailed) {
    lines.push('', 'hub&#45;governance&#46;yml has errors, so it was ignored for this run.');
  }
  if (warnings.length > 0) {
    lines.push('', '### Warnings (do not block)', '', ...problemsTable(warnings));
  }
  if (report.suppressions.length > 0) {
    lines.push('', '**Policy overrides:**', '', ...report.suppressions.map((suppression) =>
      `- **${escape(suppression.ruleId)}**: ${escape(suppression.action)}${suppression.reason ? ` — ${escape(suppression.reason)}` : ''}`));
  }

  // Details for anyone who wants them: every check with its result, and what was validated.
  // Configuration checks are listed only when the configuration has errors.
  const rows = [...(configurationFailed ? ['configuration' as const] : []), ...levels].flatMap((level) => {
    const ran = !(report.subject === 'hub' && level !== 'hub' && report.mode === 'offline');
    return rules.filter((rule) => levelOf(rule.id) === level).map((rule) => ruleRow(rule, report, ran));
  });
  const count = (status: RuleRow['status']): number => rows.filter((row) => row.status === status).length;
  const summary = [`${count('pass') + count('warn')} passed`, `${count('fail')} failed`,
    ...(count('skipped') > 0 ? [`${count('skipped')} not run`] : []), ...(count('not-applicable') > 0 ? [`${count('not-applicable')} not applicable`] : [])];
  const details = ['', `<details><summary>All checks: ${summary.join(', ')}</summary>`, '', '| Rule | Check | Result |', '| --- | --- | --- |',
    ...rows.map((row) => `| ${row.rule.id} | ${escape(row.rule.description)} | ${row.result} |`)];
  if (report.mode !== 'sources') {
    details.push('', 'Offline; source repositories were not contacted.');
  }
  const scope: string[] = [];
  if (report.scope) {
    scope.push(...renderHubScope(report.scope));
  }
  if (report.prScope) {
    scope.push(...renderPrScope(report.prScope));
  }
  return (report.subject === 'collection'
    ? [...header, ...details, '', '</details>', ...lines, ...scope, '']
    : [...header, ...lines, ...details, ...scope, '', '</details>', '']).join('\n');
}
