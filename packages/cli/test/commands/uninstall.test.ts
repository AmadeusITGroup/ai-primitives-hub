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
  createGovernedReleaseArchive,
  writeReleaseArchive,
} from '../fixtures/release-archives';
import {
  addRepositoryTargets,
  initGitRoot,
  makeRun,
  readRecord,
  recordPathIn,
} from '../helpers/install-record-fixtures';

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

  const run = makeRun(() => workspace, COMMAND_CLASSES);

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
    const oldLockPath = (): string => path.join(workspace, 'prompt-registry.lock.json');
    /**
     * Write an old 2.0.0 `prompt-registry.lock.json`, as an install made before the record would have left it.
     * @param bundles - Bundle id → its single prompt file, relative to the bundle.
     */
    const writeOldLock = async (bundles: Record<string, string>): Promise<void> => {
      await writeFile(oldLockPath(), `${JSON.stringify({
        $schema: 'https://github.com/AmadeusITGroup/prompt-registry/schemas/lockfile.schema.json',
        version: '2.0.0',
        generatedAt: '2026-10-01T00:00:00.000Z',
        generatedBy: 'ai-primitives-hub-cli@0.2.1',
        bundles: Object.fromEntries(Object.entries(bundles).map(([id, file]) => [id, {
          version: '1.0.0',
          sourceId: 'local-bundle',
          sourceType: 'local',
          installedAt: '2026-10-01T00:00:00.000Z',
          commitMode: 'commit',
          files: [{ path: file, checksum: '0'.repeat(64) }]
        }])),
        sources: { 'local-bundle': { type: 'local', url: bundleDir } }
      }, null, 2)}\n`);
    };
    const recordPath = (): string => recordPathIn(workspace);
    const vscodePrompt = (): string => path.join(workspace, '.github', 'prompts', 'hello.prompt.md');
    const recordedTools = async (): Promise<string[]> =>
      Object.keys((await readRecord(workspace)).bundles['local-foo'].tools).toSorted();
    const exists = async (file: string): Promise<boolean> => readFile(file).then(() => true, () => false);

    beforeEach(async () => {
      await initGitRoot(workspace);
      await addRepositoryTargets(run, workspace, [['repo-vscode', 'vscode'], ['repo-kiro', 'kiro']], { bundleDir });
    });

    it('uninstalling one tool from the record keeps the other tool and its files', async () => {
      const result = await run(['uninstall', '--bundle', 'local-foo', '--target', 'repo-kiro', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(0);
      expect(parseJson<{ lockfile: string }>(result.stdout).data.lockfile).toBe(recordPath());
      expect(await recordedTools()).toEqual(['vscode']);
      expect(await exists(vscodePrompt())).toBe(true);
    });

    it.each([
      ['a file edited after install is kept and named in a warning', (): Promise<void> => writeFile(vscodePrompt(), '# My own edits\n'), true,
        ['Did not remove .github/prompts/hello.prompt.md: it was changed after install.']],
      ['a missing file does not fail it', (): Promise<void> => rm(vscodePrompt()), false, []]
    ])('uninstall: %s, and the entry is removed (NFR4.13)', async (_label, change, onDisk, warnings) => {
      await change();

      const result = await run(['uninstall', '--bundle', 'local-foo', '--target', 'repo-vscode', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(0);
      const envelope = JSON.parse(result.stdout) as { warnings: string[]; data: { removed: string[] } };
      expect(envelope.warnings).toEqual(warnings);
      expect(envelope.data.removed).toEqual([]);
      expect(await recordedTools()).toEqual(['kiro']);
      expect(await exists(vscodePrompt())).toBe(onDisk);
    });

    it('falls back to the old store for a bundle that is not in the record', async () => {
      expect((await run(['uninstall', '--bundle', 'local-foo', '--target', 'repo-vscode', '-o', 'json'])).exitCode).toBe(0);
      await mkdir(path.dirname(vscodePrompt()), { recursive: true });
      await writeFile(vscodePrompt(), '# Hello Prompt\n');
      await writeOldLock({ 'local-foo': 'prompts/hello.prompt.md' });

      const result = await run(['uninstall', '--bundle', 'local-foo', '--target', 'repo-vscode', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(0);
      expect(parseJson<{ lockfile: string }>(result.stdout).data.lockfile).toBe(oldLockPath());
      expect(await exists(vscodePrompt())).toBe(false);
    });

    it('--all uninstalls a bundle in both the record and the old store once', async () => {
      await writeFile(path.join(workspace, '.github', 'prompts', 'old.prompt.md'), '# Old\n');
      await writeOldLock({ 'local-foo': 'prompts/hello.prompt.md', 'old-only': 'prompts/old.prompt.md' });

      const result = await run(['uninstall', '--all', '--target', 'repo-vscode', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(0);
      const data = parseJson<{ uninstalled: number; bundles: { id: string }[] }>(result.stdout).data;
      expect(data.bundles.map((bundle) => bundle.id)).toEqual(['local-foo', 'old-only']);
      expect(data.uninstalled).toBe(2);
      expect(await recordedTools()).toEqual(['kiro']);
    });

    it('refuses uninstall <id> without --target when the bundle has several tools, removing nothing', async () => {
      const before = await readFile(recordPath(), 'utf8');

      const result = await run(['uninstall', '--bundle', 'local-foo', '-o', 'json']);

      expect(result.exitCode).toBe(1);
      const error = (JSON.parse(result.stdout) as { errors: { code: string; message: string; context: { tools: string[] } }[] }).errors[0];
      expect(error).toMatchObject({ code: 'USAGE.MISSING_FLAG', context: { tools: ['kiro', 'vscode'] } });
      expect(error.message).toContain('kiro, vscode');
      expect(await readFile(recordPath(), 'utf8')).toBe(before);
      expect(await exists(vscodePrompt())).toBe(true);
    });

    it('--lockfile <3.0.0 record> --target <user-scope vscode> refuses with USAGE.INVALID_FLAG, removing nothing', async () => {
      expect((await run(['target', 'add', 'user-vscode', '--type', 'vscode', '--path', path.join(workspace, 'user-vscode'), '-o', 'json'])).exitCode).toBe(0);
      const before = await readFile(recordPath(), 'utf8');

      const result = await run(['uninstall', '--lockfile', recordPath(), '--target', 'user-vscode', '-o', 'json']);

      expect(result.exitCode).toBe(1);
      expect((JSON.parse(result.stdout) as { errors: { code: string }[] }).errors[0].code).toBe('USAGE.INVALID_FLAG');
      expect(await readFile(recordPath(), 'utf8')).toBe(before);
      expect(await exists(vscodePrompt())).toBe(true);
    });

    it('--lockfile <3.0.0 record> --target <kiro> removes only the kiro entries and keeps vscode files', async () => {
      const result = await run(['uninstall', '--lockfile', recordPath(), '--target', 'repo-kiro']);

      expect(result.exitCode, result.stdout).toBe(0);
      expect(result.stdout).toContain(`Record: repository ${recordPath()}\n`);
      expect(await recordedTools()).toEqual(['vscode']);
      expect(await exists(vscodePrompt())).toBe(true);
    });

    it('--lockfile <2.0.0 file> uninstalls as before', async () => {
      const oldFile = path.join(workspace, '.github', 'prompts', 'old.prompt.md');
      await writeFile(oldFile, '# Old\n');
      await writeOldLock({ 'old-only': 'prompts/old.prompt.md' });

      const result = await run(['uninstall', '--lockfile', oldLockPath(), '--target', 'repo-vscode', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(0);
      expect(parseJson<{ lockfile: string; uninstalled: number }>(result.stdout).data).toMatchObject({ lockfile: oldLockPath(), uninstalled: 1 });
      expect(await exists(oldFile)).toBe(false);
      expect(await recordedTools()).toEqual(['kiro', 'vscode']);
    });
  });

  it('fails with exit 1 when neither --bundle, --lockfile, nor --all is given (and no lockfile is discoverable)', async () => {
    const freshWorkspace = await mkdtemp(path.join(os.tmpdir(), 'cli-uninstall-test-fresh-'));
    try {
      const freshTargetDir = path.join(freshWorkspace, 'target');
      await mkdir(freshTargetDir, { recursive: true });
      const freshRun = makeRun(() => freshWorkspace, COMMAND_CLASSES);
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
