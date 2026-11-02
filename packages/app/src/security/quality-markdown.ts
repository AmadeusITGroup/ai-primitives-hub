/**
 * Markdown for a quality report: the job summary or pull-request comment.
 *
 * Score bars, risk badges, a collapsible findings table per failing bundle, and the full table
 * collapsed. GitHub renders the tables and `<details>` blocks; the text still reads without them.
 * @module app/security/quality-markdown
 */
import {
  DEFAULT_SCORING_WEIGHTS,
  gateFailed,
  gateScoreLimit,
  type QualityBundle,
  type QualityFailOn,
  type QualityReport,
  type QualityRisk,
  type SecuritySeverity,
} from '@ai-primitives-hub/core';

const ICONS: Readonly<Record<QualityRisk, string>> = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴', unknown: '⚪' };
const RISK_ORDER = ['critical', 'high', 'medium', 'low'] as const;
const OK = '✅';
const FAIL = '❌';
const WARN = '⚠️';

export const riskBadge = (risk: QualityRisk): string => `${ICONS[risk]} ${risk}`;

export const scoreBar = (score: number | null, width = 10): string => {
  if (score === null) {
    return '—';
  }
  const filled = Math.max(0, Math.min(width, Math.round((score / 100) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
};

const scoreCell = (score: number | null): string => (score === null ? '—' : `\`${scoreBar(score)}\` **${String(score)}**`);

const escapeCell = (text: string): string => text.replaceAll('|', String.raw`\|`).replaceAll(/\r?\n/g, ' ').trim();

const riskCounts = (bundles: readonly QualityBundle[]): string => {
  const counts = new Map<QualityRisk, number>();
  for (const bundle of bundles) {
    if (bundle.score !== null) {
      counts.set(bundle.risk, (counts.get(bundle.risk) ?? 0) + 1);
    }
  }
  const parts = RISK_ORDER.filter((risk) => (counts.get(risk) ?? 0) > 0).map((risk) => `${ICONS[risk]} ${String(counts.get(risk))} ${risk}`);
  return parts.length > 0 ? parts.join(' · ') : 'no scored bundles';
};

const severityCounts = (counts: Readonly<Record<SecuritySeverity, number>>): string =>
  (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((severity) => `${String(counts[severity])}${severity[0]}`).join(' ');

const details = (summary: string, body: readonly string[]): string[] =>
  [`<details><summary>${summary}</summary>`, '', ...body, '', '</details>', ''];

const findingsTable = (findings: QualityBundle['findings'], limit = 5): string[] => {
  const lines = ['| Cost | Rule | Where | How to fix |', '|---:|---|---|---|'];
  for (const item of findings.slice(0, limit)) {
    lines.push(`| -${String(item.points)} | \`${item.ruleId}\` ${escapeCell(item.title)} | \`${escapeCell(item.file)}:${String(item.line)}\` | ${escapeCell(item.fix)} |`);
  }
  if (findings.length > limit) {
    lines.push(`| | _${String(findings.length - limit)} more in the JSON report_ | | |`);
  }
  return lines;
};

const bundlesTable = (bundles: readonly QualityBundle[], failOn: QualityFailOn): string[] => {
  const lines = ['| | Bundle | Score | Risk | Findings | Costliest finding |', '|:-:|---|---|---|---|---|'];
  const ordered = bundles.toSorted((a, b) => (a.score ?? -1) - (b.score ?? -1) || a.id.localeCompare(b.id));
  for (const bundle of ordered) {
    const top = bundle.findings.at(0)?.title ?? '-';
    lines.push(
      `| ${gateFailed(bundle.score, failOn) ? FAIL : OK} | \`${bundle.id}\` ${bundle.version} | ${scoreCell(bundle.score)} `
      + `| ${riskBadge(bundle.risk)} | ${severityCounts(bundle.counts)} | ${escapeCell(top)} |`
    );
  }
  return lines;
};

const bundleSections = (bundles: readonly QualityBundle[], failOn: QualityFailOn, attentionLimit = 10): string[] => {
  const failing = bundles.filter((bundle) => gateFailed(bundle.score, failOn));
  const lowest = bundles.filter((bundle) => bundle.penalty > 0 && bundle.score !== null)
    .toSorted((a, b) => (a.score ?? 0) - (b.score ?? 0)).slice(0, 5);
  const shown = (failing.length > 0 ? failing : lowest)
    .toSorted((a, b) => (a.score ?? 0) - (b.score ?? 0) || a.id.localeCompare(b.id)).slice(0, attentionLimit);
  const lines: string[] = [];
  if (shown.length > 0) {
    lines.push(failing.length > 0 ? `#### Needs attention (${String(failing.length)} below the gate limit)` : '#### Lowest scoring bundles', '');
    for (const bundle of shown.filter((item) => item.findings.length > 0)) {
      lines.push(...details(`<b><code>${bundle.id}</code></b> &nbsp; ${String(bundle.score)}/100 &nbsp; ${riskBadge(bundle.risk)}`, findingsTable(bundle.findings)));
    }
    if (failing.length > shown.length) {
      lines.push(`_${String(failing.length - shown.length)} more below the limit are in the full table._`, '');
    }
  }
  lines.push(...details(`All ${String(bundles.length)} bundles`, bundlesTable(bundles, failOn)));
  return lines;
};

const gateLine = (failOn: QualityFailOn, failing: number, total: number): string => {
  if (failOn === 'none') {
    return 'Gate: off (report only).';
  }
  const verdict = failing > 0 ? `**${String(failing)} of ${String(total)} bundle(s) are below the limit.**` : `All ${String(total)} bundle(s) pass.`;
  return `Gate \`${failOn}\`: a bundle fails below a score of ${String(gateScoreLimit(failOn))}. ${verdict}`;
};

const howScoringWorks = (): string => {
  const { curveScale, riskBands } = DEFAULT_SCORING_WEIGHTS;
  return `<sub>Score = 100 × exp(−penalty / ${String(curveScale)}); each finding costs points by severity, confidence, location and repetition. `
    + `Risk: 🟢 low ≥ ${String(riskBands.low)}, 🟡 medium ≥ ${String(riskBands.medium)}, 🟠 high ≥ ${String(riskBands.high)}, 🔴 critical below. `
    + 'Scores are advisory.</sub>';
};

/**
 * Render a quality report as markdown.
 * @param report - Report from the rating use case
 */
export const renderQualityMarkdown = (report: QualityReport): string => {
  const failOn = report.gate.failOn === 'NONE' ? 'none' : report.gate.failOn;
  const failed = !report.gate.passed;
  const { repo, bundles } = report;
  const lines = [`## ${failed ? FAIL : OK} Quality scan: ${failed ? 'failed' : 'passed'}`, ''];
  if (repo.basis === 'bundles-average') {
    const failing = bundles.filter((bundle) => gateFailed(bundle.score, failOn)).length;
    lines.push(
      `**Source score ${String(repo.score)}/100 · ${riskBadge(repo.risk)}** (average of ${String(bundles.length)} bundle${bundles.length === 1 ? '' : 's'}) &nbsp; ${scoreCell(repo.score)}`,
      '', riskCounts(bundles), '', `> ${gateLine(failOn, failing, bundles.length)}`, '',
      ...bundleSections(bundles, failOn)
    );
  } else {
    lines.push(
      `**Whole repository ${String(repo.score)}/100 · ${riskBadge(repo.risk)}** &nbsp; ${scoreCell(repo.score)}`, '',
      `> ${WARN} No collections or skills were found, so the whole repository was scanned as one unit. Vendored code and changelogs can lower this score.`, '',
      `> ${gateLine(failOn, failed ? 1 : 0, 1)}`, ''
    );
    if (repo.findings.length > 0) {
      lines.push(...details('Costliest findings', findingsTable(repo.findings, 10)));
    }
  }
  lines.push(howScoringWorks());
  return `${lines.join('\n')}\n`;
};
