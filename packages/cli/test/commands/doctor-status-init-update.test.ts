/**
 * `doctor`, `doctor diagnostics`, `status`, `init`, and `update`
 * command tests.
 *
 * Uses a real `NodeFileSystem` against a real temp directory (not
 * `createTestContext`'s default in-memory `fs` stub, which rejects
 * every call) since these commands do real file IO. Network-touching
 * paths (`doctor`'s github-api check, `update`'s remote-source
 * resolution) are avoided via `AI_PRIMITIVES_HUB_SKIP_NETWORK=1` and by
 * only exercising local-source lockfiles, matching the established
 * approach in install.test.ts/uninstall.test.ts.
 */
import {
  realpathSync,
} from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  HttpClient,
  HttpRequest,
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
  DoctorCommand,
  DoctorDiagnosticsCommand,
} from '../../src/commands/doctor';
import {
  InitCommand,
} from '../../src/commands/init';
import {
  InstallCommand,
} from '../../src/commands/install';
import {
  SourceAddCommand,
} from '../../src/commands/source';
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
  UpdateCommand,
} from '../../src/commands/update';
import {
  createTestContext,
  runCli,
  runCommand,
} from '../../src/framework';

const COMMAND_CLASSES = [
  DoctorCommand,
  DoctorDiagnosticsCommand,
  StatusCommand,
  InitCommand,
  UpdateCommand,
  TargetAddCommand,
  InstallCommand
];

interface JsonEnvelope<T> {
  status: string;
  data: T;
}

describe('doctor/status/init/update commands', () => {
  let workspace: string;

  const run = (argv: string[]): ReturnType<typeof runCommand> => runCommand(argv, {
    commandClasses: COMMAND_CLASSES,
    context: {
      cwd: workspace,
      fs: new NodeFileSystem(),
      env: {
        HOME: workspace,
        USERPROFILE: workspace,
        XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
        XDG_CACHE_HOME: path.join(workspace, 'xdg-cache'),
        AI_PRIMITIVES_HUB_SKIP_NETWORK: '1'
      }
    }
  });

  const parseJson = <T>(stdout: string): JsonEnvelope<T> => JSON.parse(stdout) as JsonEnvelope<T>;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-doctor-test-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  describe('doctor', () => {
    it('runs every check and exits 0 with zero failures', async () => {
      const result = await run(['doctor', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ checks: { name: string; status: string; detail?: string }[]; summary: { ok: number; warn: number; fail: number } }>(result.stdout);
      expect(envelope.data.checks.length).toBe(11);
      expect(envelope.data.summary.fail).toBe(0);
      expect(envelope.data.checks).toContainEqual(expect.objectContaining({
        name: 'github-cli',
        status: 'warn'
      }));
      expect(envelope.data.checks).toContainEqual(expect.objectContaining({
        name: 'project-config',
        status: 'warn',
        detail: expect.stringContaining('--scope repository')
      }));
      const projectConfigCheck = envelope.data.checks.find(({ name }) => name === 'project-config');
      expect(projectConfigCheck?.detail).toContain('need one. For repository installs');
    });

    it('-v includes per-check logs', async () => {
      const result = await run(['doctor', '-v', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ checks: { logs?: unknown[] }[] }>(result.stdout);
      expect(envelope.data.checks.some((c) => (c.logs?.length ?? 0) > 0)).toBe(true);
    });
  });

  describe('doctor diagnostics', () => {
    it('runs the full self-contained smoke test successfully', async () => {
      const result = await run(['doctor', 'diagnostics', '-o', 'json']);
      const envelope = parseJson<{
        ok: boolean;
        workspace: string;
        workspaceRetained: boolean;
        steps: { name: string; exitCode: number }[];
      }>(result.stdout);
      const failed = envelope.data.steps.filter((s) => s.exitCode !== 0);
      const stepNames = envelope.data.steps.map((step) => step.name);
      expect(failed).toEqual([]);
      expect(envelope.data.ok).toBe(true);
      expect(envelope.data.workspaceRetained).toBe(false);
      expect(stepNames).toEqual(expect.arrayContaining([
        'index-bench',
        'index-report',
        'build-governed-bundle',
        'verify-governed-archive',
        'materialize-governed-bundle',
        'install-governed-bundle',
        'verify-governed-install',
        'uninstall-governed-bundle',
        'verify-governed-removed',
        'collection-affected',
        'version-compute',
        'config-list',
        'target-remove',
        'hub-remove'
      ]));
      await expect(access(envelope.data.workspace)).rejects.toThrow();
      expect(result.exitCode).toBe(0);
    }, 60_000);

    it('retains the diagnostic workspace when explicitly requested', async () => {
      const result = await run(['doctor', 'diagnostics', '--retain-workspace', '-o', 'json']);
      const envelope = parseJson<{
        ok: boolean;
        workspace: string;
        workspaceRetained: boolean;
        steps: {
          name: string;
          exitCode: number;
          output?: { formatVersion?: number; inventoryCount?: number };
        }[];
      }>(result.stdout);

      try {
        expect(result.exitCode).toBe(0);
        expect(envelope.data.ok).toBe(true);
        expect(envelope.data.workspaceRetained).toBe(true);
        await expect(access(envelope.data.workspace)).resolves.toBeUndefined();
        await expect(access(path.join(
          envelope.data.workspace,
          'collections',
          'governed.collection.yml'
        ))).resolves.toBeUndefined();
        await expect(access(path.join(
          envelope.data.workspace,
          'governed-dist',
          'governed-foo',
          'governed-foo.bundle.zip'
        ))).resolves.toBeUndefined();
        await expect(access(path.join(envelope.data.workspace, '.git', 'HEAD'))).resolves.toBeUndefined();

        const archiveStep = envelope.data.steps.find((step) => step.name === 'verify-governed-archive');
        expect(archiveStep?.exitCode).toBe(0);
        expect(archiveStep?.output).toMatchObject({
          formatVersion: 1
        });
        expect(archiveStep?.output?.inventoryCount).toBeGreaterThan(0);
      } finally {
        await rm(envelope.data.workspace, { recursive: true, force: true });
      }
    }, 60_000);
  });

  describe('status', () => {
    it('reports empty state for a fresh workspace', async () => {
      const result = await run(['status', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{
        configPath: string | null;
        targets: unknown[];
        activeHubId: string | null;
        index: unknown;
        lockfile: unknown;
      }>(result.stdout);
      expect(envelope.data).toMatchObject({
        configPath: null,
        targets: [],
        activeHubId: null,
        index: null,
        lockfile: null
      });
    });

    it('reflects a configured target + installed bundle', async () => {
      const bundleDir = path.join(workspace, 'bundle');
      const targetDir = path.join(workspace, 'target');
      await mkdir(path.join(bundleDir, 'prompts'), { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await writeFile(
        path.join(bundleDir, 'deployment-manifest.yml'),
        'id: local-foo\nversion: 1.0.0\nname: Local Foo\nitems:\n  - path: prompts/hello.prompt.md\n    kind: prompt\n'
      );
      await writeFile(path.join(bundleDir, 'prompts', 'hello.prompt.md'), '# Hello Prompt\n');

      await run(['target', 'add', 'copilot', '--type', 'copilot-cli', '--path', targetDir, '-o', 'json']);
      await run(['install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json']);

      const result = await run(['status', '--verbose', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{
        targets: { name: string; type: string }[];
        lockfile: { entries: number; bundles?: { bundleId: string }[] } | null;
      }>(result.stdout);
      expect(envelope.data.targets).toContainEqual(expect.objectContaining({ name: 'copilot', type: 'copilot-cli' }));
      expect(envelope.data.lockfile?.entries).toBe(1);
      expect(envelope.data.lockfile?.bundles?.map((b) => b.bundleId)).toContain('local-foo');
    });
  });

  describe('init', () => {
    const writeLocalHubConfig = async (hubConfigFile: string): Promise<void> => {
      const hubSourceDir = path.join(path.dirname(hubConfigFile), 'hub-source');
      await mkdir(hubSourceDir, { recursive: true });
      await writeFile(
        hubConfigFile,
        `version: 1.0.0
metadata:
  name: Test Hub
  description: Test hub
  maintainer: test
  updatedAt: '2026-01-01T00:00:00Z'
sources:
  - id: local-foo-src
    name: Local Foo Source
    type: local
    url: ${hubSourceDir}
    enabled: true
    priority: 0
    hubId: test-hub
profiles: []
`
      );
    };

    it('creates a target non-interactively', async () => {
      const result = await run(['init', '--target-name', 'copilot', '--target-type', 'copilot-cli', '--yes', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ target: { name: string; type: string; created: boolean } }>(result.stdout);
      expect(envelope.data.target).toMatchObject({ name: 'copilot', type: 'copilot-cli', created: true });
    });

    it('is idempotent: re-running with the same target reports created: false', async () => {
      await run(['init', '--target-name', 'copilot', '--target-type', 'copilot-cli', '--yes', '-o', 'json']);
      const result = await run(['init', '--target-name', 'copilot', '--target-type', 'copilot-cli', '--yes', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ target: { created: boolean } }>(result.stdout);
      expect(envelope.data.target.created).toBe(false);
    });

    it('makes the default user-scoped target visible to doctor', async () => {
      const initResult = await run([
        'init', '--target-name', 'copilot', '--target-type', 'copilot-cli', '--yes', '--skip-index', '-o', 'json'
      ]);
      expect(initResult.exitCode).toBe(0);

      const doctorResult = await run(['doctor', '-o', 'json']);
      expect(doctorResult.exitCode).toBe(0);
      const doctor = parseJson<{
        checks: { name: string; status: string; detail: string }[];
      }>(doctorResult.stdout);
      expect(doctor.data.checks).toContainEqual(expect.objectContaining({
        name: 'project-config',
        status: 'ok',
        detail: expect.stringContaining('from user config')
      }));
      expect(doctor.data.checks).toContainEqual(expect.objectContaining({
        name: 'install-targets',
        status: 'ok',
        detail: expect.stringContaining('copilot')
      }));
    });

    it('fails with exit 1 for an unknown --target-type', async () => {
      const result = await run(['init', '--target-type', 'totally-bogus', '--yes', '-o', 'json']);
      expect(result.exitCode).toBe(1);
    });

    it('imports and syncs a local hub when --hub/--hub-type local are given', async () => {
      const hubConfigFile = path.join(workspace, 'hub-config.yml');
      await writeLocalHubConfig(hubConfigFile);
      const result = await run([
        'init', '--target-name', 'copilot', '--target-type', 'copilot-cli',
        '--hub', hubConfigFile, '--hub-type', 'local', '--yes', '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ hub: { id: string } | null }>(result.stdout);
      expect(envelope.data.hub).not.toBeNull();
    });

    it('reuses and activates the same hub on repeated initialization', async () => {
      const hubConfigFile = path.join(workspace, 'hub-config.yml');
      await writeLocalHubConfig(hubConfigFile);

      const firstResult = await run([
        'init', '--target-name', 'copilot', '--target-type', 'copilot-cli',
        '--hub', hubConfigFile, '--hub-type', 'local', '--yes', '--skip-index', '-o', 'json'
      ]);
      expect(firstResult.exitCode).toBe(0);
      const first = parseJson<{ hub: { id: string } | null }>(firstResult.stdout);
      const hubId = first.data.hub?.id;
      expect(hubId).toBeDefined();

      const secondResult = await run([
        'init', '--target-name', 'copilot', '--target-type', 'copilot-cli',
        '--hub', hubConfigFile, '--hub-type', 'local', '--yes', '--skip-index', '-o', 'json'
      ]);
      expect(secondResult.exitCode).toBe(0);
      const second = parseJson<{ hub: { id: string } | null }>(secondResult.stdout);
      expect(second.data.hub?.id).toBe(hubId);

      const statusResult = await run(['status', '-o', 'json']);
      expect(statusResult.exitCode).toBe(0);
      const status = parseJson<{
        activeHubId: string | null;
        hubs: string[];
        targets: { name: string }[];
      }>(statusResult.stdout);
      expect(status.data.activeHubId).toBe(hubId);
      expect(status.data.hubs).toEqual([hubId]);
      expect(status.data.targets).toContainEqual(expect.objectContaining({ name: 'copilot' }));
    });

    it('builds an embedded index by default after importing a hub', async () => {
      const hubConfigFile = path.join(workspace, 'hub-config.yml');
      const outFile = path.join(workspace, 'xdg-cache', 'ai-primitives-hub', 'primitive-index.json');
      await writeLocalHubConfig(hubConfigFile);
      const result = await run([
        'init', '--target-name', 'copilot', '--target-type', 'copilot-cli',
        '--hub', hubConfigFile, '--hub-type', 'local', '--yes', '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ steps: string[] }>(result.stdout);
      expect(envelope.data.steps.some((s) => s.startsWith('index built:'))).toBe(true);
      expect(envelope.data.steps.some((s) => s.includes('embeddings: ternlight-mini'))).toBe(true);
      await access(outFile);
    });

    it('honours --skip-index and --no-embed flags', async () => {
      const hubConfigFile = path.join(workspace, 'hub-config.yml');
      const outFile = path.join(workspace, 'xdg-cache', 'ai-primitives-hub', 'primitive-index.json');
      await writeLocalHubConfig(hubConfigFile);
      const result = await run([
        'init', '--target-name', 'copilot', '--target-type', 'copilot-cli',
        '--hub', hubConfigFile, '--hub-type', 'local', '--yes', '--skip-index', '-o', 'json'
      ]);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ steps: string[] }>(result.stdout);
      expect(envelope.data.steps.some((s) => s.startsWith('index built:'))).toBe(false);
      await expect(access(outFile)).rejects.toThrow();

      const noEmbedResult = await run([
        'init', '--target-name', 'copilot', '--target-type', 'copilot-cli',
        '--hub', hubConfigFile, '--hub-type', 'local', '--yes', '--no-embed', '-o', 'json'
      ]);
      expect(noEmbedResult.exitCode).toBe(0);
      const noEmbedEnvelope = parseJson<{ steps: string[] }>(noEmbedResult.stdout);
      const indexStep = noEmbedEnvelope.data.steps.find((s) => s.startsWith('index built:'));
      expect(indexStep).toBeDefined();
      expect(indexStep).not.toContain('embeddings');
    });
  });

  describe('update', () => {
    it('fails with exit 1 when no lockfile is found', async () => {
      await run(['target', 'add', 'copilot', '--type', 'copilot-cli', '--path', path.join(workspace, 'target'), '-o', 'json']);
      const result = await run(['update', '-o', 'json']);
      expect(result.exitCode).toBe(1);
    });

    it('reports up to date for a lockfile with only local-source bundles (no network needed)', async () => {
      const bundleDir = path.join(workspace, 'bundle');
      const targetDir = path.join(workspace, 'target');
      await mkdir(path.join(bundleDir, 'prompts'), { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await writeFile(
        path.join(bundleDir, 'deployment-manifest.yml'),
        'id: local-foo\nversion: 1.0.0\nname: Local Foo\nitems:\n  - path: prompts/hello.prompt.md\n    kind: prompt\n'
      );
      await writeFile(path.join(bundleDir, 'prompts', 'hello.prompt.md'), '# Hello Prompt\n');
      await run(['target', 'add', 'copilot', '--type', 'copilot-cli', '--path', targetDir, '-o', 'json']);
      await run(['install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json']);

      const result = await run(['update', '--target', 'copilot', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ checked: number; updated: number }>(result.stdout);
      expect(envelope.data).toMatchObject({ checked: 1, updated: 0 });
    });

    it('--dry-run reports the same up-to-date result without applying anything', async () => {
      const bundleDir = path.join(workspace, 'bundle');
      const targetDir = path.join(workspace, 'target');
      await mkdir(path.join(bundleDir, 'prompts'), { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await writeFile(
        path.join(bundleDir, 'deployment-manifest.yml'),
        'id: local-foo\nversion: 1.0.0\nname: Local Foo\nitems:\n  - path: prompts/hello.prompt.md\n    kind: prompt\n'
      );
      await writeFile(path.join(bundleDir, 'prompts', 'hello.prompt.md'), '# Hello Prompt\n');
      await run(['target', 'add', 'copilot', '--type', 'copilot-cli', '--path', targetDir, '-o', 'json']);
      await run(['install', 'local-foo', '--from', bundleDir, '--target', 'copilot', '-o', 'json']);

      const result = await run(['update', '--target', 'copilot', '--dry-run', '-o', 'json']);
      expect(result.exitCode).toBe(0);
      const envelope = parseJson<{ dryRun: boolean; updated: number }>(result.stdout);
      expect(envelope.data).toMatchObject({ dryRun: true, updated: 0 });
    });
  });

  describe('update on the repository install record (format 3.0.0)', () => {
    const ART_ROOT = 'https://artifactory.example/repo/source';
    const recordPath = (): string => path.join(workspace, 'ai-primitives-hub.lock.json');
    const bundleDir = (): string => path.join(workspace, 'bundle');
    const requests: HttpRequest[] = [];
    const envReads = new Set<string>();

    /**
     * Bundle files of `local-foo`; version 1.0.0 also ships `extra.prompt.md`.
     * @param version
     */
    const bundleFiles = (version: string): Map<string, string> => new Map([
      ['deployment-manifest.yml', [
        'id: local-foo', `version: ${version}`, 'name: Local Foo', 'prompts:',
        '  - id: hello', '    file: prompts/hello.prompt.md', '    type: prompt',
        ...(version === '1.0.0' ? ['  - id: extra', '    file: prompts/extra.prompt.md', '    type: prompt'] : [])
      ].join('\n') + '\n'],
      ['prompts/hello.prompt.md', `# Hello ${version}\n`],
      ...(version === '1.0.0' ? [['prompts/extra.prompt.md', '# Extra\n'] as [string, string]] : [])
    ]);
    const v2Zip = buildZip([...bundleFiles('2.0.0')].map(([filePath, text]) => ({ path: filePath, bytes: new TextEncoder().encode(text) })));
    const json = (request: HttpRequest, body: unknown) =>
      ({ statusCode: 200, body: new TextEncoder().encode(JSON.stringify(body)), finalUrl: request.url, headers: {} });

    /** HTTP boundary: a GitHub release and an Artifactory index serving `local-foo` 2.0.0. */
    const http: HttpClient = {
      fetch: async (request) => {
        requests.push(request);
        if (request.url === 'https://api.github.com/repos/acme-org/local-foo/releases') {
          return json(request, [{ tag_name: 'local-foo-v2.0.0', assets: [{ name: 'bundle.zip', url: 'https://api.github.com/assets/local-foo' }] }]);
        }
        if (request.url === 'https://api.github.com/assets/local-foo') {
          return { statusCode: 200, body: v2Zip, finalUrl: request.url, headers: {} };
        }
        if (request.url === `${ART_ROOT}/index-v1.json`) {
          return json(request, {
            formatVersion: 1, source: { id: 'art', name: 'Art', updatedAt: '2026-01-01T00:00:00Z' },
            bundles: [{
              id: 'local-foo', version: '2.0.0', name: 'Local Foo', description: '', author: 'Test', environments: ['vscode'],
              tags: [], dependencies: [], license: 'Apache-2.0', lastUpdated: '2026-01-01T00:00:00Z',
              manifest: { path: '2.0.0/local-foo/deployment-manifest.yml', size: 1, sha256: 'a'.repeat(64) },
              archive: { path: '2.0.0/local-foo.zip', size: v2Zip.length, sha256: 'b'.repeat(64), mediaType: 'application/zip' }
            }]
          });
        }
        throw new Error(`Unexpected request: ${request.url}`);
      }
    };

    /**
     * Run a command; `ctx.env` records every key read, so a test can prove a variable was never read.
     * @param argv Command line.
     */
    const runRecord = async (argv: string[]): Promise<{ exitCode: number; stdout: string }> => {
      const base = createTestContext({
        cwd: workspace,
        fs: new NodeFileSystem(),
        env: {
          HOME: workspace,
          USERPROFILE: workspace,
          XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
          XDG_CACHE_HOME: path.join(workspace, 'xdg-cache'),
          ARTIFACTORY_TOKEN: 'reader-token'
        }
      });
      const env = new Proxy(base.env, {
        get: (target, key, receiver) => {
          if (typeof key === 'string') {
            envReads.add(key);
          }
          return Reflect.get(target, key, receiver) as unknown;
        }
      });
      const ctx = { ...base, env };
      const exitCode = await runCli(argv, {
        ctx,
        http,
        tokens: { getToken: async () => undefined },
        commandClasses: [TargetAddCommand, TargetRemoveCommand, InstallCommand, UpdateCommand, SourceAddCommand],
        commands: [],
        name: 'test',
        version: 'test'
      });
      return { exitCode, stdout: base.stdout.captured() };
    };

    interface RecordJson {
      bundles: Record<string, { tools: Record<string, { version: string; sourceId: string; sourceType: string; files: { path: string }[] }> }>;
      sources: Record<string, Record<string, string>>;
    }
    interface UpdateData {
      level: string;
      records: string[];
      updates: { bundleId: string; tool: string; from: string; to: string }[];
      alsoUpdated: { bundleId: string; tool: string }[];
      skipped: { bundleId: string; tool: string; reason: string }[];
    }
    const readRecord = async (): Promise<RecordJson> => JSON.parse(await readFile(recordPath(), 'utf8')) as RecordJson;
    const versions = async (): Promise<Record<string, string>> =>
      Object.fromEntries(Object.entries((await readRecord()).bundles['local-foo'].tools).map(([tool, entry]) => [tool, entry.version]));
    const promptFile = (name: string): string => path.join(workspace, '.github', 'prompts', name);

    /**
     * Add repository targets, install `local-foo` 1.0.0 from a local folder
     * with each (in order), then point every record entry at `source`.
     * @param targets Target name and type pairs, in install order.
     * @param source Recorded source the entries now come from.
     */
    const installAt100 = async (targets: [string, string][], source: Record<string, string>): Promise<void> => {
      for (const [filePath, text] of bundleFiles('1.0.0')) {
        await mkdir(path.dirname(path.join(bundleDir(), filePath)), { recursive: true });
        await writeFile(path.join(bundleDir(), filePath), text);
      }
      for (const [name, type] of targets) {
        expect((await runRecord(['target', 'add', name, '--type', type, '--scope', 'repository', '--workspace-root', workspace, '-o', 'json'])).exitCode).toBe(0);
      }
      for (const [name] of targets) {
        const installed = await runRecord(['install', 'local-foo', '--from', bundleDir(), '--target', name, '-o', 'json']);
        expect(installed.exitCode, installed.stdout).toBe(0);
      }
      const record = await readRecord();
      record.sources = { remote: source };
      for (const entry of Object.values(record.bundles['local-foo'].tools)) {
        entry.sourceId = 'remote';
        entry.sourceType = source.type;
      }
      await writeFile(recordPath(), JSON.stringify(record, null, 2) + '\n');
    };
    const GITHUB_SOURCE = { type: 'github', url: 'https://github.com/acme-org/local-foo' };

    beforeEach(async () => {
      workspace = realpathSync.native(workspace);
      requests.length = 0;
      envReads.clear();
      await mkdir(path.join(workspace, '.git'), { recursive: true });
      await writeFile(path.join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    });

    it.each([
      ['vscode then kiro', [['repo-vscode', 'vscode'], ['repo-kiro', 'kiro']]],
      ['kiro then vscode', [['repo-kiro', 'kiro'], ['repo-vscode', 'vscode']]]
    ] as [string, [string, string][]][])('updates every tool at the level with an inferred target (%s), one key per tool', async (_order, targets) => {
      await installAt100(targets, GITHUB_SOURCE);

      const result = await runRecord(['update', '--no-hub-sync', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(0);
      const { data } = parseJson<UpdateData>(result.stdout);
      expect(data).toMatchObject({ level: 'repository', records: [recordPath()], alsoUpdated: [], skipped: [] });
      expect(data.updates).toEqual([
        { bundleId: 'local-foo', tool: 'kiro', from: '1.0.0', to: '2.0.0' },
        { bundleId: 'local-foo', tool: 'vscode', from: '1.0.0', to: '2.0.0' }
      ]);
      const record = await readRecord();
      expect(Object.keys(record.bundles)).toEqual(['local-foo']);
      expect(await versions()).toEqual({ kiro: '2.0.0', vscode: '2.0.0' });
      expect(await readFile(promptFile('hello.prompt.md'), 'utf8')).toBe('# Hello 2.0.0\n');
    });

    it('--target narrows the update to that tool and prints the Record line', async () => {
      await installAt100([['repo-vscode', 'vscode'], ['repo-kiro', 'kiro']], GITHUB_SOURCE);

      const result = await runRecord(['update', '--target', 'repo-kiro', '--no-hub-sync']);

      expect(result.exitCode, result.stdout).toBe(0);
      expect(result.stdout).toContain('local-foo (kiro): 1.0.0 → 2.0.0');
      expect(result.stdout).not.toContain('(vscode)');
      expect(result.stdout).toContain(`Record: repository ${recordPath()}\n`);
      expect(await versions()).toEqual({ kiro: '2.0.0', vscode: '1.0.0' });
    });

    // copilot-cli targets are user-scope only, so vscode-insiders is the repository
    // tool that shares `.github` files with vscode here.
    it('updates a sibling sharing .github files with its own writer and reports it in alsoUpdated', async () => {
      await installAt100([['repo-vscode', 'vscode'], ['repo-insiders', 'vscode-insiders']], GITHUB_SOURCE);

      const result = await runRecord(['update', '--no-hub-sync', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(0);
      const { status, data } = parseJson<UpdateData>(result.stdout);
      expect(status).toBe('ok');
      expect(data.updates).toEqual([{ bundleId: 'local-foo', tool: 'vscode', from: '1.0.0', to: '2.0.0' }]);
      expect(data.alsoUpdated).toEqual([{ bundleId: 'local-foo', tool: 'vscode-insiders' }]);
      expect(await versions()).toEqual({ vscode: '2.0.0', 'vscode-insiders': '2.0.0' });
      await expect(readFile(promptFile('extra.prompt.md'), 'utf8')).rejects.toThrow();
    });

    it('reports a sibling with no target as out of date and keeps the file it still lists', async () => {
      await installAt100([['repo-insiders', 'vscode-insiders'], ['repo-vscode', 'vscode']], GITHUB_SOURCE);
      expect((await runRecord(['target', 'remove', 'repo-insiders', '-o', 'json'])).exitCode).toBe(0);

      const result = await runRecord(['update', '--no-hub-sync', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(0);
      const { status, data } = parseJson<UpdateData>(result.stdout);
      expect(status).toBe('warning');
      expect(data.updates.map((entry) => entry.tool)).toEqual(['vscode']);
      expect(data.alsoUpdated).toEqual([]);
      expect(data.skipped).toEqual([{ bundleId: 'local-foo', tool: 'vscode-insiders', reason: expect.stringContaining('out of date (still 1.0.0)') }]);
      expect(await versions()).toEqual({ vscode: '2.0.0', 'vscode-insiders': '1.0.0' });
      expect(await readFile(promptFile('extra.prompt.md'), 'utf8')).toBe('# Extra\n');
    });

    it('--dry-run looks the version up from the configured source only and never reads the record\'s credentialRef', async () => {
      await installAt100([['repo-vscode', 'vscode']], { type: 'artifactory', url: 'https://evil.example/repo', authMode: 'bearer', credentialRef: 'RECORD_SECRET' });
      const record = await readFile(recordPath(), 'utf8');
      expect((await runRecord([
        'source', 'add', '--type', 'artifactory', '--url', ART_ROOT, '--id', 'remote', '--auth', 'bearer', '--credential-ref', 'ARTIFACTORY_TOKEN', '-o', 'json'
      ])).exitCode).toBe(0);
      envReads.clear();

      const result = await runRecord(['update', '--dry-run', '--no-hub-sync', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(0);
      expect(parseJson<UpdateData>(result.stdout).data.updates).toEqual([{ bundleId: 'local-foo', tool: 'vscode', from: '1.0.0', to: '2.0.0' }]);
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((request) => request.url.startsWith(ART_ROOT) && request.headers?.Authorization === 'Bearer reader-token')).toBe(true);
      expect(envReads.has('RECORD_SECRET')).toBe(false);
      expect(await readFile(recordPath(), 'utf8')).toBe(record);
    });

    it('a user-scope update leaves the repository record byte-identical', async () => {
      await installAt100([['repo-vscode', 'vscode']], GITHUB_SOURCE);
      const record = await readFile(recordPath(), 'utf8');
      expect((await runRecord(['target', 'add', 'copilot', '--type', 'copilot-cli', '--path', path.join(workspace, 'target'), '-o', 'json'])).exitCode).toBe(0);
      expect((await runRecord(['install', 'local-foo', '--from', bundleDir(), '--target', 'copilot', '-o', 'json'])).exitCode).toBe(0);

      const result = await runRecord(['update', '--target', 'copilot', '--no-hub-sync', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(0);
      expect(await readFile(recordPath(), 'utf8')).toBe(record);
    });
  });
});
