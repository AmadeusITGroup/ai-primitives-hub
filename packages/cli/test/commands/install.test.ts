/**
 * `install` command tests (local `--from` mode — no network required).
 *
 * Uses a real `NodeFileSystem` against a real temp directory (not
 * `createTestContext`'s default in-memory `fs` stub, which rejects
 * every call) since install does real file writes + lockfile IO.
 */
import {
  createHash,
} from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type Lockfile,
  resolveUserConfigPaths,
} from '@ai-primitives-hub/app';
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  RegistrySource,
  Target,
} from '@ai-primitives-hub/core';
import {
  TARGET_TYPES,
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
  vi,
} from 'vitest';
import {
  HubAddCommand,
  HubUseCommand,
} from '../../src/commands/hub';
import {
  createSourceAwareInstallDependencyCache,
  installBundleWithSource,
  InstallCommand,
} from '../../src/commands/install';
import {
  TargetAddCommand,
} from '../../src/commands/target-add';
import {
  UpdateCommand,
} from '../../src/commands/update';
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
import {
  runGit,
} from '../helpers/git-fixture';

const COMMAND_CLASSES = [
  TargetAddCommand,
  InstallCommand
];

interface JsonEnvelope<T> {
  status: string;
  data: T;
}

describe('install command (local --from mode)', () => {
  let workspace: string;
  let bundleDir: string;
  let targetDir: string;

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

  it('shares source-aware dependencies for repeated bundle requests', async () => {
    const target = { host: 'github.com', owner: 'owner', repository: 'repo' };
    const preflight = vi.fn(async () => ({
      valid: true,
      results: [{
        sourceId: 'source',
        target,
        category: 'public-generic' as const,
        operations: ['repository metadata'],
        credentialMode: 'generic' as const
      }],
      appRoutes: []
    }));
    const clientFor = vi.fn(() => ({}) as import('@ai-primitives-hub/core').GitHubApi);
    const tokenProviderFor = vi.fn(() => ({ getToken: async () => 'generic-token' }));
    const runtime = {
      preflight,
      clientFor,
      tokenProviderFor
    } as unknown as import('@ai-primitives-hub/infra').GitHubSourceAuthRuntime;
    const ctx = createTestContext({ cwd: workspace });
    const sourceConfig: RegistrySource = {
      id: 'source',
      name: 'Source',
      type: 'github',
      url: 'https://github.com/owner/repo',
      enabled: true,
      priority: 0
    };
    const cache = createSourceAwareInstallDependencyCache({} as HttpClient, ctx, runtime);

    const first = await cache.get('owner/repo', sourceConfig);
    const second = await cache.get('owner/repo', sourceConfig);

    expect(first).toBe(second);
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(clientFor).toHaveBeenCalledTimes(1);
    expect(tokenProviderFor).toHaveBeenCalledTimes(1);
  });

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-install-test-'));
    bundleDir = path.join(workspace, 'bundle');
    targetDir = path.join(workspace, 'target');

    await mkdir(targetDir, { recursive: true });
    await writeReleaseArchive(bundleDir, createLegacyReleaseArchive({ id: 'local-foo' }));

    expect((await run([
      'target', 'add', 'copilot', '--type', 'copilot-cli', '--path', targetDir, '-o', 'json'
    ])).exitCode).toBe(0);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  const artifactoryFixture = () => {
    const catalogId = 'owner-repo-bundle';
    const root = 'https://artifactory.example/repo/source';
    let version = '1.0.0';
    let manifestVersion = '1.0.0';
    const archives = new Map<string, Uint8Array>();
    const additionalCatalogIds: string[] = [];
    const extraEntries: { path: string; bytes: Uint8Array; mode?: number }[] = [];
    let indexFailuresRemaining = 0;
    let archiveFailureBundleId: string | undefined;
    const archiveFor = (): Uint8Array => {
      const key = `${version}:${manifestVersion}`;
      if (!archives.has(key)) {
        const files = createLegacyReleaseArchive({ id: 'bundle', version: manifestVersion });
        archives.set(key, buildZip([...[...files].map(([filePath, bytes]) => ({ path: filePath, bytes })), ...extraEntries]));
      }
      return archives.get(key)!;
    };
    const source: RegistrySource = {
      id: 'artifact-source', name: 'Artifact Source', type: 'artifactory', url: root,
      enabled: true, priority: 0, config: { authMode: 'bearer', credentialRef: 'ARTIFACTORY_TOKEN' }
    };
    const env = {
      HOME: workspace, USERPROFILE: workspace, XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
      XDG_CACHE_HOME: path.join(workspace, 'xdg-cache'), ARTIFACTORY_TOKEN: 'reader-token'
    };
    const requests: HttpRequest[] = [];
    const http: HttpClient = {
      fetch: (request) => {
        requests.push(request);
        expect(request.headers?.Authorization).toBe('Bearer reader-token');
        let body: Uint8Array;
        if (request.url === `${root}/index-v1.json`) {
          if (indexFailuresRemaining > 0) {
            if (Number.isFinite(indexFailuresRemaining)) {
              indexFailuresRemaining--;
            }
            return Promise.resolve({ statusCode: 403, body: new Uint8Array(), finalUrl: request.url, headers: {} });
          }
          body = new TextEncoder().encode(JSON.stringify({
            formatVersion: 1, source: { id: source.id, name: source.name, updatedAt: '2026-01-01T00:00:00Z' },
            bundles: [catalogId, ...additionalCatalogIds].map((id) => {
              const bytes = archiveFor();
              return {
                id, version, name: 'Bundle', description: '', author: 'Test', environments: ['vscode'],
                tags: [], dependencies: [], license: 'Apache-2.0', lastUpdated: '2026-01-01T00:00:00Z',
                manifest: { path: `${version}/${id}/deployment-manifest.yml`, size: 1, sha256: 'a'.repeat(64) },
                archive: { path: `${version}/${id}.zip`, size: bytes.length,
                  sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'application/zip' }
              };
            })
          }));
        } else if (request.url.startsWith(`${root}/${version}/`) && request.url.endsWith('.zip')) {
          if (archiveFailureBundleId !== undefined && request.url.endsWith(`/${archiveFailureBundleId}.zip`)) {
            return Promise.resolve({ statusCode: 403, body: new Uint8Array(), finalUrl: request.url, headers: {} });
          }
          body = archiveFor();
        } else {
          throw new Error(`Unexpected Artifactory request: ${request.url}`);
        }
        return Promise.resolve({ statusCode: 200, body, finalUrl: request.url, headers: {} });
      }
    };
    const tokens = { getToken: () => Promise.reject(new Error('GitHub credentials must not be used')) };
    const context = () => createTestContext({ cwd: workspace, fs: new NodeFileSystem(), env });
    const target: Target = { name: 'copilot', type: 'copilot-cli', scope: 'user', path: targetDir };
    const install = async (bundleId = catalogId) => {
      const ctx = context();
      const exitCode = await installBundleWithSource(bundleId, source, target, ctx, http, tokens, 'json');
      return { exitCode, ctx, lockPath: JSON.parse(ctx.stdout.captured()).data.lockfile as string };
    };
    const command = async (args: string[]) => {
      const ctx = context();
      const exitCode = await runCli(args, { ctx, http, tokens, commandClasses: [InstallCommand, UpdateCommand], commands: [], name: 'test', version: 'test' });
      return { exitCode, ctx };
    };
    return { catalogId, root, requests, install, command, context, source, target, http, tokens,
      addCatalogBundle: (id: string) => {
        additionalCatalogIds.push(id);
      },
      addArchiveEntry: (entry: { path: string; bytes: Uint8Array; mode?: number }) => {
        extraEntries.push(entry);
      },
      setVersion: (selected: string, embedded = selected) => {
        version = selected;
        manifestVersion = embedded;
      },
      setIndexFailure: () => {
        indexFailuresRemaining = Number.POSITIVE_INFINITY;
      },
      failNextIndexRequest: () => {
        indexFailuresRemaining = 1;
      },
      failArchiveFor: (bundleId: string) => {
        archiveFailureBundleId = bundleId;
      } };
  };

  it('persists the Artifactory catalog ID through install replay and update without GitHub access', async () => {
    const fixture = artifactoryFixture();
    const installed = await fixture.install();
    const installEnvelope = JSON.parse(installed.ctx.stdout.captured());
    expect(installEnvelope.data.bundle).toEqual({ id: fixture.catalogId, version: '1.0.0' });
    const lock = JSON.parse(await readFile(installed.lockPath, 'utf8')) as Lockfile;
    expect(Object.keys(lock.bundles)).toEqual([fixture.catalogId]);
    expect(lock.sources['artifact-source']).toMatchObject({ type: 'artifactory', credentialRef: 'ARTIFACTORY_TOKEN' });
    expect(JSON.stringify(lock)).not.toContain('reader-token');
    await rm(path.join(targetDir, 'prompts', 'hello.prompt.md'));
    const replay = await fixture.command(['install', '--lockfile', installed.lockPath, '--target', 'copilot', '-o', 'json']);
    expect(replay.exitCode).toBe(0);
    expect(JSON.parse(replay.ctx.stdout.captured()).data.replayed).toEqual([fixture.catalogId]);
    await expect(readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8')).resolves.toContain('Hello Prompt');
    fixture.setVersion('2.0.0');
    const updated = await fixture.command(['update', '--lockfile', installed.lockPath, '--target', 'copilot', '--no-hub-sync', '-o', 'json']);
    expect(updated.exitCode).toBe(0);
    expect(JSON.parse(updated.ctx.stdout.captured()).data.updated).toBe(1);
    const nextLock = JSON.parse(await readFile(installed.lockPath, 'utf8')) as Lockfile;
    expect(Object.keys(nextLock.bundles)).toEqual([fixture.catalogId]);
    expect(nextLock.bundles[fixture.catalogId].version).toBe('2.0.0');
    expect(nextLock.bundles[fixture.catalogId].targetType).toBe('copilot-cli');
    expect(nextLock.bundles[fixture.catalogId]).not.toHaveProperty('commitMode');
    const replayUpdated = await fixture.command(['install', '--lockfile', installed.lockPath, '--target', 'copilot', '-o', 'json']);
    expect(replayUpdated.exitCode).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('restores executable bits on install, lockfile replay and update (#577)', async () => {
    const fixture = artifactoryFixture();
    fixture.addArchiveEntry({ path: 'skills/demo/scripts/run.sh', bytes: new TextEncoder().encode('#!/bin/sh\necho ok\n'), mode: 0o755 });
    const script = path.join(targetDir, 'skills', 'demo', 'scripts', 'run.sh');
    // eslint-disable-next-line no-bitwise -- test reads the POSIX execute bits
    const executable = async (filePath = script): Promise<boolean> => ((await stat(filePath)).mode & 0o111) !== 0;

    const installed = await fixture.install();
    expect(await executable()).toBe(true);
    expect(await executable(path.join(targetDir, 'prompts', 'hello.prompt.md'))).toBe(false);

    await rm(script);
    const replay = await fixture.command(['install', '--lockfile', installed.lockPath, '--target', 'copilot', '-o', 'json']);
    expect(replay.exitCode).toBe(0);
    expect(await executable()).toBe(true);

    await chmod(script, 0o644);
    fixture.setVersion('2.0.0');
    const updated = await fixture.command(['update', '--lockfile', installed.lockPath, '--target', 'copilot', '--no-hub-sync', '-o', 'json']);
    expect(updated.exitCode).toBe(0);
    expect(JSON.parse(updated.ctx.stdout.captured()).data.updated).toBe(1);
    expect(await executable()).toBe(true);
  });

  it('reports Artifactory discovery failures instead of reporting no updates', async () => {
    const fixture = artifactoryFixture();
    const installed = await fixture.install();
    fixture.setIndexFailure();

    const result = await fixture.command([
      'update', '--lockfile', installed.lockPath, '--target', 'copilot', '--no-hub-sync', '-o', 'json'
    ]);
    const output = JSON.parse(result.ctx.stdout.captured());

    expect(result.exitCode).toBe(1);
    expect(output.status).toBe('warning');
    expect(output.warnings).toEqual(expect.arrayContaining([expect.stringContaining(fixture.catalogId)]));
    expect(output.data.failures).toEqual(output.warnings);
  });

  it('shows available updates alongside discovery failures in text dry-run output', async () => {
    const fixture = artifactoryFixture();
    const secondBundleId = 'owner-repo-second';
    fixture.addCatalogBundle(secondBundleId);
    const installed = await fixture.install();
    await fixture.install(secondBundleId);
    fixture.setVersion('2.0.0');
    fixture.failNextIndexRequest();

    const result = await fixture.command([
      'update', '--lockfile', installed.lockPath, '--target', 'copilot', '--no-hub-sync', '--dry-run', '-o', 'text'
    ]);
    const output = result.ctx.stdout.captured();

    expect(result.exitCode).toBe(1);
    expect(output).toContain('Available updates (1):');
    expect(output).toContain(`${secondBundleId}: 1.0.0 → 2.0.0`);
    expect(output).toContain('Update check is incomplete.');
  });

  it('shows completed updates alongside installation failures in text output', async () => {
    const fixture = artifactoryFixture();
    const secondBundleId = 'owner-repo-second';
    fixture.addCatalogBundle(secondBundleId);
    const installed = await fixture.install();
    await fixture.install(secondBundleId);
    fixture.setVersion('2.0.0');
    fixture.failArchiveFor(fixture.catalogId);

    const result = await fixture.command([
      'update', '--lockfile', installed.lockPath, '--target', 'copilot', '--no-hub-sync', '-o', 'text'
    ]);
    const output = result.ctx.stdout.captured();

    expect(result.exitCode).toBe(1);
    expect(output).toContain('Updated 1 bundle:');
    expect(output).toContain(`${secondBundleId}: 1.0.0 → 2.0.0`);
    expect(output).toContain('1 update check or installation failed.');
  });

  it('rejects an Artifactory latest install with a different embedded version before writing', async () => {
    const fixture = artifactoryFixture();
    fixture.setVersion('2.0.0', '3.0.0');
    await expect(installBundleWithSource(fixture.catalogId, fixture.source, fixture.target, fixture.context(), fixture.http, fixture.tokens, 'json'))
      .rejects.toThrow(/version/i);
    await expect(readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8')).rejects.toThrow();
  });

  it('rejects an Artifactory update version mismatch without changing files or lockfile', async () => {
    const fixture = artifactoryFixture();
    const installed = await fixture.install();
    const oldLock = await readFile(installed.lockPath, 'utf8');
    const oldContent = await readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8');
    fixture.setVersion('2.0.0', '3.0.0');
    const updated = await fixture.command(['update', '--lockfile', installed.lockPath, '--target', 'copilot', '--no-hub-sync', '-o', 'json']);
    expect(updated.exitCode).toBe(1);
    expect(JSON.parse(updated.ctx.stdout.captured())).toMatchObject({ status: 'warning', data: { updated: 0 } });
    expect(JSON.parse(updated.ctx.stdout.captured()).warnings[0]).toMatch(/version/i);
    const textUpdate = await fixture.command([
      'update', '--lockfile', installed.lockPath, '--target', 'copilot', '--no-hub-sync', '-o', 'text'
    ]);
    expect(textUpdate.exitCode).toBe(1);
    expect(textUpdate.ctx.stderr.captured().match(/Failed to update/g)).toHaveLength(1);
    expect(await readFile(installed.lockPath, 'utf8')).toBe(oldLock);
    expect(await readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8')).toBe(oldContent);
  });

  it('installs a local bundle: writes files and records a lockfile entry', async () => {
    const result = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json'
    ]);
    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{
      bundle: { id: string; version: string };
      written: string[];
      lockfile: string;
    }>(result.stdout);
    expect(envelope.data.bundle).toEqual({ id: 'local-foo', version: '1.0.0' });
    expect(envelope.data.written.length).toBeGreaterThan(0);

    const installed = await readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8');
    expect(installed).toContain('Hello Prompt');

    const lockContent = await readFile(envelope.data.lockfile, 'utf8');
    expect(lockContent).toContain('local-foo');
  });

  it('does not write or lock governed archive metadata', async () => {
    await writeReleaseArchive(bundleDir, createGovernedReleaseArchive({ id: 'local-foo' }));

    const result = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json'
    ]);

    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ lockfile: string }>(result.stdout);
    await expect(readFile(path.join(targetDir, 'metadata', 'source-collection.yml'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(targetDir, 'LICENSE'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(targetDir, 'ignored', 'build', 'cache.pyc'), 'utf8')).rejects.toThrow();
    const lockfile = JSON.parse(await readFile(envelope.data.lockfile, 'utf8')) as {
      bundles: Record<string, { files: { path: string }[] }>;
    };
    expect(lockfile.bundles['local-foo'].files.map((file) => file.path)).toEqual([
      'prompts/hello.prompt.md'
    ]);
  });

  it('preserves legacy archive compatibility while routing only target-supported files', async () => {
    const result = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json'
    ]);

    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ lockfile: string }>(result.stdout);
    await expect(readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8'))
      .resolves.toContain('Hello Prompt');
    const lockfile = JSON.parse(await readFile(envelope.data.lockfile, 'utf8')) as {
      bundles: Record<string, { files: { path: string }[] }>;
    };
    expect(lockfile.bundles['local-foo'].files.map((file) => file.path)).toEqual([
      'prompts/hello.prompt.md'
    ]);
  });

  it('replays a governed archive from its lockfile without restoring metadata evidence', async () => {
    await writeReleaseArchive(bundleDir, createGovernedReleaseArchive({ id: 'local-foo' }));
    const firstInstall = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json'
    ]);
    expect(firstInstall.exitCode).toBe(0);
    const firstEnvelope = parseJson<{ lockfile: string }>(firstInstall.stdout);

    await rm(path.join(targetDir, 'prompts', 'hello.prompt.md'));
    const replay = await run([
      'install', '--lockfile', firstEnvelope.data.lockfile, '--target', 'copilot', '-o', 'json'
    ]);

    expect(replay.exitCode).toBe(0);
    const replayEnvelope = parseJson<{ replayed: string[]; failures: unknown[] }>(replay.stdout);
    expect(replayEnvelope.data.replayed).toEqual(['local-foo']);
    expect(replayEnvelope.data.failures).toEqual([]);
    await expect(readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8'))
      .resolves.toContain('Hello Prompt');
    await expect(readFile(path.join(targetDir, 'README.md'), 'utf8')).rejects.toThrow();
  });

  it('dry-run: reports the plan but writes nothing', async () => {
    const result = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '--dry-run', '-o', 'json'
    ]);
    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ dryRun: boolean; bundle: { id: string } }>(result.stdout);
    expect(envelope.data.dryRun).toBe(true);
    expect(envelope.data.bundle.id).toBe('local-foo');

    await expect(readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8')).rejects.toThrow();
  });

  it('is idempotent: installing the same bundle twice still exits 0 with one lockfile entry', async () => {
    await run(['install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json']);
    const result = await run(['install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json']);
    expect(result.exitCode).toBe(0);

    const envelope = parseJson<{ lockfile: string }>(result.stdout);
    const lockContent = JSON.parse(await readFile(envelope.data.lockfile, 'utf8')) as { bundles: Record<string, unknown> };
    expect(Object.keys(lockContent.bundles)).toEqual(['local-foo']);
  });

  it('installs --from <dir> without a bundle id, accepting the manifest id', async () => {
    const result = await run(['install', '--from', bundleDir, '--target', 'copilot', '-o', 'json']);

    expect(result.exitCode, result.stdout).toBe(0);
    expect(parseJson<{ bundle: { id: string } }>(result.stdout).data.bundle.id).toBe('local-foo');
  });

  it('still rejects --from <dir> with a bundle id that does not match the manifest', async () => {
    const result = await run(['install', 'wrong-id', '--from', bundleDir, '--target', 'copilot', '-o', 'json']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('BUNDLE.ID_MISMATCH');
  });

  describe('--source resolved through the hub', () => {
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
    const runWithHub = async (argv: string[]): Promise<{ exitCode: number; stdout: string }> => {
      const ctx = createTestContext({
        cwd: workspace,
        fs: new NodeFileSystem(),
        env: {
          HOME: workspace,
          USERPROFILE: workspace,
          XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
          XDG_CACHE_HOME: path.join(workspace, 'xdg-cache')
        }
      });
      const exitCode = await runCli(argv, {
        ctx,
        http,
        tokens: { getToken: async () => undefined },
        commandClasses: [...COMMAND_CLASSES, HubAddCommand, HubUseCommand],
        commands: [],
        name: 'test',
        version: 'test'
      });
      return { exitCode, stdout: ctx.stdout.captured() };
    };

    beforeEach(async () => {
      const hubConfigFile = path.join(workspace, 'hub-config.yml');
      await writeFile(hubConfigFile, [
        'version: 1.0.0',
        'metadata:',
        '  name: Sample Hub',
        '  description: Hub with a GitHub source',
        '  maintainer: test',
        "  updatedAt: '2026-01-01T00:00:00Z'",
        'sources:',
        '  - id: sample-collections',
        '    name: Sample Collections',
        '    type: github',
        '    url: https://github.com/acme-org/sample-skills',
        '    enabled: true',
        '    priority: 0',
        '    hubId: sample-hub',
        'profiles: []',
        ''
      ].join('\n'));
      expect((await runWithHub(['hub', 'add', '--type', 'local', '--location', hubConfigFile, '--id', 'sample-hub', '-o', 'json'])).exitCode).toBe(0);
      expect((await runWithHub(['hub', 'use', 'sample-hub', '-o', 'json'])).exitCode).toBe(0);
    });

    it('installs <id> --source <source-id> using the active hub source', async () => {
      const result = await runWithHub([
        'install', 'acme-org-sample-skills-sample-skills',
        '--source', 'sample-collections', '--target', 'copilot', '-o', 'json'
      ]);

      expect(result.exitCode, result.stdout).toBe(0);
      await expect(readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8'))
        .resolves.toContain('Hello Prompt');
    });

    it('installs <id> --source <hub-id> using that hub\'s source', async () => {
      const result = await runWithHub([
        'install', 'acme-org-sample-skills-sample-skills',
        '--source', 'sample-hub', '--target', 'copilot', '-o', 'json'
      ]);

      expect(result.exitCode, result.stdout).toBe(0);
    });

    it('reports every lookup it tried when --source matches nothing', async () => {
      const result = await runWithHub([
        'install', 'some-bundle', '--source', 'no-such-source', '--target', 'copilot', '-o', 'json'
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('BUNDLE.NOT_FOUND');
      expect(result.stdout).toContain('no-such-source');
      expect(result.stdout).toMatch(/source id.*hub id.*owner\/repo/);
    });

    it('reports a malformed active hub configuration instead of BUNDLE.NOT_FOUND', async () => {
      const hubsDir = resolveUserConfigPaths({ XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'), HOME: workspace }).hubs;
      await writeFile(path.join(hubsDir, 'sample-hub.yml'), 'sources:\n  - id: [unclosed\n');

      const result = await runWithHub([
        'install', 'some-bundle', '--source', 'demo', '--target', 'copilot', '-o', 'json'
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('HUB.LOAD_FAILED');
      expect(result.stdout).toContain('hub \\"sample-hub\\" configuration could not be loaded');
      expect(result.stdout).not.toContain('BUNDLE.NOT_FOUND');
    });
  });

  it('fails with exit 1 when neither <bundle>, --lockfile, --from, nor --source is given', async () => {
    const result = await run(['install', '--target', 'copilot', '-o', 'json']);
    expect(result.exitCode).toBe(1);
  });

  it('fails with exit 1 for an unknown --target', async () => {
    const result = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'does-not-exist', '-o', 'json'
    ]);
    expect(result.exitCode).toBe(1);
  });

  it('fails without writing or locking content excluded by the target allowlist', async () => {
    const addTarget = await run([
      'target', 'add', 'skills-only', '--type', 'copilot-cli', '--path', targetDir,
      '--allowed-kinds', 'skill', '-o', 'json'
    ]);
    expect(addTarget.exitCode).toBe(0);

    const result = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'skills-only', '-o', 'json'
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('BUNDLE.UNSUPPORTED_CONTENT');
    expect(result.stdout).toContain('prompts/hello.prompt.md');
    await expect(readFile(path.join(targetDir, 'prompts', 'hello.prompt.md'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(workspace, 'prompt-registry.lock.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(workspace, 'prompt-registry.local.lock.json'), 'utf8')).rejects.toThrow();
  });

  it('uses the effective repository scope for both writing and lockfile selection', async () => {
    await writeReleaseArchive(bundleDir, new Map([
      ['deployment-manifest.yml', new TextEncoder().encode(`id: local-foo
version: 1.0.0
name: Local Bundle
prompts:
  - id: hello
    file: prompts/hello.prompt.md
    type: prompt
agents:
  - id: hello-agent
    file: agents/hello.agent.md
    type: agent`)],
      ['prompts/hello.prompt.md', new TextEncoder().encode('# Hello Prompt\n')],
      ['agents/hello.agent.md', new TextEncoder().encode('# Hello Agent\n')]
    ]));

    const result = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot',
      '--scope', 'repository', '--commit-mode', 'local-only', '-o', 'json'
    ]);
    expect(result.exitCode).toBe(0);

    const envelope = parseJson<{ lockfile: string }>(result.stdout);
    expect(envelope.data.lockfile).toBe(path.join(workspace, 'prompt-registry.local.lock.json'));
    await expect(
      readFile(path.join(workspace, '.github', 'prompts', 'hello.prompt.md'), 'utf8')
    ).resolves.toContain('Hello Prompt');
    await expect(
      readFile(path.join(workspace, '.github', 'agents', 'hello.agent.md'), 'utf8')
    ).resolves.toContain('Hello Agent');
    await expect(
      readFile(path.join(workspace, '.github', 'copilot', 'agents', 'hello.agent.md'), 'utf8')
    ).rejects.toThrow();
  });

  it('uses the effective user scope when it overrides a repository target', async () => {
    const addTarget = await run([
      'target', 'add', 'repository-vscode', '--type', 'vscode', '--scope', 'repository',
      '--workspace-root', workspace, '-o', 'json'
    ]);
    expect(addTarget.exitCode).toBe(0);

    const result = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'repository-vscode',
      '--scope', 'user', '-o', 'json'
    ]);
    expect(result.exitCode).toBe(0);

    await expect(
      readFile(path.join(workspace, '.copilot', 'prompts', 'hello.prompt.md'), 'utf8')
    ).resolves.toContain('Hello Prompt');
    await expect(
      readFile(path.join(workspace, '.github', 'prompts', 'hello.prompt.md'), 'utf8')
    ).rejects.toThrow();
  });

  it('removes a prompt the new version dropped on a vscode repository reinstall', async () => {
    const manifest = (version: string, prompts: string[]): string => [
      'id: local-foo',
      `version: ${version}`,
      'name: Local Bundle',
      'prompts:',
      ...prompts.flatMap((id) => [`  - id: ${id}`, `    file: prompts/${id}.prompt.md`, '    type: prompt'])
    ].join('\n');
    const writeVersion = async (version: string, prompts: string[]): Promise<void> => {
      await rm(bundleDir, { recursive: true, force: true });
      await writeReleaseArchive(bundleDir, new Map([
        ['deployment-manifest.yml', new TextEncoder().encode(manifest(version, prompts))],
        ...prompts.map((id): [string, Uint8Array] => [`prompts/${id}.prompt.md`, new TextEncoder().encode(`# ${id}\n`)])
      ]));
    };
    const addTarget = await run([
      'target', 'add', 'repository-vscode', '--type', 'vscode', '--scope', 'repository',
      '--workspace-root', workspace, '-o', 'json'
    ]);
    expect(addTarget.exitCode).toBe(0);
    const install = (): ReturnType<typeof run> => run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'repository-vscode', '-o', 'json'
    ]);

    await writeVersion('1.0.0', ['kept', 'dropped']);
    expect((await install()).exitCode).toBe(0);
    await writeVersion('2.0.0', ['kept']);
    const reinstall = await install();

    expect(reinstall.exitCode, reinstall.stdout).toBe(0);
    await expect(readFile(path.join(workspace, '.github', 'prompts', 'kept.prompt.md'), 'utf8')).resolves.toContain('kept');
    await expect(readFile(path.join(workspace, '.github', 'prompts', 'dropped.prompt.md'), 'utf8')).rejects.toThrow();
  });

  it('uses the repository-scope writer for remote installs', async () => {
    const zipBytes = buildZip([
      {
        path: 'deployment-manifest.yml',
        bytes: new TextEncoder().encode(
          'id: remote-foo\nversion: 1.0.0\nname: Remote Foo\nprompts:\n'
          + '  - id: hello\n    file: prompts/hello.prompt.md\n    type: prompt\n'
        )
      },
      {
        path: 'prompts/hello.prompt.md',
        bytes: new TextEncoder().encode('# Hello from a remote bundle\n')
      }
    ]);
    const http: HttpClient = {
      fetch: async (request: HttpRequest): Promise<HttpResponse> => {
        if (request.url === 'https://api.github.com/repos/owner/repo/releases') {
          return {
            statusCode: 200,
            body: new TextEncoder().encode(JSON.stringify([{
              tag_name: 'remote-foo-v1.0.0',
              assets: [{ name: 'bundle.zip', url: 'https://api.github.com/assets/remote-foo' }]
            }])),
            finalUrl: request.url,
            headers: {}
          };
        }
        if (request.url === 'https://api.github.com/assets/remote-foo') {
          return { statusCode: 200, body: zipBytes, finalUrl: request.url, headers: {} };
        }
        throw new Error(`Unexpected request: ${request.url}`);
      }
    };
    const source: RegistrySource = {
      id: 'github-source',
      name: 'GitHub source',
      type: 'github',
      url: 'https://github.com/owner/repo',
      enabled: true,
      priority: 0
    };
    const target: Target = {
      name: 'repository-copilot',
      type: 'copilot-cli',
      scope: 'repository',
      rootPath: workspace
    };
    const ctx = createTestContext({
      cwd: workspace,
      fs: new NodeFileSystem(),
      env: {
        HOME: workspace,
        USERPROFILE: workspace,
        XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
        XDG_CACHE_HOME: path.join(workspace, 'xdg-cache')
      }
    });

    const result = await installBundleWithSource(
      'remote-foo',
      source,
      target,
      ctx,
      http,
      { getToken: async () => undefined },
      'json'
    );

    expect(result).toBe(0);
    await expect(
      readFile(path.join(workspace, '.github', 'prompts', 'hello.prompt.md'), 'utf8')
    ).resolves.toContain('Hello from a remote bundle');
    await expect(
      readFile(path.join(workspace, '.github', 'copilot', 'prompts', 'hello.prompt.md'), 'utf8')
    ).rejects.toThrow();
  });

  it('installs a governed remote archive without writing its metadata evidence', async () => {
    const governedFiles = createGovernedReleaseArchive({ id: 'remote-governed' });
    const zipBytes = buildZip([...governedFiles.entries()].map(([filePath, content]) => ({
      path: filePath,
      bytes: content
    })));
    const http: HttpClient = {
      fetch: async (request: HttpRequest): Promise<HttpResponse> => {
        if (request.url === 'https://api.github.com/repos/owner/repo/releases') {
          return {
            statusCode: 200,
            body: new TextEncoder().encode(JSON.stringify([{
              tag_name: 'remote-governed-v1.0.0',
              assets: [{ name: 'bundle.zip', url: 'https://api.github.com/assets/remote-governed' }]
            }])),
            finalUrl: request.url,
            headers: {}
          };
        }
        if (request.url === 'https://api.github.com/assets/remote-governed') {
          return { statusCode: 200, body: zipBytes, finalUrl: request.url, headers: {} };
        }
        throw new Error(`Unexpected request: ${request.url}`);
      }
    };
    const source: RegistrySource = {
      id: 'github-source',
      name: 'GitHub source',
      type: 'github',
      url: 'https://github.com/owner/repo',
      enabled: true,
      priority: 0
    };
    const target: Target = {
      name: 'repository-copilot',
      type: 'copilot-cli',
      scope: 'repository',
      rootPath: workspace
    };
    const ctx = createTestContext({
      cwd: workspace,
      fs: new NodeFileSystem(),
      env: {
        HOME: workspace,
        USERPROFILE: workspace,
        XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
        XDG_CACHE_HOME: path.join(workspace, 'xdg-cache')
      }
    });

    const result = await installBundleWithSource(
      'remote-governed',
      source,
      target,
      ctx,
      http,
      { getToken: async () => undefined },
      'json'
    );

    expect(result).toBe(0);
    await expect(
      readFile(path.join(workspace, '.github', 'prompts', 'hello.prompt.md'), 'utf8')
    ).resolves.toContain('Hello Prompt');
    await expect(readFile(path.join(workspace, '.github', 'README.md'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(workspace, '.github', 'LICENSE'), 'utf8')).rejects.toThrow();
  });

  it('preflights a remote source before an opt-in authenticated install', async () => {
    const zipBytes = buildZip([
      {
        path: 'deployment-manifest.yml',
        bytes: new TextEncoder().encode(
          'id: remote-preflight\nversion: 1.0.0\nname: Remote Preflight\nprompts:\n'
          + '  - id: hello\n    file: prompts/hello.prompt.md\n    type: prompt\n'
        )
      },
      {
        path: 'prompts/hello.prompt.md',
        bytes: new TextEncoder().encode('# Hello from a preflighted bundle\n')
      }
    ]);
    const http: HttpClient = {
      fetch: async (request: HttpRequest): Promise<HttpResponse> => {
        if (request.url === 'https://api.github.com/repos/owner/repo') {
          return { statusCode: 200, body: new TextEncoder().encode('{"private":false}'), finalUrl: request.url, headers: {} };
        }
        if (request.url === 'https://api.github.com/repos/owner/repo/commits/main') {
          return { statusCode: 200, body: new TextEncoder().encode('{"sha":"preflight-sha"}'), finalUrl: request.url, headers: {} };
        }
        if (request.url === 'https://api.github.com/repos/owner/repo/git/trees/main?recursive=1') {
          return { statusCode: 200, body: new TextEncoder().encode('{"tree":[],"truncated":false}'), finalUrl: request.url, headers: {} };
        }
        if (request.url === 'https://api.github.com/repos/owner/repo/releases') {
          return {
            statusCode: 200,
            body: new TextEncoder().encode(JSON.stringify([{
              tag_name: 'remote-preflight-v1.0.0',
              assets: [{ name: 'bundle.zip', url: 'https://api.github.com/assets/remote-preflight' }]
            }])),
            finalUrl: request.url,
            headers: {}
          };
        }
        if (request.url === 'https://api.github.com/assets/remote-preflight') {
          return { statusCode: 200, body: zipBytes, finalUrl: request.url, headers: {} };
        }
        throw new Error(`Unexpected request: ${request.url}`);
      }
    };
    const source: RegistrySource = {
      id: 'github-source',
      name: 'GitHub source',
      type: 'github',
      url: 'https://github.com/owner/repo',
      enabled: true,
      priority: 0
    };
    const target: Target = {
      name: 'repository-copilot',
      type: 'copilot-cli',
      scope: 'repository',
      rootPath: workspace
    };
    const ctx = createTestContext({
      cwd: workspace,
      fs: new NodeFileSystem(),
      env: {
        HOME: workspace,
        USERPROFILE: workspace,
        XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
        XDG_CACHE_HOME: path.join(workspace, 'xdg-cache'),
        AI_PRIMITIVES_HUB_GH_APP_AUTH_ENABLED: 'true',
        GH_TOKEN: 'generic-token'
      }
    });

    const result = await installBundleWithSource(
      'remote-preflight',
      source,
      target,
      ctx,
      http,
      { getToken: async () => 'must-not-be-used' },
      'json'
    );

    expect(result).toBe(0);
    await expect(
      readFile(path.join(workspace, '.github', 'prompts', 'hello.prompt.md'), 'utf8')
    ).resolves.toContain('preflighted bundle');
  });

  describe('install records, exclusion and rollback', () => {
    const posixNonRoot = it.skipIf(process.platform === 'win32' || process.getuid?.() === 0);
    const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
    const toPosix = (p: string): string => p.split(path.sep).join('/');
    const commitLock = (): string => path.join(workspace, 'prompt-registry.lock.json');
    const localLock = (): string => path.join(workspace, 'prompt-registry.local.lock.json');
    const readLock = async (file: string): Promise<Lockfile> => JSON.parse(await readFile(file, 'utf8')) as Lockfile;
    const excludeLines = async (root = workspace): Promise<string[]> =>
      (await readFile(path.join(root, '.git', 'info', 'exclude'), 'utf8')).split('\n');

    /**
     * Write a local bundle directory with an `items:` manifest.
     * @param dir Bundle directory.
     * @param id Bundle id.
     * @param items Manifest items (path, kind, optional id).
     * @param files Bundle files.
     */
    const writeBundle = async (
      dir: string,
      id: string,
      items: { path: string; kind: string; id?: string }[],
      files: Record<string, string>
    ): Promise<void> => {
      await rm(dir, { recursive: true, force: true });
      const manifest = [
        `id: ${id}`, 'version: 1.0.0', `name: ${id}`, 'items:',
        ...items.flatMap((item) => [
          `  - path: ${item.path}`, `    kind: ${item.kind}`, ...(item.id === undefined ? [] : [`    id: ${item.id}`])
        ])
      ].join('\n');
      for (const [file, content] of Object.entries({ 'deployment-manifest.yml': `${manifest}\n`, ...files })) {
        await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
        await writeFile(path.join(dir, file), content);
      }
    };
    const addRepositoryTarget = async (name: string, type: string): Promise<void> => {
      expect((await run(['target', 'add', name, '--type', type, '--scope', 'repository', '-o', 'json'])).exitCode).toBe(0);
    };
    const installRepository = (target: string, extra: string[] = [], from = bundleDir): ReturnType<typeof run> => run([
      'install', '--from', from, '--target', target, '--scope', 'repository', ...extra, '-o', 'json'
    ]);

    it.each(TARGET_TYPES)('local-only on a %s repository target excludes the written files and the local lockfile', async (type) => {
      await mkdir(path.join(workspace, '.git'));
      await addRepositoryTarget('repo', type);

      const result = await installRepository('repo', ['--commit-mode', 'local-only']);

      expect(result.exitCode, result.stdout).toBe(0);
      const envelope = parseJson<{ written: string[] }>(result.stdout);
      expect(envelope.status).toBe('ok');
      expect(envelope.data.written.length).toBeGreaterThan(0);
      const lines = await excludeLines();
      for (const written of envelope.data.written) {
        expect(lines).toContain(toPosix(path.relative(workspace, written)));
      }
      expect(lines).toContain('prompt-registry.local.lock.json');
    });

    it('records targetType, no commitMode and installedPath where placement differs from the route', async () => {
      await writeBundle(bundleDir, 'placements', [
        { path: 'prompts/top.prompt.md', kind: 'prompt' },
        { path: 'prompts/sub/a.prompt.md', kind: 'prompt' },
        { path: 'prompts/x.agent.md', kind: 'agent' },
        { path: 'plugins/src-dir/plugin.json', kind: 'plugin', id: 'demo' }
      ], {
        'prompts/top.prompt.md': '# Top\n',
        'prompts/sub/a.prompt.md': '# A\n',
        'prompts/x.agent.md': '# X\n',
        'plugins/src-dir/plugin.json': '{}\n',
        'plugins/src-dir/scripts/run.sh': 'echo\n'
      });
      await addRepositoryTarget('repo', 'vscode');

      const result = await installRepository('repo');

      expect(result.exitCode, result.stdout).toBe(0);
      const entry = (await readLock(commitLock())).bundles.placements;
      expect(entry.targetType).toBe('vscode');
      expect(entry).not.toHaveProperty('commitMode');
      expect(Object.fromEntries(entry.files.map((file) => [file.path, file.installedPath]))).toEqual({
        'prompts/top.prompt.md': undefined,
        'prompts/sub/a.prompt.md': 'prompts/a.prompt.md',
        'prompts/x.agent.md': 'agents/x.agent.md',
        'plugins/src-dir/plugin.json': 'plugins/demo/plugin.json',
        'plugins/src-dir/scripts/run.sh': 'plugins/demo/scripts/run.sh'
      });
    });

    posixNonRoot('rolls back the new files when the lockfile cannot be written', async () => {
      const otherDir = path.join(workspace, 'other-bundle');
      await writeBundle(otherDir, 'other', [{ path: 'prompts/other.prompt.md', kind: 'prompt' }], { 'prompts/other.prompt.md': '# Other\n' });
      await addRepositoryTarget('repo', 'vscode');
      expect((await installRepository('repo', [], otherDir)).exitCode).toBe(0);
      await chmod(commitLock(), 0o444);

      const result = await installRepository('repo');

      expect(result.exitCode).toBe(1);
      await expect(stat(path.join(workspace, '.github', 'prompts', 'hello.prompt.md'))).rejects.toThrow();
      await expect(readFile(path.join(workspace, '.github', 'prompts', 'other.prompt.md'), 'utf8')).resolves.toContain('Other');
    });

    it('moves the entry to the local lockfile on a reinstall with --commit-mode local-only', async () => {
      await mkdir(path.join(workspace, '.git'));
      await addRepositoryTarget('repo', 'vscode');
      expect((await installRepository('repo')).exitCode).toBe(0);
      expect(Object.keys((await readLock(commitLock())).bundles)).toEqual(['local-foo']);

      const result = await installRepository('repo', ['--commit-mode', 'local-only']);

      expect(result.exitCode, result.stdout).toBe(0);
      expect(parseJson<{ lockfile: string }>(result.stdout).data.lockfile).toBe(localLock());
      expect(Object.keys((await readLock(localLock())).bundles)).toEqual(['local-foo']);
      await expect(stat(commitLock())).rejects.toThrow();
    });

    it.each(['kiro', 'windsurf', 'claude-code'])('records installedChecksum for the files a %s target transforms', async (type) => {
      await writeBundle(bundleDir, 'transformed', [
        { path: 'agents/helper.agent.md', kind: 'agent' },
        { path: 'prompts/rule.prompt.md', kind: 'prompt' }
      ], {
        'agents/helper.agent.md': '---\ntitle: Helper\n---\n# Helper\n',
        'prompts/rule.prompt.md': '---\ntitle: Rule\n---\n# Rule\n'
      });
      await addRepositoryTarget('repo', type);

      const result = await installRepository('repo');

      expect(result.exitCode, result.stdout).toBe(0);
      const written = parseJson<{ written: string[] }>(result.stdout).data.written;
      const onDisk = new Set(await Promise.all(written.map(async (file) => sha256(await readFile(file)))));
      const files = (await readLock(commitLock())).bundles.transformed.files;
      const transformed = files.filter((file) => file.installedChecksum !== undefined);
      expect(transformed.length).toBeGreaterThan(0);
      for (const file of transformed) {
        expect(file.installedChecksum).not.toBe(file.checksum);
        expect(onDisk).toContain(file.installedChecksum);
      }
    });

    it('local-only in a linked git worktree writes the main repository exclude file', async () => {
      const main = path.join(workspace, 'main');
      const worktree = path.join(workspace, 'wt');
      await mkdir(main);
      runGit(main, ['init', '-q']);
      runGit(main, ['commit', '-q', '--allow-empty', '-m', 'init']);
      runGit(main, ['worktree', 'add', '-q', worktree]);
      const runIn = (argv: string[]): ReturnType<typeof run> => runCommand(argv, {
        commandClasses: COMMAND_CLASSES,
        context: {
          cwd: worktree,
          fs: new NodeFileSystem(),
          env: { HOME: workspace, USERPROFILE: workspace, XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'), XDG_CACHE_HOME: path.join(workspace, 'xdg-cache') }
        }
      });
      expect((await runIn(['target', 'add', 'repo', '--type', 'vscode', '--scope', 'repository', '-o', 'json'])).exitCode).toBe(0);

      const result = await runIn(['install', '--from', bundleDir, '--target', 'repo', '--commit-mode', 'local-only', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(0);
      expect(parseJson(result.stdout).status).toBe('ok');
      const lines = await excludeLines(main);
      expect(lines).toContain('.github/prompts/hello.prompt.md');
      expect(lines).toContain('prompt-registry.local.lock.json');
      await expect(stat(path.join(worktree, '.git', 'info'))).rejects.toThrow();
    });

    it('local-only in a folder that is not a git repository warns and creates no .git', async () => {
      await addRepositoryTarget('repo', 'vscode');

      const result = await installRepository('repo', ['--commit-mode', 'local-only']);

      expect(result.exitCode, result.stdout).toBe(0);
      const envelope = JSON.parse(result.stdout) as JsonEnvelope<{ written: string[] }> & { warnings?: string[] };
      expect(envelope.status).toBe('warning');
      expect(envelope.warnings).toEqual([`${workspace} is not a git repository; local-only files are not excluded from git`]);
      await expect(stat(path.join(workspace, '.git'))).rejects.toThrow();
      await expect(readFile(path.join(workspace, '.github', 'prompts', 'hello.prompt.md'), 'utf8')).resolves.toContain('Hello Prompt');
    });

    posixNonRoot('an exclude file that cannot be written is a warning, not an install error', async () => {
      await mkdir(path.join(workspace, '.git', 'info'), { recursive: true });
      await writeFile(path.join(workspace, '.git', 'info', 'exclude'), '# existing\n');
      await chmod(path.join(workspace, '.git', 'info', 'exclude'), 0o444);
      await addRepositoryTarget('repo', 'kiro');

      const result = await installRepository('repo', ['--commit-mode', 'local-only']);

      expect(result.exitCode, result.stdout).toBe(0);
      const envelope = JSON.parse(result.stdout) as JsonEnvelope<unknown> & { warnings?: string[] };
      expect(envelope.status).toBe('warning');
      expect(envelope.warnings).toEqual([expect.stringMatching(/^could not update the git exclude file: /)]);
      expect(await readFile(path.join(workspace, '.git', 'info', 'exclude'), 'utf8')).toBe('# existing\n');
      expect(Object.keys((await readLock(localLock())).bundles)).toEqual(['local-foo']);
    });
  });

  describe('executable bits (#577)', () => {
    const unixOnly = it.skipIf(process.platform === 'win32');
    const SCRIPT = '#!/bin/sh\necho ok\n';
    const SKILL = '---\nname: demo\ndescription: Demo skill with a helper script\n---\n# Demo\n';
    const MANIFEST = 'id: exec-demo\nversion: 1.0.0\nname: Exec Demo\nskills:\n'
      + '  - id: demo\n    file: skills/demo/SKILL.md\n    type: skill\n';
    const userTarget = (): Target => ({ name: 'copilot', type: 'copilot-cli', scope: 'user', path: targetDir });
    const repoTarget = (): Target => ({ name: 'repository-copilot', type: 'copilot-cli', scope: 'repository', rootPath: workspace });
    let execBundleDir: string;

    const isExecutable = async (filePath: string): Promise<boolean> =>
      // eslint-disable-next-line no-bitwise -- test reads the POSIX execute bits
      ((await stat(filePath)).mode & 0o111) !== 0;
    const lockedFiles = async (lockfilePath: string): Promise<unknown> =>
      (JSON.parse(await readFile(lockfilePath, 'utf8')) as Lockfile).bundles['exec-demo'].files;
    const installFrom = async (extra: string[] = []): Promise<string> => {
      const result = await run(['install', 'exec-demo', '--from', execBundleDir, '--target', 'copilot', ...extra, '-o', 'json']);
      expect(result.exitCode, result.stdout).toBe(0);
      return parseJson<{ lockfile: string }>(result.stdout).data.lockfile;
    };
    const execZip = (scriptMode?: number): Uint8Array => buildZip([
      { path: 'deployment-manifest.yml', bytes: new TextEncoder().encode(MANIFEST) },
      { path: 'skills/demo/SKILL.md', bytes: new TextEncoder().encode(SKILL) },
      { path: 'skills/demo/scripts/run.sh', bytes: new TextEncoder().encode(SCRIPT), mode: scriptMode }
    ]);
    const installRemote = async (zipBytes: Uint8Array, target: Target): Promise<string> => {
      const http: HttpClient = {
        fetch: (request: HttpRequest): Promise<HttpResponse> => {
          if (request.url === 'https://api.github.com/repos/owner/repo/releases') {
            return Promise.resolve({
              statusCode: 200,
              body: new TextEncoder().encode(JSON.stringify([{
                tag_name: 'exec-demo-v1.0.0',
                assets: [{ name: 'bundle.zip', url: 'https://api.github.com/assets/exec-demo' }]
              }])),
              finalUrl: request.url,
              headers: {}
            });
          }
          if (request.url === 'https://api.github.com/assets/exec-demo') {
            return Promise.resolve({ statusCode: 200, body: zipBytes, finalUrl: request.url, headers: {} });
          }
          return Promise.reject(new Error(`Unexpected request: ${request.url}`));
        }
      };
      const source: RegistrySource = {
        id: 'github-source', name: 'GitHub source', type: 'github', url: 'https://github.com/owner/repo', enabled: true, priority: 0
      };
      const ctx = createTestContext({
        cwd: workspace,
        fs: new NodeFileSystem(),
        env: {
          HOME: workspace,
          USERPROFILE: workspace,
          XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
          XDG_CACHE_HOME: path.join(workspace, 'xdg-cache')
        }
      });
      const exitCode = await installBundleWithSource('exec-demo', source, target, ctx, http, { getToken: () => Promise.resolve(undefined) }, 'json');
      expect(exitCode, ctx.stdout.captured()).toBe(0);
      return (JSON.parse(ctx.stdout.captured()) as JsonEnvelope<{ lockfile: string }>).data.lockfile;
    };

    beforeEach(async () => {
      execBundleDir = path.join(workspace, 'exec-bundle');
      await mkdir(path.join(execBundleDir, 'skills', 'demo', 'scripts'), { recursive: true });
      await writeFile(path.join(execBundleDir, 'deployment-manifest.yml'), MANIFEST);
      await writeFile(path.join(execBundleDir, 'skills', 'demo', 'SKILL.md'), SKILL);
      await writeFile(path.join(execBundleDir, 'skills', 'demo', 'scripts', 'run.sh'), SCRIPT);
      await chmod(path.join(execBundleDir, 'skills', 'demo', 'SKILL.md'), 0o644);
      await chmod(path.join(execBundleDir, 'skills', 'demo', 'scripts', 'run.sh'), 0o644);
    });

    unixOnly('install --from restores the exec bit on a user-scope target without changing bytes or lockfile', async () => {
      const baselineLock = await lockedFiles(await installFrom());
      const installedScript = path.join(targetDir, 'skills', 'demo', 'scripts', 'run.sh');
      expect(await isExecutable(installedScript)).toBe(false);

      await chmod(path.join(execBundleDir, 'skills', 'demo', 'scripts', 'run.sh'), 0o755);
      const lockfilePath = await installFrom();

      expect(await isExecutable(installedScript)).toBe(true);
      expect(await isExecutable(path.join(targetDir, 'skills', 'demo', 'SKILL.md'))).toBe(false);
      expect(await readFile(installedScript, 'utf8')).toBe(SCRIPT);
      expect(await lockedFiles(lockfilePath)).toEqual(baselineLock);
      expect(JSON.stringify(baselineLock)).not.toContain('mode');
    });

    unixOnly('install --from restores the exec bit on a repository-scope target', async () => {
      await chmod(path.join(execBundleDir, 'skills', 'demo', 'scripts', 'run.sh'), 0o755);
      await installFrom(['--scope', 'repository']);

      const skillDir = path.join(workspace, '.github', 'skills', 'demo');
      expect(await isExecutable(path.join(skillDir, 'scripts', 'run.sh'))).toBe(true);
      expect(await isExecutable(path.join(skillDir, 'SKILL.md'))).toBe(false);
      expect(await readFile(path.join(skillDir, 'scripts', 'run.sh'), 'utf8')).toBe(SCRIPT);
    });

    unixOnly('install --lockfile restores the exec bit when replaying a local bundle', async () => {
      await chmod(path.join(execBundleDir, 'skills', 'demo', 'scripts', 'run.sh'), 0o755);
      const lockfilePath = await installFrom();
      const installedScript = path.join(targetDir, 'skills', 'demo', 'scripts', 'run.sh');
      await rm(installedScript);

      const replay = await run(['install', '--lockfile', lockfilePath, '--target', 'copilot', '-o', 'json']);

      expect(replay.exitCode, replay.stdout).toBe(0);
      expect(await isExecutable(installedScript)).toBe(true);
    });

    unixOnly.each([
      ['user', userTarget, (): string => path.join(targetDir, 'skills', 'demo')],
      ['repository', repoTarget, (): string => path.join(workspace, '.github', 'skills', 'demo')]
    ] as const)('installs a downloaded archive with the exec bit on %s scope', async (_scope, target, skillDir) => {
      const baselineLock = await lockedFiles(await installRemote(execZip(), target()));
      expect(await isExecutable(path.join(skillDir(), 'scripts', 'run.sh'))).toBe(false);

      const lockfilePath = await installRemote(execZip(0o755), target());

      expect(await isExecutable(path.join(skillDir(), 'scripts', 'run.sh'))).toBe(true);
      expect(await isExecutable(path.join(skillDir(), 'SKILL.md'))).toBe(false);
      expect(await readFile(path.join(skillDir(), 'scripts', 'run.sh'), 'utf8')).toBe(SCRIPT);
      expect(await lockedFiles(lockfilePath)).toEqual(baselineLock);
    });
  });
});
