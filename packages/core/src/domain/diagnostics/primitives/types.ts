/**
 * Domain layer — primitive diagnostics vocabulary (`doctor diagnostics --primitives`).
 *
 * Scopes, invariant ids, check outcomes and the command observation shape
 * shared by the planner, the evaluators, the classifier and the report.
 * Pure data and types: no I/O.
 * @module domain/diagnostics/primitives/types
 */

/** Install scopes a diagnostic case is run at. */
export const DIAGNOSTIC_SCOPES = ['user', 'repository'] as const;

/** Install scope of a diagnostic case. */
export type DiagnosticScope = typeof DIAGNOSTIC_SCOPES[number];

/**
 * Invariants evaluated by the diagnostics. Ids are stable report values;
 * the unused numbers (I5, I9–I12) are left free for future invariants.
 * `HARNESS` marks a defect of the diagnostic run itself (never absorbed by
 * a known gap).
 */
export const INVARIANTS = [
  /** validate and build succeed and produce a governed manifest with the bundle's id and version. */
  { id: 'I0', level: 'bundle' },
  /** Every source file of an item is in the archive. */
  { id: 'I1', level: 'bundle' },
  /** The manifest lists each item exactly once, with its kind and expected id. */
  { id: 'I2', level: 'bundle' },
  /** The manifest's file inventory matches the archive (validateManifest). */
  { id: 'I3', level: 'bundle' },
  /** The install status matches the support matrix. */
  { id: 'I4', level: 'case' },
  /** Uninstall removes every placed file. */
  { id: 'I6', level: 'case' },
  /** A rejected or failed install writes nothing user-facing. */
  { id: 'I7', level: 'case' },
  /** The target honours the requested scope. */
  { id: 'I8', level: 'case' },
  /** Every archived installable file lands at its expected destination. */
  { id: 'I13', level: 'case' },
  { id: 'HARNESS', level: 'any' }
] as const;

/** Invariant identifier. */
export type InvariantId = typeof INVARIANTS[number]['id'];

/** JSON-serialisable value, used for the deterministic `expected` / `observed` facts. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** Outcome of one check. */
export type CheckOutcome = 'pass' | 'known-gap' | 'fail' | 'not-applicable';

/** Outcome of a bundle or a case: `fail` > `known-gap` > `pass`. */
export type RollupOutcome = 'pass' | 'known-gap' | 'fail';

/** Marker for cascade checks that were not evaluated. Never matched by a gap. */
export const NOT_EVALUATED = { notEvaluated: true } as const;

/**
 * Whether an `observed` value is the {@link NOT_EVALUATED} marker.
 * @param value - Observed value of a check.
 * @returns True for the not-evaluated marker.
 */
export const isNotEvaluated = (value: unknown): boolean =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && (value as Record<string, unknown>).notEvaluated === true;

/** One invariant check on a bundle or a case. */
export interface DiagnosticCheck {
  invariant: InvariantId;
  outcome: CheckOutcome;
  /** Collection item path, for per-item bundle checks (I1, I2). */
  item?: string;
  gapIds?: string[];
  expected?: JsonValue;
  /** Exactly the facts the invariant compares; deterministic (no raw messages, no absolute paths). */
  observed?: JsonValue;
  /** Human-readable reason; may contain command messages and absolute paths (not deterministic, unlike `observed`). */
  detail?: string;
  /**
   * Non-blocking findings of a passing check. I0 carries only the
   * kind/route mismatch warnings of `collection validate`; the key is
   * omitted when there are none.
   */
  warnings?: string[];
}

/** What a command produced, as seen by the evaluators (filled from `DriverCommandResult`). */
export interface CommandObservation {
  exitCode: number;
  status?: 'ok' | 'warning' | 'error';
  warnings: readonly string[];
  errorCode?: string;
  /** All failure reasons the command reported. Empty on success. */
  errorMessages: readonly string[];
}
