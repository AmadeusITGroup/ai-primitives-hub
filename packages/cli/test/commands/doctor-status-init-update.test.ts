/**
 * `doctor`, `doctor diagnostics`, `status`, `init`, and `update`
 * command tests.
 *
 * Uses a real `NodeFileSystem` against a real temp directory (not
 * `createTestContext`'s default in-memory `fs` stub, which rejects
 * every call) since these commands do real file IO. Network-touching
 * paths (`doctor`'s github-api check, `update`'s remote-source
 * resolution) are avoided via `AI_PRIMITIVES_HUB_SKIP_NETWORK=1` and by
 * only exercising local-source lockfiles, matching the established
 * approach in install.test.ts/uninstall.test.ts.
 */
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  DoctorCommand,
  DoctorDiagnosticsCommand,
} from '../../src/commands/doctor';
import {
  InitCommand,
} from '../../src/commands/init';
import {
  InstallCommand,
} from '../../src/commands/install';
import {
  StatusCommand,
} from '../../src/commands/status';
import {
  TargetAddCommand,
} from '../../src/commands/target-add';
import {
  UpdateCommand,
} from '../../src/commands/update';
import {
  runCommand,
} from '../../src/framework';

const COMMAND_CLASSES = [
  DoctorCommand,
  DoctorDiagnosticsCommand,
  StatusCommand,
  InitCommand,
  UpdateCommand,
  TargetAddCommand,
  InstallCommand
];

interface JsonEnvelope<T> {
  status: string;
  data: T;
}

describe('doctor/status/init/update commands', () => {
  let workspace: string;

  const run = (argv: string[]): ReturnType<typeof runCommand> => runCommand(argv, {
    commandClasses: COMMAND_CLASSES,
    context: {
      cwd: workspace,
      fs: new NodeFileSystem(),
      env: {
        HOME: workspace,
        USERPROFILE: workspace,
        XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
        XDG_CACHE_HOME: path.join(workspace, 'xdg-cache'),
        AI_PRIMITIVES_HUB_SKIP_NETWORK: '1'
      }
    }
  });

  const parseJson = <T>(stdout: string): JsonEnvelope<T> => JSON.parse(stdout) as JsonEnvelope<T>;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-doctor-test-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  describe('doctor', () => {
    it('runs every check and exits 0 with zero failures', async () => {
      const result = await run(['doctor', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ checks: { name: string; status: string }[]; summary: { ok: number; warn: number; fail: number } }>(result.stdout);
      expect(envelope.data.checks.length).toBe(11);
      expect(envelope.data.summary.fail).toBe(0);
    });

    it('-v includes per-check logs', async () => {
      const result = await run(['doctor', '-v', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ checks: { logs?: unknown[] }[] }>(result.stdout);
      expect(envelope.data.checks.some((c) => (c.logs?.length ?? 0) > 0)).toBe(true);
    });
  });

  describe('doctor diagnostics', () => {
    it('runs the full self-contained smoke test successfully', async () => {
      const result = await run(['doctor', 'diagnostics', '-o', 'json']);
      const envelope = parseJson<{ ok: boolean; steps: { name: string; exitCode: number }[] }>(result.stdout);
      const failed = envelope.data.steps.filter((s) => s.exitCode !== 0);
      expect(failed).toEqual([]);
      expect(envelope.data.ok).toBe(true);
      expect(result.exitCode).toBe(0);
    }, 60_000);
  });

  describe('status', () => {
    it('reports empty state for a fresh workspace', async () => {
      const result = await run(['status', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{
        configPath: string | null;
        targets: unknown[];
        activeHubId: string | null;
        index: unknown;
        lockfile: unknown;
      }>(result.stdout);
      expect(envelope.data).toMatchObject({
        configPath: null,
        targets: [],
        activeHubId: null,
        index: null,
        lockfile: null
      });
    });

    it('reflects a configured target + installed bundle', async () => {
      const bundleDir = path.join(workspace, 'bundle');
      const targetDir = path.join(workspace, 'target');
      await mkdir(path.join(bundleDir, 'prompts'), { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await writeFile(
        path.join(bundleDir, 'deployment-manifest.yml'),
        'id: local-foo\nversion: 1.0.0\nname: Local Foo\nitems:\n  - path: prompts/hello.prompt.md\n    kind: prompt\n'
      );
      await writeFile(path.join(bundleDir, 'prompts', 'hello.prompt.md'), '# Hello Prompt\n');

      await run(['target', 'add', 'copilot', '--type', 'copilot-cli', '--path', targetDir, '-o', 'json']);
      await run(['install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json']);

      const result = await run(['status', '--verbose', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{
        targets: { name: string; type: string }[];
        lockfile: { entries: number; bundles?: { bundleId: string }[] } | null;
      }>(result.stdout);
      expect(envelope.data.targets).toContainEqual(expect.objectContaining({ name: 'copilot', type: 'copilot-cli' }));
      expect(envelope.data.lockfile?.entries).toBe(1);
      expect(envelope.data.lockfile?.bundles?.map((b) => b.bundleId)).toContain('local-foo');
    });
  });

  describe('init', () => {
    it('creates a target non-interactively', async () => {
      const result = await run(['init', '--target-name', 'copilot', '--target-type', 'copilot-cli', '--yes', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ target: { name: string; type: string; created: boolean } }>(result.stdout);
      expect(envelope.data.target).toMatchObject({ name: 'copilot', type: 'copilot-cli', created: true });
    });

    it('is idempotent: re-running with the same target reports created: false', async () => {
      await run(['init', '--target-name', 'copilot', '--target-type', 'copilot-cli', '--yes', '-o', 'json']);
      const result = await run(['init', '--target-name', 'copilot', '--target-type', 'copilot-cli', '--yes', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ target: { created: boolean } }>(result.stdout);
      expect(envelope.data.target.created).toBe(false);
    });

    it('fails with exit 1 for an unknown --target-type', async () => {
      const result = await run(['init', '--target-type', 'totally-bogus', '--yes', '-o', 'json']);
      expect(result.exitCode).toBe(1);
    });

    it('imports and syncs a local hub when --hub/--hub-type local are given', async () => {
      const hubConfigFile = path.join(workspace, 'hub-config.yml');
      const hubSourceDir = path.join(workspace, 'hub-source');
      await mkdir(hubSourceDir, { recursive: true });
      await writeFile(
        hubConfigFile,
        `version: 1.0.0
metadata:
  name: Test Hub
  description: Test hub
  maintainer: test
  updatedAt: '2026-01-01T00:00:00Z'
sources:
  - id: local-foo-src
    name: Local Foo Source
    type: local
    url: ${hubSourceDir}
    enabled: true
    priority: 0
    hubId: test-hub
profiles: []
`
      );
      const result = await run([
        'init', '--target-name', 'copilot', '--target-type', 'copilot-cli',
        '--hub', hubConfigFile, '--hub-type', 'local', '--yes', '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ hub: { id: string } | null }>(result.stdout);
      expect(envelope.data.hub).not.toBeNull();
    });
  });

  describe('update', () => {
    it('fails with exit 1 when no lockfile is found', async () => {
      await run(['target', 'add', 'copilot', '--type', 'copilot-cli', '--path', path.join(workspace, 'target'), '-o', 'json']);
      const result = await run(['update', '-o', 'json']);
      expect(result.exitCode).toBe(1);
    });

    it('reports up to date for a lockfile with only local-source bundles (no network needed)', async () => {
      const bundleDir = path.join(workspace, 'bundle');
      const targetDir = path.join(workspace, 'target');
      await mkdir(path.join(bundleDir, 'prompts'), { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await writeFile(
        path.join(bundleDir, 'deployment-manifest.yml'),
        'id: local-foo\nversion: 1.0.0\nname: Local Foo\nitems:\n  - path: prompts/hello.prompt.md\n    kind: prompt\n'
      );
      await writeFile(path.join(bundleDir, 'prompts', 'hello.prompt.md'), '# Hello Prompt\n');
      await run(['target', 'add', 'copilot', '--type', 'copilot-cli', '--path', targetDir, '-o', 'json']);
      await run(['install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json']);

      const result = await run(['update', '--target', 'copilot', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ checked: number; updated: number }>(result.stdout);
      expect(envelope.data).toMatchObject({ checked: 1, updated: 0 });
    });

    it('--dry-run reports the same up-to-date result without applying anything', async () => {
      const bundleDir = path.join(workspace, 'bundle');
      const targetDir = path.join(workspace, 'target');
      await mkdir(path.join(bundleDir, 'prompts'), { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await writeFile(
        path.join(bundleDir, 'deployment-manifest.yml'),
        'id: local-foo\nversion: 1.0.0\nname: Local Foo\nitems:\n  - path: prompts/hello.prompt.md\n    kind: prompt\n'
      );
      await writeFile(path.join(bundleDir, 'prompts', 'hello.prompt.md'), '# Hello Prompt\n');
      await run(['target', 'add', 'copilot', '--type', 'copilot-cli', '--path', targetDir, '-o', 'json']);
      await run(['install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json']);

      const result = await run(['update', '--target', 'copilot', '--dry-run', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ dryRun: boolean; updated: number }>(result.stdout);
      expect(envelope.data).toMatchObject({ dryRun: true, updated: 0 });
    });
  });
});
