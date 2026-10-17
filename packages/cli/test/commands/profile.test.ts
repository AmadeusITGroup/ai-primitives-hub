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
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  ProfileActivationState,
} from '@ai-primitives-hub/core';
import {
  buildZip,
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
  InstallCommand,
} from '../../src/commands/install';
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
  createTestContext,
  runCli,
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

interface JsonEnvelope<T> {
  status: string;
  data: T;
}

describe('profile activate/deactivate', () => {
  let workspace: string;
  let bundleDir: string;
  let targetDir: string;
  let hubConfigFile: string;

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
    await writeReleaseArchive(bundleDir, createGovernedReleaseArchive({ id: 'local-foo' }));
    expect((await run(['hub', 'sync', 'test-hub', '-o', 'json'])).exitCode).toBe(0);

    const activateResult = await run(['profile', 'activate', 'backend', '--target', 'copilot', '-o', 'json']);
    expect(activateResult.exitCode).toBe(0);

    await expect(readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8'))
      .resolves.toContain('Hello Prompt');
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
      'prompts/hello.prompt.md'
    ]);
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

describe('profile activate with a GitHub hub source and {owner}-{repo}-{manifestId} bundle ids', () => {
  let workspace: string;
  let targetDir: string;

  const env = (): Record<string, string> => ({
    HOME: workspace,
    USERPROFILE: workspace,
    XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
    XDG_CACHE_HOME: path.join(workspace, 'xdg-cache')
  });

  // Fake GitHub: one release of the `sample-skills` bundle (manifest id `sample-skills`).
  const bundleZip = buildZip([...createLegacyReleaseArchive({ id: 'sample-skills', version: '1.8.1' })]
    .map(([filePath, bytes]) => ({ path: filePath, bytes })));
  const http: HttpClient = {
    fetch: async (request: HttpRequest): Promise<HttpResponse> => {
      if (request.url === 'https://api.github.com/repos/acme-org/sample-skills/releases') {
        return {
          statusCode: 200,
          body: new TextEncoder().encode(JSON.stringify([{
            tag_name: 'sample-skills-v1.8.1',
            assets: [{ name: 'bundle.zip', url: 'https://api.github.com/assets/sample' }]
          }])),
          finalUrl: request.url,
          headers: {}
        };
      }
      if (request.url === 'https://api.github.com/assets/sample') {
        return { statusCode: 200, body: bundleZip, finalUrl: request.url, headers: {} };
      }
      throw new Error(`Unexpected request: ${request.url}`);
    }
  };

  const run = async (argv: string[], fs = new NodeFileSystem()): Promise<{ exitCode: number; stdout: string }> => {
    const ctx = createTestContext({ cwd: workspace, fs, env: env() });
    const exitCode = await runCli(argv, {
      ctx,
      http,
      tokens: { getToken: async () => undefined },
      commandClasses: [...COMMAND_CLASSES, InstallCommand],
      commands: [],
      name: 'test',
      version: 'test'
    });
    return { exitCode, stdout: ctx.stdout.captured() };
  };

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-profile-github-test-'));
    targetDir = path.join(workspace, 'target');
    await mkdir(targetDir, { recursive: true });
    const hubConfigFile = path.join(workspace, 'hub-config.yml');
    await writeFile(hubConfigFile, `version: 1.0.0
metadata:
  name: Sample Hub
  description: Hub with a GitHub source
  maintainer: test
  updatedAt: '2026-01-01T00:00:00Z'
sources:
  - id: sample-collections
    name: Sample Collections
    type: github
    url: https://github.com/acme-org/sample-skills
    enabled: true
    priority: 0
    hubId: sample-hub
profiles:
  - id: organization-sample-developer
    name: Sample Developer
    description: Versionless hub id
    bundles:
      - id: acme-org-sample-skills-sample-skills
        version: latest
        source: sample-collections
        required: true
  - id: wrong-bundle
    name: Wrong bundle
    description: Hub id naming another bundle of the same repo
    bundles:
      - id: acme-org-sample-skills-other-bundle
        version: latest
        source: sample-collections
        required: true
`);
    expect((await run(['target', 'add', 'copilot', '--type', 'copilot-cli', '--path', targetDir, '-o', 'json'])).exitCode).toBe(0);
    expect((await run(['hub', 'add', '--type', 'local', '--location', hubConfigFile, '--id', 'sample-hub', '-o', 'json'])).exitCode).toBe(0);
    expect((await run(['hub', 'use', 'sample-hub', '-o', 'json'])).exitCode).toBe(0);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('activates a profile whose bundle id is the versionless {owner}-{repo}-{manifestId}', async () => {
    const result = await run(['profile', 'activate', 'organization-sample-developer', '--target', 'copilot', '-o', 'json']);

    expect(result.exitCode, result.stdout).toBe(0);
    await expect(readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8'))
      .resolves.toContain('Hello Prompt');
  });

  it('switching profiles deactivates the previous one and records only installed bundles', async () => {
    const first = await run(['profile', 'activate', 'organization-sample-developer', '--target', 'copilot', '-o', 'json']);
    expect(first.exitCode, first.stdout).toBe(0);
    const firstState = (JSON.parse(first.stdout) as JsonEnvelope<{ state: ProfileActivationState }>).data.state;
    // The installed manifest version is recorded, not the profile's `latest`.
    expect(firstState.syncedBundleVersions).toEqual({ 'acme-org-sample-skills-sample-skills': '1.8.1' });

    const second = await run(['profile', 'activate', 'wrong-bundle', '--target', 'copilot', '-o', 'json']);
    expect(second.exitCode).toBe(1);
    const secondState = (JSON.parse(second.stdout) as JsonEnvelope<{ state: ProfileActivationState }>).data.state;
    expect(secondState.syncedBundles).toEqual([]);

    // The previous profile's files are gone and the new one is current.
    await expect(readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8')).rejects.toThrow();
    const current = await run(['profile', 'current', '-o', 'json']);
    expect((JSON.parse(current.stdout) as JsonEnvelope<{ active: unknown }>).data.active)
      .toEqual({ hubId: 'sample-hub', profileId: 'wrong-bundle' });
    const shown = await run(['profile', 'show', 'organization-sample-developer', '-o', 'json']);
    expect((JSON.parse(shown.stdout) as JsonEnvelope<{ profile: { active?: boolean } }>).data.profile.active).toBe(false);
  });

  it('replays the activated profile\'s lockfile into a clean target', async () => {
    const activated = await run(['profile', 'activate', 'organization-sample-developer', '--target', 'copilot', '-o', 'json']);
    expect(activated.exitCode, activated.stdout).toBe(0);
    const lockfile = path.join(workspace, 'replay.lock.json');
    await writeFile(lockfile, await readFile(resolveUserConfigPaths(env()).userLockfile, 'utf8'));
    // The lockfile keeps the hub's versionless bundle id as its key.
    expect(Object.keys((JSON.parse(await readFile(lockfile, 'utf8')) as { bundles: object }).bundles))
      .toEqual(['acme-org-sample-skills-sample-skills']);
    const cleanDir = path.join(workspace, 'clean-target');
    await mkdir(cleanDir, { recursive: true });
    expect((await run(['target', 'add', 'clean', '--type', 'copilot-cli', '--path', cleanDir, '-o', 'json'])).exitCode).toBe(0);

    const replay = await run(['install', '--lockfile', lockfile, '--target', 'clean', '-o', 'json']);

    expect(replay.exitCode, replay.stdout).toBe(0);
    await expect(readFile(path.join(cleanDir, 'prompts', 'hello.prompt.md'), 'utf8'))
      .resolves.toContain('Hello Prompt');
  });

  it('fails when the activation state cannot be saved after the install', async () => {
    // Fault-inject the activation store's files: the pre-install save
    // succeeds, the save of the installed outcome fails.
    let activationWrites = 0;
    class FailingActivationFs extends NodeFileSystem {
      public override async writeJson(filePath: string, value: unknown): Promise<void> {
        if (filePath.includes('profile-activations')) {
          activationWrites += 1;
          if (activationWrites === 2) {
            throw new Error('EACCES: permission denied');
          }
        }
        await super.writeJson(filePath, value);
      }
    }

    const result = await run(
      ['profile', 'activate', 'organization-sample-developer', '--target', 'copilot', '-o', 'json'],
      new FailingActivationFs()
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('HUB.ACTIVATION_FAILED');
    expect(result.stdout).toContain('EACCES: permission denied');
    // The failed activation is rolled back, not left half-active.
    const current = await run(['profile', 'current', '-o', 'json']);
    expect((JSON.parse(current.stdout) as JsonEnvelope<{ active: unknown }>).data.active).toBeNull();
    await expect(readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8')).rejects.toThrow();
  });

  it('rolls the activation back when the sync fails unexpectedly', async () => {
    // Fault-inject the lockfile write: the bundle files are already written
    // and the activation state + hub flag already saved when it fails.
    const userLockfile = resolveUserConfigPaths(env()).userLockfile;
    class FailingLockfileFs extends NodeFileSystem {
      public override async writeFile(filePath: string, contents: string): Promise<void> {
        if (filePath === userLockfile) {
          throw new Error('EROFS: read-only file system');
        }
        await super.writeFile(filePath, contents);
      }
    }

    const result = await run(
      ['profile', 'activate', 'organization-sample-developer', '--target', 'copilot', '-o', 'json'],
      new FailingLockfileFs()
    );

    // The original (unexpected) error is rethrown after the rollback.
    expect(result.exitCode).not.toBe(0);
    const current = await run(['profile', 'current', '-o', 'json']);
    expect((JSON.parse(current.stdout) as JsonEnvelope<{ active: unknown }>).data.active).toBeNull();
    const shown = await run(['profile', 'show', 'organization-sample-developer', '-o', 'json']);
    expect((JSON.parse(shown.stdout) as JsonEnvelope<{ profile: { active?: boolean } }>).data.profile.active).not.toBe(true);
    expect(await readdir(targetDir, { recursive: true }).then((entries) => entries.filter((e) => e.endsWith('.md'))))
      .toEqual([]);
  });

  it('still rejects a manifest whose id is not the bundle named by the profile', async () => {
    const result = await run(['profile', 'activate', 'wrong-bundle', '--target', 'copilot', '-o', 'json']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('manifest id \\"sample-skills\\" does not match expected');
  });
});
