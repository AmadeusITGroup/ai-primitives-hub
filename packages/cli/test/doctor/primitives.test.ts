/**
 * `doctor diagnostics --primitives` through the real command classes.
 *
 * Usage errors, the full default run (the acceptance criteria: every
 * known gap exercised by the real commands, nothing failing, nothing
 * unused), process-level isolation, `-v` progress lines and the text
 * renderer.
 */
import * as path from 'node:path';
import type {
  DiagnosticCheck,
  PrimitiveDiagnosticsReport,
} from '@ai-primitives-hub/core';
import {
  PRIMITIVE_KNOWN_GAPS,
} from '@ai-primitives-hub/core';
import {
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  DoctorDiagnosticsCommand,
} from '../../src/commands/doctor';
import {
  runPrimitivesMode,
} from '../../src/doctor/primitives';
import {
  renderPrimitivesText,
} from '../../src/doctor/primitives-text';
import {
  createTestContext,
  runCommand,
  type RunCommandResult,
} from '../../src/framework';
import {
  listTree,
  useProcessIsolation,
} from '../helpers/process-isolation';

interface Report {
  ok: boolean;
  summary: {
    cases: number; pass: number; knownGap: number; fail: number;
    bundles: { bundles: number; pass: number; knownGap: number; fail: number };
  };
  filters: { kinds: string[] };
  notCovered: { kinds: string[] };
  bundles: { id: string; outcome: string; checks: { invariant: string; outcome: string }[] }[];
  cases: {
    id: string; bundle: string; target: string; mode: string; status: string | null; outcome: string; gapIds: string[];
    checks: { invariant: string; outcome: string }[];
  }[];
  knownGaps: { key: string; id: string; absorbed: number }[];
  unusedKnownGaps: unknown[];
  workspace: string;
  workspaceRetained: boolean;
}

interface Envelope {
  command: string;
  status: string;
  data: Report | null;
  errors: { code: string; message: string }[];
}

// Production passes process.env straight through as ctx.env.
const doctorEnv = (): Record<string, string> => ({ ...process.env, AI_PRIMITIVES_HUB_SKIP_NETWORK: '1' });

const runDoctor = (args: string[], options: { cwd?: string } = {}): Promise<RunCommandResult> =>
  runCommand(['doctor', 'diagnostics', ...args], {
    commandClasses: [DoctorDiagnosticsCommand],
    context: {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      fs: new NodeFileSystem(),
      env: doctorEnv()
    }
  });

/**
 * Whether this host has POSIX file modes. Without them (Windows) the
 * executable-bit checks (I10) are not applicable.
 */
const POSIX_FILE_MODES = process.platform !== 'win32';

const parse = (result: RunCommandResult): Envelope => JSON.parse(result.stdout) as Envelope;

const isInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const INVALID_PLUGIN_BUNDLES = [
  'aph-e2e-bad-plugin-no-schema',
  'aph-e2e-bad-plugin-name',
  'aph-e2e-bad-plugin-author',
  'aph-e2e-bad-plugin-nested-manifest'
];

const absorbedById = (report: Report): Record<string, number> => {
  const totals: Record<string, number> = {};
  for (const gap of report.knownGaps) {
    totals[gap.id] = (totals[gap.id] ?? 0) + gap.absorbed;
  }
  return totals;
};

describe('doctor diagnostics --primitives usage errors', () => {
  const isolation = useProcessIsolation();

  it.each([
    ['--kinds bogus', ['--primitives', '--kinds', 'bogus', '-o', 'json']],
    ['--targets bogus', ['--primitives', '--targets', 'bogus', '-o', 'json']],
    ['--scopes bogus', ['--primitives', '--scopes', 'bogus', '-o', 'json']],
    ['--kinds ""', ['--primitives', '--kinds', '', '-o', 'json']],
    ['--kinds without --primitives', ['--kinds', 'prompt', '-o', 'json']],
    ['--targets without --primitives', ['--targets', 'vscode', '-o', 'json']],
    ['--scopes without --primitives', ['--scopes', 'user', '-o', 'json']]
  ])('rejects %s with USAGE.INVALID_FLAG before creating a workspace', async (_name, args) => {
    const result = await runDoctor(args);
    const envelope = parse(result);

    expect(result.exitCode).toBe(1);
    expect(envelope.status).toBe('error');
    expect(envelope.data).toBeNull();
    expect(envelope.errors[0]?.code).toBe('USAGE.INVALID_FLAG');
    expect(await listTree(isolation.processTmp)).toEqual([]);
  }, 60_000);

  it('names the bad value and the allowed values', async () => {
    const envelope = parse(await runDoctor(['--primitives', '--targets', 'vscode,bogus', '-o', 'json']));

    expect(envelope.errors[0]?.message).toContain('bogus');
    expect(envelope.errors[0]?.message).toContain('copilot-cli');
  }, 60_000);

  it('covers plugin: the plugin bundle on each target and the invalid plugin bundles', async () => {
    const result = await runDoctor(['--primitives', '--kinds', 'plugin', '--targets', 'vscode,kiro', '-o', 'json']);
    const report = parse(result).data!;

    expect(result.exitCode).toBe(0);
    expect(report.notCovered.kinds).toEqual([]);
    expect(report.bundles.map((b) => [b.id, b.outcome, b.checks.map((c) => `${c.invariant}:${c.outcome}`)])).toEqual([
      ['aph-e2e-only-plugin', 'pass', ['I0:pass', 'I1:pass', 'I2:pass', 'I3:pass', POSIX_FILE_MODES ? 'I10:pass' : 'I10:not-applicable']],
      ...INVALID_PLUGIN_BUNDLES.map((id) => [id, 'pass', ['I5:pass']])
    ]);
    expect(report.cases.map((c) => [c.id, c.gapIds])).toEqual([
      ['aph-e2e-only-plugin__vscode__user', ['plugin-mcp-projection', 'plugin-root-unresolved', 'plugin-skill-projection']],
      ['aph-e2e-only-plugin__vscode__repository', ['plugin-mcp-projection', 'plugin-root-unresolved', 'plugin-skill-projection']],
      ['aph-e2e-only-plugin__kiro__user', ['kiro-plugin-rejected']],
      ['aph-e2e-only-plugin__kiro__repository', ['kiro-plugin-rejected']]
    ]);
  }, 120_000);
});

/**
 * Assert the default run: every kind, the mixed bundles in both install
 * modes, the invalid bundles, nothing failing and every known gap used. The executable-bit checks
 * (I10) pass with POSIX file modes and are not applicable without them;
 * neither changes an outcome.
 * @param result - Command result.
 * @param result.exitCode
 * @param result.stdout
 * @param posixFileModes - Host capability the run used.
 */
const expectDefaultRun = (result: { exitCode: number; stdout: string }, posixFileModes: boolean): void => {
  const report = (JSON.parse(result.stdout) as Envelope).data!;

  expect(report.summary).toEqual({
    cases: 462,
    pass: 313,
    knownGap: 149,
    fail: 0,
    bundles: { bundles: 23, pass: 13, knownGap: 10, fail: 0 }
  });
  // With POSIX file modes, I10 is still not applicable where the install was rejected.
  const i10 = [...report.bundles, ...report.cases].flatMap((s) => s.checks).filter((c) => c.invariant === 'I10');
  expect(new Set(i10.map((c) => c.outcome))).toEqual(new Set(posixFileModes ? ['pass', 'not-applicable'] : ['not-applicable']));
  expect(report.filters.kinds).toContain('plugin');
  expect(report.notCovered.kinds).toEqual([]);
  expect(report.unusedKnownGaps).toEqual([]);
  expect(report.knownGaps.map((g) => g.key).toSorted()).toEqual(PRIMITIVE_KNOWN_GAPS.map((g) => g.key).toSorted());
  expect(absorbedById(report)).toEqual({
    'copilot-cli-repository-scope': 21,
    'kiro-hook-rejected': 16,
    'kiro-plugin-rejected': 16,
    'manifest-id-file-stem': 18,
    'mcp-server-rejected': 88,
    'plugin-mcp-projection': 80,
    'plugin-root-unresolved': 80,
    'plugin-skill-projection': 80,
    'power-directory-unit': 4
  });
  // Mixed bundles run in both install modes; every other bundle in the default mode only.
  const mixed = report.cases.filter((c) => c.bundle.startsWith('aph-e2e-mix-'));
  expect(mixed).toHaveLength(88);
  expect(mixed.filter((c) => c.mode === 'skip-unsupported')).toHaveLength(44);
  expect(mixed.filter((c) => c.outcome === 'fail')).toEqual([]);
  expect(report.cases.filter((c) => c.gapIds.includes('all-or-nothing-install'))).toEqual([]);
  expect(report.cases.filter((c) => !c.bundle.startsWith('aph-e2e-mix-')).every((c) => c.mode === 'default')).toBe(true);
  // The all-kinds mix: rejected as expected by default, partially installed with --skip-unsupported.
  const allKinds = mixed.filter((c) => c.bundle === 'aph-e2e-mix-all-kinds');
  for (const c of allKinds) {
    const i4 = c.checks.find((check) => check.invariant === 'I4');
    expect([c.id, c.status, i4?.outcome]).toEqual([c.id, c.mode === 'default' ? 'rejected' : 'partial', 'pass']);
  }
  expect(allKinds.filter((c) => c.mode === 'skip-unsupported').flatMap((c) => c.checks.filter((check) => check.invariant === 'I15').map((check) => check.outcome)))
    .toEqual(Array.from({ length: 22 }, () => 'pass'));
  for (const id of INVALID_PLUGIN_BUNDLES) {
    expect(report.bundles.find((b) => b.id === id)).toMatchObject({ outcome: 'pass', checks: [{ invariant: 'I5', outcome: 'pass' }] });
  }
  expect(report.cases.filter((c) => c.target !== 'kiro' && c.gapIds.some((id) => id.startsWith('kiro-')))).toEqual([]);
  expect(report.ok).toBe(true);
  expect(result.exitCode).toBe(0);
};

describe('doctor diagnostics --primitives default run', () => {
  it('covers every kind, the mixed and the invalid bundles, fails nothing and uses every known gap', async () => {
    expectDefaultRun(await runDoctor(['--primitives', '-o', 'json']), POSIX_FILE_MODES);
  }, 300_000);

  // The Windows capability, simulated on a POSIX host; a Windows host covers it in the test above.
  it.skipIf(!POSIX_FILE_MODES)('without POSIX file modes, treats I10 as not applicable and leaves no known gap unused', async () => {
    const ctx = createTestContext({ fs: new NodeFileSystem(), env: doctorEnv() });

    const exitCode = await runPrimitivesMode(ctx, { output: 'json', verbose: false, retainWorkspace: false }, { posixFileModes: false });

    expectDefaultRun({ exitCode, stdout: ctx.stdout.captured() }, false);
  }, 300_000);
});

describe('doctor diagnostics --primitives process-level isolation', () => {
  const isolation = useProcessIsolation();

  it('writes nothing outside its workspace across every target layout', async () => {
    const { processHome, processTmp } = isolation;
    const result = await runDoctor(['--primitives', '--kinds', 'prompt,skill,plugin', '--scopes', 'user', '-o', 'json'], { cwd: processHome });
    const report = parse(result).data!;

    expect(report.summary.cases).toBe(33);
    expect(report.summary.fail).toBe(0);
    expect(isInside(processTmp, report.workspace)).toBe(true);
    expect(report.workspaceRetained).toBe(false);
    expect(await listTree(processHome)).toEqual([]);
    expect(await listTree(processTmp)).toEqual([]);
    expect(result.exitCode).toBe(0);
  }, 120_000);
});

describe('doctor diagnostics --primitives output', () => {
  it('-v -o json prints one envelope and one progress line per bundle and per case', async () => {
    const result = await runDoctor(['--primitives', '--kinds', 'prompt', '--targets', 'vscode', '-v', '-o', 'json']);
    const report = parse(result).data!;
    const progress = result.stderr.split('\n').filter((line) => line.length > 0);

    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    // Bundles run first; case lines follow in completion order (bounded pool).
    expect(progress[0]).toBe('  [primitives] aph-e2e-only-prompt GAP manifest-id-file-stem');
    expect(progress.slice(1).toSorted()).toEqual(report.cases.map((c) => `  [primitives] ${c.id} OK`).toSorted());
    expect(result.exitCode).toBe(0);
  }, 120_000);

  it('renders the text report', async () => {
    const result = await runDoctor(['--primitives', '--kinds', 'prompt', '--targets', 'vscode']);
    const lines = result.stdout.split('\n');

    expect(lines[0]).toBe('ai-primitives-hub doctor diagnostics --primitives');
    expect(lines[1]).toMatch(/^ {2}workspace: .*ai-primitives-hub-doctor-\d+-\d+ \(removed\)$/);
    expect(lines[2]).toBe('  filters: kinds=prompt targets=vscode scopes=user,repository');
    expect(lines).toContainEqual(expect.stringMatching(/^ {2}\[GAP \] aph-e2e-only-prompt +manifest-id-file-stem \(I2\)$/));
    expect(lines).toContainEqual(expect.stringMatching(/^ {2}prompt +vscode +user: OK +repository: OK$/));
    expect(lines).toContain('summary: 2 cases: 2 pass, 0 known-gap, 0 fail; 1 bundles: 0 pass, 1 known-gap, 0 fail');
    expect(result.exitCode).toBe(0);
  }, 120_000);

  describe('kind/route mismatch warnings', () => {
    const WARNING = 'collections/x.collection.yml: items[0] plugins/p/skills/s/SKILL.md: kind "skill" differs from the kind '
      + '"plugin" of the install route "plugins/" that this path matches';
    const reportWith = (i0: DiagnosticCheck): PrimitiveDiagnosticsReport => ({
      ok: true,
      summary: { cases: 0, pass: 0, knownGap: 0, fail: 0, bundles: { bundles: 2, pass: 2, knownGap: 0, fail: 0 } },
      filters: { kinds: ['skill'], targets: ['vscode'], scopes: ['user'] },
      notCovered: { kinds: [] },
      bundles: [
        { id: 'aph-e2e-first', kinds: ['skill'], outcome: 'pass', checks: [i0, { invariant: 'I3', outcome: 'pass' }] },
        { id: 'aph-e2e-second', kinds: ['skill'], outcome: 'pass', checks: [{ invariant: 'I0', outcome: 'pass' }] }
      ],
      cases: [],
      knownGaps: [],
      unusedKnownGaps: [],
      workspace: '/tmp/ws',
      workspaceRetained: false,
      durationMs: 0
    });

    it('prints each warning directly under its bundle, without -v', () => {
      const lines = renderPrimitivesText(
        reportWith({ invariant: 'I0', outcome: 'pass', warnings: [WARNING] }),
        { verbose: false }
      ).split('\n');
      const first = lines.indexOf('  [ OK ] aph-e2e-first');
      expect(first).toBeGreaterThan(-1);
      expect(lines[first + 1]).toBe(`      warning: ${WARNING}`);
      expect(lines[first + 2]).toBe('  [ OK ] aph-e2e-second');
      expect(lines.filter((line) => line.includes('warning:'))).toHaveLength(1);
    });

    it('prints no warning line when no check carries warnings', () => {
      const text = renderPrimitivesText(reportWith({ invariant: 'I0', outcome: 'pass' }), { verbose: true });
      expect(text).not.toContain('warning:');
    });
  });

  it('labels a mixed-kind bundle row by its bundle id and install mode', async () => {
    const result = await runDoctor(['--primitives', '--kinds', 'prompt,instruction,agent,skill,plugin,hook', '--targets', 'vscode', '--scopes', 'user']);
    const lines = result.stdout.split('\n');

    expect(lines).toContainEqual(expect.stringMatching(/^ {2}aph-e2e-mix-portable \[default\] +vscode +user: GAP /));
    expect(lines).toContainEqual(expect.stringMatching(/^ {2}aph-e2e-mix-portable \[skip-unsupported\] +vscode +user: GAP /));
    expect(lines).toContainEqual(expect.stringMatching(/^ {2}plugin +vscode +user: GAP /));
    expect(result.exitCode).toBe(0);
  }, 120_000);
});
