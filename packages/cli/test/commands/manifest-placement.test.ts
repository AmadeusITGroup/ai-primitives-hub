/**
 * Manifest-driven placement through the CLI: a bundle laid out for Copilot
 * (every file under `.github/`, each listed in the manifest's `prompts:`
 * with its type) installs onto Kiro and VS Code targets by item type, and
 * uninstall / profile deactivate / lockfile replay find the renamed files.
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
  emptyLockfile,
  type Lockfile,
  resolveUserConfigPaths,
  upsertBundleEntry,
  upsertSource,
  writeLockfile,
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
  HubAddCommand,
  HubUseCommand,
} from '../../src/commands/hub';
import {
  InstallCommand,
} from '../../src/commands/install';
import {
  ProfileActivateCommand,
  ProfileDeactivateCommand,
} from '../../src/commands/profile';
import {
  TargetAddCommand,
} from '../../src/commands/target-add';
import {
  UninstallCommand,
} from '../../src/commands/uninstall';
import {
  UpdateCommand,
} from '../../src/commands/update';
import {
  createTestContext,
  runCli,
} from '../../src/framework';

const MANIFEST = `id: sample-skills
version: 1.8.1
name: Sample Skills
prompts:
  - id: sample-skill
    name: Sample Skill
    file: .github/skills/sample-skill/SKILL.md
    type: skill
  - id: sample-rules.instructions
    name: Sample Rules
    file: .github/instructions/sample-rules.instructions.md
    type: instructions
  - id: copilot-instructions
    name: Workspace Policy
    file: .github/copilot-instructions.md
    type: instructions
mcpServers:
  sample-server:
    type: http
    url: https://example.invalid/sse
`;

const BUNDLE_FILES: Record<string, string> = {
  'deployment-manifest.yml': MANIFEST,
  '.github/skills/sample-skill/SKILL.md': '---\nname: sample-skill\ndescription: Sample\n---\n# Sample Skill\n',
  '.github/skills/sample-skill/references/notes.md': '# Notes\n',
  '.github/instructions/sample-rules.instructions.md': '# Sample Rules\n',
  '.github/copilot-instructions.md': '# Workspace Policy\n'
};

/**
 * Version 2.0.0 of a prompt bundle whose manifest now places `prompts/x.md`
 * by type (as `x.prompt.md`); `prompts/keep.prompt.md` stays path-routed.
 */
const PROMPT_BUNDLE_FILES: Record<string, string> = {
  'deployment-manifest.yml': `id: sample-prompts
version: 2.0.0
name: Sample Prompts
prompts:
  - id: x
    name: X
    file: prompts/x.md
    type: prompt
`,
  'prompts/x.md': '# X v2\n',
  'prompts/keep.prompt.md': '# Keep v2\n'
};

/** Kiro base-relative paths every install of the bundle must produce. */
const KIRO_PATHS = [
  'skills/sample-skill/SKILL.md',
  'skills/sample-skill/references/notes.md',
  'steering/sample-rules.instructions.md',
  'steering/copilot-instructions.instructions.md'
];

interface JsonEnvelope<T> {
  status: string;
  data: T;
}

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

describe('manifest-driven placement of a Copilot-layout bundle', () => {
  let workspace: string;
  let bundleDir: string;
  let kiroDir: string;

  const bundleZip = buildZip(Object.entries(BUNDLE_FILES)
    .map(([filePath, content]) => ({ path: filePath, bytes: new TextEncoder().encode(content) })));
  const promptBundleZip = buildZip(Object.entries(PROMPT_BUNDLE_FILES)
    .map(([filePath, content]) => ({ path: filePath, bytes: new TextEncoder().encode(content) })));
  const http: HttpClient = {
    fetch: async (request: HttpRequest): Promise<HttpResponse> => {
      if (request.url === 'https://api.github.com/repos/acme-org/sample-prompts/releases') {
        return {
          statusCode: 200,
          body: new TextEncoder().encode(JSON.stringify([{
            tag_name: 'sample-prompts-v2.0.0',
            assets: [{ name: 'bundle.zip', url: 'https://api.github.com/assets/sample-prompts' }]
          }])),
          finalUrl: request.url,
          headers: {}
        };
      }
      if (request.url === 'https://api.github.com/assets/sample-prompts') {
        return { statusCode: 200, body: promptBundleZip, finalUrl: request.url, headers: {} };
      }
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

  const env = (): Record<string, string> => ({
    HOME: workspace,
    USERPROFILE: workspace,
    XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
    XDG_CACHE_HOME: path.join(workspace, 'xdg-cache')
  });

  const run = async (argv: string[]): Promise<{ exitCode: number; stdout: string }> => {
    const ctx = createTestContext({ cwd: workspace, fs: new NodeFileSystem(), env: env() });
    const exitCode = await runCli(argv, {
      ctx,
      http,
      tokens: { getToken: async () => undefined },
      commandClasses: [
        TargetAddCommand,
        InstallCommand,
        UninstallCommand,
        HubAddCommand,
        HubUseCommand,
        ProfileActivateCommand,
        ProfileDeactivateCommand,
        UpdateCommand
      ],
      commands: [],
      name: 'test',
      version: 'test'
    });
    return { exitCode, stdout: ctx.stdout.captured() };
  };

  const readUserLock = async (): Promise<Lockfile> =>
    JSON.parse(await readFile(resolveUserConfigPaths(env()).userLockfile, 'utf8')) as Lockfile;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-manifest-placement-test-'));
    bundleDir = path.join(workspace, 'bundle');
    kiroDir = path.join(workspace, '.kiro');
    for (const [filePath, content] of Object.entries(BUNDLE_FILES)) {
      await mkdir(path.dirname(path.join(bundleDir, filePath)), { recursive: true });
      await writeFile(path.join(bundleDir, filePath), content);
    }
    expect((await run(['target', 'add', 'kiro-ide', '--type', 'kiro', '-o', 'json'])).exitCode).toBe(0);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('installs to a Kiro user target by item type and uninstall removes every file', async () => {
    const installed = await run(['install', '--from', bundleDir, '--target', 'kiro-ide', '-o', 'json']);

    expect(installed.exitCode, installed.stdout).toBe(0);
    expect(await listFiles(kiroDir)).toEqual(KIRO_PATHS.toSorted());
    expect(await readFile(path.join(kiroDir, 'skills', 'sample-skill', 'references', 'notes.md'), 'utf8')).toBe('# Notes\n');
    const entry = (await readUserLock()).bundles['sample-skills'];
    // Lockfile paths stay bundle-relative; the install location is recorded beside them.
    expect(entry.files.map((f) => [f.path, f.installedPath]).toSorted()).toEqual([
      ['.github/copilot-instructions.md', 'steering/copilot-instructions.instructions.md'],
      ['.github/instructions/sample-rules.instructions.md', 'steering/sample-rules.instructions.md'],
      ['.github/skills/sample-skill/SKILL.md', 'skills/sample-skill/SKILL.md'],
      ['.github/skills/sample-skill/references/notes.md', 'skills/sample-skill/references/notes.md']
    ]);
    expect(entry.files.every((f) => /^[a-f0-9]{64}$/.test(f.checksum))).toBe(true);

    const removed = await run(['uninstall', '--bundle', 'sample-skills', '--target', 'kiro-ide', '-o', 'json']);

    expect(removed.exitCode, removed.stdout).toBe(0);
    expect(await listFiles(kiroDir)).toEqual([]);
  });

  /**
   * Seed version 1.0.0 of `sample-prompts` as an earlier release installed
   * it: path-routed, so its lockfile entry has no `installedPath`.
   */
  const seedPathRoutedPrompts = async (): Promise<void> => {
    await mkdir(path.join(kiroDir, 'steering'), { recursive: true });
    await writeFile(path.join(kiroDir, 'steering', 'x.md'), '# X v1\n');
    await writeFile(path.join(kiroDir, 'steering', 'keep.prompt.md'), '# Keep v1\n');
    let lock = upsertBundleEntry(emptyLockfile('test'), 'sample-prompts', {
      version: '1.0.0',
      sourceId: 'sample-prompts-source',
      sourceType: 'github',
      installedAt: '2026-01-01T00:00:00Z',
      files: [
        { path: 'prompts/x.md', checksum: 'a'.repeat(64) },
        { path: 'prompts/keep.prompt.md', checksum: 'b'.repeat(64) }
      ]
    });
    lock = upsertSource(lock, 'sample-prompts-source', { type: 'github', url: 'https://github.com/acme-org/sample-prompts' });
    await writeLockfile(resolveUserConfigPaths(env()).userLockfile, lock, new NodeFileSystem());
  };

  it('update removes a path-routed file the new version places under a new name', async () => {
    await seedPathRoutedPrompts();

    const updated = await run(['update', '--target', 'kiro-ide', '--no-hub-sync', '-o', 'json']);

    expect(updated.exitCode, updated.stdout).toBe(0);
    expect(await listFiles(kiroDir)).toEqual(['steering/keep.prompt.md', 'steering/x.prompt.md']);
    expect(await readFile(path.join(kiroDir, 'steering', 'x.prompt.md'), 'utf8')).toBe('# X v2\n');
    // A file written to the same place by both versions is kept (overwritten).
    expect(await readFile(path.join(kiroDir, 'steering', 'keep.prompt.md'), 'utf8')).toBe('# Keep v2\n');
    expect((await readUserLock()).bundles['sample-prompts'].version).toBe('2.0.0');
  });

  it('re-install removes a path-routed file the new version places under a new name', async () => {
    await seedPathRoutedPrompts();
    const promptsDir = path.join(workspace, 'prompt-bundle');
    for (const [filePath, content] of Object.entries(PROMPT_BUNDLE_FILES)) {
      await mkdir(path.dirname(path.join(promptsDir, filePath)), { recursive: true });
      await writeFile(path.join(promptsDir, filePath), content);
    }

    const installed = await run(['install', '--from', promptsDir, '--target', 'kiro-ide', '-o', 'json']);

    expect(installed.exitCode, installed.stdout).toBe(0);
    expect(await listFiles(kiroDir)).toEqual(['steering/keep.prompt.md', 'steering/x.prompt.md']);
  });

  it('installs to a Kiro repository target under the workspace .kiro directory', async () => {
    const project = path.join(workspace, 'project');
    await mkdir(project, { recursive: true });
    expect((await run([
      'target', 'add', 'kiro-repo', '--type', 'kiro', '--scope', 'repository', '--workspace-root', project, '-o', 'json'
    ])).exitCode).toBe(0);

    const installed = await run(['install', '--from', bundleDir, '--target', 'kiro-repo', '-o', 'json']);

    expect(installed.exitCode, installed.stdout).toBe(0);
    expect(await listFiles(path.join(project, '.kiro'))).toEqual(KIRO_PATHS.toSorted());
  });

  it('rejects the install, writing nothing, when allowedKinds excludes a listed item', async () => {
    expect((await run([
      'target', 'add', 'kiro-skills', '--type', 'kiro', '--allowed-kinds', 'skill', '-o', 'json'
    ])).exitCode).toBe(0);

    const installed = await run(['install', '--from', bundleDir, '--target', 'kiro-skills', '-o', 'json']);

    expect(installed.exitCode).toBe(1);
    expect(installed.stdout).toContain('BUNDLE.UNSUPPORTED_CONTENT');
    expect(await listFiles(kiroDir)).toEqual([]);
  });

  it('installs the same bundle into a VS Code user target', async () => {
    expect((await run(['target', 'add', 'vsc', '--type', 'vscode', '-o', 'json'])).exitCode).toBe(0);

    const installed = await run(['install', '--from', bundleDir, '--target', 'vsc', '-o', 'json']);

    expect(installed.exitCode, installed.stdout).toBe(0);
    const written = (JSON.parse(installed.stdout) as JsonEnvelope<{ written: string[] }>).data.written
      .map((p) => p.split(path.sep).join('/'));
    expect(written.some((p) => p.endsWith('/skills/sample-skill/references/notes.md'))).toBe(true);
    expect(written.some((p) => p.endsWith('/instructions/sample-rules.instructions.md'))).toBe(true);
    expect(written.some((p) => p.endsWith('/instructions/copilot-instructions.instructions.md'))).toBe(true);
  });

  it('round-trips profile activate, deactivate and lockfile replay on a Kiro target', async () => {
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
  - id: sample-developer
    name: Sample Developer
    description: One Copilot-layout bundle
    bundles:
      - id: acme-org-sample-skills-sample-skills
        version: latest
        source: sample-collections
        required: true
`);
    expect((await run(['hub', 'add', '--type', 'local', '--location', hubConfigFile, '--id', 'sample-hub', '-o', 'json'])).exitCode).toBe(0);
    expect((await run(['hub', 'use', 'sample-hub', '-o', 'json'])).exitCode).toBe(0);

    const activated = await run(['profile', 'activate', 'sample-developer', '--target', 'kiro-ide', '-o', 'json']);
    expect(activated.exitCode, activated.stdout).toBe(0);
    expect(await listFiles(kiroDir)).toEqual(KIRO_PATHS.toSorted());
    const lockCopy = path.join(workspace, 'replay.lock.json');
    await writeFile(lockCopy, await readFile(resolveUserConfigPaths(env()).userLockfile, 'utf8'));

    const deactivated = await run(['profile', 'deactivate', '-o', 'json']);
    expect(deactivated.exitCode, deactivated.stdout).toBe(0);
    expect(await listFiles(kiroDir)).toEqual([]);

    const replayed = await run(['install', '--lockfile', lockCopy, '--target', 'kiro-ide', '-o', 'json']);
    expect(replayed.exitCode, replayed.stdout).toBe(0);
    expect(await listFiles(kiroDir)).toEqual(KIRO_PATHS.toSorted());

    // The copied lockfile records where each file landed, so it removes them again.
    const removed = await run(['uninstall', '--lockfile', lockCopy, '--target', 'kiro-ide', '-o', 'json']);
    expect(removed.exitCode, removed.stdout).toBe(0);
    expect(await listFiles(kiroDir)).toEqual([]);
  });
});
