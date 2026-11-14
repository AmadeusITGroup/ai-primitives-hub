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
  createHash,
} from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getLockfilePathForMode,
  readLockfile,
  resolveUserConfigPaths,
} from '@ai-primitives-hub/app';
import type {
  ArtifactorySourceIndex,
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
  dump,
  load,
} from 'js-yaml';
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
  ProfileInstallCommand,
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
  ProfileDeactivateCommand,
  ProfileInstallCommand
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

  it.skipIf(process.platform === 'win32')('activates a profile with the bundle\'s executable bits (#577)', async () => {
    const script = path.join(bundleDir, 'skills', 'demo', 'scripts', 'run.sh');
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, '#!/bin/sh\necho ok\n');
    await chmod(script, 0o755);
    expect((await run(['hub', 'sync', 'test-hub', '-o', 'json'])).exitCode).toBe(0);

    const activateResult = await run(['profile', 'activate', 'backend', '--target', 'copilot', '-o', 'json']);
    expect(activateResult.exitCode, activateResult.stdout).toBe(0);

    // eslint-disable-next-line no-bitwise -- test reads the POSIX execute bits
    const executable = async (filePath: string): Promise<boolean> => ((await stat(filePath)).mode & 0o111) !== 0;
    expect(await executable(path.join(targetDir, 'skills', 'demo', 'scripts', 'run.sh'))).toBe(true);
    expect(await executable(path.join(targetDir, 'prompts', 'hello.prompt.md'))).toBe(false);
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
  - id: install-only
    name: Install only
    description: Pinned to the released version
    bundles:
      - id: acme-org-sample-skills-sample-skills
        version: 1.8.1
        source: sample-collections
        required: true
  - id: partial-required
    name: Partially installable
    description: One required bundle installs, the other does not
    bundles:
      - id: acme-org-sample-skills-sample-skills
        version: latest
        source: sample-collections
        required: true
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

  it('switching to a profile whose required bundle fails to install reports it and leaves no profile active', async () => {
    const first = await run(['profile', 'activate', 'organization-sample-developer', '--target', 'copilot', '-o', 'json']);
    expect(first.exitCode, first.stdout).toBe(0);
    const firstState = (JSON.parse(first.stdout) as JsonEnvelope<{ state: ProfileActivationState }>).data.state;
    // The installed manifest version is recorded, not the profile's `latest`.
    expect(firstState.syncedBundleVersions).toEqual({ 'acme-org-sample-skills-sample-skills': '1.8.1' });

    const second = await run(['profile', 'activate', 'wrong-bundle', '--target', 'copilot', '-o', 'json']);
    expect(second.exitCode).toBe(1);
    expect(second.stdout).toContain('HUB.REQUIRED_BUNDLE_MISSING');
    expect(second.stdout).toContain('acme-org-sample-skills-other-bundle');

    // The previous profile was deactivated, and the failed one is not left active.
    await expect(readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8')).rejects.toThrow();
    const current = await run(['profile', 'current', '-o', 'json']);
    expect((JSON.parse(current.stdout) as JsonEnvelope<{ active: unknown }>).data.active).toBeNull();
    const failed = await run(['profile', 'show', 'wrong-bundle', '-o', 'json']);
    expect((JSON.parse(failed.stdout) as JsonEnvelope<{ profile: { active?: boolean } }>).data.profile.active).toBe(false);
    const shown = await run(['profile', 'show', 'organization-sample-developer', '-o', 'json']);
    expect((JSON.parse(shown.stdout) as JsonEnvelope<{ profile: { active?: boolean } }>).data.profile.active).toBe(false);
  });

  it('removes the bundles a failed activation installed when another required bundle is missing', async () => {
    const result = await run(['profile', 'activate', 'partial-required', '--target', 'copilot', '-o', 'json']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('HUB.REQUIRED_BUNDLE_MISSING');
    expect(result.stdout).toContain('acme-org-sample-skills-other-bundle');
    // The bundle that did install is rolled back: its files and lockfile entry are gone.
    await expect(readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8')).rejects.toThrow();
    const lock = await readFile(resolveUserConfigPaths(env()).userLockfile, 'utf8').catch(() => '{"bundles":{}}');
    expect(Object.keys((JSON.parse(lock) as { bundles?: object }).bundles ?? {})).not.toContain('acme-org-sample-skills-sample-skills');
    const current = await run(['profile', 'current', '-o', 'json']);
    expect((JSON.parse(current.stdout) as JsonEnvelope<{ active: unknown }>).data.active).toBeNull();
  });

  describe('profile install', () => {
    const lockedBundleIds = async (): Promise<string[]> => {
      const lock = await readFile(resolveUserConfigPaths(env()).userLockfile, 'utf8').catch(() => '{"bundles":{}}');
      return Object.keys((JSON.parse(lock) as { bundles?: object }).bundles ?? {});
    };

    it('installs the profile bundles as ordinary installs without activating the profile', async () => {
      const result = await run(['profile', 'install', 'organization-sample-developer', '--target', 'copilot', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(0);
      const data = (JSON.parse(result.stdout) as JsonEnvelope<{ installed: { bundleId: string; version: string }[] }>).data;
      expect(data.installed).toEqual([{ bundleId: 'acme-org-sample-skills-sample-skills', version: '1.8.1' }]);
      await expect(readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8')).resolves.toContain('Hello Prompt');
      expect(await lockedBundleIds()).toEqual(['acme-org-sample-skills-sample-skills']);
      const current = await run(['profile', 'current', '-o', 'json']);
      expect((JSON.parse(current.stdout) as JsonEnvelope<{ active: unknown }>).data.active).toBeNull();
    });

    it('keeps the active profile active and reports bundles already installed at the pinned version', async () => {
      expect((await run(['profile', 'activate', 'organization-sample-developer', '--target', 'copilot', '-o', 'json'])).exitCode).toBe(0);

      const result = await run(['profile', 'install', 'install-only', '--target', 'copilot', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(0);
      const data = (JSON.parse(result.stdout) as JsonEnvelope<{ installed: unknown[]; alreadyInstalled: unknown[] }>).data;
      expect(data.installed).toEqual([]);
      expect(data.alreadyInstalled).toEqual([{ bundleId: 'acme-org-sample-skills-sample-skills', version: '1.8.1' }]);
      const current = await run(['profile', 'current', '-o', 'json']);
      expect((JSON.parse(current.stdout) as JsonEnvelope<{ active: unknown }>).data.active)
        .toEqual({ hubId: 'sample-hub', profileId: 'organization-sample-developer' });
    });

    it('removes what it installed when a required bundle is missing', async () => {
      const result = await run(['profile', 'install', 'partial-required', '--target', 'copilot', '-o', 'json']);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('HUB.REQUIRED_BUNDLE_MISSING');
      expect(result.stdout).toContain('acme-org-sample-skills-other-bundle');
      await expect(readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8')).rejects.toThrow();
      expect(await lockedBundleIds()).toEqual([]);
    });

    it('installs onto every user target even though they share one lockfile, and removes from all on failure', async () => {
      const secondDir = path.join(workspace, 'second-target');
      await mkdir(secondDir, { recursive: true });
      expect((await run(['target', 'add', 'second', '--type', 'copilot-cli', '--path', secondDir, '-o', 'json'])).exitCode).toBe(0);

      const installed = await run(['profile', 'install', 'install-only', '--target', 'copilot,second', '-o', 'json']);
      expect(installed.exitCode, installed.stdout).toBe(0);
      for (const dir of [targetDir, secondDir]) {
        await expect(readFile(path.join(dir, 'prompts', 'hello.prompt.md'), 'utf8')).resolves.toContain('Hello Prompt');
      }

      await rm(resolveUserConfigPaths(env()).userLockfile);
      await rm(path.join(targetDir, 'prompts'), { recursive: true });
      await rm(path.join(secondDir, 'prompts'), { recursive: true });
      const failed = await run(['profile', 'install', 'partial-required', '--target', 'copilot,second', '-o', 'json']);
      expect(failed.exitCode).toBe(1);
      for (const dir of [targetDir, secondDir]) {
        await expect(readFile(path.join(dir, 'prompts', 'hello.prompt.md'), 'utf8')).rejects.toThrow();
      }
      expect(await lockedBundleIds()).toEqual([]);
    });

    it('reports a version change as installed, not as already installed', async () => {
      expect((await run(['profile', 'install', 'organization-sample-developer', '--target', 'copilot', '-o', 'json'])).exitCode).toBe(0);
      const lockPath = resolveUserConfigPaths(env()).userLockfile;
      const lock = JSON.parse(await readFile(lockPath, 'utf8')) as { bundles: Record<string, { version: string }> };
      lock.bundles['acme-org-sample-skills-sample-skills'].version = '1.0.0';
      await writeFile(lockPath, JSON.stringify(lock));

      const result = await run(['profile', 'install', 'organization-sample-developer', '--target', 'copilot', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(0);
      const data = (JSON.parse(result.stdout) as JsonEnvelope<{ installed: unknown[]; alreadyInstalled: unknown[] }>).data;
      expect(data.installed).toEqual([{ bundleId: 'acme-org-sample-skills-sample-skills', version: '1.8.1' }]);
      expect(data.alreadyInstalled).toEqual([]);
    });

    it('keeps a bundle tracked and reports its path when the rollback cannot remove a file', async () => {
      class FailingRemoveFs extends NodeFileSystem {
        public override async remove(filePath: string, opts?: { recursive?: boolean }): Promise<void> {
          if (filePath.endsWith('hello.prompt.md')) {
            throw new Error('EBUSY: resource busy');
          }
          await super.remove(filePath, opts);
        }
      }

      const result = await run(['profile', 'install', 'partial-required', '--target', 'copilot', '-o', 'json'], new FailingRemoveFs());

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('HUB.REQUIRED_BUNDLE_MISSING');
      expect(result.stdout).toContain('hello.prompt.md');
      expect(await lockedBundleIds()).toEqual(['acme-org-sample-skills-sample-skills']);
    });

    it('reports both errors when the install fails and undoing it fails too', async () => {
      class FailingLockAndRemoveFs extends NodeFileSystem {
        public override async writeFile(filePath: string, contents: string): Promise<void> {
          if (filePath === resolveUserConfigPaths(env()).userLockfile) {
            throw new Error('EACCES: lockfile not writable');
          }
          await super.writeFile(filePath, contents);
        }

        public override async remove(filePath: string, opts?: { recursive?: boolean }): Promise<void> {
          if (filePath.endsWith('hello.prompt.md')) {
            throw new Error('EBUSY: resource busy');
          }
          await super.remove(filePath, opts);
        }
      }

      const result = await run(['profile', 'install', 'install-only', '--target', 'copilot', '-o', 'json'], new FailingLockAndRemoveFs());

      expect(result.exitCode, result.stdout).toBe(1);
      expect(result.stdout).toContain('EACCES: lockfile not writable');
      expect(result.stdout).toContain('hello.prompt.md');
    });

    it('removes files a target\'s previous version shipped, on every target sharing the lockfile', async () => {
      const secondDir = path.join(workspace, 'second-target');
      await mkdir(secondDir, { recursive: true });
      expect((await run(['target', 'add', 'second', '--type', 'copilot-cli', '--path', secondDir, '-o', 'json'])).exitCode).toBe(0);
      expect((await run(['profile', 'install', 'install-only', '--target', 'copilot,second', '-o', 'json'])).exitCode).toBe(0);
      // Pretend the installed version also shipped a prompt the current one no longer has.
      const lockPath = resolveUserConfigPaths(env()).userLockfile;
      const lock = JSON.parse(await readFile(lockPath, 'utf8')) as { bundles: Record<string, { files: { path: string; checksum: string }[] }> };
      lock.bundles['acme-org-sample-skills-sample-skills'].files.push({ path: 'prompts/old.prompt.md', checksum: 'x' });
      await writeFile(lockPath, JSON.stringify(lock));
      for (const dir of [targetDir, secondDir]) {
        await writeFile(path.join(dir, 'prompts', 'old.prompt.md'), 'old');
      }

      expect((await run(['profile', 'install', 'install-only', '--target', 'copilot,second', '-o', 'json'])).exitCode).toBe(0);

      for (const dir of [targetDir, secondDir]) {
        await expect(readFile(path.join(dir, 'prompts', 'old.prompt.md'), 'utf8')).rejects.toThrow();
        await expect(readFile(path.join(dir, 'prompts', 'hello.prompt.md'), 'utf8')).resolves.toContain('Hello Prompt');
      }
    });

    it('drops the entry it added to the local-only lockfile, and keeps the commit one, when a required bundle is missing', async () => {
      const repoDir = path.join(workspace, 'repo');
      await mkdir(repoDir, { recursive: true });
      for (const name of ['repo-commit', 'repo-local']) {
        expect((await run(['target', 'add', name, '--type', 'vscode', '--scope', 'repository', '--workspace-root', repoDir, '-o', 'json'])).exitCode).toBe(0);
      }
      // `target add` has no commit-mode flag: mark the second target local-only in the project config.
      const configFile = path.join(workspace, 'ai-primitives-hub.yml');
      const config = load(await readFile(configFile, 'utf8')) as { targets: { name: string; commitMode?: string }[] };
      config.targets.find((t) => t.name === 'repo-local')!.commitMode = 'local-only';
      await writeFile(configFile, dump(config));
      const bundleIds = async (mode: 'commit' | 'local-only'): Promise<string[]> => {
        const raw = await readFile(getLockfilePathForMode(repoDir, mode), 'utf8').catch(() => '{"bundles":{}}');
        return Object.keys((JSON.parse(raw) as { bundles?: object }).bundles ?? {});
      };
      const seeded = await run(['profile', 'install', 'organization-sample-developer', '--target', 'repo-commit', '-o', 'json']);
      expect(seeded.exitCode, seeded.stdout).toBe(0);

      const result = await run(['profile', 'install', 'partial-required', '--target', 'repo-local', '-o', 'json']);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('HUB.REQUIRED_BUNDLE_MISSING');
      expect(await bundleIds('commit')).toEqual(['acme-org-sample-skills-sample-skills']);
      expect(await bundleIds('local-only')).toEqual([]);
      await expect(readFile(path.join(repoDir, '.github', 'prompts', 'hello.prompt.md'), 'utf8')).resolves.toContain('Hello Prompt');
    });

    it('keeps the local-only entry for files it updated when a required bundle is missing', async () => {
      const repoDir = path.join(workspace, 'repo');
      await mkdir(repoDir, { recursive: true });
      for (const name of ['repo-commit', 'repo-local']) {
        expect((await run(['target', 'add', name, '--type', 'vscode', '--scope', 'repository', '--workspace-root', repoDir, '-o', 'json'])).exitCode).toBe(0);
      }
      // `target add` has no commit-mode flag: mark the second target local-only in the project config.
      const configFile = path.join(workspace, 'ai-primitives-hub.yml');
      const config = load(await readFile(configFile, 'utf8')) as { targets: { name: string; commitMode?: string }[] };
      config.targets.find((t) => t.name === 'repo-local')!.commitMode = 'local-only';
      await writeFile(configFile, dump(config));
      const seeded = await run(['profile', 'install', 'organization-sample-developer', '--target', 'repo-commit', '-o', 'json']);
      expect(seeded.exitCode, seeded.stdout).toBe(0);
      // The commit lockfile records an older version than the one the install writes.
      const commitLock = getLockfilePathForMode(repoDir, 'commit');
      const recorded = JSON.parse(await readFile(commitLock, 'utf8')) as { bundles: Record<string, { version: string }> };
      recorded.bundles['acme-org-sample-skills-sample-skills'].version = '1.0.0';
      await writeFile(commitLock, JSON.stringify(recorded));

      const result = await run(['profile', 'install', 'partial-required', '--target', 'repo-local', '-o', 'json']);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('HUB.REQUIRED_BUNDLE_MISSING');
      // The updated files stay, so the entry describing them stays too.
      const versions = async (mode: 'commit' | 'local-only'): Promise<Record<string, string>> => {
        const lock = JSON.parse(await readFile(getLockfilePathForMode(repoDir, mode), 'utf8')) as { bundles: Record<string, { version: string }> };
        return Object.fromEntries(Object.entries(lock.bundles).map(([id, entry]) => [id, entry.version]));
      };
      expect(await versions('commit')).toEqual({ 'acme-org-sample-skills-sample-skills': '1.0.0' });
      expect(await versions('local-only')).toEqual({ 'acme-org-sample-skills-sample-skills': '1.8.1' });
      await expect(readFile(path.join(repoDir, '.github', 'prompts', 'hello.prompt.md'), 'utf8')).resolves.toContain('Hello Prompt');
    });

    it('keeps an updated entry in one repository while removing the bundle it added to another', async () => {
      const repo1 = path.join(workspace, 'repo1');
      const repo2 = path.join(workspace, 'repo2');
      for (const [name, root] of [['repo1-commit', repo1], ['repo1-local', repo1], ['repo2', repo2]] as const) {
        await mkdir(root, { recursive: true });
        expect((await run(['target', 'add', name, '--type', 'vscode', '--scope', 'repository', '--workspace-root', root, '-o', 'json'])).exitCode).toBe(0);
      }
      const configFile = path.join(workspace, 'ai-primitives-hub.yml');
      const config = load(await readFile(configFile, 'utf8')) as { targets: { name: string; commitMode?: string }[] };
      config.targets.find((t) => t.name === 'repo1-local')!.commitMode = 'local-only';
      await writeFile(configFile, dump(config));
      const seeded = await run(['profile', 'install', 'organization-sample-developer', '--target', 'repo1-commit', '-o', 'json']);
      expect(seeded.exitCode, seeded.stdout).toBe(0);
      const repo1Commit = getLockfilePathForMode(repo1, 'commit');
      const recorded = JSON.parse(await readFile(repo1Commit, 'utf8')) as { bundles: Record<string, { version: string }> };
      recorded.bundles['acme-org-sample-skills-sample-skills'].version = '1.0.0';
      await writeFile(repo1Commit, JSON.stringify(recorded));
      const versions = async (root: string, mode: 'commit' | 'local-only'): Promise<Record<string, string>> => {
        const raw = await readFile(getLockfilePathForMode(root, mode), 'utf8').catch(() => '{"bundles":{}}');
        const lock = JSON.parse(raw) as { bundles?: Record<string, { version: string }> };
        return Object.fromEntries(Object.entries(lock.bundles ?? {}).map(([id, entry]) => [id, entry.version]));
      };

      const result = await run(['profile', 'install', 'partial-required', '--target', 'repo1-local,repo2', '-o', 'json']);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('HUB.REQUIRED_BUNDLE_MISSING');
      // repo1: the update stays, and so does the entry describing it.
      expect(await versions(repo1, 'commit')).toEqual({ 'acme-org-sample-skills-sample-skills': '1.0.0' });
      expect(await versions(repo1, 'local-only')).toEqual({ 'acme-org-sample-skills-sample-skills': '1.8.1' });
      await expect(readFile(path.join(repo1, '.github', 'prompts', 'hello.prompt.md'), 'utf8')).resolves.toContain('Hello Prompt');
      // repo2: the bundle was new there, so it is removed.
      expect(await versions(repo2, 'commit')).toEqual({});
      await expect(readFile(path.join(repo2, '.github', 'prompts', 'hello.prompt.md'), 'utf8')).rejects.toThrow();
    });

    it('leaves bundles installed before the batch in place when a required bundle is missing', async () => {
      expect((await run(['profile', 'activate', 'organization-sample-developer', '--target', 'copilot', '-o', 'json'])).exitCode).toBe(0);

      const result = await run(['profile', 'install', 'partial-required', '--target', 'copilot', '-o', 'json']);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('HUB.REQUIRED_BUNDLE_MISSING');
      await expect(readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8')).resolves.toContain('Hello Prompt');
      expect(await lockedBundleIds()).toEqual(['acme-org-sample-skills-sample-skills']);
    });
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

describe('profile activate with an authenticated Artifactory hub source', () => {
  let workspace: string;
  let targetDir: string;

  const bundleId = 'example-repo-artifactory-bundle';
  const manifestId = 'artifactory-bundle';
  const sourceRoot = 'https://artifactory.example/repo';
  const archivePath = 'bundles/artifactory-bundle/1.0.0/bundle.zip';
  const bundleFiles = createLegacyReleaseArchive({ id: manifestId, version: '1.0.0' });
  const duplicatePrompt = bundleFiles.get('prompts/hello.prompt.md');
  if (duplicatePrompt === undefined) {
    throw new Error('Legacy release fixture is missing its expected prompt');
  }
  bundleFiles.set('apm.yml', new TextEncoder().encode(`name: ${manifestId}\nversion: 1.0.0\n`));
  bundleFiles.set('.apm/prompts/hello.prompt.md', duplicatePrompt);
  const bundleZip = buildZip([...bundleFiles]
    .map(([filePath, bytes]) => ({ path: filePath, bytes })));
  const index: ArtifactorySourceIndex = {
    formatVersion: 1,
    source: { id: 'replicated', name: 'Replicated', updatedAt: '2026-01-01T00:00:00Z' },
    bundles: [{
      id: bundleId,
      version: '1.0.0',
      name: 'Artifactory Bundle',
      description: 'Bundle served from an authenticated Artifactory source',
      author: 'Test',
      environments: ['vscode'],
      tags: [],
      lastUpdated: '2026-01-01T00:00:00Z',
      dependencies: [],
      canonicalSource: 'https://github.com/example/repo',
      license: 'Apache-2.0',
      manifest: {
        path: 'bundles/artifactory-bundle/1.0.0/deployment-manifest.yml',
        size: 1,
        sha256: 'a'.repeat(64),
        mediaType: 'application/yaml'
      },
      archive: {
        path: archivePath,
        size: bundleZip.byteLength,
        sha256: createHash('sha256').update(bundleZip).digest('hex'),
        mediaType: 'application/zip'
      }
    }]
  };
  let servedZip = bundleZip;
  let servedIndex = index;

  const requests: HttpRequest[] = [];
  const http: HttpClient = {
    fetch: (request: HttpRequest): Promise<HttpResponse> => {
      requests.push(request);
      if (request.headers?.Authorization !== 'Bearer test-artifactory-token') {
        return Promise.resolve({ statusCode: 401, body: new Uint8Array(), finalUrl: request.url, headers: {} });
      }
      if (request.url === `${sourceRoot}/index-v1.json`) {
        return Promise.resolve({
          statusCode: 200,
          body: new TextEncoder().encode(JSON.stringify(servedIndex)),
          finalUrl: request.url,
          headers: {}
        });
      }
      if (request.url === `${sourceRoot}/${archivePath}`) {
        return Promise.resolve({ statusCode: 200, body: servedZip, finalUrl: request.url, headers: {} });
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    }
  };

  const run = async (argv: string[]): Promise<{ exitCode: number; stdout: string }> => {
    const ctx = createTestContext({
      cwd: workspace,
      fs: new NodeFileSystem(),
      env: {
        HOME: workspace,
        USERPROFILE: workspace,
        XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
        XDG_CACHE_HOME: path.join(workspace, 'xdg-cache'),
        ARTIFACTORY_READER_TOKEN: 'test-artifactory-token'
      }
    });
    const exitCode = await runCli(argv, {
      ctx,
      http,
      tokens: { getToken: () => Promise.resolve(undefined) },
      commandClasses: [...COMMAND_CLASSES, InstallCommand],
      commands: [],
      name: 'test',
      version: 'test'
    });
    return { exitCode, stdout: ctx.stdout.captured() };
  };

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-profile-artifactory-test-'));
    targetDir = path.join(workspace, 'target');
    await mkdir(targetDir, { recursive: true });
    requests.length = 0;
    servedZip = bundleZip;
    servedIndex = structuredClone(index);
    const hubConfigFile = path.join(workspace, 'hub-config.yml');
    await writeFile(hubConfigFile, `version: 1.0.0
metadata:
  name: Artifactory Hub
  description: Hub with an authenticated Artifactory source
  maintainer: test
  updatedAt: '2026-01-01T00:00:00Z'
sources:
  - id: replicated
    name: Replicated
    type: artifactory
    url: ${sourceRoot}
    enabled: true
    priority: 0
    config:
      indexFile: index-v1.json
      authMode: bearer
      credentialRef: ARTIFACTORY_READER_TOKEN
profiles:
  - id: artifactory-profile
    name: Artifactory Profile
    description: Installs a bundle from the authenticated source
    bundles:
      - id: ${bundleId}
        version: 1.0.0
        source: replicated
        required: true
`);

    expect((await run(['target', 'add', 'copilot', '--type', 'copilot-cli', '--path', targetDir, '-o', 'json'])).exitCode).toBe(0);
    expect((await run(['hub', 'add', '--type', 'local', '--location', hubConfigFile, '--id', 'artifactory-hub', '-o', 'json'])).exitCode).toBe(0);
    expect((await run(['hub', 'use', 'artifactory-hub', '-o', 'json'])).exitCode).toBe(0);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('authenticates and installs repository-qualified Artifactory bundle IDs', async () => {
    const result = await run(['profile', 'activate', 'artifactory-profile', '--target', 'copilot', '-o', 'json']);

    expect(result.exitCode, result.stdout).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.headers?.Authorization === 'Bearer test-artifactory-token')).toBe(true);
    await expect(readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8'))
      .resolves.toContain('Hello Prompt');

    const lockfilePath = resolveUserConfigPaths({
      HOME: workspace,
      XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
      XDG_CACHE_HOME: path.join(workspace, 'xdg-cache')
    }).userLockfile;
    const persisted = await readLockfile(lockfilePath, new NodeFileSystem());
    expect(persisted?.sources.replicated).toEqual({
      type: 'artifactory',
      url: sourceRoot,
      indexFile: 'index-v1.json',
      authMode: 'bearer',
      credentialRef: 'ARTIFACTORY_READER_TOKEN'
    });
    const replayDir = path.join(workspace, 'replay-target');
    await mkdir(replayDir);
    expect((await run(['target', 'add', 'replay', '--type', 'copilot-cli', '--path', replayDir, '-o', 'json'])).exitCode).toBe(0);
    requests.length = 0;
    const replay = await run(['install', '--lockfile', lockfilePath, '--target', 'replay', '-o', 'json']);

    expect(replay.exitCode, replay.stdout).toBe(0);
    expect(requests.map((request) => request.url)).toEqual([`${sourceRoot}/index-v1.json`, `${sourceRoot}/${archivePath}`]);
    expect(requests.every((request) => request.headers?.Authorization === 'Bearer test-artifactory-token')).toBe(true);
    await expect(readFile(path.join(replayDir, 'prompts', 'hello.prompt.md'), 'utf8')).resolves.toContain('Hello Prompt');
  });

  it.each(['profile', 'install'])('rejects a valid-checksum archive for another package through %s', async (entryPoint) => {
    const wrongFiles = createLegacyReleaseArchive({ id: 'unrelated-bundle', version: '1.0.0' });
    servedZip = buildZip([...wrongFiles].map(([filePath, bytes]) => ({ path: filePath, bytes })));
    servedIndex.bundles[0].archive = {
      ...servedIndex.bundles[0].archive,
      size: servedZip.byteLength,
      sha256: createHash('sha256').update(servedZip).digest('hex')
    };

    const result = await run(entryPoint === 'profile'
      ? ['profile', 'activate', 'artifactory-profile', '--target', 'copilot', '-o', 'json']
      : ['install', bundleId, '--source', 'replicated', '--target', 'copilot', '-o', 'json']);

    expect(result.exitCode, result.stdout).not.toBe(0);
    expect(result.stdout).toContain('does not match expected');
    await expect(stat(path.join(targetDir, 'prompts', 'hello.prompt.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('profile install with an Artifactory hub source', () => {
  let workspace: string;
  let targetDir: string;
  const root = 'https://artifactory.example/repo/source';
  const env = (): Record<string, string> => ({
    HOME: workspace,
    USERPROFILE: workspace,
    XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
    XDG_CACHE_HOME: path.join(workspace, 'xdg-cache'),
    ARTIFACTORY_TOKEN: 'reader-token'
  });
  const archive = buildZip([...createLegacyReleaseArchive({ id: 'bundle', version: '1.0.0' })]
    .map(([filePath, bytes]) => ({ path: filePath, bytes })));
  const requests: HttpRequest[] = [];
  const http: HttpClient = {
    fetch: (request: HttpRequest): Promise<HttpResponse> => {
      requests.push(request);
      if (request.url === `${root}/custom-index.json`) {
        const body = JSON.stringify({
          formatVersion: 1, source: { id: 'artifact-source', name: 'Artifact Source', updatedAt: '2026-01-01T00:00:00Z' },
          bundles: [{
            id: 'bundle', version: '1.0.0', name: 'Bundle', description: '', author: 'Test', environments: ['vscode'],
            tags: [], dependencies: [], license: 'Apache-2.0', lastUpdated: '2026-01-01T00:00:00Z',
            manifest: { path: '1.0.0/bundle/deployment-manifest.yml', size: 1, sha256: 'a'.repeat(64) },
            archive: { path: '1.0.0/bundle.zip', size: archive.length,
              sha256: createHash('sha256').update(archive).digest('hex'), mediaType: 'application/zip' }
          }]
        });
        return Promise.resolve({ statusCode: 200, body: new TextEncoder().encode(body), finalUrl: request.url, headers: {} });
      }
      if (request.url === `${root}/1.0.0/bundle.zip`) {
        return Promise.resolve({ statusCode: 200, body: archive, finalUrl: request.url, headers: {} });
      }
      return Promise.resolve({ statusCode: 404, body: new Uint8Array(), finalUrl: request.url, headers: {} });
    }
  };

  const run = async (argv: string[]): Promise<{ exitCode: number; stdout: string }> => {
    const ctx = createTestContext({ cwd: workspace, fs: new NodeFileSystem(), env: env() });
    const exitCode = await runCli(argv, {
      ctx,
      http,
      tokens: { getToken: () => Promise.resolve(undefined) },
      commandClasses: COMMAND_CLASSES,
      commands: [],
      name: 'test',
      version: 'test'
    });
    return { exitCode, stdout: ctx.stdout.captured() };
  };

  beforeEach(async () => {
    requests.length = 0;
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-profile-artifactory-test-'));
    targetDir = path.join(workspace, 'target');
    await mkdir(targetDir, { recursive: true });
    const hubConfigFile = path.join(workspace, 'hub-config.yml');
    await writeFile(hubConfigFile, `version: 1.0.0
metadata:
  name: Artifactory Hub
  description: Hub with an Artifactory source
  maintainer: test
  updatedAt: '2026-01-01T00:00:00Z'
sources:
  - id: artifact-source
    name: Artifact Source
    type: artifactory
    url: ${root}
    enabled: true
    priority: 0
    config:
      indexFile: custom-index.json
      authMode: bearer
      credentialRef: ARTIFACTORY_TOKEN
profiles:
  - id: artifactory-profile
    name: Artifactory profile
    description: One Artifactory bundle
    bundles:
      - id: bundle
        version: 1.0.0
        source: artifact-source
        required: true
`);
    expect((await run(['target', 'add', 'copilot', '--type', 'copilot-cli', '--path', targetDir, '-o', 'json'])).exitCode).toBe(0);
    expect((await run(['hub', 'add', '--type', 'local', '--location', hubConfigFile, '--id', 'artifactory-hub', '-o', 'json'])).exitCode).toBe(0);
    expect((await run(['hub', 'use', 'artifactory-hub', '-o', 'json'])).exitCode).toBe(0);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('uses the source\'s index file and bearer credentials', async () => {
    const result = await run(['profile', 'install', 'artifactory-profile', '--target', 'copilot', '-o', 'json']);

    expect(result.exitCode, result.stdout).toBe(0);
    await expect(readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8')).resolves.toContain('Hello Prompt');
    const artifactoryRequests = requests.filter((r) => r.url.startsWith(root));
    expect(artifactoryRequests.map((r) => r.url)).toContain(`${root}/custom-index.json`);
    expect(artifactoryRequests.every((r) => r.headers?.Authorization === 'Bearer reader-token')).toBe(true);
  });
});
