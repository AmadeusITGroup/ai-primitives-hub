/**
 * `runPrimitiveDiagnostics` tests: the orchestration of `doctor diagnostics
 * --primitives` against a scripted fake driver on an in-memory filesystem.
 * The use case and core run for real; only the driver, the extractor and
 * the filesystem are doubles.
 */
import * as path from 'node:path';
import {
  buildPrimitiveFixture,
  type BundleExtractor,
  NOT_EVALUATED,
  planPrimitiveDiagnostics,
  PRIMITIVE_FIXTURE_REPOSITORY_URL,
  PRIMITIVE_KNOWN_GAPS,
  type PrimitiveDiagnosticsFilters,
  type PrimitiveDiagnosticsReport,
} from '@ai-primitives-hub/core';
import {
  LAYOUTS_CONFIG_FILE,
} from '@ai-primitives-hub/infra';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  LOCAL_LOCKFILE_NAME,
  LOCKFILE_NAME,
  runPrimitiveDiagnostics,
  type RunPrimitiveDiagnosticsDeps,
  type RunPrimitiveDiagnosticsInput,
} from '../../src';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';
import {
  createCountingClock,
  createFakeExtractor,
  createThrowingExtractor,
  FakePrimitiveDriver,
} from './fake-primitive-driver';

// Native absolute path: gains the drive on win32, as the use case's own
// `path.resolve` calls do, so in-memory paths match on every platform.
const WORKSPACE = path.resolve('/sandbox/run/aph-doctor-1');
const PROMPT = 'aph-e2e-only-prompt';
const HOOK = 'aph-e2e-only-hook';

interface Harness {
  fs: InMemoryFileSystem;
  driver: FakePrimitiveDriver;
  deps: RunPrimitiveDiagnosticsDeps;
}

const harness = (extractor?: BundleExtractor): Harness => {
  const fs = new InMemoryFileSystem();
  const driver = new FakePrimitiveDriver(fs);
  return {
    fs,
    driver,
    deps: { fs, driver, extractor: extractor ?? createFakeExtractor(driver.archives), clock: createCountingClock() }
  };
};

const run = (
  h: Harness,
  filters: PrimitiveDiagnosticsFilters,
  input: Partial<RunPrimitiveDiagnosticsInput> = {}
): Promise<PrimitiveDiagnosticsReport> =>
  runPrimitiveDiagnostics(h.deps, { plan: planPrimitiveDiagnostics(filters), workspace: WORKSPACE, retainWorkspace: false, ...input });

const caseById = (report: PrimitiveDiagnosticsReport, id: string): PrimitiveDiagnosticsReport['cases'][number] =>
  report.cases.find((c) => c.id === id)!;

const withoutDurations = (report: PrimitiveDiagnosticsReport): unknown =>
  ({ ...report, durationMs: 0, cases: report.cases.map((c) => ({ ...c, durationMs: 0 })) });

/**
 * Deterministic pseudo-random delays of 0-5 ms (Park-Miller LCG).
 * @param seed - Positive seed.
 * @returns Delay generator.
 */
const randomDelays = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state * 48_271) % 2_147_483_647;
    return state % 6;
  };
};

const MIXED: PrimitiveDiagnosticsFilters = { kinds: ['prompt', 'skill', 'steering'], targets: ['vscode', 'kiro', 'claude-code'] };

describe('runPrimitiveDiagnostics', () => {
  describe('a healthy product', () => {
    it('passes every bundle and case, in plan order, and cleans up', async () => {
      const h = harness();
      const plan = planPrimitiveDiagnostics(MIXED);

      const report = await runPrimitiveDiagnostics(h.deps, { plan, workspace: WORKSPACE, retainWorkspace: false });

      expect(report.error).toBeUndefined();
      expect(report.bundles.map((b) => b.id)).toEqual(plan.bundles.map((b) => b.id));
      expect(report.cases.map((c) => c.id)).toEqual(plan.cases.map((c) => c.id));
      expect(report.summary).toEqual({ cases: 18, pass: 18, knownGap: 0, fail: 0, bundles: { bundles: 3, pass: 3, knownGap: 0, fail: 0 } });
      expect(report.ok).toBe(true);
      expect(caseById(report, `${PROMPT}__vscode__user`)).toMatchObject({
        status: 'installed',
        effectiveScope: 'user',
        destinations: ['$HOME/.copilot/prompts/hello-world.prompt.md']
      });
      expect(caseById(report, 'aph-e2e-only-steering__vscode__repository')).toMatchObject({ status: 'rejected', outcome: 'pass', destinations: [] });
      expect(report.workspace).toBe(WORKSPACE);
      expect(report.workspaceRetained).toBe(false);
      await expect(h.fs.exists(WORKSPACE)).resolves.toBe(false);
    });

    it('keeps plan order under randomised completion, and concurrency 1 and 4 agree minus durations', async () => {
      const serial = harness();
      serial.driver.installDelay = randomDelays(7);
      const parallel = harness();
      parallel.driver.installDelay = randomDelays(7);
      const completion: string[] = [];
      parallel.deps.onProgress = (event) => {
        if (event.type === 'case') {
          completion.push(event.id);
        }
      };

      const one = await run(serial, MIXED, { concurrency: 1 });
      const four = await run(parallel, MIXED, { concurrency: 4 });

      const planned = planPrimitiveDiagnostics(MIXED).cases.map((c) => c.id);
      expect(completion).not.toEqual(planned);
      expect(completion.toSorted()).toEqual(planned.toSorted());
      expect(four.cases.map((c) => c.id)).toEqual(planned);
      expect(withoutDurations(four)).toEqual(withoutDurations(one));
    });

    it('writes the fixture under fixture/repo, creating each parent before the file, then commits it', async () => {
      const h = harness();
      const mkdir = vi.spyOn(h.fs, 'mkdir');
      const write = vi.spyOn(h.fs, 'writeFileBytes');

      await run(h, { kinds: ['prompt'], targets: ['vscode'] }, { retainWorkspace: true });

      const repo = path.join(WORKSPACE, 'fixture', 'repo');
      for (const [file, { bytes }] of buildPrimitiveFixture()) {
        const absolute = path.join(repo, file);
        await expect(h.fs.readFileBytes(absolute)).resolves.toEqual(bytes);
        const writeCall = write.mock.calls.findIndex(([p]) => p === absolute);
        const mkdirCall = mkdir.mock.calls.findIndex(([p, opts]) => p === path.dirname(absolute) && opts?.recursive === true);
        expect(mkdirCall, file).toBeGreaterThanOrEqual(0);
        expect(mkdir.mock.invocationCallOrder[mkdirCall]).toBeLessThan(write.mock.invocationCallOrder[writeCall]);
      }
      const executableFiles = [...buildPrimitiveFixture()].filter(([, file]) => file.mode === 0o755).map(([file]) => file).toSorted();
      expect(executableFiles).toContain('skills/standalone-skill/scripts/run.sh');
      expect(h.driver.callsOf('commitFixtureRepository')).toEqual([{
        method: 'commitFixtureRepository',
        input: { remoteUrl: PRIMITIVE_FIXTURE_REPOSITORY_URL, executableFiles },
        root: path.join(WORKSPACE, 'fixture')
      }]);
    });

    it('materialises each bundle once and installs by catalogue id from it', async () => {
      const h = harness();

      await run(h, MIXED);

      const plan = planPrimitiveDiagnostics(MIXED);
      expect(h.driver.callsOf('materializeBundle').map((call) => call.input)).toEqual(plan.bundles.map((bundle) => ({
        zipPath: path.join(WORKSPACE, 'dist', `${bundle.id}-1.0.0.zip`),
        destination: path.join(WORKSPACE, 'bundles', bundle.id)
      })));
      const installs = h.driver.callsOf('install');
      expect(installs).toHaveLength(plan.cases.length);
      for (const call of installs) {
        const planned = plan.cases.find((c) => path.join(WORKSPACE, 'cases', c.id) === call.root)!;
        expect(call.input).toEqual({ bundleId: planned.bundle, from: path.join(WORKSPACE, 'bundles', planned.bundle), target: 'tgt' });
      }
      expect(h.driver.callsOf('addTarget').map((call) => call.input)).toEqual(
        expect.arrayContaining([{ name: 'tgt', type: 'kiro', scope: 'repository' }])
      );
    });
  });

  describe('bundle failures', () => {
    it('builds after a failing validate and cascades the I0 failure to the bundle and its cases', async () => {
      const h = harness();
      h.driver.onValidate = (collectionFile) => ({
        exitCode: 1,
        status: 'error',
        warnings: [],
        errorMessages: [`${collectionFile}: items[0] referenced file not found: prompts/x.md`]
      });

      const report = await run(h, { kinds: ['prompt'], targets: ['vscode'] });

      expect(h.driver.callsOf('validateCollection')).toHaveLength(1);
      expect(h.driver.callsOf('buildBundle')).toHaveLength(1);
      const [bundle] = report.bundles;
      expect(bundle.outcome).toBe('fail');
      expect(bundle.checks.map((c) => [c.invariant, c.outcome])).toEqual([['I0', 'fail'], ['I1', 'fail'], ['I2', 'fail'], ['I3', 'fail']]);
      expect(bundle.checks[0].observed).toMatchObject({ validateExit: 1, buildExit: 0, firstError: { command: 'validate', code: null } });
      expect(bundle.checks.slice(1).map((c) => c.observed)).toEqual([NOT_EVALUATED, NOT_EVALUATED, NOT_EVALUATED]);
      for (const c of report.cases) {
        expect(c).toMatchObject({
          status: null,
          effectiveScope: null,
          destinations: [],
          outcome: 'fail',
          checks: [{ invariant: 'I0', outcome: 'fail', observed: NOT_EVALUATED, detail: `bundle ${PROMPT} did not build` }]
        });
      }
      expect(h.driver.callsOf('materializeBundle')).toEqual([]);
      expect(h.driver.callsOf('addTarget')).toEqual([]);
      expect(report.ok).toBe(false);
    });

    it('reports an unreadable zip as I0 manifestPresent false', async () => {
      const h = harness(createThrowingExtractor('corrupt zip: bad central directory'));

      const report = await run(h, { kinds: ['prompt'], targets: ['vscode'], scopes: ['user'] });

      const [i0] = report.bundles[0].checks;
      expect(i0).toMatchObject({ invariant: 'I0', outcome: 'fail', observed: { manifestPresent: false, buildExit: 0, validateExit: 0 } });
      expect(i0.detail).toContain('corrupt zip: bad central directory');
      expect(report.cases[0].checks).toEqual([{ invariant: 'I0', outcome: 'fail', observed: NOT_EVALUATED, detail: `bundle ${PROMPT} did not build` }]);
    });

    it('gives a bundle HARNESS failure when materialising throws, and its cases the HARNESS stop shape', async () => {
      const h = harness();
      h.driver.materializeBundle = () => Promise.reject(new Error('disk full'));

      const report = await run(h, { kinds: ['prompt'], targets: ['vscode'], scopes: ['user'] });

      const harnessCheck = report.bundles[0].checks.at(-1)!;
      expect(harnessCheck).toMatchObject({ invariant: 'HARNESS', outcome: 'fail' });
      expect(harnessCheck.detail).toContain('disk full');
      expect(report.cases[0]).toMatchObject({ status: null, destinations: [], checks: [{ invariant: 'HARNESS', outcome: 'fail' }] });
      expect(h.driver.callsOf('install')).toEqual([]);
    });

    it('fails the bundle with HARNESS when a case writes into the shared materialised input', async () => {
      const h = harness();
      h.driver.onInstall = (call) => {
        h.fs.seed(path.join(call.from, 'stray.md'), 'written into the --from input');
        return h.driver.defaultInstall(call);
      };

      const report = await run(h, { kinds: ['prompt'], targets: ['vscode'], scopes: ['user'] });

      expect(report.bundles[0].outcome).toBe('fail');
      expect(report.bundles[0].checks.at(-1)).toEqual({
        invariant: 'HARNESS',
        outcome: 'fail',
        observed: { changed: ['<bundle>/stray.md'] },
        detail: 'materialised bundle modified by a case'
      });
      expect(report.cases[0].outcome).toBe('pass');
      expect(report.ok).toBe(false);
    });
  });

  describe('case failures', () => {
    it('stops a throwing case with the HARNESS shape and keeps running the others', async () => {
      const h = harness();
      const broken = `${PROMPT}__vscode__user`;
      h.driver.onInstall = (call) => {
        if (call.caseId === broken) {
          throw new Error('writer exploded');
        }
        return h.driver.defaultInstall(call);
      };

      const report = await run(h, { kinds: ['prompt'], targets: ['vscode', 'kiro'] });

      const stopped = caseById(report, broken);
      expect(stopped).toMatchObject({ status: null, effectiveScope: 'user', destinations: [], outcome: 'fail' });
      expect(stopped.checks).toHaveLength(1);
      expect(stopped.checks[0]).toMatchObject({ invariant: 'HARNESS', outcome: 'fail' });
      expect(stopped.checks[0].detail).toContain('writer exploded');
      expect(report.cases.filter((c) => c.id !== broken).every((c) => c.outcome === 'pass')).toBe(true);
      expect(h.driver.callsOf('install')).toHaveLength(4);
    });

    it('stops a case whose sandbox escapes its root before any command', async () => {
      const h = harness();
      const escaping = `${PROMPT}__vscode__repository`;
      h.driver.escapes = (sandbox) => sandbox.root.endsWith(escaping);

      const report = await run(h, { kinds: ['prompt'], targets: ['vscode'] });

      const stopped = caseById(report, escaping);
      expect(stopped).toMatchObject({ status: null, effectiveScope: null, destinations: [], checks: [{ invariant: 'HARNESS', outcome: 'fail' }] });
      expect(stopped.checks[0].detail).toContain('HOME');
      expect(h.driver.calls.filter((call) => call.root?.endsWith(escaping)).map((call) => call.method)).toEqual(['prepareSandbox']);
      expect(caseById(report, `${PROMPT}__vscode__user`).outcome).toBe('pass');
    });

    it('fails I13 when the install writes to a moved route', async () => {
      const h = harness();
      h.driver.onInstall = (call) => ({ exitCode: 0, files: call.defaultFiles.map((file) => file.replace(`${path.sep}prompts${path.sep}`, `${path.sep}moved${path.sep}`)) });

      const report = await run(h, { kinds: ['prompt'], targets: ['vscode'], scopes: ['user'] });

      const i13 = report.cases[0].checks.find((c) => c.invariant === 'I13');
      expect(i13).toMatchObject({
        outcome: 'fail',
        observed: { missing: ['$HOME/.copilot/prompts/hello-world.prompt.md'], unexpected: ['$HOME/.copilot/moved/hello-world.prompt.md'] }
      });
      expect(report.cases[0].outcome).toBe('fail');
      expect(report.ok).toBe(false);
    });

    it('reports a write under the case root outside home and ws as I13 unexpected', async () => {
      const h = harness();
      h.driver.onInstall = (call) => ({ exitCode: 0, files: [...call.defaultFiles, path.join(call.sandbox.root, 'stray')] });

      const report = await run(h, { kinds: ['prompt'], targets: ['vscode'], scopes: ['user'] });

      expect(report.cases[0].checks.find((c) => c.invariant === 'I13')).toMatchObject({
        outcome: 'fail',
        observed: { missing: [], unexpected: ['<case>/stray'] }
      });
    });

    it('absorbs the kiro-hook-rejected cells with the gap, and fails exactly them without it', async () => {
      const rejectKiroHook = (h: Harness): void => {
        h.driver.onInstall = (call) => (call.bundle.id === HOOK && call.target === 'kiro'
          ? { exitCode: 1, errorCode: 'BUNDLE.UNSUPPORTED_CONTENT', files: [] }
          : h.driver.defaultInstall(call));
      };
      const filters: PrimitiveDiagnosticsFilters = { kinds: ['hook'], targets: ['vscode', 'kiro'] };
      const kiroCases = [`${HOOK}__kiro__user`, `${HOOK}__kiro__repository`];

      const withGapHarness = harness();
      rejectKiroHook(withGapHarness);
      const withGap = await run(withGapHarness, filters);
      const withoutGapHarness = harness();
      rejectKiroHook(withoutGapHarness);
      const withoutGap = await run(withoutGapHarness, filters, { knownGaps: PRIMITIVE_KNOWN_GAPS.filter((gap) => gap.key !== 'kiro-hook-rejected/I4/hook@kiro') });

      for (const id of kiroCases) {
        expect(caseById(withGap, id)).toMatchObject({ status: 'rejected', outcome: 'known-gap', gapIds: ['kiro-hook-rejected'] });
      }
      expect(withGap.cases.filter((c) => c.target === 'vscode').every((c) => c.outcome === 'pass')).toBe(true);
      expect(withGap.knownGaps).toEqual(expect.arrayContaining([{ key: 'kiro-hook-rejected/I4/hook@kiro', id: 'kiro-hook-rejected', invariant: 'I4', absorbed: 2, issue: 549 }]));
      expect(withGap.ok).toBe(true);
      expect(withoutGap.cases.filter((c) => c.outcome === 'fail').map((c) => c.id)).toEqual(kiroCases);
      expect(withoutGap.ok).toBe(false);
    });
  });

  describe('setup errors', () => {
    it.each(['ai-primitives-hub.yml', 'ai-primitives-hub.yaml', LAYOUTS_CONFIG_FILE, LOCKFILE_NAME, LOCAL_LOCKFILE_NAME])(
      'stops at preflight on an ancestor %s, writing nothing',
      async (name) => {
        const h = harness();
        h.fs.seed(path.resolve('/sandbox', name), 'x');
        const writes = [
          vi.spyOn(h.fs, 'writeFile'),
          vi.spyOn(h.fs, 'writeFileBytes'),
          vi.spyOn(h.fs, 'writeJson'),
          vi.spyOn(h.fs, 'mkdir'),
          vi.spyOn(h.fs, 'remove')
        ];

        const report = await run(h, { kinds: ['prompt'], targets: ['vscode'] });

        expect(report.error?.step).toBe('preflight');
        expect(report.error?.message).toContain(path.resolve('/sandbox', name));
        expect(report).toMatchObject({ ok: false, bundles: [], cases: [], workspaceRetained: false });
        expect(report.summary.cases).toBe(0);
        for (const spy of writes) {
          expect(spy).not.toHaveBeenCalled();
        }
        expect(h.driver.calls).toEqual([]);
      }
    );

    it('stops at the fixture step when the git commit fails, and still removes the workspace', async () => {
      const h = harness();
      h.driver.commitError = new Error('git: command not found');

      const report = await run(h, { kinds: ['prompt'], targets: ['vscode'] });

      expect(report.error).toEqual({ step: 'fixture', message: 'git: command not found' });
      expect(report).toMatchObject({ ok: false, bundles: [], cases: [], workspaceRetained: false });
      expect(h.driver.callsOf('validateCollection')).toEqual([]);
      await expect(h.fs.exists(WORKSPACE)).resolves.toBe(false);
    });

    it('stops at the sandbox step when the fixture sandbox escapes its root', async () => {
      const h = harness();
      h.driver.escapes = (sandbox) => sandbox.root.endsWith('fixture');

      const report = await run(h, { kinds: ['prompt'], targets: ['vscode'] });

      expect(report.error?.step).toBe('sandbox');
      expect(report.error?.message).toContain('HOME');
      expect(h.driver.callsOf('commitFixtureRepository')).toEqual([]);
    });

    it('retains the workspace on request, also after a failure', async () => {
      const healthy = harness();
      const failing = harness();
      failing.driver.commitError = new Error('git failed');

      const kept = await run(healthy, { kinds: ['prompt'], targets: ['vscode'] }, { retainWorkspace: true });
      const keptAfterFailure = await run(failing, { kinds: ['prompt'], targets: ['vscode'] }, { retainWorkspace: true });

      expect(kept.workspaceRetained).toBe(true);
      await expect(healthy.fs.exists(path.join(WORKSPACE, 'cases', `${PROMPT}__vscode__user`, 'ws', 'ai-primitives-hub.yml'))).resolves.toBe(true);
      expect(keptAfterFailure.workspaceRetained).toBe(true);
      await expect(failing.fs.exists(path.join(WORKSPACE, 'fixture', 'repo', 'LICENSE'))).resolves.toBe(true);
    });

    it('clears a leftover workspace before the run', async () => {
      const h = harness();
      h.fs.seed(path.join(WORKSPACE, 'leftover.txt'), 'old');

      await run(h, { kinds: ['prompt'], targets: ['vscode'] }, { retainWorkspace: true });

      await expect(h.fs.exists(path.join(WORKSPACE, 'leftover.txt'))).resolves.toBe(false);
    });
  });

  describe('internal errors', () => {
    it('reports a throwing onProgress as an internal error and fills every unfinished case', async () => {
      const h = harness();
      h.deps.onProgress = (event) => {
        if (event.type === 'case') {
          throw new Error('renderer crashed');
        }
      };
      const plan = planPrimitiveDiagnostics({ kinds: ['prompt'], targets: ['vscode', 'kiro'] });

      const report = await runPrimitiveDiagnostics(h.deps, { plan, workspace: WORKSPACE, retainWorkspace: false, concurrency: 1 });

      expect(report.error).toEqual({ step: 'internal', message: 'renderer crashed' });
      expect(report.ok).toBe(false);
      expect(report.cases).toHaveLength(plan.cases.length);
      expect(report.cases[0].outcome).toBe('pass');
      for (const c of report.cases.slice(1)) {
        expect(c.checks).toEqual([{ invariant: 'HARNESS', outcome: 'fail', detail: 'not run: internal error' }]);
      }
      expect(h.driver.callsOf('install')).toHaveLength(1);
      await expect(h.fs.exists(WORKSPACE)).resolves.toBe(false);
    });
  });
});
