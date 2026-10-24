/**
 * Text renderer for `doctor diagnostics --primitives`.
 *
 * Formatting only: every outcome, gap id and expected value comes from the
 * core-assembled report.
 * @module doctor/primitives-text
 */
import type {
  DiagnosticCheck,
  PrimitiveDiagnosticsReport,
  RollupOutcome,
} from '@ai-primitives-hub/core';

/** Renderer options. */
export interface PrimitivesTextOptions {
  /** Also expand known-gap checks (fail checks are always expanded). */
  verbose: boolean;
}

type ReportCase = PrimitiveDiagnosticsReport['cases'][number];

const GLYPHS: Record<RollupOutcome, string> = {
  pass: '[ OK ]',
  'known-gap': '[GAP ]',
  fail: '[FAIL]'
};

const WORDS: Record<RollupOutcome, string> = {
  pass: 'OK',
  'known-gap': 'GAP',
  fail: 'FAIL'
};

const BUNDLE_WIDTH = 27;
const KIND_WIDTH = 12;
const TARGET_WIDTH = 14;
const SCOPE_WIDTH = 20;

const pad = (value: string, width: number): string => value.padEnd(Math.max(width, value.length + 1));

/**
 * The outcome word of a progress event or a scope cell.
 * @param outcome Rolled-up outcome.
 * @returns `OK`, `GAP` or `FAIL`.
 */
export const outcomeWord = (outcome: RollupOutcome): string => WORDS[outcome];

/**
 * Gap ids with the invariants each absorbed, e.g. `power-directory-unit (I1, I2)`.
 * @param checks Classified checks.
 * @returns Annotation, empty when no check is a known gap.
 */
const gapAnnotation = (checks: readonly DiagnosticCheck[]): string => {
  const byGap = new Map<string, string[]>();
  for (const check of checks.filter((c) => c.outcome === 'known-gap')) {
    for (const id of check.gapIds ?? []) {
      const invariants = byGap.get(id) ?? [];
      if (!invariants.includes(check.invariant)) {
        invariants.push(check.invariant);
      }
      byGap.set(id, invariants);
    }
  }
  return [...byGap].map(([id, invariants]) => `${id} (${invariants.join(', ')})`).join(', ');
};

const CHECK_INDENT = '      ';

const expandChecks = (checks: readonly DiagnosticCheck[], verbose: boolean, prefix: string): string[] =>
  checks
    .filter((c) => c.outcome === 'fail' || (verbose && c.outcome === 'known-gap'))
    .flatMap((c) => {
      const lines = [`${CHECK_INDENT}${prefix}${c.invariant}${c.item === undefined ? '' : ` ${c.item}`}: ${c.outcome}`
        + `${c.gapIds === undefined || c.gapIds.length === 0 ? '' : ` ${c.gapIds.join(', ')}`}`];
      if (c.expected !== undefined) {
        lines.push(`${CHECK_INDENT}  expected: ${JSON.stringify(c.expected)}`);
      }
      if (c.observed !== undefined) {
        lines.push(`${CHECK_INDENT}  observed: ${JSON.stringify(c.observed)}`);
      }
      if (c.detail !== undefined) {
        lines.push(`${CHECK_INDENT}  detail: ${c.detail}`);
      }
      return lines;
    });

const scopeCell = (c: ReportCase): string => {
  const annotation = gapAnnotation(c.checks);
  return `${c.scope}: ${outcomeWord(c.outcome)}${annotation === '' ? '' : ` ${annotation}`}`;
};

const renderCases = (report: PrimitiveDiagnosticsReport, verbose: boolean): string[] => {
  const rows = new Map<string, ReportCase[]>();
  for (const c of report.cases) {
    const key = `${c.bundle}\u0000${c.target}`;
    rows.set(key, [...(rows.get(key) ?? []), c]);
  }
  return [...rows.values()].flatMap((row) => {
    const cells = row.map((c, index) => (index === row.length - 1 ? scopeCell(c) : pad(scopeCell(c), SCOPE_WIDTH)));
    const line = `  ${pad(row[0].kinds.join('+'), KIND_WIDTH)}${pad(row[0].target, TARGET_WIDTH)}${cells.join('')}`;
    return [line, ...row.flatMap((c) => expandChecks(c.checks, verbose, `${c.scope} `))];
  });
};

const renderKnownGaps = (report: PrimitiveDiagnosticsReport): string[] => {
  const totals = new Map<string, number>();
  for (const gap of report.knownGaps) {
    totals.set(gap.id, (totals.get(gap.id) ?? 0) + gap.absorbed);
  }
  const tally = [...totals].toSorted(([a], [b]) => a.localeCompare(b)).map(([id, absorbed]) => `${id} ${String(absorbed)}`).join('   ');
  return [
    'known gaps',
    `  ${tally === '' ? 'none' : tally}`,
    ...report.unusedKnownGaps.map((gap) => `  [WARN] unused known gap ${gap.key}`)
  ];
};

const renderSummary = (report: PrimitiveDiagnosticsReport): string => {
  const { summary } = report;
  return `summary: ${String(summary.cases)} cases: ${String(summary.pass)} pass, ${String(summary.knownGap)} known-gap, `
    + `${String(summary.fail)} fail; ${String(summary.bundles.bundles)} bundles: ${String(summary.bundles.pass)} pass, `
    + `${String(summary.bundles.knownGap)} known-gap, ${String(summary.bundles.fail)} fail`;
};

/**
 * Render a primitive diagnostics report as text.
 * @param report Report assembled by core.
 * @param options Renderer options.
 * @returns Text output ending with a newline.
 */
export const renderPrimitivesText = (report: PrimitiveDiagnosticsReport, options: PrimitivesTextOptions): string => {
  const { filters } = report;
  const lines = [
    'ai-primitives-hub doctor diagnostics --primitives',
    `  workspace: ${report.workspace} (${report.workspaceRetained ? 'retained' : 'removed'})`,
    `  filters: kinds=${filters.kinds.join(',')} targets=${filters.targets.join(',')} scopes=${filters.scopes.join(',')}`
  ];
  if (report.notCovered.kinds.length > 0) {
    lines.push(`  not covered yet: ${report.notCovered.kinds.join(', ')}`);
  }
  lines.push('');
  if (report.error !== undefined && report.error.step !== 'internal') {
    lines.push(`[FAIL] setup (${report.error.step}): ${report.error.message}`, renderSummary(report));
    return `${lines.join('\n')}\n`;
  }
  lines.push('bundles');
  for (const bundle of report.bundles) {
    const annotation = gapAnnotation(bundle.checks);
    lines.push(
      `  ${GLYPHS[bundle.outcome]} ${annotation === '' ? bundle.id : `${pad(bundle.id, BUNDLE_WIDTH)}${annotation}`}`,
      ...expandChecks(bundle.checks, options.verbose, '')
    );
  }
  lines.push('', 'cases', ...renderCases(report, options.verbose), '', ...renderKnownGaps(report));
  if (report.error !== undefined) {
    lines.push(`[FAIL] internal: ${report.error.message}`);
  }
  lines.push(renderSummary(report));
  return `${lines.join('\n')}\n`;
};
