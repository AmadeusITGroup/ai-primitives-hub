/**
 * `install --skip-unsupported`: a partial install the user opts into.
 *
 * Without the flag a bundle the target cannot fully hold is rejected and
 * nothing is written (unchanged). With it, the supported items install,
 * the rest are listed in the output, the lockfile records only what was
 * installed, and uninstall removes exactly that.
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
  type Lockfile,
  resolveUserConfigPaths,
} from '@ai-primitives-hub/app';
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
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
  InstallCommand,
} from '../../src/commands/install';
import {
  TargetAddCommand,
} from '../../src/commands/target-add';
import {
  UninstallCommand,
} from '../../src/commands/uninstall';
import {
  createTestContext,
  runCli,
  runCommand,
} from '../../src/framework';

const MIXED_FILES: Record<string, string> = {
  'deployment-manifest.yml': `id: sample-mixed
version: 1.0.0
name: Sample Mixed
prompts:
  - id: hello
    name: Hello
    file: prompts/hello.prompt.md
    type: prompt
`,
  'prompts/hello.prompt.md': '# Hello\n',
  'hooks/pre-commit.hook.json': '{"hooks":{}}\n'
};
const PROMPT_ONLY_FILES: Record<string, string> = {
  'deployment-manifest.yml': MIXED_FILES['deployment-manifest.yml'],
  'prompts/hello.prompt.md': MIXED_FILES['prompts/hello.prompt.md']
};
const REPO_FILES: Record<string, string> = {
  'deployment-manifest.yml': `id: sample-repo
version: 1.0.0
name: Sample Repo
prompts:
  - id: hello
    file: prompts/hello.prompt.md
    type: prompt
agents:
  - id: hello-agent
    file: agents/hello.agent.md
    type: agent
`,
  'prompts/hello.prompt.md': '# Hello Prompt\n',
  'agents/hello.agent.md': '# Hello Agent\n'
};
const KIRO_REASON = 'target "kiro-ide" (kiro) cannot install this content';
const HOOK_SKIP = { path: 'hooks/pre-commit.hook.json', code: 'BUNDLE.UNSUPPORTED_CONTENT', reason: KIRO_REASON };

interface JsonEnvelope<T> {
  status: string;
  data: T;
  warnings: string[];
}
interface InstallData {
  written: string[];
  skipped: { path: string; code: string; reason: string }[];
  lockfile: string;
}

const parseJson = <T>(stdout: string): JsonEnvelope<T> => JSON.parse(stdout) as JsonEnvelope<T>;

/**
 * List every file below a directory, relative to it, `/`-separated.
 * @param root Directory to list.
 * @returns Sorted relative file paths (empty when the directory is missing).
 */
const listFiles = async (root: string): Promise<string[]> => {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
      .toSorted();
  } catch {
    return [];
  }
};

const writeBundle = async (dir: string, files: Record<string, string>): Promise<void> => {
  for (const [filePath, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, filePath)), { recursive: true });
    await writeFile(path.join(dir, filePath), content);
  }
};

describe('install --skip-unsupported', () => {
  let workspace: string;
  let bundleDir: string;
  let kiroDir: string;
  const mixedZip = buildZip(Object.entries(MIXED_FILES)
    .map(([filePath, content]) => ({ path: filePath, bytes: new TextEncoder().encode(content) })));
  const http: HttpClient = {
    fetch: async (request: HttpRequest): Promise<HttpResponse> => {
      if (request.url === 'https://api.github.com/repos/acme-org/sample-mixed/releases') {
        return {
          statusCode: 200,
          body: new TextEncoder().encode(JSON.stringify([{
            tag_name: 'sample-mixed-v1.0.0',
            assets: [{ name: 'bundle.zip', url: 'https://api.github.com/assets/sample-mixed' }]
          }])),
          finalUrl: request.url,
          headers: {}
        };
      }
      if (request.url === 'https://api.github.com/assets/sample-mixed') {
        return { statusCode: 200, body: mixedZip, finalUrl: request.url, headers: {} };
      }
      throw new Error(`Unexpected request: ${request.url}`);
    }
  };
  const env = (): Record<string, string> => ({
    HOME: workspace,
    USERPROFILE: workspace,
    XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
    XDG_CACHE_HOME: path.join(workspace, 'xdg-cache')
  });
  const run = (argv: string[]): ReturnType<typeof runCommand> => runCommand(argv, {
    commandClasses: [TargetAddCommand, InstallCommand, UninstallCommand],
    context: { cwd: workspace, fs: new NodeFileSystem(), env: env() }
  });
  const runRemote = async (argv: string[]): Promise<{ exitCode: number; stdout: string }> => {
    const ctx = createTestContext({ cwd: workspace, fs: new NodeFileSystem(), env: env() });
    const exitCode = await runCli(argv, {
      ctx,
      http,
      tokens: { getToken: async () => undefined },
      commandClasses: [TargetAddCommand, InstallCommand, UninstallCommand],
      commands: [],
      name: 'test',
      version: 'test'
    });
    return { exitCode, stdout: ctx.stdout.captured() };
  };
  const userLockPath = (): string => resolveUserConfigPaths(env()).userLockfile;
  const readLock = async (lockPath: string): Promise<Lockfile> =>
    JSON.parse(await readFile(lockPath, 'utf8')) as Lockfile;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-skip-unsupported-test-'));
    bundleDir = path.join(workspace, 'bundle');
    kiroDir = path.join(workspace, '.kiro');
    await writeBundle(bundleDir, MIXED_FILES);
    expect((await run(['target', 'add', 'kiro-ide', '--type', 'kiro', '-o', 'json'])).exitCode).toBe(0);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  describe('without the flag (unchanged default)', () => {
    it('rejects a bundle with unsupported content and writes nothing', async () => {
      const result = await run(['install', '--from', bundleDir, '--target', 'kiro-ide', '-o', 'json']);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('BUNDLE.UNSUPPORTED_CONTENT');
      expect(result.stdout).toContain('hooks/pre-commit.hook.json');
      expect(await listFiles(kiroDir)).toEqual([]);
      await expect(readFile(userLockPath(), 'utf8')).rejects.toThrow();
    });

    it('keeps the JSON envelope of a fully supported install', async () => {
      const promptDir = path.join(workspace, 'prompt-bundle');
      await writeBundle(promptDir, PROMPT_ONLY_FILES);

      const result = await run(['install', '--from', promptDir, '--target', 'kiro-ide', '-o', 'json']);

      expect(result.exitCode, result.stdout).toBe(0);
      const envelope = parseJson<InstallData>(result.stdout);
      expect(envelope.status).toBe('ok');
      expect(envelope.warnings).toEqual([]);
      expect(envelope.data.skipped).toEqual([]);
    });

    it('keeps the text output of a fully supported install', async () => {
      const promptDir = path.join(workspace, 'prompt-bundle');
      await writeBundle(promptDir, PROMPT_ONLY_FILES);

      const result = await run(['install', '--from', promptDir, '--target', 'kiro-ide']);

      expect(result.exitCode, result.stdout).toBe(0);
      expect(result.stdout).toBe(
        `Installed sample-mixed@1.0.0 into target "kiro-ide" (1 written, 0 skipped). Updated ${userLockPath()}.\n`
      );
      expect(result.stderr).toBe('');
    });
  });

  it('installs the supported items and reports the skipped ones in JSON', async () => {
    const result = await run([
      'install', '--from', bundleDir, '--target', 'kiro-ide', '--skip-unsupported', '-o', 'json'
    ]);

    expect(result.exitCode, result.stdout).toBe(0);
    const envelope = parseJson<InstallData>(result.stdout);
    expect(envelope.status).toBe('warning');
    expect(envelope.data.written).toEqual([path.join(kiroDir, 'steering', 'hello.prompt.md')]);
    expect(envelope.data.skipped).toEqual([HOOK_SKIP]);
    expect(envelope.warnings).toEqual([`skipped hooks/pre-commit.hook.json: ${KIRO_REASON}`]);
    expect(await listFiles(kiroDir)).toEqual(['steering/hello.prompt.md']);
    const entry = (await readLock(envelope.data.lockfile)).bundles['sample-mixed'];
    expect(entry.files.map((f) => f.path)).toEqual(['prompts/hello.prompt.md']);
  });

  it('lists the skipped items in text output and warns on stderr', async () => {
    const result = await run(['install', '--from', bundleDir, '--target', 'kiro-ide', '--skip-unsupported']);

    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.stdout).toBe(
      `Installed sample-mixed@1.0.0 into target "kiro-ide" (1 written, 1 skipped). Updated ${userLockPath()}.\n`
      + 'Skipped:\n'
      + `  - hooks/pre-commit.hook.json: ${KIRO_REASON}\n`
    );
    expect(result.stderr).toBe(`warning: skipped hooks/pre-commit.hook.json: ${KIRO_REASON}\n`);
  });

  it('uninstalls exactly what a partial install wrote', async () => {
    expect((await run([
      'install', '--from', bundleDir, '--target', 'kiro-ide', '--skip-unsupported', '-o', 'json'
    ])).exitCode).toBe(0);

    const removed = await run(['uninstall', '--bundle', 'sample-mixed', '--target', 'kiro-ide', '-o', 'json']);

    expect(removed.exitCode, removed.stdout).toBe(0);
    expect(parseJson<{ removed: string[] }>(removed.stdout).data.removed).toEqual(['prompts/hello.prompt.md']);
    expect(await listFiles(kiroDir)).toEqual([]);
    expect((await readLock(userLockPath())).bundles['sample-mixed']).toBeUndefined();
  });

  it('applies to a remote install', async () => {
    const result = await runRemote([
      'install', 'sample-mixed', '--source', 'acme-org/sample-mixed', '--target', 'kiro-ide',
      '--skip-unsupported', '-o', 'json'
    ]);

    expect(result.exitCode, result.stdout).toBe(0);
    const envelope = parseJson<InstallData>(result.stdout);
    expect(envelope.status).toBe('warning');
    expect(envelope.data.skipped).toEqual([HOOK_SKIP]);
    const entry = (await readLock(envelope.data.lockfile)).bundles['sample-mixed'];
    expect(entry.files.map((f) => f.path)).toEqual(['prompts/hello.prompt.md']);
  });

  it('skips content a repository-scope target excludes and uninstalls only the rest', async () => {
    const repoBundle = path.join(workspace, 'repo-bundle');
    await writeBundle(repoBundle, REPO_FILES);
    expect((await run([
      'target', 'add', 'repo-prompts', '--type', 'vscode', '--scope', 'repository',
      '--workspace-root', workspace, '--allowed-kinds', 'prompt', '-o', 'json'
    ])).exitCode).toBe(0);

    const result = await run([
      'install', '--from', repoBundle, '--target', 'repo-prompts',
      '--skip-unsupported', '--commit-mode', 'local-only', '-o', 'json'
    ]);

    expect(result.exitCode, result.stdout).toBe(0);
    const envelope = parseJson<InstallData>(result.stdout);
    expect(envelope.data.skipped.map((s) => s.path)).toEqual(['agents/hello.agent.md']);
    await expect(readFile(path.join(workspace, '.github', 'prompts', 'hello.prompt.md'), 'utf8'))
      .resolves.toContain('Hello Prompt');
    await expect(readFile(path.join(workspace, '.github', 'agents', 'hello.agent.md'), 'utf8')).rejects.toThrow();
    const entry = (await readLock(envelope.data.lockfile)).bundles['sample-repo'];
    expect(entry.files.map((f) => f.path)).toEqual(['prompts/hello.prompt.md']);

    const removed = await run(['uninstall', '--bundle', 'sample-repo', '--target', 'repo-prompts', '-o', 'json']);

    expect(removed.exitCode, removed.stdout).toBe(0);
    expect(parseJson<{ removed: string[] }>(removed.stdout).data.removed).toEqual(['prompts/hello.prompt.md']);
    await expect(readFile(path.join(workspace, '.github', 'prompts', 'hello.prompt.md'), 'utf8')).rejects.toThrow();
  });

  it('refuses the flag with --lockfile before writing anything', async () => {
    const result = await run([
      'install', '--lockfile', path.join(workspace, 'prompt-registry.lock.json'), '--target', 'kiro-ide',
      '--skip-unsupported', '-o', 'json'
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('USAGE.INVALID_FLAG');
    expect(await listFiles(kiroDir)).toEqual([]);
  });

  it('still fails when the target supports none of the bundle', async () => {
    const promptDir = path.join(workspace, 'prompt-bundle');
    await writeBundle(promptDir, PROMPT_ONLY_FILES);
    expect((await run([
      'target', 'add', 'kiro-skills', '--type', 'kiro', '--allowed-kinds', 'skill', '-o', 'json'
    ])).exitCode).toBe(0);

    const result = await run([
      'install', '--from', promptDir, '--target', 'kiro-skills', '--skip-unsupported', '-o', 'json'
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('BUNDLE.UNSUPPORTED_CONTENT');
    expect(await listFiles(kiroDir)).toEqual([]);
    await expect(readFile(userLockPath(), 'utf8')).rejects.toThrow();
  });
});
