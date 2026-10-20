/**
 * Domain layer — primitive diagnostics planner.
 *
 * Turns the `--kinds/--targets/--scopes` filters into the bundles to build
 * and the cases to run. Filters select cases only; they never change an
 * expected outcome (R2.8).
 * @module domain/diagnostics/primitives/planner
 */
import {
  TARGET_TYPES,
  type TargetType,
} from '../../install/target';
import {
  PRIMITIVE_KINDS,
  type PrimitiveKind,
} from '../../primitive/types';
import {
  type DiagnosticBundle,
  PRIMITIVE_DIAGNOSTIC_BUNDLES,
} from './catalogue';
import {
  expectedStatus,
} from './support-matrix';
import {
  DIAGNOSTIC_SCOPES,
  type DiagnosticScope,
} from './types';

/** Requested filters; an absent filter means all. */
export interface PrimitiveDiagnosticsFilters {
  kinds?: readonly PrimitiveKind[];
  targets?: readonly TargetType[];
  scopes?: readonly DiagnosticScope[];
}

/** One install case: a bundle on a target at a scope. */
export interface PlannedCase {
  /** `${bundle}__${target}__${scope}`. */
  id: string;
  bundle: string;
  kinds: PrimitiveKind[];
  target: TargetType;
  scope: DiagnosticScope;
  expectedStatus: 'installed' | 'rejected';
}

/** What a run executes. */
export interface PrimitiveDiagnosticsPlan {
  /** Effective filters: de-duplicated, in enum order. */
  filters: { kinds: PrimitiveKind[]; targets: TargetType[]; scopes: DiagnosticScope[] };
  /** Filter kinds no catalogued bundle contains (`plugin` in this slice). */
  notCovered: { kinds: PrimitiveKind[] };
  /** Catalogue order. */
  bundles: DiagnosticBundle[];
  /** Bundle, then TARGET_TYPES, then DIAGNOSTIC_SCOPES order. */
  cases: PlannedCase[];
}

/**
 * De-duplicate and re-sort values into enum order.
 * @param order - Enum values in canonical order.
 * @param values - Requested values.
 * @returns The requested values in canonical order.
 */
const inEnumOrder = <T extends string>(order: readonly T[], values: readonly T[]): T[] =>
  order.filter((value) => values.includes(value));

const kindsOf = (bundle: DiagnosticBundle): PrimitiveKind[] => [...new Set(bundle.items.map((item) => item.kind))];

/**
 * Plan a primitive diagnostics run.
 * @param filters - Requested filters.
 * @param catalogue - Bundles to choose from.
 * @returns The plan; `bundles` is empty when nothing matches (R2.6).
 */
export function planPrimitiveDiagnostics(
  filters: PrimitiveDiagnosticsFilters,
  catalogue: readonly DiagnosticBundle[] = PRIMITIVE_DIAGNOSTIC_BUNDLES
): PrimitiveDiagnosticsPlan {
  const cataloguedKinds = new Set(catalogue.flatMap((bundle) => kindsOf(bundle)));
  const kinds = inEnumOrder(PRIMITIVE_KINDS, filters.kinds ?? [...cataloguedKinds]);
  const targets = inEnumOrder(TARGET_TYPES, filters.targets ?? TARGET_TYPES);
  const scopes = inEnumOrder(DIAGNOSTIC_SCOPES, filters.scopes ?? DIAGNOSTIC_SCOPES);

  const bundles = catalogue.filter((bundle) => kindsOf(bundle).every((kind) => kinds.includes(kind)));
  const cases = bundles.flatMap((bundle) => {
    const bundleKinds = kindsOf(bundle);
    return targets.flatMap((target) => {
      const status = expectedStatus(bundleKinds, target);
      return scopes.map((scope): PlannedCase => ({
        id: `${bundle.id}__${target}__${scope}`,
        bundle: bundle.id,
        kinds: [...bundleKinds],
        target,
        scope,
        expectedStatus: status
      }));
    });
  });

  return {
    filters: { kinds, targets, scopes },
    notCovered: { kinds: kinds.filter((kind) => !cataloguedKinds.has(kind)) },
    bundles,
    cases
  };
}
