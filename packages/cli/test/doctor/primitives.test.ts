/**
 * `doctor diagnostics --primitives` through the real command classes
 * (PR-05, design §7.3, §7.4, §9.3).
 *
 * Usage errors, the gap-coverage slice (every seed known gap exercised by
 * the real commands), process-level isolation (R8.7), `-v` progress lines
 * and the text renderer.
 */
import * as path from 'node:path';
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
  notCovered: { kinds: string[] };
  cases: { id: string; target: string; outcome: string; gapIds: string[] }[];
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

const runDoctor = (args: string[], options: { cwd?: string } = {}): Promise<RunCommandResult> =>
  runCommand(['doctor', 'diagnostics', ...args], {
    commandClasses: [DoctorDiagnosticsCommand],
    context: {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      fs: new NodeFileSystem(),
      // Production passes process.env straight through as ctx.env.
      env: { ...process.env, AI_PRIMITIVES_HUB_SKIP_NETWORK: '1' }
    }
  });

const parse = (result: RunCommandResult): Envelope => JSON.parse(result.stdout) as Envelope;

const isInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

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
    ['--scopes without --primitives', ['--scopes', 'user', '-o', 'json']],
    ['an empty plan (--kinds plugin)', ['--primitives', '--kinds', 'plugin', '-o', 'json']]
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

  it('explains an empty plan with the kinds not covered yet', async () => {
    const envelope = parse(await runDoctor(['--primitives', '--kinds', 'plugin', '-o', 'json']));

    expect(envelope.errors[0]?.message).toBe('no primitive diagnostic case matches the filters; not covered yet: plugin');
  }, 60_000);

  it('runs the covered kinds and reports the uncovered ones', async () => {
    const result = await runDoctor(['--primitives', '--kinds', 'prompt,plugin', '--targets', 'vscode', '--scopes', 'user', '-o', 'json']);
    const envelope = parse(result);

    expect(result.exitCode).toBe(0);
    expect(envelope.command).toBe('doctor.diagnostics.primitives');
    expect(envelope.data?.notCovered.kinds).toEqual(['plugin']);
    expect(envelope.data?.summary.cases).toBe(1);
  }, 120_000);
});

describe('doctor diagnostics --primitives gap-coverage slice', () => {
  it('absorbs every seed known gap through the real commands', async () => {
    const result = await runDoctor([
      '--primitives',
      '--kinds', 'prompt,chat-mode,hook,mcp-server,power',
      '--targets', 'vscode,copilot-cli,kiro',
      '-o', 'json'
    ]);
    const report = parse(result).data!;

    expect(report.summary).toEqual({
      cases: 30,
      pass: 18,
      knownGap: 12,
      fail: 0,
      bundles: { bundles: 5, pass: 0, knownGap: 5, fail: 0 }
    });
    expect(absorbedById(report)).toEqual({ G05: 6, G08: 2, G13: 2, G15: 4, G18: 5 });
    expect(report.cases.filter((c) => c.target === 'vscode' && c.gapIds.includes('G08'))).toEqual([]);
    expect(report.unusedKnownGaps).toEqual([]);
    expect(report.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  }, 120_000);
});

describe('doctor diagnostics --primitives process-level isolation', () => {
  const isolation = useProcessIsolation();

  it('writes nothing outside its workspace across every target layout (R8.7)', async () => {
    const { processHome, processTmp } = isolation;
    const result = await runDoctor(['--primitives', '--kinds', 'prompt,skill', '--scopes', 'user', '-o', 'json'], { cwd: processHome });
    const report = parse(result).data!;

    expect(report.summary.cases).toBe(22);
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
    expect(progress[0]).toBe('  [primitives] aph-e2e-only-prompt GAP G15');
    expect(progress.slice(1).toSorted()).toEqual(report.cases.map((c) => `  [primitives] ${c.id} OK`).toSorted());
    expect(result.exitCode).toBe(0);
  }, 120_000);

  it('renders the text report', async () => {
    const result = await runDoctor(['--primitives', '--kinds', 'prompt', '--targets', 'vscode']);
    const lines = result.stdout.split('\n');

    expect(lines[0]).toBe('ai-primitives-hub doctor diagnostics --primitives');
    expect(lines[1]).toMatch(/^ {2}workspace: .*ai-primitives-hub-doctor-\d+-\d+ \(removed\)$/);
    expect(lines[2]).toBe('  filters: kinds=prompt targets=vscode scopes=user,repository');
    expect(lines).toContainEqual(expect.stringMatching(/^ {2}\[GAP \] aph-e2e-only-prompt +G15 \(I2\)$/));
    expect(lines).toContainEqual(expect.stringMatching(/^ {2}prompt +vscode +user: OK +repository: OK$/));
    expect(lines).toContain('summary: 2 cases: 2 pass, 0 known-gap, 0 fail; 1 bundles: 0 pass, 1 known-gap, 0 fail');
    expect(result.exitCode).toBe(0);
  }, 120_000);
});
