/**
 * Domain layer — primitive diagnostics classifier.
 *
 * Matches failing checks against the known gaps, rolls checks up into a
 * bundle or case outcome, and finds the known gaps a run no longer needs.
 * A failing check becomes `known-gap` only when an entry matches its
 * invariant, its selectors and its exact `observed` value (arrays compared
 * sorted), so a known gap never masks a different failure mode. `HARNESS`
 * checks and not-evaluated cascades are never absorbed.
 * @module domain/diagnostics/primitives/classifier
 */
import type {
  TargetType,
} from '../../install/target';
import type {
  PrimitiveKind,
} from '../../primitive/types';
import type {
  DiagnosticBundle,
} from './catalogue';
import {
  type KnownGap,
  PRIMITIVE_KNOWN_GAPS,
} from './known-gaps';
import type {
  PlannedCase,
} from './planner';
import {
  type DiagnosticCheck,
  type DiagnosticInstallMode,
  type DiagnosticScope,
  isNotEvaluated,
  type RollupOutcome,
} from './types';

/** What a check is about: a bundle (no target/scope) or a case. */
export interface GapSubject {
  /** For per-item checks, the item's kind. */
  kinds: readonly PrimitiveKind[];
  /** Bundle id of the bundle or case. */
  bundle?: string;
  target?: TargetType;
  scope?: DiagnosticScope;
  /** Install mode of a case. */
  mode?: DiagnosticInstallMode;
}

/** A classified check, its subject and the keys of the gaps that absorbed it. */
export interface ClassifiedCheck {
  check: DiagnosticCheck;
  absorbedBy: string[];
  subject: GapSubject;
}

/** Classified checks of one bundle or case. */
export interface ClassifiedChecks {
  checks: DiagnosticCheck[];
  outcome: RollupOutcome;
  /** Distinct gap ids of the absorbed checks, sorted. */
  gapIds: string[];
  /** One record per check, for the known-gap tallies and the unused-gap rule. */
  records: ClassifiedCheck[];
}

/**
 * Canonical JSON for deep equality: object keys sorted, array elements sorted.
 * @param value - Any JSON-like value.
 * @returns A string equal for deep-equal values.
 */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonical(entry)).toSorted().join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : (a > b ? 1 : 0)));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
};

/**
 * Whether a gap's selectors match a subject. An absent selector matches all;
 * a selector on a dimension the subject lacks never matches; the kinds
 * selector matches when any subject kind is listed.
 * @param match - Gap selectors.
 * @param subject - Check subject.
 * @returns True on a match.
 */
const selectorsMatch = (match: KnownGap['match'], subject: GapSubject): boolean =>
  (match.kinds === undefined || subject.kinds.some((kind) => match.kinds!.includes(kind)))
  && (match.bundles === undefined || (subject.bundle !== undefined && match.bundles.includes(subject.bundle)))
  && (match.targets === undefined || (subject.target !== undefined && match.targets.includes(subject.target)))
  && (match.scopes === undefined || (subject.scope !== undefined && match.scopes.includes(subject.scope)))
  && (match.modes === undefined || (subject.mode !== undefined && match.modes.includes(subject.mode)));

/**
 * Whether a check was really executed: it ran to a verdict on the product.
 * @param check - A check.
 * @returns False for not-applicable, HARNESS and not-evaluated checks.
 */
const isExecuted = (check: DiagnosticCheck): boolean =>
  check.outcome !== 'not-applicable' && check.invariant !== 'HARNESS' && !isNotEvaluated(check.observed);

/**
 * Classify one raw check against the known gaps.
 * @param raw - Check from the evaluators (or the harness).
 * @param subject - What the check is about.
 * @param gaps - Known gaps.
 * @returns The check (`known-gap` with every matching id, when absorbed) and the absorbing keys.
 */
export function classifyCheck(raw: DiagnosticCheck, subject: GapSubject, gaps: readonly KnownGap[] = PRIMITIVE_KNOWN_GAPS): ClassifiedCheck {
  if (raw.outcome !== 'fail' || !isExecuted(raw)) {
    return { check: raw, absorbedBy: [], subject };
  }
  const observed = canonical(raw.observed);
  const matching = gaps.filter((gap) =>
    gap.invariant === raw.invariant && selectorsMatch(gap.match, subject) && canonical(gap.observed) === observed);
  if (matching.length === 0) {
    return { check: raw, absorbedBy: [], subject };
  }
  return {
    check: { ...raw, outcome: 'known-gap', gapIds: [...new Set(matching.map((gap) => gap.id))] },
    absorbedBy: matching.map((gap) => gap.key),
    subject
  };
}

/**
 * Roll checks up: `fail` > `known-gap` > `pass`, ignoring `not-applicable`.
 * @param checks - Classified checks.
 * @returns The outcome; `pass` for no checks.
 */
export function rollup(checks: readonly DiagnosticCheck[]): RollupOutcome {
  if (checks.some((check) => check.outcome === 'fail')) {
    return 'fail';
  }
  return checks.some((check) => check.outcome === 'known-gap') ? 'known-gap' : 'pass';
}

const collect = (records: ClassifiedCheck[]): ClassifiedChecks => {
  const checks = records.map((record) => record.check);
  return {
    checks,
    outcome: rollup(checks),
    gapIds: [...new Set(checks.flatMap((check) => check.gapIds ?? []))].toSorted(),
    records
  };
};

/**
 * Kinds a check is about: its item's kind for a per-item check, else every kind.
 * @param check - A check.
 * @param items - Items of the bundle or case.
 * @param kinds - Every kind of the bundle or case.
 * @returns Subject kinds.
 */
const subjectKinds = (
  check: DiagnosticCheck,
  items: readonly { path: string; kind: PrimitiveKind }[],
  kinds: readonly PrimitiveKind[]
): readonly PrimitiveKind[] => {
  const itemKind = check.item === undefined ? undefined : items.find((item) => item.path === check.item)?.kind;
  return itemKind === undefined ? kinds : [itemKind];
};

/**
 * Classify the checks of one case. A per-item check's subject kind is its item's kind.
 * @param planned - Planned case (the subject: its bundle, kinds, target, requested scope and install mode).
 * @param checks - Raw case checks.
 * @param gaps - Known gaps.
 * @returns Classified checks, outcome and gap ids.
 */
export function classifyCase(planned: PlannedCase, checks: readonly DiagnosticCheck[], gaps: readonly KnownGap[] = PRIMITIVE_KNOWN_GAPS): ClassifiedChecks {
  return collect(checks.map((check) => classifyCheck(check, {
    kinds: subjectKinds(check, planned.items, planned.kinds),
    bundle: planned.bundle,
    target: planned.target,
    scope: planned.scope,
    mode: planned.mode
  }, gaps)));
}

/**
 * Classify the checks of one bundle. A per-item check's subject kind is its item's kind.
 * @param bundle - Catalogue bundle.
 * @param checks - Raw bundle checks.
 * @param gaps - Known gaps.
 * @returns Classified checks, outcome and gap ids.
 */
export function classifyBundle(bundle: DiagnosticBundle, checks: readonly DiagnosticCheck[], gaps: readonly KnownGap[] = PRIMITIVE_KNOWN_GAPS): ClassifiedChecks {
  const bundleKinds = bundle.items.map((item) => item.kind);
  return collect(checks.map((check) =>
    classifyCheck(check, { kinds: subjectKinds(check, bundle.items, bundleKinds), bundle: bundle.id }, gaps)));
}

/**
 * Known gaps a run no longer needs: entries that absorbed nothing
 * although at least one executed check of their invariant matched their
 * selectors. Entries outside the run's filters are never unused.
 * @param records - Classified check records of the whole run.
 * @param gaps - Known gaps.
 * @returns Unused entries, in `gaps` order.
 */
export function findUnusedKnownGaps(records: readonly ClassifiedCheck[], gaps: readonly KnownGap[] = PRIMITIVE_KNOWN_GAPS): KnownGap[] {
  const absorbed = new Set(records.flatMap((record) => record.absorbedBy));
  return gaps.filter((gap) => !absorbed.has(gap.key) && records.some((record) =>
    record.check.invariant === gap.invariant
    && isExecuted(record.check)
    && selectorsMatch(gap.match, record.subject)));
}
