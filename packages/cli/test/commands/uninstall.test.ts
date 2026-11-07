/**
 * `uninstall` command tests (symmetric with install.test.ts's local
 * `--from` mode — no network required).
 *
 * Uses a real `NodeFileSystem` against a real temp directory (not
 * `createTestContext`'s default in-memory `fs` stub, which rejects
 * every call) since uninstall does real file removals + lockfile IO.
 */
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
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
import {
  makeGitDir,
} from '../helpers/git-fixture';

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

  describe('guarded removal', () => {
    const posixOnly = it.skipIf(process.platform === 'win32');
    const posixNonRoot = it.skipIf(process.platform === 'win32' || process.getuid?.() === 0);
    const commitLock = (): string => path.join(workspace, 'prompt-registry.lock.json');
    const localLock = (): string => path.join(workspace, 'prompt-registry.local.lock.json');
    const github = (...segments: string[]): string => path.join(workspace, '.github', ...segments);
    type Envelope = JsonEnvelope<{ removed: string[]; skipped: string[]; lockfile: string }> & { warnings?: string[] };
    const envelopeOf = (stdout: string): Envelope => JSON.parse(stdout) as Envelope;

    /**
     * Write a local bundle directory with an `items:` manifest.
     * @param id Bundle id (also the directory name below the workspace).
     * @param items Manifest items.
     * @param files Bundle files.
     * @returns The bundle directory.
     */
    const writeBundle = async (id: string, items: { path: string; kind: string }[], files: Record<string, string>): Promise<string> => {
      const dir = path.join(workspace, 'bundles', id);
      const manifest = [`id: ${id}`, 'version: 1.0.0', `name: ${id}`, 'items:',
        ...items.flatMap((item) => [`  - path: ${item.path}`, `    kind: ${item.kind}`])].join('\n');
      for (const [file, content] of Object.entries({ 'deployment-manifest.yml': `${manifest}\n`, ...files })) {
        await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
        await writeFile(path.join(dir, file), content);
      }
      return dir;
    };
    const sharedBundle = (id: string): Promise<string> => writeBundle(id, [
      { path: 'prompts/shared.prompt.md', kind: 'prompt' },
      { path: `prompts/${id}.prompt.md`, kind: 'prompt' }
    ], { 'prompts/shared.prompt.md': '# Shared\n', [`prompts/${id}.prompt.md`]: `# ${id}\n` });
    const pluginBundle = (id: string): Promise<string> => writeBundle(id, [
      { path: `plugins/${id}/plugin.json`, kind: 'plugin' }
    ], {
      [`plugins/${id}/plugin.json`]: '{"name":"N","description":"D"}\n',
      [`plugins/${id}/scripts/run.sh`]: 'echo run\n',
      [`plugins/${id}/skills/helper/SKILL.md`]: '# Helper\n'
    });
    const addRepositoryTarget = async (name: string, type: string): Promise<void> => {
      expect((await run(['target', 'add', name, '--type', type, '--scope', 'repository', '-o', 'json'])).exitCode).toBe(0);
    };
    const install = async (from: string, target: string, extra: string[] = []): Promise<void> => {
      const result = await run(['install', '--from', from, '--target', target, ...extra, '-o', 'json']);
      expect(result.exitCode, result.stdout).toBe(0);
    };
    const uninstall = (bundle: string, target: string, extra: string[] = []): ReturnType<typeof run> =>
      run(['uninstall', '--bundle', bundle, '--target', target, ...extra, '-o', 'json']);
    const editEntry = async (lockfile: string, bundle: string, extraPaths: string[]): Promise<void> => {
      const lock = JSON.parse(await readFile(lockfile, 'utf8')) as { bundles: Record<string, { files: { path: string; checksum: string }[] }> };
      lock.bundles[bundle].files.push(...extraPaths.map((p) => ({ path: p, checksum: 'a'.repeat(64) })));
      await writeFile(lockfile, JSON.stringify(lock, null, 2));
    };
    const exists = async (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

    const SCOPES = [
      { scope: 'user', target: 'copilot', root: (): string => targetDir },
      { scope: 'repository', target: 'repo', root: (): string => github() }
    ] as const;

    it.each(SCOPES)('keeps a file another bundle records and lists it in skipped ($scope scope)', async ({ target, root }) => {
      await addRepositoryTarget('repo', 'vscode');
      await install(await sharedBundle('alpha'), target);
      await install(await sharedBundle('beta'), target);

      const first = await uninstall('alpha', target);

      expect(first.exitCode, first.stdout).toBe(0);
      const envelope = envelopeOf(first.stdout);
      expect(envelope.status).toBe('ok');
      expect(envelope.data.removed).toEqual(['prompts/alpha.prompt.md']);
      expect(envelope.data.skipped).toEqual(['prompts/shared.prompt.md']);
      expect(await exists(path.join(root(), 'prompts', 'shared.prompt.md'))).toBe(true);

      const second = await uninstall('beta', target);

      expect(envelopeOf(second.stdout).data.removed).toEqual(expect.arrayContaining(['prompts/shared.prompt.md']));
      expect(await exists(path.join(root(), 'prompts', 'shared.prompt.md'))).toBe(false);
    });

    it.each(SCOPES)('leaves no empty directory of an uninstalled plugin ($scope scope)', async ({ target, root }) => {
      await addRepositoryTarget('repo', 'vscode');
      await install(await pluginBundle('demo-plugin'), target);
      expect(await exists(path.join(root(), 'plugins', 'demo-plugin', 'skills', 'helper', 'SKILL.md'))).toBe(true);

      const result = await uninstall('demo-plugin', target);

      expect(result.exitCode, result.stdout).toBe(0);
      expect(await exists(path.join(root(), 'plugins', 'demo-plugin'))).toBe(false);
      expect(await exists(path.join(root(), 'plugins'))).toBe(false);
      expect(await exists(root())).toBe(true);
    });

    it('never removes a recorded path outside the target root and warns about it', async () => {
      await addRepositoryTarget('repo', 'vscode');
      await install(bundleDir, 'repo');
      const outside = path.join(workspace, 'outside.txt');
      const absolute = path.join(workspace, 'absolute.txt');
      const readme = path.join(workspace, 'README.md');
      for (const sentinel of [outside, absolute, readme]) {
        await writeFile(sentinel, 'sentinel\n');
      }
      await editEntry(commitLock(), 'local-foo', ['../outside.txt', absolute, 'README.md']);

      const result = await uninstall('local-foo', 'repo');

      expect(result.exitCode, result.stdout).toBe(0);
      const envelope = envelopeOf(result.stdout);
      expect(envelope.status).toBe('warning');
      expect(envelope.data.removed).toEqual(['prompts/hello.prompt.md']);
      expect(envelope.data.skipped).toEqual(['../outside.txt', absolute, 'README.md']);
      expect(envelope.warnings).toEqual(['../outside.txt', absolute, 'README.md']
        .map((p) => `local-foo: refused ${p}: no location inside the target root`));
      for (const sentinel of [outside, absolute, readme]) {
        expect(await readFile(sentinel, 'utf8')).toBe('sentinel\n');
      }
    });

    posixNonRoot('reports kept, refused, missing and failed files as skipped', async () => {
      await addRepositoryTarget('repo', 'kiro');
      const mixed = await writeBundle('mixed', [
        { path: 'prompts/shared.prompt.md', kind: 'prompt' },
        { path: 'prompts/gone.prompt.md', kind: 'prompt' },
        { path: 'agents/locked.agent.md', kind: 'agent' }
      ], { 'prompts/shared.prompt.md': '# Shared\n', 'prompts/gone.prompt.md': '# Gone\n', 'agents/locked.agent.md': '# Locked\n' });
      const kiro = (...segments: string[]): string => path.join(workspace, '.kiro', ...segments);
      await install(mixed, 'repo');
      await install(await sharedBundle('other'), 'repo');
      await editEntry(commitLock(), 'mixed', ['../outside.txt']);
      await rm(kiro('steering', 'gone.prompt.md'));
      await chmod(kiro('agents'), 0o555);
      try {
        const result = await uninstall('mixed', 'repo');

        expect(result.exitCode, result.stdout).toBe(0);
        const envelope = envelopeOf(result.stdout);
        expect(envelope.data.removed).toEqual([]);
        expect(envelope.data.skipped.toSorted()).toEqual([
          '../outside.txt', 'agents/locked.agent.md', 'prompts/gone.prompt.md', 'prompts/shared.prompt.md'
        ]);
        expect(envelope.warnings).toEqual([
          'mixed: refused ../outside.txt: no location inside the target root',
          expect.stringMatching(/^mixed: could not remove agents\/locked\.agent\.md: /)
        ]);
      } finally {
        await chmod(kiro('agents'), 0o755);
      }
    });

    it('removes a kiro-installed entry where kiro placed it when uninstalled through a vscode target', async () => {
      await addRepositoryTarget('kiro-repo', 'kiro');
      await addRepositoryTarget('repo', 'vscode');
      await install(bundleDir, 'kiro-repo');
      const kiroFile = path.join(workspace, '.kiro', 'steering', 'hello.prompt.md');
      expect(await exists(kiroFile)).toBe(true);

      const result = await uninstall('local-foo', 'repo');

      expect(result.exitCode, result.stdout).toBe(0);
      expect(envelopeOf(result.stdout).data.removed).toEqual(['prompts/hello.prompt.md']);
      expect(await exists(kiroFile)).toBe(false);
    });

    posixOnly.each(SCOPES)('never follows a symlinked directory below the root out of it ($scope scope)', async ({ target, root }) => {
      await addRepositoryTarget('repo', 'vscode');
      await install(await pluginBundle('linked'), target);
      const outsideDir = path.join(workspace, 'outside-dir');
      await mkdir(outsideDir);
      await writeFile(path.join(outsideDir, 'plugin.json'), 'sentinel\n');
      await rm(path.join(root(), 'plugins', 'linked'), { recursive: true });
      await symlink(outsideDir, path.join(root(), 'plugins', 'linked'));

      const result = await uninstall('linked', target);

      expect(result.exitCode, result.stdout).toBe(0);
      const envelope = envelopeOf(result.stdout);
      expect(envelope.data.skipped).toContain('plugins/linked/plugin.json');
      expect(envelope.warnings).toContain('linked: refused plugins/linked/plugin.json: no location inside the target root');
      expect(await readFile(path.join(outsideDir, 'plugin.json'), 'utf8')).toBe('sentinel\n');
    });

    it('removes every managed exclude line on a kiro local-only uninstall', async () => {
      await makeGitDir(workspace);
      await addRepositoryTarget('repo', 'kiro');
      await install(bundleDir, 'repo', ['--commit-mode', 'local-only']);
      const excludeFile = path.join(workspace, '.git', 'info', 'exclude');
      expect(await readFile(excludeFile, 'utf8')).toContain('.kiro/steering/hello.prompt.md');

      const result = await uninstall('local-foo', 'repo');

      expect(result.exitCode, result.stdout).toBe(0);
      expect(await readFile(excludeFile, 'utf8')).toBe('# Prompt Registry (local)');
      expect(await exists(localLock())).toBe(false);
    });

    it('reports the local lockfile for a local-only entry', async () => {
      await makeGitDir(workspace);
      await addRepositoryTarget('repo', 'vscode');
      await install(bundleDir, 'repo', ['--commit-mode', 'local-only']);

      const result = await uninstall('local-foo', 'repo');

      expect(result.exitCode, result.stdout).toBe(0);
      expect(envelopeOf(result.stdout).data.lockfile).toBe(localLock());
    });

    it('--all warns once, naming the workspace, that a folder outside git has no exclude file', async () => {
      await addRepositoryTarget('repo', 'kiro');
      await install(await sharedBundle('alpha'), 'repo', ['--commit-mode', 'local-only']);
      await install(await writeBundle('beta', [{ path: 'prompts/beta.prompt.md', kind: 'prompt' }], { 'prompts/beta.prompt.md': '# beta\n' }), 'repo', ['--commit-mode', 'local-only']);

      const result = await run(['uninstall', '--all', '--target', 'repo', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(0);
      expect(envelopeOf(result.stdout).warnings).toEqual([`${workspace} is not a git repository; local-only files are not excluded from git`]);
    });

    it('--all reports removed and skipped counts per bundle', async () => {
      await addRepositoryTarget('repo', 'vscode');
      await install(await sharedBundle('alpha'), 'repo');
      await install(await sharedBundle('beta'), 'repo');
      await rm(github('prompts', 'beta.prompt.md'));

      const result = await run(['uninstall', '--all', '--target', 'repo', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(0);
      expect(parseJson<{ bundles: unknown[] }>(result.stdout).data.bundles).toEqual([
        { id: 'alpha', removed: 1, skipped: 1 },
        { id: 'beta', removed: 1, skipped: 1 }
      ]);
      expect(await exists(github('prompts', 'shared.prompt.md'))).toBe(false);
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
