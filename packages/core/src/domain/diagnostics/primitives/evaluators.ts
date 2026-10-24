/**
 * Domain layer — primitive diagnostics evaluators.
 *
 * Pure functions that turn what the commands produced into invariant
 * checks with outcome `pass`, `fail` or `not-applicable`. Only the
 * classifier turns a failing check into `known-gap`. `observed` holds
 * exactly the deterministic facts each invariant compares (no raw command
 * messages, no absolute paths); `detail` carries the human-readable reason,
 * capped at 500 characters.
 *
 * Bundle checks run in the order I0, I1 (per item), I2 (per item), I3;
 * case checks in the order I4, I6, I7, I8, I13.
 * @module domain/diagnostics/primitives/evaluators
 */
import {
  MANIFEST_FILENAME,
  ManifestValidationError,
  validateManifest,
} from '../../collection/manifest-validator';
import {
  LEGACY_RELEASE_WARNING,
} from '../../collection/release-manifest-plan';
import {
  verifyArchiveIntegrity,
} from '../../install/integrity';
import type {
  DiagnosticBundle,
  FixtureItem,
} from './catalogue';
import {
  type ManifestView,
  readManifestView,
} from './manifest-view';
import {
  expectedDestination,
  PLACEMENT_ROUTES,
} from './placements';
import type {
  PlannedCase,
} from './planner';
import {
  diffSnapshots,
  isBookkeepingLabel,
  type Snapshot,
} from './sandbox';
import {
  type CommandObservation,
  DIAGNOSTIC_SCOPES,
  type DiagnosticCheck,
  type DiagnosticScope,
  type InvariantId,
  type JsonValue,
  NOT_EVALUATED,
} from './types';

/** Maximum length of a check's `detail`. */
const DETAIL_LIMIT = 500;

/** Install error code of a by-design (or known-gap) rejection. */
const UNSUPPORTED_CONTENT = 'BUNDLE.UNSUPPORTED_CONTENT';

/** Inputs of the bundle-level invariants. */
export interface BundleEvaluationInput {
  bundle: DiagnosticBundle;
  validate: CommandObservation;
  build: CommandObservation;
  /** Extracted zip; absent when no zip was produced or it could not be read. */
  archive?: ReadonlyMap<string, Uint8Array>;
  /** Extractor/read error message when the zip existed but could not be read. */
  archiveError?: string;
}

/** Result of the bundle-level invariants. */
export interface BundleEvaluation {
  /** Order: I0, I1 (per item), I2 (per item), I3. */
  checks: DiagnosticCheck[];
  /** I0 passed: the cases of this bundle can run. */
  ready: boolean;
  /** Per item path; input to I13. Empty when there is no view. */
  archivedItemFiles: ReadonlyMap<string, readonly string[]>;
}

/** What one case's commands and snapshots produced. */
export interface CaseObservation {
  targetAdd: CommandObservation & { effectiveScope: string | null };
  install?: CommandObservation;
  uninstall?: CommandObservation;
  snapshots: { beforeInstall?: Snapshot; afterInstall?: Snapshot; afterUninstall?: Snapshot };
}

/** Observed install status of a case. */
export type InstallStatus = 'installed' | 'rejected' | 'error';

const cap = (detail: string): string => (detail.length > DETAIL_LIMIT ? `${detail.slice(0, DETAIL_LIMIT - 1)}…` : detail);

const withMessages = (reason: string, messages: readonly string[]): string =>
  cap(messages.length > 0 ? `${reason}: ${messages.join('; ')}` : reason);

const scalar = (value: unknown): JsonValue =>
  (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null);

const fail = (invariant: InvariantId, observed: JsonValue, detail: string, extra: Partial<DiagnosticCheck> = {}): DiagnosticCheck =>
  ({ invariant, outcome: 'fail', ...extra, observed, detail: cap(detail) });

const notApplicable = (invariant: InvariantId, detail: string): DiagnosticCheck =>
  ({ invariant, outcome: 'not-applicable', detail });

const EMPTY_SNAPSHOT: Snapshot = new Map();

/**
 * Archived installable files of an item: its source files that are archive
 * entries listed with role `installable`. Excludes LICENSE, metadata/** and
 * anything the build dropped.
 * @param item - Collection item.
 * @param archive - Extracted archive.
 * @param view - Manifest view of the archive.
 * @returns Sorted archive paths.
 */
export function archivedItemFiles(
  item: FixtureItem,
  archive: ReadonlyMap<string, Uint8Array>,
  view: ManifestView
): string[] {
  return item.files.filter((f) => archive.has(f) && view.files.get(f)?.role === 'installable').toSorted();
}

/**
 * I0: the build produced a readable governed manifest for this bundle.
 * @param input - Bundle inputs.
 * @param view - Parsed manifest, when present and a mapping.
 * @returns The I0 check.
 */
const evaluateI0 = (input: BundleEvaluationInput, view: ManifestView | undefined): DiagnosticCheck => {
  const { bundle, validate, build, archive, archiveError } = input;
  const manifestPresent = archive?.has(MANIFEST_FILENAME) ?? false;
  const firstError: JsonValue = validate.exitCode === 0
    ? (build.exitCode === 0 ? null : { command: 'build', code: build.errorCode ?? null })
    : { command: 'validate', code: validate.errorCode ?? null };

  let reason: string | undefined;
  if (validate.exitCode !== 0) {
    reason = withMessages(`collection validate exited ${String(validate.exitCode)}`, validate.errorMessages);
  } else if (build.exitCode !== 0) {
    reason = withMessages(`bundle build exited ${String(build.exitCode)}`, build.errorMessages);
  } else if (build.warnings.length > 0) {
    const legacy = build.warnings.includes(LEGACY_RELEASE_WARNING) ? ' (LEGACY_RELEASE_WARNING: legacy release path, no governed evidence)' : '';
    reason = withMessages(`bundle build reported warnings${legacy}`, build.warnings);
  } else if (archive === undefined) {
    reason = archiveError === undefined ? 'bundle build produced no archive' : `bundle archive could not be read: ${archiveError}`;
  } else if (!manifestPresent) {
    reason = `archive has no ${MANIFEST_FILENAME}`;
  } else if (view === undefined) {
    reason = `${MANIFEST_FILENAME} is not valid YAML or not a mapping`;
  } else if (view.formatVersion !== 1) {
    reason = `manifest formatVersion is ${JSON.stringify(scalar(view.formatVersion))}, expected 1`;
  } else if (view.id !== bundle.id) {
    reason = `manifest id is ${JSON.stringify(scalar(view.id))}, expected "${bundle.id}"`;
  } else if (view.version !== bundle.version) {
    reason = `manifest version is ${JSON.stringify(scalar(view.version))}, expected "${bundle.version}"`;
  }

  if (reason === undefined) {
    return { invariant: 'I0', outcome: 'pass' };
  }
  return fail('I0', {
    validateExit: validate.exitCode,
    buildExit: build.exitCode,
    buildWarnings: [...build.warnings],
    manifestPresent,
    formatVersion: scalar(view?.formatVersion),
    manifestId: scalar(view?.id),
    manifestVersion: scalar(view?.version),
    firstError
  }, reason);
};

const evaluateI1 = (item: FixtureItem, archive: ReadonlyMap<string, Uint8Array>): DiagnosticCheck => {
  const missingArchivePaths = item.files.filter((f) => !archive.has(f)).toSorted();
  return missingArchivePaths.length === 0
    ? { invariant: 'I1', outcome: 'pass', item: item.path }
    : fail('I1', { missingArchivePaths }, `archive is missing ${missingArchivePaths.join(', ')}`, { item: item.path });
};

const evaluateI2 = (item: FixtureItem, view: ManifestView): DiagnosticCheck => {
  const matches = view.items.filter((candidate) => candidate.path === item.path);
  const entry = matches[0];
  const expected = { id: item.expectedId, kind: item.kind, occurrences: 1 };
  if (matches.length === 1 && entry.kind === item.kind && entry.id === item.expectedId) {
    return { invariant: 'I2', outcome: 'pass', item: item.path };
  }
  const observed = { id: entry?.id ?? null, kind: entry?.kind ?? null, occurrences: matches.length };
  return fail('I2', observed, `manifest items[] has ${String(matches.length)} entr${matches.length === 1 ? 'y' : 'ies'} for ${item.path}`
    + (entry === undefined ? '' : ` (id ${JSON.stringify(entry.id)}, kind ${JSON.stringify(entry.kind)})`), { item: item.path, expected });
};

const evaluateI3 = (bundle: DiagnosticBundle, archive: ReadonlyMap<string, Uint8Array>, view: ManifestView): DiagnosticCheck => {
  try {
    validateManifest(archive, { expectedId: bundle.id, expectedVersion: bundle.version });
    return { invariant: 'I3', outcome: 'pass' };
  } catch (error) {
    const missing: string[] = [];
    const sizeMismatch: string[] = [];
    const digestMismatch: string[] = [];
    for (const [filePath, file] of view.files) {
      const bytes = archive.get(filePath);
      if (bytes === undefined) {
        missing.push(filePath);
        continue;
      }
      if (file.size !== bytes.byteLength) {
        sizeMismatch.push(filePath);
      }
      if (file.sha256 === null || !verifyArchiveIntegrity(bytes, file.sha256)) {
        digestMismatch.push(filePath);
      }
    }
    const unlisted = [...archive.keys()].filter((p) => p !== MANIFEST_FILENAME && !view.files.has(p));
    return fail('I3', {
      code: error instanceof ManifestValidationError ? error.code : null,
      missing: missing.toSorted(),
      sizeMismatch: sizeMismatch.toSorted(),
      digestMismatch: digestMismatch.toSorted(),
      unlisted: unlisted.toSorted()
    }, error instanceof Error ? error.message : String(error));
  }
};

/**
 * Evaluate the bundle-level invariants. When I0 fails, I1–I3 are reported
 * once each as not evaluated and the bundle is not ready. When I0
 * passes, I1–I3 are evaluated independently; an I3 failure does not block
 * the cases.
 * @param input - What validate and build produced, and the extracted archive.
 * @returns Checks in the order I0, I1, I2, I3; readiness; archived item files.
 */
export function evaluateBundle(input: BundleEvaluationInput): BundleEvaluation {
  const { bundle, archive } = input;
  const manifestBytes = archive?.get(MANIFEST_FILENAME);
  const view = manifestBytes === undefined ? undefined : readManifestView(manifestBytes);
  const files = new Map<string, readonly string[]>();
  if (archive !== undefined && view !== undefined) {
    for (const item of bundle.items) {
      files.set(item.path, archivedItemFiles(item, archive, view));
    }
  }

  const i0 = evaluateI0(input, view);
  if (i0.outcome !== 'pass' || archive === undefined || view === undefined) {
    const cascade = (['I1', 'I2', 'I3'] as const).map((invariant): DiagnosticCheck => ({
      invariant, outcome: 'fail', observed: NOT_EVALUATED, detail: 'not evaluated: build failed'
    }));
    return { checks: [i0, ...cascade], ready: false, archivedItemFiles: new Map() };
  }
  return {
    checks: [
      i0,
      ...bundle.items.map((item) => evaluateI1(item, archive)),
      ...bundle.items.map((item) => evaluateI2(item, view)),
      evaluateI3(bundle, archive, view)
    ],
    ready: true,
    archivedItemFiles: files
  };
}

/**
 * Observed install status: exit 0 → installed; `BUNDLE.UNSUPPORTED_CONTENT`
 * → rejected; anything else (including no install) → error.
 * @param install - Install command observation.
 * @returns The status.
 */
export function observedInstallStatus(install: CommandObservation | undefined): InstallStatus {
  if (install?.exitCode === 0) {
    return 'installed';
  }
  return install?.errorCode === UNSUPPORTED_CONTENT ? 'rejected' : 'error';
}

/**
 * Non-bookkeeping labels the install added: the case's destinations.
 * @param observation - Case observation.
 * @returns Sorted labels.
 */
export function placedLabels(observation: CaseObservation): string[] {
  const { beforeInstall = EMPTY_SNAPSHOT, afterInstall = EMPTY_SNAPSHOT } = observation.snapshots;
  return diffSnapshots(beforeInstall, afterInstall).added.filter((label) => !isBookkeepingLabel(label));
}

const isDiagnosticScope = (value: string | null): value is DiagnosticScope =>
  value !== null && (DIAGNOSTIC_SCOPES as readonly string[]).includes(value);

/**
 * Evaluate the case-level invariants. Called only for a ready bundle's case
 * that reached install.
 * @param planned - Planned case.
 * @param bundle - Its bundle.
 * @param evaluation - The bundle's evaluation (archived item files).
 * @param observation - What the case's commands and snapshots produced.
 * @returns Checks in the order I4, I6, I7, I8, I13.
 */
export function evaluateCase(
  planned: PlannedCase,
  bundle: DiagnosticBundle,
  evaluation: BundleEvaluation,
  observation: CaseObservation
): DiagnosticCheck[] {
  const status = observedInstallStatus(observation.install);
  const { beforeInstall = EMPTY_SNAPSHOT, afterInstall = EMPTY_SNAPSHOT, afterUninstall = EMPTY_SNAPSHOT } = observation.snapshots;
  const installDiff = diffSnapshots(beforeInstall, afterInstall);
  const placed = installDiff.added.filter((label) => !isBookkeepingLabel(label));
  const effectiveScope = observation.targetAdd.effectiveScope;
  const checks: DiagnosticCheck[] = [];

  // I4 — install status matches the support matrix.
  const i4Expected = { status: planned.expectedStatus };
  checks.push(status === planned.expectedStatus
    ? { invariant: 'I4', outcome: 'pass', expected: i4Expected }
    : fail('I4', { status, errorCode: status === 'installed' ? null : (observation.install?.errorCode ?? null) },
      withMessages(`install ${status}, expected ${planned.expectedStatus}`, observation.install?.errorMessages ?? []), { expected: i4Expected }));

  // I6 — uninstall removes every placed file.
  if (status === 'installed') {
    const exitCode = observation.uninstall?.exitCode ?? null;
    const remaining = placed.filter((label) => afterUninstall.has(label));
    checks.push(exitCode === 0 && remaining.length === 0
      ? { invariant: 'I6', outcome: 'pass' }
      : fail('I6', { exitCode, remaining }, exitCode === 0
        ? `uninstall left ${remaining.join(', ')}`
        : withMessages(`uninstall exited ${String(exitCode)}`, observation.uninstall?.errorMessages ?? [])));
  } else {
    checks.push(notApplicable('I6', `not applicable: install ${status}`));
  }

  // I7 — a rejected (or failed) install writes nothing user-facing.
  if (status === 'installed') {
    checks.push(notApplicable('I7', 'not applicable: installed'));
  } else {
    const changed = [...new Set([...installDiff.added, ...installDiff.modified, ...installDiff.removed])]
      .filter((label) => !isBookkeepingLabel(label))
      .toSorted();
    checks.push(changed.length === 0
      ? { invariant: 'I7', outcome: 'pass' }
      : fail('I7', { changed }, `install ${status} but changed ${changed.join(', ')}`));
  }

  // I8 — the target honours the requested scope.
  const i8Expected = { effectiveScope: planned.scope };
  checks.push(effectiveScope === planned.scope
    ? { invariant: 'I8', outcome: 'pass', expected: i8Expected }
    : fail('I8', { effectiveScope }, `target add reported scope ${JSON.stringify(effectiveScope)}, requested ${planned.scope}`, { expected: i8Expected }));

  // I13 — every archived installable file lands at its expected destination.
  if (status !== 'installed') {
    checks.push(notApplicable('I13', `not applicable: install ${status}`));
  } else if (bundle.items.every((item) => PLACEMENT_ROUTES[planned.target][item.kind] === 'config')) {
    checks.push(notApplicable('I13', 'not applicable: merged into a config file'));
  } else if (isDiagnosticScope(effectiveScope)) {
    const expected = new Set<string>();
    for (const item of bundle.items) {
      for (const archivePath of evaluation.archivedItemFiles.get(item.path) ?? []) {
        const destination = expectedDestination(planned.target, effectiveScope, item, archivePath);
        if (destination.kind === 'file') {
          expected.add(destination.label);
        }
      }
    }
    const actual = new Set([...installDiff.added, ...installDiff.modified].filter((label) => !isBookkeepingLabel(label)));
    const missing = [...expected].filter((label) => !actual.has(label)).toSorted();
    const unexpected = [...actual].filter((label) => !expected.has(label)).toSorted();
    checks.push(missing.length === 0 && unexpected.length === 0
      ? { invariant: 'I13', outcome: 'pass' }
      : fail('I13', { missing, unexpected }, `placement differs: missing ${missing.join(', ') || '-'}; unexpected ${unexpected.join(', ') || '-'}`));
  } else {
    checks.push(notApplicable('I13', 'unknown effective scope'));
  }

  return checks;
}
