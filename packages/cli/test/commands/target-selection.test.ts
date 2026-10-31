/**
 * Contract tests for target selection without `target-state.json`
 * (BR23.1–BR23.3, BR25.1; NFR4.27, NFR4.28, NFR4.30, NFR5.5).
 *
 * Every case runs the real commands against a temp git repository, a
 * separate home folder and a local bundle folder: targets are configured
 * with `target add`, records are written by real installs, and "unchanged"
 * means byte-identical files on disk.
 */
import {
  realpathSync,
} from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveUserConfigPaths,
} from '@ai-primitives-hub/app';
import {
  NodeFileSystem,
  XdgAppStorage,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
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
  TargetRemoveCommand,
} from '../../src/commands/target-remove';
import {
  UninstallCommand,
} from '../../src/commands/uninstall';
import {
  UpdateCommand,
} from '../../src/commands/update';
import {
  runCommand,
} from '../../src/framework';

const COMMAND_CLASSES = [TargetAddCommand, TargetRemoveCommand, InstallCommand, UninstallCommand, UpdateCommand, StatusCommand, InitCommand];
const OLD_STATE_LINE = 'The last used target (.ai-primitives-hub/target-state.json) is no longer used; pass --target.';
const OLD_STATE_TEXT = '{"targets":{"copilot":{"targetName":"copilot","lastInstalledBundles":[],"lastUsedAt":"2026-01-01T00:00:00Z"}}}\n';

interface Envelope<T> {
  status: string;
  data: T;
  warnings?: string[];
  errors?: { code: string; message: string; hint?: string }[];
}

describe('target selection without target-state.json', () => {
  let root: string;
  let repo: string;
  let home: string;
  let bundle: string;

  const env = (): Record<string, string> => ({
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    AI_PRIMITIVES_HUB_SKIP_NETWORK: '1'
  });
  const run = (argv: string[]): ReturnType<typeof runCommand> =>
    runCommand(argv, { commandClasses: COMMAND_CLASSES, context: { cwd: repo, fs: new NodeFileSystem(), env: env() } });
  const ok = async (argv: string[]): Promise<void> => {
    const result = await run(argv);
    expect(result.exitCode, `${argv.join(' ')}\n${result.stdout}${result.stderr}`).toBe(0);
  };
  const json = <T>(stdout: string): Envelope<T> => JSON.parse(stdout) as Envelope<T>;

  const userRecord = (): string => new XdgAppStorage(env()).getPaths().userRecord;
  const repoRecord = (): string => path.join(repo, 'ai-primitives-hub.lock.json');
  const oldRepoLock = (): string => path.join(repo, 'prompt-registry.lock.json');
  const userTargetDir = (): string => path.join(home, 'target');
  const statePath = (): string => path.join(repo, '.ai-primitives-hub', 'target-state.json');
  const exists = (file: string): Promise<boolean> => readFile(file).then(() => true, () => false);

  /**
   * Every file under a folder, by relative path, with its bytes as base64.
   * @param dir Folder to read.
   */
  const tree = async (dir: string): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) {
        const file = path.join(entry.parentPath, entry.name);
        out[path.relative(dir, file)] = (await readFile(file)).toString('base64');
      }
    }
    return out;
  };

  /**
   * Configure targets: `user` adds the user-scope copilot-cli target `copilot`;
   * any other entry is a repository-scope target of that type.
   * @param targets Target name and type pairs.
   */
  const addTargets = async (targets: [string, string][]): Promise<void> => {
    for (const [name, type] of targets) {
      await ok(type === 'copilot-cli'
        ? ['target', 'add', name, '--type', type, '--path', userTargetDir(), '-o', 'json']
        : ['target', 'add', name, '--type', type, '--scope', 'repository', '--workspace-root', repo, '-o', 'json']);
    }
  };

  /**
   * Write a 2.0.0 `prompt-registry`-style lockfile.
   * @param file Absolute path.
   * @param bundles Bundle id → its single file, root-relative; empty for an empty lockfile.
   */
  const writeOldLock = async (file: string, bundles: Record<string, string>): Promise<void> => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({
      $schema: 'https://github.com/AmadeusITGroup/prompt-registry/schemas/lockfile.schema.json',
      version: '2.0.0',
      generatedAt: '2026-10-01T00:00:00.000Z',
      generatedBy: 'ai-primitives-hub-cli@0.2.1',
      bundles: Object.fromEntries(Object.entries(bundles).map(([id, filePath]) => [id, {
        version: '1.0.0', sourceId: 'local-bundle', sourceType: 'local', installedAt: '2026-10-01T00:00:00.000Z',
        commitMode: 'commit', files: [{ path: filePath, checksum: '0'.repeat(64) }]
      }])),
      sources: Object.keys(bundles).length === 0 ? {} : { 'local-bundle': { type: 'local', url: bundle } }
    }, null, 2)}\n`);
  };

  beforeEach(async () => {
    root = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), 'cli-target-selection-')));
    repo = path.join(root, 'repo');
    home = path.join(root, 'home');
    // Inside home, so the user level's source trust gate accepts the local source.
    bundle = path.join(home, 'bundle');
    await mkdir(path.join(repo, '.git'), { recursive: true });
    await writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await mkdir(userTargetDir(), { recursive: true });
    await mkdir(path.join(bundle, 'prompts'), { recursive: true });
    await writeFile(path.join(bundle, 'deployment-manifest.yml'),
      'id: local-foo\nversion: 1.0.0\nname: Local Foo\nitems:\n  - path: prompts/hello.prompt.md\n    kind: prompt\n');
    await writeFile(path.join(bundle, 'prompts', 'hello.prompt.md'), '# Hello Prompt\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('two targets and no --target (NFR4.27)', () => {
    beforeEach(async () => {
      await addTargets([['copilot', 'copilot-cli'], ['repo-kiro', 'kiro']]);
      // A user record without the import marker, an old user lockfile, an
      // empty older repository lockfile and an old target-state.json: a
      // failing command must leave every one of them as it is.
      await ok(['install', 'local-foo', '--from', bundle, '--target', 'copilot', '-o', 'json']);
      const record = JSON.parse(await readFile(userRecord(), 'utf8')) as Record<string, unknown>;
      delete record.importedUserLockfileAt;
      await writeFile(userRecord(), `${JSON.stringify(record, null, 2)}\n`);
      await writeOldLock(resolveUserConfigPaths(env()).userLockfile, { 'old-user': 'prompts/old.prompt.md' });
      await writeOldLock(oldRepoLock(), {});
      await mkdir(path.dirname(statePath()), { recursive: true });
      await writeFile(statePath(), OLD_STATE_TEXT);
    });

    it.each([
      ['install <bundle-id>', ['install', 'local-foo']],
      ['install --from', ['install', 'local-foo', '--from', '<bundle>']],
      ['install --source', ['install', '--source', 'some-hub']],
      ['install --lockfile <2.0.0 file>', ['install', '--lockfile', 'prompt-registry.lock.json']],
      ['uninstall --all', ['uninstall', '--all']],
      ['uninstall --lockfile', ['uninstall', '--lockfile', 'prompt-registry.lock.json']],
      ['old-format update', ['update', '--no-hub-sync']],
      ['old-format uninstall', ['uninstall', '--bundle', 'old-user']]
    ])('%s fails with USAGE.MISSING_FLAG listing both targets and changes nothing', async (_name, argv) => {
      const before = await tree(root);

      const result = await run([...argv.map((arg) => (arg === '<bundle>' ? bundle : arg)), '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(1);
      const [error] = json<null>(result.stdout).errors ?? [];
      expect(error).toMatchObject({ code: 'USAGE.MISSING_FLAG', message: expect.stringContaining('--target <name> is required') });
      expect(error.hint).toContain('Multiple targets configured: copilot, repo-kiro.');
      expect(error.hint).toContain(OLD_STATE_LINE);
      expect(await tree(root)).toEqual(before);
    });
  });

  it('uses the only configured target when no --target is given (BR23.2)', async () => {
    await addTargets([['copilot', 'copilot-cli']]);

    const result = await run(['install', 'local-foo', '--from', bundle, '-o', 'json']);

    expect(result.exitCode, result.stdout).toBe(0);
    expect(json<{ target: string }>(result.stdout).data.target).toBe('copilot');
    expect(await readFile(path.join(userTargetDir(), 'prompts', 'hello.prompt.md'), 'utf8')).toBe('# Hello Prompt\n');
  });

  it.each([true, false])('install, update and uninstall never mention, change or create target-state.json (file present: %s; NFR4.28, NFR5.5)', async (present) => {
    await addTargets([['copilot', 'copilot-cli'], ['repo-kiro', 'kiro']]);
    if (present) {
      await mkdir(path.dirname(statePath()), { recursive: true });
      await writeFile(statePath(), OLD_STATE_TEXT);
    }

    for (const argv of [
      ['install', 'local-foo', '--from', bundle, '--target', 'copilot'],
      ['update', '--target', 'copilot', '--no-hub-sync'],
      ['uninstall', '--bundle', 'local-foo', '--target', 'copilot']
    ]) {
      const result = await run(argv);
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(result.stdout + result.stderr).not.toContain('target-state');
    }

    expect(present ? await readFile(statePath(), 'utf8') : await exists(statePath())).toBe(present ? OLD_STATE_TEXT : false);
  });

  describe('record-driven uninstall and update with two repository targets (BR23.3)', () => {
    const vscodePrompt = (): string => path.join(repo, '.github', 'prompts', 'hello.prompt.md');

    it('uninstalls a bundle recorded for one tool through the target mapped to it', async () => {
      await addTargets([['repo-vscode', 'vscode'], ['repo-kiro', 'kiro']]);
      await ok(['install', 'local-foo', '--from', bundle, '--target', 'repo-vscode', '-o', 'json']);

      const result = await run(['uninstall', '--bundle', 'local-foo', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(0);
      expect(json<{ target: string; level: string }>(result.stdout).data).toMatchObject({ target: 'repo-vscode', level: 'repository' });
      expect(await exists(vscodePrompt())).toBe(false);
      expect(await exists(repoRecord())).toBe(false);
    });

    it('fails with USAGE.MISSING_FLAG and removes nothing when no target matches the recorded tool', async () => {
      await addTargets([['repo-vscode', 'vscode'], ['repo-kiro', 'kiro'], ['copilot', 'copilot-cli']]);
      await ok(['install', 'local-foo', '--from', bundle, '--target', 'repo-vscode', '-o', 'json']);
      await ok(['target', 'remove', 'repo-vscode', '-o', 'json']);
      const before = await tree(root);

      const result = await run(['uninstall', '--bundle', 'local-foo', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(1);
      expect(json<null>(result.stdout).errors?.[0]).toMatchObject({
        code: 'USAGE.MISSING_FLAG',
        message: 'uninstall: no vscode target configured; add one with target add, or pass --target'
      });
      expect(await tree(root)).toEqual(before);
    });

    it('uses the first matching target by name and puts the note in warnings', async () => {
      await addTargets([['vscode-b', 'vscode'], ['vscode-a', 'vscode']]);
      await ok(['install', 'local-foo', '--from', bundle, '--target', 'vscode-b', '-o', 'json']);

      const result = await run(['uninstall', '--bundle', 'local-foo', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(0);
      const envelope = json<{ target: string }>(result.stdout);
      expect(envelope.data.target).toBe('vscode-a');
      expect(envelope.warnings).toContain('several vscode targets match; using vscode-a');
      expect(await exists(vscodePrompt())).toBe(false);
    });

    it('update --dry-run reports old-file-only bundles as per-bundle failures and checks the recorded ones', async () => {
      await addTargets([['repo-vscode', 'vscode'], ['repo-kiro', 'kiro']]);
      await ok(['install', 'local-foo', '--from', bundle, '--target', 'repo-vscode', '-o', 'json']);
      await writeOldLock(oldRepoLock(), { 'old-only': '.github/prompts/old.prompt.md' });
      const before = await tree(root);

      const result = await run(['update', '--dry-run', '--no-hub-sync', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(1);
      const { data } = json<{ checked: number; records: string[]; oldFile: { failures: string[] } }>(result.stdout);
      expect(data).toMatchObject({ checked: 1, records: [repoRecord()] });
      expect(data.oldFile.failures).toEqual(['Failed to update old-only: update: --target <name> is required']);
      expect(await tree(root)).toEqual(before);
    });

    it('removes a lone unknown entry, keeps its files and names the record instead of a target (BR21.3)', async () => {
      await addTargets([['repo-vscode', 'vscode'], ['repo-kiro', 'kiro']]);
      const oldPrompt = path.join(repo, '.github', 'prompts', 'old.prompt.md');
      await mkdir(path.dirname(oldPrompt), { recursive: true });
      await writeFile(oldPrompt, '# Old\n');
      await writeOldLock(oldRepoLock(), { 'old-only': '.github/prompts/old.prompt.md' });
      // The install migrates the old file: old-only becomes a lone unknown entry.
      await ok(['install', 'local-foo', '--from', bundle, '--target', 'repo-vscode', '-o', 'json']);

      const result = await run(['uninstall', '--bundle', 'old-only', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(0);
      const { data } = json<Record<string, unknown>>(result.stdout);
      expect(data).toMatchObject({ level: 'repository', records: [repoRecord()], tool: 'unknown', kept: ['.github/prompts/old.prompt.md'] });
      expect(data).not.toHaveProperty('target');
      expect(await readFile(oldPrompt, 'utf8')).toBe('# Old\n');
      expect(Object.keys((JSON.parse(await readFile(repoRecord(), 'utf8')) as { bundles: object }).bundles)).toEqual(['local-foo']);
    });

    it.each(['text', 'json'])('uninstall --dry-run (%s) of a lone unknown entry names the level and record, no target, and leaves an older file unmigrated (BR18.1, NFR4.30)', async (format) => {
      await addTargets([['repo-vscode', 'vscode'], ['repo-kiro', 'kiro']]);
      const oldPrompt = path.join(repo, '.github', 'prompts', 'old.prompt.md');
      await mkdir(path.dirname(oldPrompt), { recursive: true });
      await writeFile(oldPrompt, '# Old\n');
      await writeOldLock(oldRepoLock(), { 'old-only': '.github/prompts/old.prompt.md' });
      // The install migrates the old file: old-only becomes a lone unknown entry.
      await ok(['install', 'local-foo', '--from', bundle, '--target', 'repo-vscode', '-o', 'json']);
      // An older release then writes the old file again, so a real run would migrate it first.
      await writeOldLock(oldRepoLock(), { 'old-later': '.github/prompts/later.prompt.md' });
      const before = await tree(root);
      const argv = ['uninstall', '--bundle', 'old-only', '--dry-run'];

      const result = await run(format === 'json' ? [...argv, '-o', 'json'] : argv);

      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      if (format === 'json') {
        const { data } = json<Record<string, unknown>>(result.stdout);
        expect(data).toMatchObject({ dryRun: true, level: 'repository', records: [repoRecord()], bundle: 'old-only' });
        expect(data).not.toHaveProperty('target');
      } else {
        expect(result.stdout).toContain(`Record: repository ${repoRecord()}\n`);
        expect(result.stdout).not.toContain('Target');
      }
      expect(await tree(root)).toEqual(before);
    });
  });

  describe('the default rule picks the level for update and uninstall without --target (NFR4.30)', () => {
    beforeEach(async () => {
      await addTargets([['copilot', 'copilot-cli'], ['repo-kiro', 'kiro']]);
      await ok(['install', 'local-foo', '--from', bundle, '--target', 'copilot', '-o', 'json']);
    });

    it.each([
      ['uninstall', 'text'], ['uninstall', 'json'], ['update', 'text'], ['update', 'json']
    ])('%s (%s) in a repository with no record acts on the user level only', async (command, format) => {
      const repoBefore = await tree(repo);
      const argv = command === 'uninstall' ? ['uninstall', '--bundle', 'local-foo'] : ['update', '--no-hub-sync'];

      const result = await run(format === 'json' ? [...argv, '-o', 'json'] : argv);

      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      if (format === 'json') {
        expect(json<{ level: string; records: string[] }>(result.stdout).data).toMatchObject({ level: 'user', records: [userRecord()] });
      } else {
        expect(result.stdout).toContain(`Record: user ${userRecord()}\n`);
      }
      expect(await tree(repo)).toEqual(repoBefore);
      expect(await exists(path.join(userTargetDir(), 'prompts', 'hello.prompt.md'))).toBe(command === 'update');
    });

    it.each(['text', 'json'])('uninstall --dry-run (%s) names the level and record it would change and changes nothing', async (format) => {
      const before = await tree(root);
      const argv = ['uninstall', '--bundle', 'local-foo', '--dry-run'];

      const result = await run(format === 'json' ? [...argv, '-o', 'json'] : argv);

      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      if (format === 'json') {
        expect(json<Record<string, unknown>>(result.stdout).data).toMatchObject({ dryRun: true, level: 'user', records: [userRecord()], target: 'copilot', bundle: 'local-foo' });
      } else {
        expect(result.stdout).toContain(`Record: user ${userRecord()}\n`);
      }
      expect(await tree(root)).toEqual(before);
    });

    it.each([
      ['uninstall --scope repository', ['uninstall', '--bundle', 'local-foo', '--scope', 'repository']],
      ['update --scope repository', ['update', '--scope', 'repository', '--no-hub-sync']],
      ['update --lockfile <repository record>', ['update', '--lockfile', 'ai-primitives-hub.lock.json', '--no-hub-sync']]
    ])('%s acts on the repository record only when the user record holds the bundle too', async (_name, argv) => {
      // The repository level only trusts a local source inside the repository.
      const repoBundle = path.join(repo, 'bundles', 'local-foo');
      await cp(bundle, repoBundle, { recursive: true });
      const repoBaseline = await tree(repo);
      // The repository record holds local-foo for another tool (kiro) than the user record (copilot-cli).
      await ok(['install', 'local-foo', '--from', repoBundle, '--target', 'repo-kiro', '-o', 'json']);
      const homeBefore = await tree(home);

      const result = await run([...argv, '-o', 'json']);

      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(json<{ level: string; records: string[] }>(result.stdout).data).toMatchObject({ level: 'repository', records: [repoRecord()] });
      // The user record and the user target's files stay byte-identical.
      expect(await tree(home)).toEqual(homeBefore);
      if (argv[0] === 'uninstall') {
        expect(await tree(repo)).toEqual(repoBaseline);
      } else {
        const record = JSON.parse(await readFile(repoRecord(), 'utf8')) as { bundles: Record<string, { tools: object }> };
        expect(Object.keys(record.bundles['local-foo'].tools)).toEqual(['kiro']);
      }
    });

    it.each([['uninstall', '--bundle', 'local-foo'], ['update', '--no-hub-sync']])('%s selects the repository level when only an older prompt-registry.lock.json is there', async (...argv) => {
      await writeOldLock(oldRepoLock(), {});
      const before = await tree(root);

      const result = await run([...argv, '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(1);
      expect(json<null>(result.stdout).errors?.[0].code).toBe('USAGE.MISSING_FLAG');
      expect(await tree(root)).toEqual(before);
    });
  });

  describe('init at repository scope (BR25.1, NFR4.28)', () => {
    const initRepo = ['init', '--target-name', 'repo-vscode', '--target-type', 'vscode', '--scope', 'repository', '--yes', '--skip-index', '-o', 'json'];

    it('creates no record, does not report a lockfile step, and status then uses the user record', async () => {
      const result = await run(initRepo);

      expect(result.exitCode, result.stdout).toBe(0);
      expect(result.stdout).not.toContain('lockfile initialized');
      expect(await exists(repoRecord())).toBe(false);
      expect(await exists(oldRepoLock())).toBe(false);
      const status = await run(['status']);
      expect(status.stdout).toContain(`Record: user ${userRecord()}\n`);
    });

    it('leaves existing records and older files byte-identical', async () => {
      const other = path.join(home, 'other');
      await mkdir(path.join(other, 'prompts'), { recursive: true });
      await writeFile(path.join(other, 'deployment-manifest.yml'),
        'id: other-foo\nversion: 1.0.0\nname: Other Foo\nitems:\n  - path: prompts/other.prompt.md\n    kind: prompt\n');
      await writeFile(path.join(other, 'prompts', 'other.prompt.md'), '# Other\n');
      await ok(['target', 'add', 'repo-vscode', '--type', 'vscode', '--scope', 'repository', '--workspace-root', repo, '-o', 'json']);
      await ok(['install', 'local-foo', '--from', bundle, '--target', 'repo-vscode', '-o', 'json']);
      await ok(['install', 'other-foo', '--from', other, '--target', 'repo-vscode', '--commit-mode', 'local-only', '-o', 'json']);
      await writeOldLock(oldRepoLock(), {});
      const files = [repoRecord(), path.join(repo, 'ai-primitives-hub.local.lock.json'), oldRepoLock()];
      const before = await Promise.all(files.map((file) => readFile(file, 'utf8')));

      const result = await run(initRepo);

      expect(result.exitCode, result.stdout).toBe(0);
      expect(await Promise.all(files.map((file) => readFile(file, 'utf8')))).toEqual(before);
    });
  });
});
