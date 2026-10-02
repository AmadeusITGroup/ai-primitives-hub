/**
 * `install` command tests (local `--from` mode — no network required).
 *
 * Uses a real `NodeFileSystem` against a real temp directory (not
 * `createTestContext`'s default in-memory `fs` stub, which rejects
 * every call) since install does real file writes + lockfile IO.
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
  createSourceAwareInstallDependencyCache,
  installBundleWithSource,
  InstallCommand,
} from '../../src/commands/install';
import {
  TargetAddCommand,
} from '../../src/commands/target-add';
import {
  createTestContext,
  runCommand,
} from '../../src/framework';
import {
  createGovernedReleaseArchive,
  createLegacyReleaseArchive,
  writeReleaseArchive,
} from '../fixtures/release-archives';

const COMMAND_CLASSES = [
  TargetAddCommand,
  InstallCommand
];

interface JsonEnvelope<T> {
  status: string;
  data: T;
}

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

describe('install command (local --from mode)', () => {
  let workspace: string;
  let bundleDir: string;
  let targetDir: string;

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

  it('restores overwritten prompt and removes knowledge if lockfile persistence fails', async () => {
    const firstInstall = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json'
    ]);
    expect(firstInstall.exitCode).toBe(0);
    const lockPath = parseJson<{ lockfile: string }>(firstInstall.stdout).data.lockfile;
    const lockBefore = await readFile(lockPath, 'utf8');
    const promptPath = path.join(targetDir, 'prompts', 'hello.prompt.md');
    await writeFile(promptPath, '# User prompt');
    await writeReleaseArchive(bundleDir, createGovernedReleaseArchive({ id: 'local-foo', includeKnowledge: true }));

    const failingFs = new FailLockfileWriteFileSystem();
    const result = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json'
    ], failingFs);

    expect(result.exitCode).not.toBe(0);
    await expect(readFile(promptPath, 'utf8')).resolves.toBe('# User prompt');
    await expect(readFile(path.join(
      targetDir,
      'knowledge',
      'specifications',
      'RDP',
      'provider_layer',
      'SBB_B2P',
      'SBB_B2P.md'
    ), 'utf8')).rejects.toThrow();
    await expect(readFile(lockPath, 'utf8')).resolves.toBe(lockBefore);
    expect(failingFs.failedWritePath).not.toBeNull();
    expect(await failingFs.exists(failingFs.failedWritePath as string)).toBe(false);
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

  it('installs nested governed knowledge for a Copilot user target and tracks virtual bytes', async () => {
    await writeReleaseArchive(bundleDir, createGovernedReleaseArchive({ id: 'local-foo', includeKnowledge: true }));

    const result = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json'
    ]);

    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ lockfile: string }>(result.stdout);
    const relativePath = 'specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md';
    await expect(readFile(path.join(targetDir, 'knowledge', relativePath), 'utf8')).resolves.toContain('SBB B2P');
    const lockfile = JSON.parse(await readFile(envelope.data.lockfile, 'utf8')) as {
      bundles: Record<string, { files: { path: string; checksum: string }[] }>;
    };
    expect(lockfile.bundles['local-foo'].files.map((file) => file.path)).toContain(`knowledge/${relativePath}`);
  });

  it('installs and tracks distinct knowledge paths with the same basename', async () => {
    await writeReleaseArchive(bundleDir, createGovernedReleaseArchive({ id: 'local-foo', includeKnowledgePair: true }));

    const result = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json'
    ]);

    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ lockfile: string }>(result.stdout);
    const first = 'specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md';
    const second = 'specifications/alternate/SBB_B2P.md';
    await expect(readFile(path.join(targetDir, 'knowledge', first), 'utf8')).resolves.toContain('SBB B2P');
    await expect(readFile(path.join(targetDir, 'knowledge', second), 'utf8')).resolves.toContain('Alternate SBB B2P');
    const lockfile = JSON.parse(await readFile(envelope.data.lockfile, 'utf8')) as {
      bundles: Record<string, { files: { path: string }[] }>;
    };
    expect(lockfile.bundles['local-foo'].files.map((file) => file.path)).toContain(`knowledge/${first}`);
    expect(lockfile.bundles['local-foo'].files.map((file) => file.path)).toContain(`knowledge/${second}`);
  });

  it('installs legacy manifest-declared knowledge without flattening its source path', async () => {
    await writeReleaseArchive(bundleDir, createLegacyReleaseArchive({ id: 'local-foo', includeKnowledge: true }));

    const result = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json'
    ]);

    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ lockfile: string }>(result.stdout);
    const relativePath = 'specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md';
    await expect(readFile(path.join(targetDir, 'knowledge', relativePath), 'utf8')).resolves.toContain('SBB B2P');
    const lockfile = JSON.parse(await readFile(envelope.data.lockfile, 'utf8')) as {
      bundles: Record<string, { files: { path: string }[] }>;
    };
    expect(lockfile.bundles['local-foo'].files.map((file) => file.path)).toContain(`knowledge/${relativePath}`);
  });

  it('fails before writing when a legacy knowledge declaration has a traversal path', async () => {
    await writeReleaseArchive(bundleDir, new Map([
      ['deployment-manifest.yml', new TextEncoder().encode(
        'id: local-foo\nversion: 1.0.0\nname: Legacy\nprompts:\n'
        + '  - id: bad\n    file: ../outside.md\n    type: knowledge\n'
      )]
    ]));

    const result = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json'
    ]);

    expect(result.exitCode).not.toBe(0);
    await expect(readFile(path.join(targetDir, 'knowledge', 'outside.md'), 'utf8')).rejects.toThrow();
    const userLockfile = resolveUserConfigPaths({
      HOME: workspace,
      USERPROFILE: workspace,
      XDG_CONFIG_HOME: path.join(workspace, 'xdg-config')
    }).userLockfile;
    await expect(readFile(userLockfile, 'utf8')).rejects.toThrow();
  });

  it('installs knowledge for a Kiro user target', async () => {
    await writeReleaseArchive(bundleDir, createGovernedReleaseArchive({ id: 'local-foo', includeKnowledge: true }));
    const targetResult = await run([
      'target', 'add', 'kiro-user', '--type', 'kiro', '--path', targetDir, '-o', 'json'
    ]);
    expect(targetResult.exitCode).toBe(0);

    const result = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'kiro-user', '-o', 'json'
    ]);

    expect(result.exitCode).toBe(0);
    const relativePath = 'specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md';
    await expect(readFile(path.join(targetDir, 'knowledge', relativePath), 'utf8')).resolves.toContain('SBB B2P');
  });

  it('records the physical knowledge destination for Copilot repository scope', async () => {
    await writeReleaseArchive(bundleDir, createGovernedReleaseArchive({ id: 'local-foo', includeKnowledge: true }));

    const result = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot',
      '--scope', 'repository', '--commit-mode', 'local-only', '-o', 'json'
    ]);

    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ lockfile: string }>(result.stdout);
    const relativePath = 'specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md';
    await expect(readFile(path.join(workspace, '.github', 'knowledge', relativePath), 'utf8'))
      .resolves.toContain('SBB B2P');
    const lockfile = JSON.parse(await readFile(envelope.data.lockfile, 'utf8')) as {
      bundles: Record<string, { files: { path: string }[] }>;
    };
    expect(lockfile.bundles['local-foo'].files.map((file) => file.path)).toContain(`.github/knowledge/${relativePath}`);
  });

  it('records Kiro repository knowledge under its physical repository-relative path', async () => {
    await writeReleaseArchive(bundleDir, createGovernedReleaseArchive({ id: 'local-foo', includeKnowledge: true }));
    const targetResult = await run([
      'target', 'add', 'kiro-repository', '--type', 'kiro', '--scope', 'repository',
      '--workspace-root', workspace, '-o', 'json'
    ]);
    expect(targetResult.exitCode).toBe(0);

    const result = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'kiro-repository', '-o', 'json'
    ]);

    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ lockfile: string }>(result.stdout);
    const relativePath = 'specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md';
    await expect(readFile(path.join(workspace, '.kiro', 'knowledge', relativePath), 'utf8'))
      .resolves.toContain('SBB B2P');
    const lockfile = JSON.parse(await readFile(envelope.data.lockfile, 'utf8')) as {
      bundles: Record<string, { files: { path: string }[] }>;
    };
    expect(lockfile.bundles['local-foo'].files.map((file) => file.path)).toContain(`.kiro/knowledge/${relativePath}`);
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
    await writeReleaseArchive(bundleDir, createGovernedReleaseArchive({ id: 'local-foo', includeKnowledge: true }));
    const firstInstall = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json'
    ]);
    expect(firstInstall.exitCode).toBe(0);
    const firstEnvelope = parseJson<{ lockfile: string }>(firstInstall.stdout);

    await rm(path.join(targetDir, 'prompts', 'hello.prompt.md'));
    await rm(path.join(targetDir, 'knowledge', 'specifications', 'RDP', 'provider_layer', 'SBB_B2P', 'SBB_B2P.md'));
    const replay = await run([
      'install', '--lockfile', firstEnvelope.data.lockfile, '--target', 'copilot', '-o', 'json'
    ]);

    expect(replay.exitCode).toBe(0);
    const replayEnvelope = parseJson<{ replayed: string[]; failures: unknown[] }>(replay.stdout);
    expect(replayEnvelope.data.replayed).toEqual(['local-foo']);
    expect(replayEnvelope.data.failures).toEqual([]);
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
  });

  it('dry-run: reports source knowledge paths but writes nothing', async () => {
    await writeReleaseArchive(bundleDir, createGovernedReleaseArchive({ id: 'local-foo', includeKnowledge: true }));
    const result = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '--dry-run', '-o', 'json'
    ]);
    expect(result.exitCode).toBe(0);
    const envelope = parseJson<{ dryRun: boolean; bundle: { id: string }; files: string[] }>(result.stdout);
    expect(envelope.data.dryRun).toBe(true);
    expect(envelope.data.bundle.id).toBe('local-foo');
    expect(envelope.data.files).toContain('specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md');
    expect(envelope.data.files).not.toContain('knowledge/specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md');

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
    const result = await run([
      'install', 'local-foo', '--from', bundleDir, '--target', 'copilot',
      '--scope', 'repository', '--commit-mode', 'local-only', '-o', 'json'
    ]);
    expect(result.exitCode).toBe(0);

    const envelope = parseJson<{ lockfile: string }>(result.stdout);
    expect(envelope.data.lockfile).toBe(path.join(workspace, 'prompt-registry.local.lock.json'));
    await expect(
      readFile(path.join(workspace, '.github', 'copilot', 'prompts', 'hello.prompt.md'), 'utf8')
    ).resolves.toContain('Hello Prompt');
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

  it('uses the repository-scope writer for remote installs', async () => {
    const zipBytes = buildZip([
      {
        path: 'deployment-manifest.yml',
        bytes: new TextEncoder().encode(
          'id: remote-foo\nversion: 1.0.0\nname: Remote Foo\nprompts:\n'
          + '  - id: hello\n    file: prompts/hello.prompt.md\n    type: prompt\n'
          + '  - id: guide\n    file: specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md\n    type: knowledge\n'
        )
      },
      {
        path: 'prompts/hello.prompt.md',
        bytes: new TextEncoder().encode('# Hello from a remote bundle\n')
      },
      {
        path: 'specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md',
        bytes: new TextEncoder().encode('# Remote knowledge\n')
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
      readFile(path.join(workspace, '.github', 'copilot', 'prompts', 'hello.prompt.md'), 'utf8')
    ).resolves.toContain('Hello from a remote bundle');
    const relativeKnowledgePath = 'specifications/RDP/provider_layer/SBB_B2P/SBB_B2P.md';
    await expect(readFile(path.join(workspace, '.github', 'knowledge', relativeKnowledgePath), 'utf8'))
      .resolves.toContain('Remote knowledge');
    const lockfile = JSON.parse(await readFile(path.join(workspace, 'prompt-registry.lock.json'), 'utf8')) as {
      bundles: Record<string, { files: { path: string }[] }>;
    };
    expect(lockfile.bundles['remote-foo'].files.map((file) => file.path))
      .toContain(`.github/knowledge/${relativeKnowledgePath}`);
    await expect(
      readFile(path.join(workspace, '.github', 'prompts', 'hello.prompt.md'), 'utf8')
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
      readFile(path.join(workspace, '.github', 'copilot', 'prompts', 'hello.prompt.md'), 'utf8')
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
      readFile(path.join(workspace, '.github', 'copilot', 'prompts', 'hello.prompt.md'), 'utf8')
    ).resolves.toContain('preflighted bundle');
  });
});
