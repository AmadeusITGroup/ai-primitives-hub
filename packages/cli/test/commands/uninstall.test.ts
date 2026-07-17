/**
 * `uninstall` command tests (symmetric with install.test.ts's local
 * `--from` mode — no network required).
 *
 * Uses a real `NodeFileSystem` against a real temp directory (not
 * `createTestContext`'s default in-memory `fs` stub, which rejects
 * every call) since uninstall does real file removals + lockfile IO.
 */
import {
  mkdir,
  mkdtemp,
  readFile,
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
  InstallCommand,
} from '../../src/commands/install';
import {
  TargetAddCommand,
} from '../../src/commands/target-add';
import {
  UninstallCommand,
} from '../../src/commands/uninstall';
import {
  runCommand,
} from '../../src/framework';

const COMMAND_CLASSES = [
  TargetAddCommand,
  InstallCommand,
  UninstallCommand
];

interface JsonEnvelope<T> {
  status: string;
  data: T;
}

describe('uninstall command', () => {
  let workspace: string;
  let bundleDir: string;
  let targetDir: string;
  const installedFile = (): string => path.join(targetDir, 'prompts', 'hello.prompt.md');

  const run = (argv: string[]): ReturnType<typeof runCommand> => runCommand(argv, {
    commandClasses: COMMAND_CLASSES,
    context: {
      cwd: workspace,
      fs: new NodeFileSystem(),
      env: {
        HOME: workspace,
        USERPROFILE: workspace,
        XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
        XDG_CACHE_HOME: path.join(workspace, 'xdg-cache')
      }
    }
  });

  const parseJson = <T>(stdout: string): JsonEnvelope<T> => JSON.parse(stdout) as JsonEnvelope<T>;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-uninstall-test-'));
    bundleDir = path.join(workspace, 'bundle');
    targetDir = path.join(workspace, 'target');

    await mkdir(path.join(bundleDir, 'prompts'), { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await writeFile(
      path.join(bundleDir, 'deployment-manifest.yml'),
      'id: local-foo\nversion: 1.0.0\nname: Local Foo\nitems:\n  - path: prompts/hello.prompt.md\n    kind: prompt\n'
    );
    await writeFile(path.join(bundleDir, 'prompts', 'hello.prompt.md'), '# Hello Prompt\n');

    expect((await run([
      'target', 'add', 'copilot', '--type', 'copilot-cli', '--path', targetDir, '-o', 'json'
    ])).exitCode).toBe(0);
    expect((await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json'
    ])).exitCode).toBe(0);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('uninstalls an installed bundle: removes files and clears the lockfile entry', async () => {
    const result = await run(['uninstall', '--bundle', 'local-foo', '--target', 'copilot', '-o', 'json']);
    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ removed: string[]; lockfile: string }>(result.stdout);
    expect(envelope.data.removed.length).toBeGreaterThan(0);

    await expect(readFile(installedFile(), 'utf8')).rejects.toThrow();

    const lockContent = JSON.parse(await readFile(envelope.data.lockfile, 'utf8')) as { bundles: Record<string, unknown> };
    expect(lockContent.bundles).toEqual({});
  });

  it('is a warning no-op (exit 0) when the bundle is not installed', async () => {
    await run(['uninstall', '--bundle', 'local-foo', '--target', 'copilot', '-o', 'json']);
    const result = await run(['uninstall', '--bundle', 'local-foo', '--target', 'copilot', '-o', 'json']);
    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ reason: string }>(result.stdout);
    expect(envelope.status).toBe('warning');
    expect(envelope.data.reason).toBe('not found in lockfile');
  });

  it('dry-run: previews removal without deleting files', async () => {
    const result = await run(['uninstall', '--bundle', 'local-foo', '--target', 'copilot', '--dry-run', '-o', 'json']);
    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ dryRun: boolean; files: string[] }>(result.stdout);
    expect(envelope.data.dryRun).toBe(true);
    expect(envelope.data.files.length).toBeGreaterThan(0);

    const stillInstalled = await readFile(installedFile(), 'utf8');
    expect(stillInstalled).toContain('Hello Prompt');
  });

  it('--all removes every installed bundle for the target', async () => {
    const result = await run(['uninstall', '--all', '--target', 'copilot', '-o', 'json']);
    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ uninstalled: number }>(result.stdout);
    expect(envelope.data.uninstalled).toBe(1);

    await expect(readFile(installedFile(), 'utf8')).rejects.toThrow();
  });

  it('fails with exit 1 when neither --bundle, --lockfile, nor --all is given (and no lockfile is discoverable)', async () => {
    const freshWorkspace = await mkdtemp(path.join(os.tmpdir(), 'cli-uninstall-test-fresh-'));
    try {
      const freshTargetDir = path.join(freshWorkspace, 'target');
      await mkdir(freshTargetDir, { recursive: true });
      const freshRun = (argv: string[]): ReturnType<typeof runCommand> => runCommand(argv, {
        commandClasses: COMMAND_CLASSES,
        context: {
          cwd: freshWorkspace,
          fs: new NodeFileSystem(),
          env: {
            HOME: freshWorkspace,
            USERPROFILE: freshWorkspace,
            XDG_CONFIG_HOME: path.join(freshWorkspace, 'xdg-config'),
            XDG_CACHE_HOME: path.join(freshWorkspace, 'xdg-cache')
          }
        }
      });
      expect((await freshRun([
        'target', 'add', 'copilot', '--type', 'copilot-cli', '--path', freshTargetDir, '-o', 'json'
      ])).exitCode).toBe(0);

      const result = await freshRun(['uninstall', '--target', 'copilot', '-o', 'json']);
      expect(result.exitCode).toBe(1);
    } finally {
      await rm(freshWorkspace, { recursive: true, force: true });
    }
  });
});
