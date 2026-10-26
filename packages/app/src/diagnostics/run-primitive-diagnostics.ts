/**
 * Use case — `doctor diagnostics --primitives`.
 *
 * Orchestration only: preflight, workspace lifecycle, fixture repository,
 * sequential per-bundle validate/build/extract/evaluate/materialise, a
 * bounded case pool with per-case sandbox snapshots, the shared input
 * check and the report. Every rule and expected value (catalogue, matrix,
 * placements, known gaps, evaluators, classifier, report) comes from
 * `@ai-primitives-hub/core`. The outside world is reached only through the
 * injected ports; the use case writes only under `input.workspace`.
 *
 * Workspace layout: `fixture/{home,repo}`, `dist/`, `bundles/<id>/`,
 * `cases/<caseId>/{home,ws}`.
 * @module diagnostics/run-primitive-diagnostics
 */
import * as path from 'node:path';
import {
  assemblePrimitiveReport,
  buildPrimitiveFixture,
  type BundleEvaluation,
  type BundleExtractor,
  type BundleResult,
  type CaseObservation,
  type CaseResult,
  checkSandboxContainment,
  classifyBundle,
  classifyCase,
  type Clock,
  type CommandObservation,
  type DiagnosticBundle,
  type DiagnosticCheck,
  type DiagnosticSandbox,
  diffSnapshots,
  type DriverCommandResult,
  evaluateArchiveModes,
  evaluateBundle,
  evaluateCase,
  evaluateRejectedBundle,
  type FileSystem,
  isBookkeepingLabel,
  type KnownGap,
  NOT_EVALUATED,
  observedInstallStatus,
  placedLabels,
  type PlannedCase,
  PRIMITIVE_FIXTURE_REPOSITORY_URL,
  PRIMITIVE_KNOWN_GAPS,
  type PrimitiveDiagnosticsDriver,
  type PrimitiveDiagnosticsError,
  type PrimitiveDiagnosticsPlan,
  type PrimitiveDiagnosticsReport,
  resolveSandboxLabel,
  type RollupOutcome,
  type Snapshot,
  type SnapshotRoot,
} from '@ai-primitives-hub/core';
import {
  findAncestorFile,
  PRIMITIVE_DIAGNOSTICS_PREFLIGHT_FILES,
} from './find-ancestor-file';
import {
  listExecutableLabels,
  snapshotTree,
} from './sandbox-snapshot';

/** Default bounded case concurrency. */
export const DEFAULT_PRIMITIVE_DIAGNOSTICS_CONCURRENCY = 4;

/** Name of the target every case adds. */
const TARGET_NAME = 'tgt';

/** Maximum length of a harness `detail`. */
const DETAIL_LIMIT = 500;

/** One `-v` progress event: a bundle or case finished. */
export interface PrimitiveDiagnosticsProgressEvent {
  type: 'bundle' | 'case';
  id: string;
  outcome: RollupOutcome;
  gapIds: string[];
}

/** Ports of the use case. */
export interface RunPrimitiveDiagnosticsDeps {
  fs: FileSystem;
  extractor: BundleExtractor;
  driver: PrimitiveDiagnosticsDriver;
  clock: Clock;
  /** Called after each bundle and case; a throw stops the run with `error.step: 'internal'`. */
  onProgress?: (event: PrimitiveDiagnosticsProgressEvent) => void;
  /**
   * Whether `fs` keeps POSIX permission bits. Default true; false (Windows)
   * makes the executable-bit checks (I10) not applicable.
   */
  posixFileModes?: boolean;
}

/** Input of one run. */
export interface RunPrimitiveDiagnosticsInput {
  plan: PrimitiveDiagnosticsPlan;
  /** Absolute, not-yet-existing run workspace chosen by the caller. */
  workspace: string;
  retainWorkspace: boolean;
  /** Bounded case concurrency. Default 4; 1 allowed. */
  concurrency?: number;
  /** Default PRIMITIVE_KNOWN_GAPS. Tests override it; the CLI never sets it. */
  knownGaps?: readonly KnownGap[];
}

/** A bundle whose cases can run. */
interface ReadyBundle {
  evaluation: BundleEvaluation;
  /** Materialised bundle directory: the `--from` input of its cases. */
  from: string;
  baseline: Snapshot;
}

/** A setup step failed; carries the report's `error.step`. */
class SetupError extends Error {
  public constructor(public readonly step: PrimitiveDiagnosticsError['step'], message: string) {
    super(message);
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Label prefix of a materialised bundle's files. */
const BUNDLE_PREFIX = '<bundle>/';

/**
 * Archive paths of materialised bundle labels.
 * @param labels - `<bundle>/…` labels, or undefined.
 * @returns The archive-relative paths, or undefined.
 */
const archivePaths = (labels: ReadonlySet<string> | undefined): ReadonlySet<string> | undefined =>
  (labels === undefined
    ? undefined
    : new Set([...labels].filter((label) => label.startsWith(BUNDLE_PREFIX)).map((label) => label.slice(BUNDLE_PREFIX.length))));

const cap = (detail: string): string => (detail.length > DETAIL_LIMIT ? `${detail.slice(0, DETAIL_LIMIT - 1)}…` : detail);

const harnessFail = (detail: string): DiagnosticCheck => ({ invariant: 'HARNESS', outcome: 'fail', detail: cap(detail) });

/**
 * What a command produced, without its data.
 * @param result - Driver result.
 * @returns Command observation.
 */
const observe = (result: DriverCommandResult): CommandObservation => ({
  exitCode: result.exitCode,
  warnings: result.warnings,
  errorMessages: result.errorMessages,
  ...(result.status === undefined ? {} : { status: result.status }),
  ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
  ...(result.rejectedPaths === undefined ? {} : { rejectedPaths: result.rejectedPaths })
});

/**
 * Run a setup step; any throw becomes a {@link SetupError} of that step.
 * @param step - Report step.
 * @param action - Step body.
 */
const setupStep = async (step: PrimitiveDiagnosticsError['step'], action: () => Promise<void>): Promise<void> => {
  try {
    await action();
  } catch (error) {
    throw error instanceof SetupError ? error : new SetupError(step, messageOf(error));
  }
};

/**
 * Run the primitive diagnostics of a plan.
 * @param deps - Ports.
 * @param input - Plan, workspace and options.
 * @returns The report, in plan order. Never throws for driver or filesystem failures.
 */
export async function runPrimitiveDiagnostics(
  deps: RunPrimitiveDiagnosticsDeps,
  input: RunPrimitiveDiagnosticsInput
): Promise<PrimitiveDiagnosticsReport> {
  const { fs, extractor, driver, clock } = deps;
  const { plan, workspace } = input;
  const gaps = input.knownGaps ?? PRIMITIVE_KNOWN_GAPS;
  const concurrency = Math.max(1, Math.floor(input.concurrency ?? DEFAULT_PRIMITIVE_DIAGNOSTICS_CONCURRENCY));
  const started = clock.now();
  const bundleChecks = new Map<string, DiagnosticCheck[]>();
  const caseResults: CaseResult[] = [];
  const ready = new Map<string, ReadyBundle>();
  const bundleHarnessFailed = new Set<string>();

  const report = async (failure?: PrimitiveDiagnosticsError): Promise<PrimitiveDiagnosticsReport> => {
    let workspaceRetained = true;
    try {
      workspaceRetained = await fs.exists(workspace);
    } catch {
      // Keep `true`: the workspace may still be there.
    }
    const bundleResults: BundleResult[] = [...bundleChecks].map(([id, checks]) => ({ id, checks }));
    return assemblePrimitiveReport(plan, bundleResults, caseResults, gaps, {
      workspace,
      workspaceRetained,
      durationMs: clock.now() - started,
      ...(failure === undefined ? {} : { error: failure })
    });
  };

  // 1. Preflight: reads only, so a hit leaves no trace.
  let stray: string | undefined;
  try {
    stray = await findAncestorFile(fs, path.dirname(workspace), PRIMITIVE_DIAGNOSTICS_PREFLIGHT_FILES);
  } catch (preflightError) {
    return report({ step: 'preflight', message: messageOf(preflightError) });
  }
  if (stray !== undefined) {
    return report({
      step: 'preflight',
      message: `found ${stray} above the diagnostic workspace; remove it or run from a directory outside that project`
    });
  }

  const fixture: DiagnosticSandbox = {
    root: path.join(workspace, 'fixture'),
    cwd: path.join(workspace, 'fixture', 'repo'),
    home: path.join(workspace, 'fixture', 'home')
  };
  const distDir = path.join(workspace, 'dist');
  let runFailure: PrimitiveDiagnosticsError | undefined;

  const emit = (type: PrimitiveDiagnosticsProgressEvent['type'], id: string, outcome: RollupOutcome, gapIds: string[]): void => {
    deps.onProgress?.({ type, id, outcome, gapIds });
  };

  const executableLabels = (root: string, roots: readonly SnapshotRoot[]): Promise<ReadonlySet<string> | undefined> =>
    (deps.posixFileModes === false ? Promise.resolve(undefined) : listExecutableLabels(fs, root, roots));

  // Text of the user-facing files an install added or modified, by label.
  const readInstalledText = async (before: Snapshot, after: Snapshot, roots: readonly SnapshotRoot[]): Promise<ReadonlyMap<string, string>> => {
    const diff = diffSnapshots(before, after);
    const text = new Map<string, string>();
    for (const label of [...diff.added, ...diff.modified].filter((candidate) => !isBookkeepingLabel(candidate))) {
      const absolute = resolveSandboxLabel(roots, label);
      if (absolute !== undefined) {
        text.set(label, await fs.readFile(absolute));
      }
    }
    return text;
  };

  // 4a. An invalid bundle: validate, build, and what the build wrote to the dist dir. Never materialised.
  const runRejectedBundle = async (bundle: DiagnosticBundle): Promise<DiagnosticCheck[]> => {
    const distRoots: readonly SnapshotRoot[] = [{ label: '<dist>', path: distDir }];
    const validate = await driver.validateCollection(fixture, { collectionFile: bundle.collectionFile });
    const before = await snapshotTree(fs, distDir, distRoots);
    const build = await driver.buildBundle(fixture, { collectionFile: bundle.collectionFile, version: bundle.version, outDir: distDir });
    const diff = diffSnapshots(before, await snapshotTree(fs, distDir, distRoots));
    return evaluateRejectedBundle({
      bundle,
      validate: observe(validate),
      build: observe(build),
      distWrites: [...diff.added, ...diff.modified]
    }).checks;
  };

  // 4. One bundle: validate, always build, read + extract, evaluate, materialise.
  const runBundle = async (bundle: DiagnosticBundle): Promise<void> => {
    let evaluated: DiagnosticCheck[] = [];
    try {
      if (bundle.rejection !== undefined) {
        bundleChecks.set(bundle.id, await runRejectedBundle(bundle));
        return;
      }
      const validate = await driver.validateCollection(fixture, { collectionFile: bundle.collectionFile });
      const build = await driver.buildBundle(fixture, { collectionFile: bundle.collectionFile, version: bundle.version, outDir: distDir });
      let archive: ReadonlyMap<string, Uint8Array> | undefined;
      let archiveError: string | undefined;
      let zipPath: string | undefined;
      const zipAsset = build.data?.zipAsset;
      if (build.exitCode === 0 && zipAsset !== undefined && zipAsset !== '') {
        zipPath = path.resolve(fixture.cwd, zipAsset);
        try {
          archive = await extractor.extract(await fs.readFileBytes(zipPath));
        } catch (extractError) {
          archiveError = messageOf(extractError);
        }
      }
      let evaluation = evaluateBundle({
        bundle,
        validate: observe(validate),
        build: observe(build),
        ...(archive === undefined ? {} : { archive }),
        ...(archiveError === undefined ? {} : { archiveError })
      });
      evaluated = evaluation.checks;
      if (evaluation.ready && zipPath !== undefined) {
        const from = path.join(workspace, 'bundles', bundle.id);
        const bundleRoots: readonly SnapshotRoot[] = [{ label: '<bundle>', path: from }];
        await driver.materializeBundle({ zipPath, destination: from });
        evaluation = evaluateArchiveModes(bundle, evaluation, archivePaths(await executableLabels(from, bundleRoots)));
        evaluated = evaluation.checks;
        const baseline = await snapshotTree(fs, from, bundleRoots);
        ready.set(bundle.id, { evaluation, from, baseline });
      }
      bundleChecks.set(bundle.id, evaluated);
    } catch (bundleError) {
      bundleHarnessFailed.add(bundle.id);
      bundleChecks.set(bundle.id, [...evaluated, harnessFail(`bundle ${bundle.id}: ${messageOf(bundleError)}`)]);
    }
  };

  // 5. One case, in its own sandbox. Never throws.
  const runCase = async (planned: PlannedCase): Promise<CaseResult> => {
    const caseStarted = clock.now();
    let effectiveScope: string | null = null;
    const stop = (check: DiagnosticCheck): CaseResult => ({
      id: planned.id,
      effectiveScope,
      status: null,
      checks: [check],
      destinations: [],
      durationMs: clock.now() - caseStarted
    });
    const bundle = plan.bundles.find((candidate) => candidate.id === planned.bundle);
    const source = ready.get(planned.bundle);
    if (bundle === undefined || source === undefined) {
      return stop(bundleHarnessFailed.has(planned.bundle)
        ? harnessFail(`bundle ${planned.bundle} failed in the harness`)
        : { invariant: 'I0', outcome: 'fail', observed: NOT_EVALUATED, detail: `bundle ${planned.bundle} did not build` });
    }
    try {
      const root = path.join(workspace, 'cases', planned.id);
      const sandbox: DiagnosticSandbox = { root, cwd: path.join(root, 'ws'), home: path.join(root, 'home') };
      await fs.mkdir(sandbox.home, { recursive: true });
      await fs.mkdir(sandbox.cwd, { recursive: true });
      const prepared = await driver.prepareSandbox(sandbox);
      const escaped = checkSandboxContainment(prepared);
      if (escaped.length > 0) {
        return stop(harnessFail(`sandbox escapes its case root: ${escaped.join(', ')}`));
      }
      const roots: readonly SnapshotRoot[] = prepared.roots;

      const targetAdd = await driver.addTarget(sandbox, { name: TARGET_NAME, type: planned.target, scope: planned.scope });
      effectiveScope = targetAdd.data?.target.scope ?? null;
      if (targetAdd.exitCode !== 0) {
        const reason = [targetAdd.errorCode, targetAdd.errorMessages[0]].filter((part) => part !== undefined).join(' ');
        return stop(harnessFail(`target add exited ${String(targetAdd.exitCode)}: ${reason}`));
      }

      const beforeInstall = await snapshotTree(fs, root, roots);
      const install = await driver.install(sandbox, { bundleId: bundle.id, from: source.from, target: TARGET_NAME });
      const afterInstall = await snapshotTree(fs, root, roots);
      const observation: CaseObservation = {
        targetAdd: { ...observe(targetAdd), effectiveScope },
        install: observe(install),
        snapshots: { beforeInstall, afterInstall },
        roots
      };
      if (install.exitCode === 0) {
        const executable = await executableLabels(root, roots);
        if (executable !== undefined) {
          observation.executable = executable;
        }
        observation.installedText = await readInstalledText(beforeInstall, afterInstall, roots);
        try {
          observation.uninstall = observe(await driver.uninstall(sandbox, { target: TARGET_NAME }));
        } catch {
          // No uninstall observation: I6 reports the failure.
        }
        observation.snapshots.afterUninstall = await snapshotTree(fs, root, roots);
      }

      return {
        id: planned.id,
        effectiveScope,
        status: observedInstallStatus(observation.install),
        checks: evaluateCase(planned, bundle, source.evaluation, observation),
        destinations: placedLabels(observation),
        durationMs: clock.now() - caseStarted
      };
    } catch (caseError) {
      return stop(harnessFail(`case ${planned.id}: ${messageOf(caseError)}`));
    }
  };

  // 6. A case must not modify the shared materialised input.
  const checkSharedInputs = async (): Promise<void> => {
    for (const [id, source] of ready) {
      const checks = bundleChecks.get(id)!;
      try {
        const after = await snapshotTree(fs, source.from, [{ label: '<bundle>', path: source.from }]);
        const diff = diffSnapshots(source.baseline, after);
        const changed = [...diff.added, ...diff.modified, ...diff.removed].toSorted();
        if (changed.length > 0) {
          checks.push({ invariant: 'HARNESS', outcome: 'fail', observed: { changed }, detail: 'materialised bundle modified by a case' });
        }
      } catch (checkError) {
        checks.push(harnessFail(`shared input check of ${id}: ${messageOf(checkError)}`));
      }
    }
  };

  try {
    // 2. Workspace.
    await setupStep('workspace', async () => {
      await fs.remove(workspace, { recursive: true });
      await fs.mkdir(workspace, { recursive: true });
    });

    // 3. Fixture sandbox and repository.
    await setupStep('sandbox', async () => {
      await fs.mkdir(fixture.home, { recursive: true });
      await fs.mkdir(fixture.cwd, { recursive: true });
      const escaped = checkSandboxContainment(await driver.prepareSandbox(fixture));
      if (escaped.length > 0) {
        throw new Error(`fixture sandbox escapes its root: ${escaped.join(', ')}`);
      }
    });
    await setupStep('fixture', async () => {
      const executableFiles: string[] = [];
      for (const [file, { bytes, mode }] of buildPrimitiveFixture()) {
        const absolute = path.join(fixture.cwd, file);
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFileBytes(absolute, bytes);
        if (mode === 0o755) {
          executableFiles.push(file);
        }
      }
      await driver.commitFixtureRepository(fixture, {
        remoteUrl: PRIMITIVE_FIXTURE_REPOSITORY_URL,
        executableFiles: executableFiles.toSorted()
      });
    });

    // 4. Bundles, sequentially, in plan order.
    for (const bundle of plan.bundles) {
      await runBundle(bundle);
      const classified = classifyBundle(bundle, bundleChecks.get(bundle.id)!, gaps);
      emit('bundle', bundle.id, classified.outcome, classified.gapIds);
    }

    // 5. Cases, through a bounded pool; results by plan index.
    const results: (CaseResult | undefined)[] = Array.from({ length: plan.cases.length });
    let next = 0;
    let stopped = false;
    const worker = async (): Promise<void> => {
      while (!stopped && next < plan.cases.length) {
        const index = next++;
        const planned = plan.cases[index];
        const result = await runCase(planned);
        results[index] = result;
        try {
          const classified = classifyCase(planned, result.checks, gaps);
          emit('case', planned.id, classified.outcome, classified.gapIds);
        } catch (progressError) {
          stopped = true;
          throw progressError;
        }
      }
    };
    const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, plan.cases.length) }, () => worker()));
    caseResults.push(...results.filter((result): result is CaseResult => result !== undefined));
    const rejected = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (rejected !== undefined) {
      throw rejected.reason;
    }

    // 6. Shared input check.
    await checkSharedInputs();
  } catch (runError) {
    runFailure = runError instanceof SetupError
      ? { step: runError.step, message: runError.message }
      : { step: 'internal', message: messageOf(runError) };
  } finally {
    // 8. Cleanup, best effort.
    if (!input.retainWorkspace) {
      try {
        await fs.remove(workspace, { recursive: true });
      } catch {
        // `workspaceRetained` reports what is left.
      }
    }
  }

  // 7. Report.
  return report(runFailure);
}
