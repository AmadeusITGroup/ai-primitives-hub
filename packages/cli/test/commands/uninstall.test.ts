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
import {
  createGovernedReleaseArchive,
  writeReleaseArchive,
} from '../fixtures/release-archives';

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

  it('uninstalls a governed bundle using installable-only lockfile paths', async () => {
    const initialUninstall = await run(['uninstall', '--bundle', 'local-foo', '--target', 'copilot', '-o', 'json']);
    expect(initialUninstall.exitCode).toBe(0);
    await writeReleaseArchive(bundleDir, createGovernedReleaseArchive({ id: 'local-foo' }));

    const installResult = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json'
    ]);
    expect(installResult.exitCode).toBe(0);
    await expect(readFile(installedFile(), 'utf8')).resolves.toContain('Hello Prompt');

    const uninstallResult = await run(['uninstall', '--bundle', 'local-foo', '--target', 'copilot', '-o', 'json']);
    expect(uninstallResult.exitCode).toBe(0);
    await expect(readFile(installedFile(), 'utf8')).rejects.toThrow();

    const envelope = parseJson<{ lockfile: string }>(uninstallResult.stdout);
    const lockContent = JSON.parse(await readFile(envelope.data.lockfile, 'utf8')) as {
      bundles: Record<string, unknown>;
    };
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

  it('round-trips repository scope: removes files from the same layout used by install', async () => {
    const installResult = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot',
      '--scope', 'repository', '-o', 'json'
    ]);
    expect(installResult.exitCode).toBe(0);

    const repositoryFile = path.join(workspace, '.github', 'prompts', 'hello.prompt.md');
    await expect(readFile(repositoryFile, 'utf8')).resolves.toContain('Hello Prompt');

    const uninstallResult = await run([
      'uninstall', '--bundle', 'local-foo', '--target', 'copilot',
      '--scope', 'repository', '-o', 'json'
    ]);
    expect(uninstallResult.exitCode).toBe(0);
    const envelope = parseJson<{ removed: string[]; lockfile: string }>(uninstallResult.stdout);
    expect(envelope.data.removed.length).toBeGreaterThan(0);
    await expect(readFile(repositoryFile, 'utf8')).rejects.toThrow();
    await expect(readFile(envelope.data.lockfile, 'utf8')).rejects.toThrow();
  });

  it('--all removes every installed bundle for the target', async () => {
    const result = await run(['uninstall', '--all', '--target', 'copilot', '-o', 'json']);
    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ uninstalled: number }>(result.stdout);
    expect(envelope.data.uninstalled).toBe(1);

    await expect(readFile(installedFile(), 'utf8')).rejects.toThrow();
  });

  describe('repository install record (ai-primitives-hub.lock.json)', () => {
    const recordPath = (): string => path.join(workspace, 'ai-primitives-hub.lock.json');
    const vscodePrompt = (): string => path.join(workspace, '.github', 'prompts', 'hello.prompt.md');
    const readRecord = async (): Promise<{ bundles: Record<string, { tools: Record<string, { files: { path: string }[] }> }> }> =>
      JSON.parse(await readFile(recordPath(), 'utf8')) as { bundles: Record<string, { tools: Record<string, { files: { path: string }[] }> }> };
    const kiroFiles = async (): Promise<string[]> =>
      (await readRecord()).bundles['local-foo'].tools.kiro.files.map((file) => path.join(workspace, file.path));
    const exists = async (file: string): Promise<boolean> => readFile(file).then(() => true, () => false);

    beforeEach(async () => {
      await mkdir(path.join(workspace, '.git'), { recursive: true });
      await writeFile(path.join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      for (const [name, type] of [['repo-vscode', 'vscode'], ['repo-kiro', 'kiro']]) {
        expect((await run([
          'target', 'add', name, '--type', type, '--scope', 'repository', '--workspace-root', workspace, '-o', 'json'
        ])).exitCode).toBe(0);
        expect((await run(['install', 'local-foo', '--from', bundleDir, '--target', name, '-o', 'json'])).exitCode).toBe(0);
      }
    });

    it('uninstalling kiro keeps the vscode entry and its files, and prints the record path', async () => {
      const kiro = await kiroFiles();
      expect(kiro.length).toBeGreaterThan(0);

      const result = await run(['uninstall', '--bundle', 'local-foo', '--target', 'repo-kiro', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(0);
      const envelope = parseJson<{ removed: string[]; lockfile: string }>(result.stdout);
      expect(envelope.data.lockfile).toBe(recordPath());
      expect(envelope.data.removed.length).toBe(kiro.length);
      for (const file of kiro) {
        expect(await exists(file)).toBe(false);
      }
      await expect(readFile(vscodePrompt(), 'utf8')).resolves.toContain('Hello Prompt');
      expect(Object.keys((await readRecord()).bundles['local-foo'].tools)).toEqual(['vscode']);
    });

    it('removing the last entry leaves no bundle files and deletes the record file', async () => {
      expect((await run(['uninstall', '--bundle', 'local-foo', '--target', 'repo-kiro', '-o', 'json'])).exitCode).toBe(0);
      const result = await run(['uninstall', '--bundle', 'local-foo', '--target', 'repo-vscode']);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain(`Updated ${recordPath()}`);
      expect(await exists(vscodePrompt())).toBe(false);
      expect(await exists(recordPath())).toBe(false);
    });

    it('--all uninstalls the recorded bundle for the target type only', async () => {
      const result = await run(['uninstall', '--all', '--target', 'repo-vscode', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(0);
      expect(parseJson<{ uninstalled: number }>(result.stdout).data.uninstalled).toBe(1);
      expect(await exists(vscodePrompt())).toBe(false);
      expect(Object.keys((await readRecord()).bundles['local-foo'].tools)).toEqual(['kiro']);
    });

    it('dry-run lists the recorded files and removes nothing', async () => {
      const result = await run(['uninstall', '--bundle', 'local-foo', '--target', 'repo-vscode', '--dry-run', '-o', 'json']);

      expect(result.exitCode).toBe(0);
      expect(parseJson<{ files: string[] }>(result.stdout).data.files).toEqual(['.github/prompts/hello.prompt.md']);
      expect(await exists(vscodePrompt())).toBe(true);
      expect(Object.keys((await readRecord()).bundles['local-foo'].tools).toSorted()).toEqual(['kiro', 'vscode']);
    });

    it('stops with RECORD.MALFORMED and removes nothing when the other record file is malformed', async () => {
      await writeFile(path.join(workspace, 'ai-primitives-hub.local.lock.json'), '[]');
      const before = await readFile(recordPath(), 'utf8');

      const result = await run(['uninstall', '--bundle', 'local-foo', '--target', 'repo-vscode', '-o', 'json']);

      expect(result.exitCode).toBe(1);
      expect((JSON.parse(result.stdout) as { errors?: { code: string; context?: { file?: string } }[] }).errors?.[0])
        .toMatchObject({ code: 'RECORD.MALFORMED', context: { file: 'ai-primitives-hub.local.lock.json' } });
      expect(await exists(vscodePrompt())).toBe(true);
      expect(await readFile(recordPath(), 'utf8')).toBe(before);
    });

    it('falls back to the old store for a bundle that is not in the record', async () => {
      // The vscode entry is removed from the record, then the bundle is
      // re-placed and listed only in the old prompt-registry.lock.json, as an
      // install made before the record would have left it.
      expect((await run(['uninstall', '--bundle', 'local-foo', '--target', 'repo-vscode', '-o', 'json'])).exitCode).toBe(0);
      await mkdir(path.dirname(vscodePrompt()), { recursive: true });
      await writeFile(vscodePrompt(), '# Hello Prompt\n');
      await writeFile(path.join(workspace, 'prompt-registry.lock.json'), `${JSON.stringify({
        $schema: 'https://github.com/AmadeusITGroup/prompt-registry/schemas/lockfile.schema.json',
        version: '2.0.0',
        generatedAt: '2026-10-01T00:00:00.000Z',
        generatedBy: 'ai-primitives-hub-cli@0.2.1',
        bundles: {
          'local-foo': {
            version: '1.0.0',
            sourceId: 'local-bundle',
            sourceType: 'local',
            installedAt: '2026-10-01T00:00:00.000Z',
            commitMode: 'commit',
            files: [{ path: 'prompts/hello.prompt.md', checksum: '0'.repeat(64) }]
          }
        },
        sources: { 'local-bundle': { type: 'local', url: bundleDir } }
      }, null, 2)}\n`);

      const result = await run(['uninstall', '--bundle', 'local-foo', '--target', 'repo-vscode', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(0);
      expect(parseJson<{ lockfile: string }>(result.stdout).data.lockfile).toBe(path.join(workspace, 'prompt-registry.lock.json'));
      expect(await exists(vscodePrompt())).toBe(false);
      expect(Object.keys((await readRecord()).bundles['local-foo'].tools)).toEqual(['kiro']);
    });
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
