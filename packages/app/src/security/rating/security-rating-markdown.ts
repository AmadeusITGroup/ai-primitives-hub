/**
 * Markdown for a security rating report: the job summary or pull-request comment.
 *
 * Score bars, risk badges, a collapsible findings table per failing bundle, and the full table
 * collapsed. GitHub renders the tables and `<details>` blocks; the text still reads without them.
 * The layout lives in `security-rating-templates`; this module only prepares the values.
 * @module app/security/rating/security-rating-markdown
 */
import {
  DEFAULT_SCORING_WEIGHTS,
  gateFailed,
  gateScoreLimit,
  type SecurityRatingBundle,
  type SecurityRatingFailOn,
  type SecurityRatingReport,
  type SecurityRatingRisk,
  type SecurityRatingSeverity,
} from '@ai-primitives-hub/core';
import {
  fillTemplate,
  TEMPLATES,
} from './security-rating-templates';

const ICONS: Readonly<Record<SecurityRatingRisk, string>> = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴', unknown: '⚪' };
const RISK_ORDER = ['critical', 'high', 'medium', 'low'] as const;
const OK = '✅';
const FAIL = '❌';
const WARN = '⚠️';

export const riskBadge = (risk: SecurityRatingRisk): string => `${ICONS[risk]} ${risk}`;

export const scoreBar = (score: number | null, width = 10): string => {
  if (score === null) {
    return '—';
  }
  const filled = Math.max(0, Math.min(width, Math.round((score / 100) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
};

const scoreCell = (score: number | null): string =>
  (score === null ? '—' : fillTemplate(TEMPLATES.scoreCell, { bar: scoreBar(score), score: String(score) }));

const riskCounts = (bundles: readonly SecurityRatingBundle[]): string => {
  const counts = new Map<SecurityRatingRisk, number>();
  for (const bundle of bundles) {
    if (bundle.score !== null) {
      counts.set(bundle.risk, (counts.get(bundle.risk) ?? 0) + 1);
    }
  }
  const parts = RISK_ORDER.filter((risk) => (counts.get(risk) ?? 0) > 0).map((risk) => `${ICONS[risk]} ${String(counts.get(risk))} ${risk}`);
  return parts.length > 0 ? parts.join(' · ') : 'no scored bundles';
};

const severityCounts = (counts: Readonly<Record<SecurityRatingSeverity, number>>): string =>
  (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((severity) => `${String(counts[severity])}${severity[0]}`).join(' ');

const details = (summary: string, body: readonly string[]): string =>
  fillTemplate(TEMPLATES.details, { summary, body: body.join('\n') });

const findingsTable = (findings: SecurityRatingBundle['findings'], limit = 5): string[] => [
  TEMPLATES.findingsHeader,
  ...findings.slice(0, limit).map((item) => fillTemplate(TEMPLATES.findingRow, {
    points: String(item.points), ruleId: item.ruleId, title: item.title, where: `${item.file}:${String(item.line)}`, fix: item.fix
  })),
  ...(findings.length > limit ? [fillTemplate(TEMPLATES.findingsMore, { count: String(findings.length - limit) })] : [])
];

const bundlesTable = (bundles: readonly SecurityRatingBundle[], failOn: SecurityRatingFailOn): string[] => [
  TEMPLATES.bundlesHeader,
  ...bundles.toSorted((a, b) => (a.score ?? -1) - (b.score ?? -1) || a.id.localeCompare(b.id)).map((bundle) => fillTemplate(TEMPLATES.bundleRow, {
    status: gateFailed(bundle.score, failOn) ? FAIL : OK,
    id: bundle.id,
    version: bundle.version,
    score: scoreCell(bundle.score),
    risk: riskBadge(bundle.risk),
    counts: severityCounts(bundle.counts),
    top: bundle.findings.at(0)?.title ?? '-'
  }))
];

const bundleSections = (bundles: readonly SecurityRatingBundle[], failOn: SecurityRatingFailOn, attentionLimit = 10): string => {
  const failing = bundles.filter((bundle) => gateFailed(bundle.score, failOn));
  const lowest = bundles.filter((bundle) => bundle.penalty > 0 && bundle.score !== null)
    .toSorted((a, b) => (a.score ?? 0) - (b.score ?? 0)).slice(0, 5);
  const shown = (failing.length > 0 ? failing : lowest)
    .toSorted((a, b) => (a.score ?? 0) - (b.score ?? 0) || a.id.localeCompare(b.id)).slice(0, attentionLimit);
  const parts: string[] = [];
  if (shown.length > 0) {
    parts.push(failing.length > 0 ? fillTemplate(TEMPLATES.attentionHeading, { failing: String(failing.length) }) : TEMPLATES.lowestHeading, '');
    for (const bundle of shown.filter((item) => item.findings.length > 0)) {
      const summary = fillTemplate(TEMPLATES.bundleSummary, { id: bundle.id, score: String(bundle.score), risk: riskBadge(bundle.risk) });
      parts.push(details(summary, findingsTable(bundle.findings)));
    }
    if (failing.length > shown.length) {
      parts.push(fillTemplate(TEMPLATES.moreBelowLimit, { count: String(failing.length - shown.length) }), '');
    }
  }
  parts.push(details(fillTemplate(TEMPLATES.allBundles, { count: String(bundles.length) }), bundlesTable(bundles, failOn)));
  return parts.join('\n');
};

const gateLine = (failOn: SecurityRatingFailOn, failing: number, total: number): string => {
  if (failOn === 'none') {
    return TEMPLATES.gateOff;
  }
  const counts = { failing: String(failing), total: String(total) };
  const verdict = fillTemplate(failing > 0 ? TEMPLATES.gateFailing : TEMPLATES.gatePassing, counts);
  return fillTemplate(TEMPLATES.gate, { failOn, limit: String(gateScoreLimit(failOn)), verdict });
};

const howScoringWorks = (): string => {
  const { curveScale, riskBands } = DEFAULT_SCORING_WEIGHTS;
  return fillTemplate(TEMPLATES.scoring, {
    scale: String(curveScale), low: String(riskBands.low), medium: String(riskBands.medium), high: String(riskBands.high)
  });
};

/**
 * Render a security rating report as markdown.
 * @param report - Report from the rating use case
 */
export const renderSecurityRatingMarkdown = (report: SecurityRatingReport): string => {
  const failOn = report.gate.failOn === 'NONE' ? 'none' : report.gate.failOn;
  const failed = !report.gate.passed;
  const { repo, bundles } = report;
  const common = {
    title: fillTemplate(TEMPLATES.title, { icon: failed ? FAIL : OK, verdict: failed ? 'failed' : 'passed' }),
    score: String(repo.score),
    risk: riskBadge(repo.risk),
    scoreCell: scoreCell(repo.score),
    scoring: howScoringWorks()
  };
  if (repo.basis === 'bundles-average') {
    const failing = bundles.filter((bundle) => gateFailed(bundle.score, failOn)).length;
    return fillTemplate(TEMPLATES.bundlesReport, {
      ...common,
      count: String(bundles.length),
      plural: bundles.length === 1 ? '' : 's',
      riskCounts: riskCounts(bundles),
      gate: gateLine(failOn, failing, bundles.length),
      sections: bundleSections(bundles, failOn)
    });
  }
  return fillTemplate(TEMPLATES.repositoryReport, {
    ...common,
    warn: WARN,
    gate: gateLine(failOn, failed ? 1 : 0, 1),
    findings: repo.findings.length > 0
      ? `${details(TEMPLATES.costliestFindings, findingsTable(repo.findings, 10))}\n`
      : ''
  });
};
