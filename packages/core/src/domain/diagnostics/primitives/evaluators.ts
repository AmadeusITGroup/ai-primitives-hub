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
 * Bundle checks run in the order I0, I1 (per item), I2 (per item), I3,
 * then I10 (per item with executable files) once materialised; an invalid
 * bundle has the single check I5. Case checks run in the order I4, I6,
 * I7, I8, I9 (per item when items were left out), I10 (per item with
 * executable files), I11 and I12 (per plugin item), I13, I14 (per plugin
 * item), then I15 for a `--skip-unsupported` case only. With
 * `--skip-unsupported`, I10 to I14 judge the installed items only: those
 * none of whose archived files were skipped. I9 judges which items should
 * have been skipped.
 * @module domain/diagnostics/primitives/evaluators
 */
import type {
  SnapshotRoot,
} from '../../../ports/primitive-diagnostics-driver';
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
import {
  isKindRouteMismatchWarning,
} from '../../install/kind-route';
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
  evaluatePluginProjection,
  type PluginProjection,
} from './plugin-projection';
import {
  diffSnapshots,
  isBookkeepingLabel,
  type Snapshot,
} from './sandbox';
import {
  PRIMITIVE_SUPPORT_MATRIX,
} from './support-matrix';
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
  /** Archive paths that are executable in the materialised archive; absent when unknown. Input to the case-level I10. */
  executableArchivePaths?: ReadonlySet<string>;
}

/** What one case's commands and snapshots produced. */
export interface CaseObservation {
  targetAdd: CommandObservation & { effectiveScope: string | null };
  install?: CommandObservation;
  uninstall?: CommandObservation;
  snapshots: { beforeInstall?: Snapshot; afterInstall?: Snapshot; afterUninstall?: Snapshot };
  /** Labels of the executable files after install; absent when the platform reports no permission bits. */
  executable?: ReadonlySet<string>;
  /** Text of the files the install added or modified (non-bookkeeping), by label. */
  installedText?: ReadonlyMap<string, string>;
  /** Snapshot roots of the case, to resolve labels to absolute paths. */
  roots?: readonly SnapshotRoot[];
  /**
   * Sorted archive paths the install's lockfile records for the bundle
   * (`--skip-unsupported` cases only); absent when it was not read.
   */
  lockedFiles?: readonly string[];
}

/**
 * Observed install status of a case. `partial`: a `--skip-unsupported`
 * install succeeded and left content out.
 */
export type InstallStatus = 'installed' | 'partial' | 'rejected' | 'error';

const cap = (detail: string): string => (detail.length > DETAIL_LIMIT ? `${detail.slice(0, DETAIL_LIMIT - 1)}…` : detail);

const withMessages = (reason: string, messages: readonly string[]): string =>
  cap(messages.length > 0 ? `${reason}: ${messages.join('; ')}` : reason);

const scalar = (value: unknown): JsonValue =>
  (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null);

const fail = (invariant: InvariantId, observed: JsonValue, detail: string, extra: Partial<DiagnosticCheck> = {}): DiagnosticCheck =>
  ({ invariant, outcome: 'fail', ...extra, observed, detail: cap(detail) });

const notApplicable = (invariant: InvariantId, detail: string): DiagnosticCheck =>
  ({ invariant, outcome: 'not-applicable', detail });

/** Why the case-level I10 does not apply when no executable file was placed. */
const NO_EXECUTABLE_PLACED = 'not applicable: no executable file was placed';

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
    // Kind/route mismatches are warnings only (ADR-0009): the check passes.
    const routeWarnings = validate.warnings.filter((warning) => isKindRouteMismatchWarning(warning));
    return { invariant: 'I0', outcome: 'pass', ...(routeWarnings.length > 0 ? { warnings: routeWarnings } : {}) };
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
 * Bundle-level I10: each item's executable fixture files are executable in
 * the materialised archive. One check per item that declares executable
 * files (files the build dropped are I1's concern); a single
 * not-applicable check when the modes are unknown.
 * @param bundle - Catalogue bundle.
 * @param evaluation - Its ready evaluation.
 * @param executable - Archive paths that are executable after materialising; undefined when unknown.
 * @returns The evaluation with the I10 checks appended and `executableArchivePaths` set.
 */
export function evaluateArchiveModes(
  bundle: DiagnosticBundle,
  evaluation: BundleEvaluation,
  executable: ReadonlySet<string> | undefined
): BundleEvaluation {
  const items = bundle.items.filter((item) => item.executable.length > 0);
  if (items.length === 0) {
    return evaluation;
  }
  if (executable === undefined) {
    return { ...evaluation, checks: [...evaluation.checks, notApplicable('I10', 'not applicable: no permission bits on this platform')] };
  }
  const checks = items.map((item): DiagnosticCheck => {
    const archived = evaluation.archivedItemFiles.get(item.path) ?? [];
    const notExecutable = item.executable.filter((file) => archived.includes(file) && !executable.has(file));
    return notExecutable.length === 0
      ? { invariant: 'I10', outcome: 'pass', item: item.path }
      : fail('I10', { notExecutable }, `not executable in the archive: ${notExecutable.join(', ')}`, { item: item.path });
  });
  return { ...evaluation, checks: [...evaluation.checks, ...checks], executableArchivePaths: executable };
}

/** Inputs of the invalid-bundle invariant (I5). */
export interface RejectedBundleEvaluationInput {
  /** A bundle with `rejection`. */
  bundle: DiagnosticBundle;
  validate: CommandObservation;
  build: CommandObservation;
  /** Sorted `<dist>/…` labels the build added to or changed in the dist directory. */
  distWrites: readonly string[];
}

/**
 * Evaluate an invalid bundle (I5): `collection validate` and `bundle build`
 * both reject it with the documented message, the build with the documented
 * error code, and no archive is written. Its only check; it is never ready.
 * @param input - What validate and build produced, and what the build wrote.
 * @returns The I5 check; not ready; no archived files.
 * @throws {Error} When the bundle declares no rejection.
 */
export function evaluateRejectedBundle(input: RejectedBundleEvaluationInput): BundleEvaluation {
  const { bundle, validate, build, distWrites } = input;
  const { rejection } = bundle;
  if (rejection === undefined) {
    throw new Error(`bundle ${bundle.id} declares no rejection`);
  }
  const expected = {
    validateRejected: true,
    validateReported: true,
    buildRejected: true,
    buildErrorCode: rejection.errorCode,
    buildReported: true,
    written: [] as string[]
  };
  const observed = {
    validateRejected: validate.exitCode !== 0,
    validateReported: validate.errorMessages.includes(rejection.message),
    buildRejected: build.exitCode !== 0,
    buildErrorCode: build.errorCode ?? null,
    buildReported: build.errorMessages.includes(rejection.message),
    written: [...distWrites].toSorted()
  };
  const reasons = [
    observed.validateRejected ? undefined : 'collection validate accepted the bundle',
    observed.validateRejected && !observed.validateReported ? withMessages('collection validate reported another message', validate.errorMessages) : undefined,
    observed.buildRejected ? undefined : 'bundle build accepted the bundle',
    observed.buildRejected && observed.buildErrorCode !== rejection.errorCode
      ? `bundle build failed with ${JSON.stringify(observed.buildErrorCode)}, expected ${rejection.errorCode}`
      : undefined,
    observed.buildRejected && !observed.buildReported ? withMessages('bundle build reported another message', build.errorMessages) : undefined,
    observed.written.length > 0 ? `bundle build wrote ${observed.written.join(', ')}` : undefined
  ].filter((reason): reason is string => reason !== undefined);
  const check: DiagnosticCheck = reasons.length === 0
    ? { invariant: 'I5', outcome: 'pass', expected }
    : fail('I5', observed, `${reasons.join('; ')}; expected: ${rejection.message}`, { expected });
  return { checks: [check], ready: false, archivedItemFiles: new Map() };
}

/**
 * Observed install status: exit 0 → partial when the install listed skipped
 * content, else installed; `BUNDLE.UNSUPPORTED_CONTENT` → rejected;
 * anything else (including no install) → error.
 * @param install - Install command observation.
 * @returns The status.
 */
export function observedInstallStatus(install: CommandObservation | undefined): InstallStatus {
  if (install?.exitCode === 0) {
    return (install.skipped?.length ?? 0) > 0 ? 'partial' : 'installed';
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

/**
 * I9, one check per item: the item is left out exactly when the target does
 * not support its kind. A rejected install leaves out the items it lists
 * as rejected paths; a successful `--skip-unsupported` install leaves out
 * the items it lists as skipped (an absent list counts as empty). An item
 * is left out when any of its archived files is listed; `rejected: null`
 * when a rejection did not list its paths. Listed paths of no item are
 * named in the first check's detail.
 * @param planned - Planned case.
 * @param bundle - Its bundle.
 * @param evaluation - The bundle's evaluation (archived item files).
 * @param install - Install observation.
 * @param status - Observed install status.
 * @returns One check per item, or one not-applicable check when no item could be left out.
 */
const evaluateRejectedItems = (
  planned: PlannedCase,
  bundle: DiagnosticBundle,
  evaluation: BundleEvaluation,
  install: CommandObservation | undefined,
  status: InstallStatus
): DiagnosticCheck[] => {
  const skipping = planned.mode === 'skip-unsupported' && (status === 'installed' || status === 'partial');
  if (status !== 'rejected' && !skipping) {
    return [notApplicable('I9', `not applicable: install ${status}`)];
  }
  const rejectedPaths = skipping ? (install?.skipped ?? []).map((entry) => entry.path) : install?.rejectedPaths;
  const listed = new Set(rejectedPaths);
  const owned = new Set<string>();
  const checks = bundle.items.map((item): DiagnosticCheck => {
    const files = evaluation.archivedItemFiles.get(item.path) ?? [];
    for (const file of files) {
      owned.add(file);
    }
    const expected = { rejected: PRIMITIVE_SUPPORT_MATRIX[item.kind]?.[planned.target] === 'unsupported' };
    const rejected = rejectedPaths === undefined ? null : files.some((file) => listed.has(file));
    if (rejected === expected.rejected) {
      return { invariant: 'I9', outcome: 'pass', item: item.path, expected };
    }
    const [leftOut, kept] = skipping ? ['skipped', 'did not skip'] : ['rejected', 'did not reject'];
    const reason = rejected === null
      ? 'install did not list the rejected content'
      : `install ${rejected ? leftOut : kept} ${item.kind} item ${item.path}`;
    return fail('I9', { rejected }, reason, { item: item.path, expected });
  });
  const stray = [...listed].filter((p) => !owned.has(p)).toSorted();
  if (stray.length > 0 && checks.length > 0) {
    const [first] = checks;
    checks[0] = { ...first, detail: cap(`${first.detail === undefined ? '' : `${first.detail}; `}${skipping ? 'skipped' : 'rejected'} paths of no item: ${stray.join(', ')}`) };
  }
  return checks;
};

const isDiagnosticScope = (value: string | null): value is DiagnosticScope =>
  value !== null && (DIAGNOSTIC_SCOPES as readonly string[]).includes(value);

/**
 * Items a successful install placed: those none of whose archived files it
 * listed as skipped. Every item when nothing was skipped (the default mode).
 * @param bundle - Its bundle.
 * @param evaluation - The bundle's evaluation (archived item files).
 * @param install - Install observation.
 * @returns The installed items, in bundle order.
 */
const installedItems = (bundle: DiagnosticBundle, evaluation: BundleEvaluation, install: CommandObservation | undefined): FixtureItem[] => {
  const skipped = new Set((install?.skipped ?? []).map((entry) => entry.path));
  return skipped.size === 0
    ? [...bundle.items]
    : bundle.items.filter((item) => !(evaluation.archivedItemFiles.get(item.path) ?? []).some((file) => skipped.has(file)));
};

/**
 * I15, `--skip-unsupported` cases only: each skipped file is reported with
 * the unsupported-content code and a reason, and the lockfile records
 * exactly the archived item files that were not skipped.
 * @param evaluation - The bundle's evaluation (archived item files).
 * @param observation - Case observation.
 * @param status - Observed install status.
 * @returns The I15 check.
 */
const evaluateLockfile = (evaluation: BundleEvaluation, observation: CaseObservation, status: InstallStatus): DiagnosticCheck => {
  if (status !== 'installed' && status !== 'partial') {
    return notApplicable('I15', `not applicable: install ${status}`);
  }
  const skipped = observation.install?.skipped ?? [];
  const skippedPaths = new Set(skipped.map((entry) => entry.path));
  const unreasoned = skipped
    .filter((entry) => entry.code !== UNSUPPORTED_CONTENT || entry.reason.trim() === '')
    .map((entry) => entry.path)
    .toSorted();
  const installedFiles = new Set([...evaluation.archivedItemFiles.values()].flat().filter((file) => !skippedPaths.has(file)));
  const locked = observation.lockedFiles === undefined ? undefined : new Set(observation.lockedFiles);
  const missing = locked === undefined ? null : [...installedFiles].filter((file) => !locked.has(file)).toSorted();
  const unexpected = locked === undefined ? null : [...locked].filter((file) => !installedFiles.has(file)).toSorted();
  const expected = { unreasoned: [], missing: [], unexpected: [] };
  if (unreasoned.length === 0 && missing?.length === 0 && unexpected?.length === 0) {
    return { invariant: 'I15', outcome: 'pass', expected };
  }
  const reasons = [
    unreasoned.length > 0 ? `skipped without the ${UNSUPPORTED_CONTENT} reason: ${unreasoned.join(', ')}` : undefined,
    locked === undefined ? 'the install lockfile could not be read' : undefined,
    (missing?.length ?? 0) > 0 ? `lockfile does not record ${missing!.join(', ')}` : undefined,
    (unexpected?.length ?? 0) > 0 ? `lockfile records ${unexpected!.join(', ')}` : undefined
  ].filter((reason): reason is string => reason !== undefined);
  return fail('I15', { unreasoned, missing, unexpected }, reasons.join('; '), { expected });
};

/**
 * Evaluate the case-level invariants. Called only for a ready bundle's case
 * that reached install.
 * @param planned - Planned case.
 * @param bundle - Its bundle.
 * @param evaluation - The bundle's evaluation (archived item files).
 * @param observation - What the case's commands and snapshots produced.
 * @returns Checks in the order I4, I6, I7, I8, I9, I10, I11, I12, I13, I14, I15
 * (I10 only for bundles with executable files, I11, I12 and I14 only for bundles with a plugin item,
 * I15 only for `--skip-unsupported` cases).
 */
export function evaluateCase(
  planned: PlannedCase,
  bundle: DiagnosticBundle,
  evaluation: BundleEvaluation,
  observation: CaseObservation
): DiagnosticCheck[] {
  const status = observedInstallStatus(observation.install);
  const succeeded = status === 'installed' || status === 'partial';
  const { beforeInstall = EMPTY_SNAPSHOT, afterInstall = EMPTY_SNAPSHOT, afterUninstall = EMPTY_SNAPSHOT } = observation.snapshots;
  const installDiff = diffSnapshots(beforeInstall, afterInstall);
  const placed = installDiff.added.filter((label) => !isBookkeepingLabel(label));
  const effectiveScope = observation.targetAdd.effectiveScope;
  const checks: DiagnosticCheck[] = [];

  // I4 — install status matches the support matrix for the install mode.
  const i4Expected = { status: planned.expectedStatus };
  checks.push(status === planned.expectedStatus
    ? { invariant: 'I4', outcome: 'pass', expected: i4Expected }
    : fail('I4', { status, errorCode: succeeded ? null : (observation.install?.errorCode ?? null) },
      withMessages(`install ${status}, expected ${planned.expectedStatus}`, observation.install?.errorMessages ?? []), { expected: i4Expected }));

  // I6 — uninstall removes every placed file.
  if (succeeded) {
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
  if (succeeded) {
    checks.push(notApplicable('I7', status === 'installed' ? 'not applicable: installed' : 'not applicable: install partial'));
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
  const i8: DiagnosticCheck = effectiveScope === planned.scope
    ? { invariant: 'I8', outcome: 'pass', expected: i8Expected }
    : fail('I8', { effectiveScope }, `target add reported scope ${JSON.stringify(effectiveScope)}, requested ${planned.scope}`, { expected: i8Expected });

  // I9 — the install leaves out exactly the items of the kinds the target does not support.
  checks.push(i8, ...evaluateRejectedItems(planned, bundle, evaluation, observation.install, status));

  const actual = new Set([...installDiff.added, ...installDiff.modified].filter((label) => !isBookkeepingLabel(label)));
  const scope = isDiagnosticScope(effectiveScope) ? effectiveScope : undefined;
  // Why the post-install checks (I10–I12, I14) do not apply, when they do not.
  const skipReason = succeeded ? (scope === undefined ? 'unknown effective scope' : undefined) : `not applicable: install ${status}`;
  // I10–I14 judge what was installed; which items should have been skipped is I9's concern.
  const items = succeeded ? installedItems(bundle, evaluation, observation.install) : [...bundle.items];

  // I10 — executable files stay executable where the install places them.
  checks.push(...evaluateInstalledModes(planned, bundle, items, evaluation, observation, actual, scope, skipReason));

  // I11, I12 (and I14 below) — plugin components are projected, and ${PLUGIN_ROOT} resolved.
  const projection = evaluateCaseProjection(planned, bundle, items, evaluation, observation, actual, scope, skipReason);
  checks.push(...projection.skills, ...projection.servers);

  // I13 — every archived installable file of an installed item lands at its expected destination.
  if (!succeeded) {
    checks.push(notApplicable('I13', `not applicable: install ${status}`));
  } else if (items.every((item) => PLACEMENT_ROUTES[planned.target][item.kind] === 'config')) {
    checks.push(notApplicable('I13', 'not applicable: merged into a config file'));
  } else if (scope === undefined) {
    checks.push(notApplicable('I13', 'unknown effective scope'));
  } else {
    const expected = new Set<string>();
    for (const item of items) {
      for (const archivePath of evaluation.archivedItemFiles.get(item.path) ?? []) {
        const destination = expectedDestination(planned.target, scope, item, archivePath);
        if (destination.kind === 'file') {
          expected.add(destination.label);
        }
      }
    }
    const missing = [...expected].filter((label) => !actual.has(label)).toSorted();
    const unexpected = [...actual].filter((label) => !expected.has(label) && !projection.projected.has(label)).toSorted();
    checks.push(missing.length === 0 && unexpected.length === 0
      ? { invariant: 'I13', outcome: 'pass' }
      : fail('I13', { missing, unexpected }, `placement differs: missing ${missing.join(', ') || '-'}; unexpected ${unexpected.join(', ') || '-'}`));
  }

  checks.push(...projection.resolution);

  // I15 — a --skip-unsupported install reports what it skipped, and its lockfile records what it installed.
  if (planned.mode === 'skip-unsupported') {
    checks.push(evaluateLockfile(evaluation, observation, status));
  }
  return checks;
}

/**
 * Case-level I10: each executable archive file of an installed item is
 * executable where the install placed it. Files that are not executable in
 * the archive (bundle-level I10) or were not placed (I13) are not counted.
 * Only for bundles with executable fixture files.
 * @param planned - Planned case.
 * @param bundle - Its bundle.
 * @param installed - Items the install placed (every item unless some were skipped).
 * @param evaluation - The bundle's evaluation.
 * @param observation - Case observation.
 * @param placed - Non-bookkeeping labels the install added or modified.
 * @param scope - Effective scope, when the install succeeded and the scope is known.
 * @param notApplicableReason - Why the check does not apply, when it does not.
 * @returns One check per item with executable archive files, or a single not-applicable check.
 */
const evaluateInstalledModes = (
  planned: PlannedCase,
  bundle: DiagnosticBundle,
  installed: readonly FixtureItem[],
  evaluation: BundleEvaluation,
  observation: CaseObservation,
  placed: ReadonlySet<string>,
  scope: DiagnosticScope | undefined,
  notApplicableReason: string | undefined
): DiagnosticCheck[] => {
  if (!bundle.items.some((item) => item.executable.length > 0)) {
    return [];
  }
  if (notApplicableReason !== undefined || scope === undefined) {
    return [notApplicable('I10', notApplicableReason ?? 'unknown effective scope')];
  }
  const items = installed.filter((item) => item.executable.length > 0);
  if (items.length === 0) {
    return [notApplicable('I10', NO_EXECUTABLE_PLACED)];
  }
  const inArchive = evaluation.executableArchivePaths;
  const executable = observation.executable;
  if (inArchive === undefined || executable === undefined) {
    return [notApplicable('I10', 'not applicable: no permission bits on this platform')];
  }
  const checks: DiagnosticCheck[] = [];
  for (const item of items) {
    const destinations = item.executable.filter((file) => inArchive.has(file)).flatMap((file) => {
      const destination = expectedDestination(planned.target, scope, item, file);
      return destination.kind === 'file' && placed.has(destination.label) ? [[file, destination.label] as const] : [];
    });
    if (destinations.length === 0) {
      continue;
    }
    const notExecutable = destinations.filter(([, label]) => !executable.has(label)).map(([file]) => file);
    checks.push(notExecutable.length === 0
      ? { invariant: 'I10', outcome: 'pass', item: item.path }
      : fail('I10', { notExecutable }, `installed without the executable bit: ${notExecutable.join(', ')}`, { item: item.path }));
  }
  return checks.length === 0 ? [notApplicable('I10', NO_EXECUTABLE_PLACED)] : checks;
};

/**
 * I11, I12 and I14 of a case: only for bundles with plugin items, over
 * the plugin items the install placed; not applicable when it skipped them all.
 * @param planned - Planned case.
 * @param bundle - Its bundle.
 * @param installed - Items the install placed (every item unless some were skipped).
 * @param evaluation - The bundle's evaluation.
 * @param observation - Case observation.
 * @param changed - Non-bookkeeping labels the install added or modified.
 * @param scope - Effective scope, when the install succeeded and the scope is known.
 * @param notApplicableReason - Why the checks do not apply, when they do not.
 * @returns The projection checks (empty for a bundle without plugin items).
 */
const evaluateCaseProjection = (
  planned: PlannedCase,
  bundle: DiagnosticBundle,
  installed: readonly FixtureItem[],
  evaluation: BundleEvaluation,
  observation: CaseObservation,
  changed: ReadonlySet<string>,
  scope: DiagnosticScope | undefined,
  notApplicableReason: string | undefined
): PluginProjection => {
  if (!bundle.items.some((item) => item.plugin !== undefined)) {
    return { skills: [], servers: [], resolution: [], projected: new Set() };
  }
  const items = installed.filter((item) => item.plugin !== undefined);
  if (notApplicableReason !== undefined || scope === undefined || items.length === 0) {
    const reason = notApplicableReason ?? (scope === undefined ? 'unknown effective scope' : 'not applicable: plugin skipped');
    return { skills: [notApplicable('I11', reason)], servers: [notApplicable('I12', reason)], resolution: [notApplicable('I14', reason)], projected: new Set() };
  }
  return evaluatePluginProjection({
    target: planned.target,
    scope,
    items,
    archivedItemFiles: evaluation.archivedItemFiles,
    changed,
    installedText: observation.installedText ?? new Map(),
    ...(observation.roots === undefined ? {} : { roots: observation.roots })
  });
};
