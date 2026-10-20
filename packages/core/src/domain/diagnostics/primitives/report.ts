/**
 * Domain layer — the primitive diagnostics report.
 *
 * `assemblePrimitiveReport` classifies the raw bundle and case results and
 * builds the stable report in plan order, whatever the completion order.
 * Fields may be added to the report, never renamed (R10).
 * @module domain/diagnostics/primitives/report
 */
import type {
  TargetType,
} from '../../install/target';
import type {
  PrimitiveKind,
} from '../../primitive/types';
import {
  type ClassifiedCheck,
  classifyBundle,
  classifyCase,
  findUnusedKnownGaps,
} from './classifier';
import type {
  InstallStatus,
} from './evaluators';
import type {
  KnownGap,
} from './known-gaps';
import type {
  PrimitiveDiagnosticsPlan,
} from './planner';
import type {
  DiagnosticCheck,
  DiagnosticScope,
  InvariantId,
  RollupOutcome,
} from './types';

/** Why a run could not start (setup steps) or the orchestration itself failed (`internal`). */
export interface PrimitiveDiagnosticsError {
  step: 'preflight' | 'workspace' | 'sandbox' | 'fixture' | 'internal';
  message: string;
}

/**
 * Report of a `doctor diagnostics --primitives` run.
 *
 * Path labels are sandbox-relative ($HOME/…, $XDG_*\/…, $TMPDIR/…, <workspace>/…, <case>/…).
 * `<workspace>` in a label = the case's project directory, not `workspace` below.
 */
export interface PrimitiveDiagnosticsReport {
  ok: boolean;
  summary: {
    cases: number; pass: number; knownGap: number; fail: number;
    bundles: { bundles: number; pass: number; knownGap: number; fail: number };
  };
  filters: PrimitiveDiagnosticsPlan['filters'];
  notCovered: { kinds: PrimitiveKind[] };
  bundles: { id: string; kinds: PrimitiveKind[]; outcome: RollupOutcome; checks: DiagnosticCheck[] }[];
  cases: {
    id: string; bundle: string; kinds: PrimitiveKind[]; target: TargetType; scope: DiagnosticScope;
    effectiveScope: string | null; status: InstallStatus | null;
    expectedStatus: 'installed' | 'rejected'; outcome: RollupOutcome; gapIds: string[];
    checks: DiagnosticCheck[]; destinations: string[]; durationMs: number;
  }[];
  knownGaps: { key: string; id: string; invariant: InvariantId; absorbed: number }[];
  unusedKnownGaps: { key: string; id: string; invariant: InvariantId }[];
  /** Absolute run workspace. */
  workspace: string;
  workspaceRetained: boolean;
  durationMs: number;
  /** Present only when the run could not start (R7.4) or the orchestration itself failed. */
  error?: PrimitiveDiagnosticsError;
}

/** Raw (unclassified) checks of one bundle. */
export interface BundleResult {
  id: string;
  checks: readonly DiagnosticCheck[];
}

/** Raw (unclassified) result of one case. */
export interface CaseResult {
  id: string;
  effectiveScope: string | null;
  status: InstallStatus | null;
  checks: readonly DiagnosticCheck[];
  destinations: readonly string[];
  durationMs: number;
}

/** Run facts that are not results. */
export interface PrimitiveReportMeta {
  workspace: string;
  workspaceRetained: boolean;
  durationMs: number;
  error?: PrimitiveDiagnosticsError;
}

const NOT_RUN: DiagnosticCheck = { invariant: 'HARNESS', outcome: 'fail', detail: 'not run: internal error' };

const tally = (outcomes: readonly RollupOutcome[]): { pass: number; knownGap: number; fail: number } => ({
  pass: outcomes.filter((o) => o === 'pass').length,
  knownGap: outcomes.filter((o) => o === 'known-gap').length,
  fail: outcomes.filter((o) => o === 'fail').length
});

/**
 * Assemble the report in plan order.
 *
 * With no error or an `internal` one, every planned bundle and case is
 * reported; a planned item without a result gets `[HARNESS] not run:
 * internal error`. A setup error reports no bundles and no cases.
 * @param plan - The run's plan.
 * @param bundleResults - Raw bundle results, in any order.
 * @param caseResults - Raw case results, in any order.
 * @param gaps - Known gaps the run classifies against.
 * @param meta - Workspace, duration and error.
 * @returns The report.
 */
export function assemblePrimitiveReport(
  plan: PrimitiveDiagnosticsPlan,
  bundleResults: readonly BundleResult[],
  caseResults: readonly CaseResult[],
  gaps: readonly KnownGap[],
  meta: PrimitiveReportMeta
): PrimitiveDiagnosticsReport {
  const setupError = meta.error !== undefined && meta.error.step !== 'internal';
  const bundleById = new Map(bundleResults.map((result) => [result.id, result]));
  const caseById = new Map(caseResults.map((result) => [result.id, result]));
  const records: ClassifiedCheck[] = [];

  const bundles: PrimitiveDiagnosticsReport['bundles'] = setupError
    ? []
    : plan.bundles.map((bundle) => {
      const classified = classifyBundle(bundle, bundleById.get(bundle.id)?.checks ?? [NOT_RUN], gaps);
      records.push(...classified.records);
      return { id: bundle.id, kinds: bundle.items.map((item) => item.kind), outcome: classified.outcome, checks: classified.checks };
    });

  const cases: PrimitiveDiagnosticsReport['cases'] = setupError
    ? []
    : plan.cases.map((planned) => {
      const result = caseById.get(planned.id);
      const classified = classifyCase(planned, result?.checks ?? [NOT_RUN], gaps);
      records.push(...classified.records);
      return {
        id: planned.id,
        bundle: planned.bundle,
        kinds: [...planned.kinds],
        target: planned.target,
        scope: planned.scope,
        effectiveScope: result?.effectiveScope ?? null,
        status: result?.status ?? null,
        expectedStatus: planned.expectedStatus,
        outcome: classified.outcome,
        gapIds: classified.gapIds,
        checks: classified.checks,
        destinations: [...(result?.destinations ?? [])],
        durationMs: result?.durationMs ?? 0
      };
    });

  const absorbed = new Map<string, number>();
  for (const key of records.flatMap((record) => record.absorbedBy)) {
    absorbed.set(key, (absorbed.get(key) ?? 0) + 1);
  }
  const caseTally = tally(cases.map((c) => c.outcome));
  const bundleTally = tally(bundles.map((b) => b.outcome));

  const report: PrimitiveDiagnosticsReport = {
    ok: meta.error === undefined && caseTally.fail === 0 && bundleTally.fail === 0,
    summary: { cases: cases.length, ...caseTally, bundles: { bundles: bundles.length, ...bundleTally } },
    filters: plan.filters,
    notCovered: plan.notCovered,
    bundles,
    cases,
    knownGaps: gaps
      .filter((gap) => (absorbed.get(gap.key) ?? 0) > 0)
      .map((gap) => ({ key: gap.key, id: gap.id, invariant: gap.invariant, absorbed: absorbed.get(gap.key)! })),
    unusedKnownGaps: findUnusedKnownGaps(records, gaps).map((gap) => ({ key: gap.key, id: gap.id, invariant: gap.invariant })),
    workspace: meta.workspace,
    workspaceRetained: meta.workspaceRetained,
    durationMs: meta.durationMs
  };
  if (meta.error !== undefined) {
    report.error = meta.error;
  }
  return report;
}
