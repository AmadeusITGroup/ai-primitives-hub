/**
 * `profile activate`/`profile deactivate` end-to-end tests.
 *
 * Uses a real `NodeFileSystem` against a real temp directory (not
 * `createTestContext`'s default in-memory `fs` stub, which rejects every
 * call — see `framework/test-context.ts`'s module doc) because
 * activate/deactivate exercise real file writes/removals across a hub
 * config, a target directory, and the user-scope profile-activation
 * store. Mirrors the fixture/command-sequence already proven correct by
 * `doctor diagnostics`' steps 1-9 and 20-21.
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
  emptyLockfile,
  resolveUserConfigPaths,
  upsertBundleEntry,
  writeLockfile,
} from '@ai-primitives-hub/app';
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
  HubAddCommand,
  HubSyncCommand,
  HubUseCommand,
} from '../../src/commands/hub';
import {
  ProfileActivateCommand,
  ProfileCurrentCommand,
  ProfileDeactivateCommand,
  ProfileListCommand,
  ProfileShowCommand,
} from '../../src/commands/profile';
import {
  TargetAddCommand,
} from '../../src/commands/target-add';
import {
  runCommand,
} from '../../src/framework';
import {
  createGovernedReleaseArchive,
  createLegacyReleaseArchive,
  writeReleaseArchive,
} from '../fixtures/release-archives';

const COMMAND_CLASSES = [
  TargetAddCommand,
  HubAddCommand,
  HubUseCommand,
  HubSyncCommand,
  ProfileListCommand,
  ProfileShowCommand,
  ProfileCurrentCommand,
  ProfileActivateCommand,
  ProfileDeactivateCommand
];

class FailLockfileWriteFileSystem extends NodeFileSystem {
  public failedWritePath: string | null = null;

  public override async writeFile(filePath: string, contents: string): Promise<void> {
    if (filePath.includes('prompt-registry') || filePath.includes('ai-primitives-hub.lock.json')) {
      this.failedWritePath = filePath;
      await super.writeFile(filePath, contents.slice(0, 9));
      throw new Error('lockfile write failed');
    }
    await super.writeFile(filePath, contents);
  }
}

class FailOneRepositoryLockfileWriteFileSystem extends NodeFileSystem {
  public failedWritePath: string | null = null;

  public constructor(private readonly failedRepositoryRoot: string) {
    super();
  }

  public override async writeFile(filePath: string, contents: string): Promise<void> {
    if (filePath.includes(this.failedRepositoryRoot) && filePath.includes('prompt-registry.lock.json')) {
      this.failedWritePath = filePath;
      await super.writeFile(filePath, contents.slice(0, 9));
      throw new Error('simulated partial lockfile write');
    }
    await super.writeFile(filePath, contents);
  }
}

interface JsonEnvelope<T> {
  status: string;
  data: T;
}

describe('profile activate/deactivate', () => {
  let workspace: string;
  let bundleDir: string;
  let targetDir: string;
  let hubConfigFile: string;

  const run = (argv: string[], fs: NodeFileSystem = new NodeFileSystem()): ReturnType<typeof runCommand> => runCommand(argv, {
    commandClasses: COMMAND_CLASSES,
    context: {
      cwd: workspace,
      fs,
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
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-profile-test-'));
    bundleDir = path.join(workspace, 'bundle');
    targetDir = path.join(workspace, 'target');
    hubConfigFile = path.join(workspace, 'hub-config.yml');

    await mkdir(targetDir, { recursive: true });
    await writeReleaseArchive(bundleDir, createLegacyReleaseArchive({ id: 'local-foo' }));
    await writeFile(
      hubConfigFile,
      `version: 1.0.0
metadata:
  name: Test Hub
  description: Test hub for profile activate/deactivate
  maintainer: test
  updatedAt: '2026-01-01T00:00:00Z'
sources:
  - id: local-foo-src
    name: Local Foo Source
    type: local
    url: ${bundleDir}
    enabled: true
    priority: 0
    hubId: test-hub
profiles:
  - id: backend
    name: Backend Developer
    description: Test profile
    bundles:
      - id: local-foo
        version: 1.0.0
        source: local-foo-src
        required: true
`
    );

    expect((await run([
      'target', 'add', 'copilot', '--type', 'copilot-cli', '--path', targetDir, '-o', 'json'
    ])).exitCode).toBe(0);
    expect((await run([
      'hub', 'add', '--type', 'local', '--location', hubConfigFile, '--id', 'test-hub', '-o', 'json'
    ])).exitCode).toBe(0);
    expect((await run(['hub', 'use', 'test-hub', '-o', 'json'])).exitCode).toBe(0);
    expect((await run(['hub', 'sync', 'test-hub', '-o', 'json'])).exitCode).toBe(0);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('lists the seeded profile', async () => {
    const result = await run(['profile', 'list', '-o', 'json']);
    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ profiles: { id: string; name: string }[] }>(result.stdout);
    expect(envelope.data.profiles.map((p) => p.id)).toContain('backend');
  });

  it('shows profile details', async () => {
    const result = await run(['profile', 'show', 'backend', '-o', 'json']);
    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ profile: { id: string; bundles: { id: string }[] } }>(result.stdout);
    expect(envelope.data.profile.id).toBe('backend');
    expect(envelope.data.profile.bundles.map((b) => b.id)).toContain('local-foo');
  });

  it('reports no active profile before activation', async () => {
    const result = await run(['profile', 'current', '-o', 'json']);
    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ active: null }>(result.stdout);
    expect(envelope.data.active).toBeNull();
  });

  it('activates a profile: installs bundle files to the target and records it as current', async () => {
    const activateResult = await run(['profile', 'activate', 'backend', '--target', 'copilot', '-o', 'json']);
    expect(activateResult.exitCode).toBe(0);
    const activateEnvelope = parseJson<{ hubId: string; profileId: string }>(activateResult.stdout);
    expect(activateEnvelope.data.profileId).toBe('backend');
    expect(activateEnvelope.data.hubId).toBe('test-hub');

    const installed = await readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8');
    expect(installed).toContain('Hello Prompt');

    const currentResult = await run(['profile', 'current', '-o', 'json']);
    expect(currentResult.exitCode).toBe(0);
    const currentEnvelope = parseJson<{ active: { hubId: string; profileId: string } }>(currentResult.stdout);
    expect(currentEnvelope.data.active).toEqual({ hubId: 'test-hub', profileId: 'backend' });
  });

  it('activates a governed profile without writing archive metadata or ignored files', async () => {
    await writeReleaseArchive(bundleDir, createGovernedReleaseArchive({ id: 'local-foo', includeKnowledge: true }));
    expect((await run(['hub', 'sync', 'test-hub', '-o', 'json'])).exitCode).toBe(0);

    const activateResult = await run(['profile', 'activate', 'backend', '--target', 'copilot', '-o', 'json']);
    expect(activateResult.exitCode).toBe(0);

    await expect(readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8'))
      .resolves.toContain('Hello Prompt');
    await expect(readFile(path.join(
      targetDir,
      'knowledge',
      'specifications',
      'RDP',
      'provider_layer',
      'SBB_B2P',
      'SBB_B2P.md'
    ), 'utf8')).resolves.toContain('SBB B2P');
    await expect(readFile(path.join(targetDir, 'README.md'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(targetDir, 'LICENSE'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(targetDir, 'ignored', 'build', 'cache.pyc'), 'utf8'))
      .rejects.toThrow();

    const lockfilePath = resolveUserConfigPaths({
      XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
      HOME: workspace,
      USERPROFILE: workspace
    }).userLockfile;
    const lockfile = JSON.parse(await readFile(lockfilePath, 'utf8')) as {
      bundles: Record<string, { files: { path: string }[] }>;
    };
    expect(lockfile.bundles['local-foo'].files.map((file) => file.path)).toEqual([
      'prompts/hello.prompt.md',
      'knowledge/specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md'
    ]);
  });

  it('rolls back profile knowledge and overwritten prompts if lockfile persistence fails', async () => {
    await writeReleaseArchive(bundleDir, createGovernedReleaseArchive({ id: 'local-foo', includeKnowledge: true }));
    expect((await run(['hub', 'sync', 'test-hub', '-o', 'json'])).exitCode).toBe(0);
    const promptPath = path.join(targetDir, 'prompts', 'hello.prompt.md');
    await mkdir(path.dirname(promptPath), { recursive: true });
    await writeFile(promptPath, '# Previous prompt');
    const lockfilePath = resolveUserConfigPaths({
      XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
      HOME: workspace,
      USERPROFILE: workspace
    }).userLockfile;

    const failingFs = new FailLockfileWriteFileSystem();
    const result = await run(
      ['profile', 'activate', 'backend', '--target', 'copilot', '-o', 'json'],
      failingFs
    );

    expect(result.exitCode).toBe(1);
    const envelope = parseJson<{
      state: { syncedBundles: string[] };
      written: Record<string, string[]>;
      failures: { bundleId: string; target: string; reason: string }[];
    }>(result.stdout);
    expect(envelope.status).toBe('warning');
    expect(envelope.data.failures).toEqual([{
      bundleId: 'local-foo', target: 'copilot', reason: expect.stringContaining('lockfile write failed')
    }]);
    expect(envelope.data.state.syncedBundles).toEqual([]);
    expect(envelope.data.written).toEqual({});
    await expect(readFile(promptPath, 'utf8')).resolves.toBe('# Previous prompt');
    await expect(readFile(path.join(
      targetDir,
      'knowledge',
      'specifications',
      'RDP',
      'provider_layer',
      'SBB_B2P',
      'SBB_B2P.md'
    ), 'utf8')).rejects.toThrow();
    await expect(readFile(lockfilePath, 'utf8')).rejects.toThrow();
    expect(failingFs.failedWritePath).not.toBeNull();
    expect(await failingFs.exists(failingFs.failedWritePath as string)).toBe(false);
  });

  it('continues across targets after rolling back a target whose lockfile write fails', async () => {
    await writeReleaseArchive(bundleDir, createGovernedReleaseArchive({ id: 'local-foo', includeKnowledge: true }));
    expect((await run(['hub', 'sync', 'test-hub', '-o', 'json'])).exitCode).toBe(0);

    const targetRoots = [
      ['a-repo-before', path.join(workspace, 'repo-before')],
      ['m-repo-fail', path.join(workspace, 'repo-fail')],
      ['z-repo-after', path.join(workspace, 'repo-after')]
    ] as const;
    for (const [targetName, targetRoot] of targetRoots) {
      await mkdir(targetRoot, { recursive: true });
      const targetResult = await run([
        'target', 'add', targetName, '--type', 'vscode', '--scope', 'repository',
        '--workspace-root', targetRoot, '-o', 'json'
      ]);
      expect(targetResult.exitCode).toBe(0);
      expect(parseJson<{ target: { scope: string; rootPath: string } }>(targetResult.stdout).data.target)
        .toMatchObject({ scope: 'repository', rootPath: targetRoot });
    }

    const failedRoot = targetRoots[1][1];
    const failedPrompt = path.join(failedRoot, '.github', 'copilot', 'prompts', 'hello.prompt.md');
    await mkdir(path.dirname(failedPrompt), { recursive: true });
    await writeFile(failedPrompt, '# Previous failed prompt');
    const failedLockfile = path.join(failedRoot, 'prompt-registry.lock.json');
    const previousLock = upsertBundleEntry(emptyLockfile('existing@1.0.0'), 'preserved', {
      version: '1.0.0', sourceId: 'local-existing', sourceType: 'local',
      installedAt: '2024-01-01T00:00:00.000Z', files: []
    });
    await writeLockfile(failedLockfile, previousLock, new NodeFileSystem());
    const previousLockBytes = await readFile(failedLockfile, 'utf8');
    const failingFs = new FailOneRepositoryLockfileWriteFileSystem(failedRoot);

    const result = await run([
      'profile', 'activate', 'backend', '--target', targetRoots.map(([name]) => name).join(','), '-o', 'json'
    ], failingFs);

    expect(result.exitCode).toBe(1);
    const envelope = parseJson<{
      state: { syncedBundles: string[] };
      written: Record<string, string[]>;
      failures: { bundleId: string; target: string; reason: string }[];
    }>(result.stdout);
    expect(envelope.status).toBe('warning');
    expect(envelope.data.failures).toEqual([{
      bundleId: 'local-foo', target: 'm-repo-fail', reason: expect.stringContaining('simulated partial lockfile write')
    }]);
    expect(envelope.data.written).toHaveProperty('a-repo-before');
    expect(envelope.data.written).not.toHaveProperty('m-repo-fail');
    expect(envelope.data.written).toHaveProperty('z-repo-after');
    expect(envelope.data.state.syncedBundles).toEqual(['local-foo']);

    for (const targetRoot of [targetRoots[0][1], targetRoots[2][1]]) {
      await expect(readFile(path.join(targetRoot, '.github', 'copilot', 'prompts', 'hello.prompt.md'), 'utf8'))
        .resolves.toContain('Hello Prompt');
      await expect(readFile(path.join(
        targetRoot, '.github', 'knowledge', 'specifications', 'RDP', 'provider_layer', 'SBB_B2P', 'SBB_B2P.md'
      ), 'utf8')).resolves.toContain('SBB B2P');
      const lock = JSON.parse(await readFile(path.join(targetRoot, 'prompt-registry.lock.json'), 'utf8')) as {
        bundles: Record<string, unknown>;
      };
      expect(lock.bundles['local-foo']).toBeDefined();
    }
    await expect(readFile(failedPrompt, 'utf8')).resolves.toBe('# Previous failed prompt');
    await expect(readFile(path.join(
      failedRoot, '.github', 'knowledge', 'specifications', 'RDP', 'provider_layer', 'SBB_B2P', 'SBB_B2P.md'
    ), 'utf8')).rejects.toThrow();
    await expect(readFile(failedLockfile, 'utf8')).resolves.toBe(previousLockBytes);
    expect(failingFs.failedWritePath).not.toBeNull();
    expect(await failingFs.exists(failingFs.failedWritePath as string)).toBe(false);
  });

  it('deactivates a profile: removes installed files and clears the active profile', async () => {
    expect((await run(['profile', 'activate', 'backend', '--target', 'copilot', '-o', 'json'])).exitCode).toBe(0);

    const deactivateResult = await run(['profile', 'deactivate', '-o', 'json']);
    expect(deactivateResult.exitCode).toBe(0);
    const deactivateEnvelope = parseJson<{ deactivated: { hubId: string; profileId: string } }>(deactivateResult.stdout);
    expect(deactivateEnvelope.data.deactivated).toEqual({ hubId: 'test-hub', profileId: 'backend' });

    await expect(readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8')).rejects.toThrow();

    const currentResult = await run(['profile', 'current', '-o', 'json']);
    const currentEnvelope = parseJson<{ active: null }>(currentResult.stdout);
    expect(currentEnvelope.data.active).toBeNull();
  });

  it('deactivating with no active profile is a no-op that succeeds', async () => {
    const result = await run(['profile', 'deactivate', '-o', 'json']);
    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ deactivated: null }>(result.stdout);
    expect(envelope.data.deactivated).toBeNull();
  });

  it('is idempotent across repeated activate/deactivate cycles: leaves no residue', async () => {
    for (let i = 0; i < 2; i += 1) {
      expect((await run(['profile', 'activate', 'backend', '--target', 'copilot', '-o', 'json'])).exitCode).toBe(0);
      expect((await run(['profile', 'deactivate', '-o', 'json'])).exitCode).toBe(0);
    }

    await expect(readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8')).rejects.toThrow();
  });
});
