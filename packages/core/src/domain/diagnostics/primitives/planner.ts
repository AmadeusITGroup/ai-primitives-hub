/**
 * Domain layer — primitive diagnostics planner.
 *
 * Turns the `--kinds/--targets/--scopes` filters into the bundles to build
 * and the cases to run. Filters select cases only; they never change an
 * expected outcome. A bundle that mixes kinds runs in both install modes
 * (the default all-or-nothing install and `install --skip-unsupported`);
 * a single-kind bundle runs in the default mode only.
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
  type ExpectedInstallStatus,
  expectedStatus,
} from './support-matrix';
import {
  DIAGNOSTIC_INSTALL_MODES,
  DIAGNOSTIC_SCOPES,
  type DiagnosticInstallMode,
  type DiagnosticScope,
} from './types';

/** Requested filters; an absent filter means all. */
export interface PrimitiveDiagnosticsFilters {
  kinds?: readonly PrimitiveKind[];
  targets?: readonly TargetType[];
  scopes?: readonly DiagnosticScope[];
}

/** One install case: a bundle on a target at a scope, in an install mode. */
export interface PlannedCase {
  /** `${bundle}__${target}__${scope}`, with a `__skip-unsupported` suffix in that mode. */
  id: string;
  bundle: string;
  /** Distinct item kinds, in bundle item order. */
  kinds: PrimitiveKind[];
  /** The bundle's items, in bundle order: the subjects of per-item case checks. */
  items: { path: string; kind: PrimitiveKind }[];
  target: TargetType;
  scope: DiagnosticScope;
  /** `skip-unsupported` only for a bundle with more than one kind. */
  mode: DiagnosticInstallMode;
  expectedStatus: ExpectedInstallStatus;
}

/** What a run executes. */
export interface PrimitiveDiagnosticsPlan {
  /** Effective filters: de-duplicated, in enum order. */
  filters: { kinds: PrimitiveKind[]; targets: TargetType[]; scopes: DiagnosticScope[] };
  /** Filter kinds no catalogued bundle contains (none with the default catalogue). */
  notCovered: { kinds: PrimitiveKind[] };
  /** Catalogue order. */
  bundles: DiagnosticBundle[];
  /** Bundle, then TARGET_TYPES, then DIAGNOSTIC_SCOPES, then DIAGNOSTIC_INSTALL_MODES order. */
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
 * Case id of a bundle on a target at a scope, in an install mode.
 * @param bundle - Bundle id.
 * @param target - Target type.
 * @param scope - Requested scope.
 * @param mode - Install mode; the default mode has no suffix.
 * @returns The case id.
 */
const caseId = (bundle: string, target: TargetType, scope: DiagnosticScope, mode: DiagnosticInstallMode): string =>
  `${bundle}__${target}__${scope}${mode === 'default' ? '' : `__${mode}`}`;

/**
 * Plan a primitive diagnostics run.
 * @param filters - Requested filters.
 * @param catalogue - Bundles to choose from.
 * @returns The plan; `bundles` is empty when nothing matches.
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
  // An invalid bundle is only validated and built: it has no install cases.
  const cases = bundles.filter((bundle) => bundle.rejection === undefined).flatMap((bundle) => {
    const bundleKinds = kindsOf(bundle);
    // Only a mixed bundle can be partially installed, so only it runs with --skip-unsupported.
    const modes: readonly DiagnosticInstallMode[] = bundleKinds.length > 1 ? DIAGNOSTIC_INSTALL_MODES : ['default'];
    return targets.flatMap((target) => scopes.flatMap((scope) => modes.map((mode): PlannedCase => ({
      id: caseId(bundle.id, target, scope, mode),
      bundle: bundle.id,
      kinds: [...bundleKinds],
      items: bundle.items.map((item) => ({ path: item.path, kind: item.kind })),
      target,
      scope,
      mode,
      expectedStatus: expectedStatus(bundleKinds, target, mode)
    }))));
  });

  return {
    filters: { kinds, targets, scopes },
    notCovered: { kinds: kinds.filter((kind) => !cataloguedKinds.has(kind)) },
    bundles,
    cases
  };
}
