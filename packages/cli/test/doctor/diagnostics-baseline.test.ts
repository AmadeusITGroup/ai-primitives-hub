/**
 * Golden baseline for plain `doctor diagnostics`.
 *
 * Pins the 54 step names, their order, the summary line and the envelope
 * shape so changes to the shared diagnostics helpers can't silently alter
 * the plain run.
 */
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
} from '../../src/framework';

const EXPECTED_STEPS = [
  'create-target',
  'add-hub',
  'use-hub',
  'sync-hub',
  'list-profiles',
  'profile-show',
  'activate-profile',
  'profile-current',
  'verify-installed',
  'build-index',
  'search-index',
  'search-index-kinds',
  'index-stats',
  'shortlist-new',
  'shortlist-add',
  'shortlist-list',
  'shortlist-remove',
  'index-export',
  'index-eval',
  'index-bench',
  'index-report',
  'deactivate-profile',
  'verify-removed',
  'install-bundle',
  'update-dry-run',
  'uninstall-bundle',
  'target-list',
  'target-types',
  'hub-list',
  'hub-refresh',
  'hub-create',
  'source-add',
  'source-list',
  'source-remove',
  'collection-list',
  'collection-validate',
  'collection-affected',
  'version-compute',
  'bundle-manifest',
  'build-governed-bundle',
  'verify-governed-archive',
  'materialize-governed-bundle',
  'install-governed-bundle',
  'verify-governed-install',
  'uninstall-governed-bundle',
  'verify-governed-removed',
  'explain',
  'plugins-list',
  'config-get',
  'config-list',
  'final-status',
  'search-alias',
  'target-remove',
  'hub-remove'
] as const;

const runDiagnostics = (output: 'json' | 'text') =>
  runCommand(['doctor', 'diagnostics', '-o', output], {
    commandClasses: [DoctorDiagnosticsCommand],
    context: {
      fs: new NodeFileSystem(),
      env: { ...process.env, AI_PRIMITIVES_HUB_SKIP_NETWORK: '1' }
    }
  });

describe('plain doctor diagnostics baseline', () => {
  it('runs the 54 pinned steps in order and reports them all passed (json)', async () => {
    const result = await runDiagnostics('json');
    const envelope = JSON.parse(result.stdout) as {
      data: Record<string, unknown> & {
        summary: string;
        steps: { name: string; exitCode: number }[];
      };
    };

    expect(envelope.data.steps.map((step) => step.name)).toEqual(EXPECTED_STEPS);
    expect(envelope.data.steps.filter((step) => step.exitCode !== 0)).toEqual([]);
    expect(envelope.data.summary).toBe('all 54 diagnostic steps passed');
    expect(Object.keys(envelope.data).toSorted()).toEqual(['ok', 'steps', 'summary', 'workspace', 'workspaceRetained']);
    expect(result.exitCode).toBe(0);
  }, 60_000);

  it('renders the pinned text header (text)', async () => {
    const result = await runDiagnostics('text');
    const lines = result.stdout.split('\n');

    expect(lines[0]).toBe('ai-primitives-hub doctor diagnostics');
    expect(lines[1]).toMatch(/^ {2}workspace: .*ai-primitives-hub-doctor-\d+-\d+ \(removed\)$/);
    expect(lines[2]).toBe('  [ OK ] all 54 diagnostic steps passed');
    expect(result.exitCode).toBe(0);
  }, 60_000);
});
