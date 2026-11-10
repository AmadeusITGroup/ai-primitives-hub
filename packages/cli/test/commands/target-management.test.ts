/**
 * Target-management CLI tests through the real registry dispatch
 * (runCli/ALL_COMMAND_CLASSES) with real Node fs/store/session under
 * synthetic roots.
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
  NodeRuntimeProjectionFileSystem,
} from '@ai-primitives-hub/infra';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  ALL_COMMAND_CLASSES,
} from '../../src/commands/registry';
import {
  runCli,
} from '../../src/framework';
import {
  createTestContext,
} from '../../src/framework/test-context';

const envOf = (root: string): Record<string, string> => ({
  HOME: path.join(root, 'home'),
  USERPROFILE: path.join(root, 'home'),
  XDG_CONFIG_HOME: path.join(root, 'xdg/config'),
  XDG_DATA_HOME: path.join(root, 'xdg/data'),
  XDG_CACHE_HOME: path.join(root, 'xdg/cache'),
  XDG_STATE_HOME: path.join(root, 'xdg/state'),
  TMPDIR: path.join(root, 'tmp')
});

const cli = async (argv: string[], opts: { cwd: string; env: Record<string, string> }) => {
  const ctx = createTestContext({ env: opts.env, cwd: opts.cwd, fs: new NodeRuntimeProjectionFileSystem() });
  const exitCode = await runCli([...argv, '-o', 'json'], {
    ctx, name: 'ai-primitives-hub', version: '0.0.0-test', commands: [], commandClasses: ALL_COMMAND_CLASSES
  });
  const stdout = ctx.stdout.captured();
  let data: unknown;
  try {
    data = (JSON.parse(stdout.slice(stdout.indexOf('{'))) as { data: unknown }).data;
  } catch { /* text output */ }
  return { exitCode, stdout, stderr: ctx.stderr.captured(), data };
};

async function fixture(root: string, name: string, version: string): Promise<string> {
  const dir = path.join(root, name);
  await mkdir(path.join(dir, 'prompts'), { recursive: true });
  await writeFile(path.join(dir, 'deployment-manifest.yml'),
    `id: demo\nversion: ${version}\nname: Demo\nitems:\n  - path: prompts/a.prompt.md\n    kind: prompt\n`);
  await writeFile(path.join(dir, 'prompts', 'a.prompt.md'), `# A ${version}\n`);
  return dir;
}

const sandbox = async (gate = true) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tm-cli-'));
  const ws = path.join(root, 'ws');
  await mkdir(path.join(ws, '.git'), { recursive: true });
  await writeFile(path.join(ws, 'ai-primitives-hub-layouts.yml'), 'layouts: {}\n');
  const env = envOf(root);
  await mkdir(path.join(env.XDG_CONFIG_HOME, 'ai-primitives-hub'), { recursive: true });
  await writeFile(path.join(env.XDG_CONFIG_HOME, 'ai-primitives-hub', 'layouts.yml'), 'layouts: {}\n');
  if (gate) {
    await writeFile(path.join(env.XDG_CONFIG_HOME, 'ai-primitives-hub', 'config.yml'), 'experimental:\n  targetManagement: true\n');
  }
  return { root, ws, env, user: path.join(env.XDG_DATA_HOME, 'ai-primitives-hub', 'ai-primitives-hub.lock.json') };
};

describe('target management CLI', () => {
  it('gate off: use/current/installed name the setting and write nothing; target list keeps working', async () => {
    const { root, ws, env } = await sandbox(false);
    try {
      for (const argv of [['target', 'use', 'kiro'], ['target', 'current'], ['installed']]) {
        const r = await cli(argv, { cwd: ws, env });
        expect(r.exitCode).not.toBe(0);
        expect(`${r.stdout}${r.stderr}`).toContain('experimental.targetManagement');
      }
      await expect(readFile(path.join(env.XDG_STATE_HOME, 'ai-primitives-hub', 'target-selection.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await cli(['target', 'list'], { cwd: ws, env })).exitCode).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('target list shows 11 harnesses with the selected marker, overrides and duplicate warnings; use accepts a configured name', async () => {
    const { root, ws, env } = await sandbox();
    try {
      await writeFile(path.join(ws, 'ai-primitives-hub.yaml'), [
        'targets:',
        '  - { name: work-kiro, type: kiro, scope: user }',
        '  - { name: other-kiro, type: kiro, scope: user }',
        '  - { name: my-devin, type: devin, scope: user }',
        ''
      ].join('\n'));
      expect((await cli(['target', 'use', 'kiro'], { cwd: ws, env })).exitCode).not.toBe(0);
      expect((await cli(['target', 'use', 'my-devin'], { cwd: ws, env })).exitCode).toBe(0);
      const current = await cli(['target', 'current'], { cwd: ws, env });
      expect(current.data).toMatchObject({ type: 'devin', selection: 'workspace' });
      const list = await cli(['target', 'list'], { cwd: ws, env });
      const rows = list.data as { type: string; selected: boolean; configured: unknown[]; warning?: string }[];
      expect(rows).toHaveLength(11);
      expect(rows.filter((r) => r.selected).map((r) => r.type)).toEqual(['devin']);
      expect(rows.find((r) => r.type === 'kiro')?.warning).toMatch(/work-kiro, other-kiro/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('mutations without --scope fail and write nothing', async () => {
    const { root, ws, env, user } = await sandbox();
    try {
      await cli(['target', 'use', 'kiro'], { cwd: ws, env });
      const d = await fixture(root, 'v1', '1.0.0');
      const r = await cli(['install', '--from', d], { cwd: ws, env });
      expect(r.exitCode).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain('--scope');
      await expect(readFile(user)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(path.join(ws, 'prompt-registry.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      for (const argv of [['uninstall', 'demo'], ['update', '--from', d]]) {
        const failed = await cli(argv, { cwd: ws, env });
        expect(failed.exitCode).not.toBe(0);
        expect(`${failed.stdout}${failed.stderr}`).toContain('--scope');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('installs in both scopes, updates and uninstalls the exact row, and records no machine paths in the repository lockfile', async () => {
    const { root, ws, env, user } = await sandbox();
    try {
      await cli(['target', 'use', 'kiro'], { cwd: ws, env });
      const v1 = await fixture(root, 'v1', '1.0.0');
      const v2 = await fixture(root, 'v2', '2.0.0');
      expect((await cli(['install', '--from', v1, '--scope', 'repository'], { cwd: ws, env })).exitCode).toBe(0);
      expect((await cli(['install', '--from', v2, '--scope', 'user'], { cwd: ws, env })).exitCode).toBe(0);
      const rows = (await cli(['installed'], { cwd: ws, env })).data as { installationId: string; version: string; instance: { scope: string } }[];
      expect(rows.map((r) => `${r.instance.scope}@${r.version}`).toSorted()).toEqual(['repository@1.0.0', 'user@2.0.0']);
      expect(new Set(rows.map((r) => r.installationId)).size).toBe(2);
      const repoText = await readFile(path.join(ws, 'prompt-registry.lock.json'), 'utf8');
      expect(repoText).not.toContain(ws);
      expect(JSON.parse(repoText).version).toBe('3.0.0');

      const repoRow = rows.find((r) => r.instance.scope === 'repository')!;
      const userBefore = await readFile(user, 'utf8');
      expect((await cli(['update', '--from', v2, '--installation-id', repoRow.installationId], { cwd: ws, env })).exitCode).toBe(0);
      expect(await readFile(path.join(ws, '.kiro', 'steering', 'a.prompt.md'), 'utf8')).toContain('2.0.0');
      expect(JSON.parse(await readFile(user, 'utf8')).bundles).toEqual(JSON.parse(userBefore).bundles);

      expect((await cli(['uninstall', 'demo', '--scope', 'repository'], { cwd: ws, env })).exitCode).toBe(0);
      const userRow = rows.find((r) => r.instance.scope === 'user')!;
      expect((await cli(['uninstall', '--installation-id', userRow.installationId], { cwd: ws, env })).exitCode).toBe(0);
      expect(((await cli(['installed'], { cwd: ws, env })).data as unknown[])).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('install --target is per-invocation and never changes the persisted selection', async () => {
    const { root, ws, env } = await sandbox();
    try {
      await cli(['target', 'use', 'kiro'], { cwd: ws, env });
      const selectionFile = path.join(env.XDG_STATE_HOME, 'ai-primitives-hub', 'target-selection.json');
      const selectionOf = async () => (JSON.parse(await readFile(selectionFile, 'utf8')) as { workspaces: unknown }).workspaces;
      const before = await selectionOf();
      const d = await fixture(root, 'v1', '1.0.0');
      const r = await cli(['install', '--from', d, '--scope', 'user', '--target', 'devin'], { cwd: ws, env });
      expect(r.exitCode).toBe(0);
      expect(await selectionOf()).toEqual(before);
      expect((await cli(['target', 'current'], { cwd: ws, env })).data).toMatchObject({ type: 'kiro' });
      expect(await readFile(path.join(env.HOME, '.devin', 'rules', 'a.prompt.md'), 'utf8')).toContain('1.0.0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('--dry-run plans only and --apply-plan applies a previewed hash', async () => {
    const { root, ws, env, user } = await sandbox();
    try {
      await cli(['target', 'use', 'vscode'], { cwd: ws, env });
      const d = await fixture(root, 'v1', '1.0.0');
      const dry = await cli(['install', '--from', d, '--scope', 'user', '--dry-run'], { cwd: ws, env });
      expect(dry.exitCode).toBe(0);
      await expect(readFile(user)).rejects.toMatchObject({ code: 'ENOENT' });
      const hash = (dry.data as { hash: string }).hash;
      expect((await cli(['install', '--from', d, '--scope', 'user', '--apply-plan', hash], { cwd: ws, env })).exitCode).toBe(0);
      expect(await readFile(path.join(env.HOME, '.copilot', 'prompts', 'a.prompt.md'), 'utf8')).toContain('1.0.0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports a conflict when another harness already owns the shared path', async () => {
    const { root, ws, env } = await sandbox();
    try {
      await cli(['target', 'use', 'vscode'], { cwd: ws, env });
      const v1 = await fixture(root, 'v1', '1.0.0');
      const v2 = await fixture(root, 'v2', '2.0.0');
      expect((await cli(['install', '--from', v1, '--scope', 'repository'], { cwd: ws, env })).exitCode).toBe(0);
      await cli(['target', 'use', 'copilot-cli'], { cwd: ws, env });
      const r = await cli(['install', '--from', v2, '--scope', 'repository'], { cwd: ws, env });
      expect(r.exitCode).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/conflict|owned|unmanaged/i);
      expect(await readFile(path.join(ws, '.github', 'prompts', 'a.prompt.md'), 'utf8')).toContain('1.0.0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a legacy v2 repository lockfile blocks mutations and points to migration', async () => {
    const { root, ws, env } = await sandbox();
    try {
      const legacy = '{"version":"2.0.0","bundles":{"old":{"version":"1.0.0"}}}';
      await writeFile(path.join(ws, 'prompt-registry.lock.json'), legacy);
      await cli(['target', 'use', 'kiro'], { cwd: ws, env });
      const d = await fixture(root, 'v1', '1.0.0');
      const r = await cli(['install', '--from', d, '--scope', 'repository'], { cwd: ws, env });
      expect(r.exitCode).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/legacy/i);
      expect(`${r.stdout}${r.stderr}`).toMatch(/migrate/i);
      expect(await readFile(path.join(ws, 'prompt-registry.lock.json'), 'utf8')).toBe(legacy);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lockfile inspect reports unresolved v2 entries read-only', async () => {
    const { root, ws, env } = await sandbox();
    try {
      const v2 = path.join(root, 'v2.json');
      await writeFile(v2, JSON.stringify({ version: '2.0.0', bundles: { a: { version: '1.0.0' } } }));
      const r = await cli(['lockfile', 'inspect', v2], { cwd: ws, env });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('needsReinstall');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  const legacyLock = async (ws: string) => {
    await mkdir(path.join(ws, '.github', 'prompts'), { recursive: true });
    await writeFile(path.join(ws, '.github', 'prompts', 'a.prompt.md'), 'A');
    const text = `${JSON.stringify({
      version: '2.0.0', generatedAt: '2026-01-01T00:00:00.000Z', generatedBy: 'prompt-registry@0.0.1',
      bundles: { a: { version: '1.0.0', sourceId: 'src', sourceType: 'local', installedAt: '2026-01-01T00:00:00.000Z',
        files: [{ path: '.github/prompts/a.prompt.md', checksum: 'sha256:559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd' }] } },
      sources: { src: { type: 'local', url: '/elsewhere' } }
    }, null, 2)}\n`;
    await writeFile(path.join(ws, 'prompt-registry.lock.json'), text);
    return text;
  };

  it('lockfile migrate: dry run lists candidates and writes nothing; ambiguity needs --harness; then it migrates with a byte-exact backup', async () => {
    const { root, ws, env } = await sandbox();
    try {
      const original = await legacyLock(ws);
      const dry = await cli(['lockfile', 'migrate', '--dry-run'], { cwd: ws, env });
      expect(dry.exitCode).toBe(0);
      expect(JSON.stringify(dry.data)).toContain('copilot-cli');
      expect(await readFile(path.join(ws, 'prompt-registry.lock.json'), 'utf8')).toBe(original);
      const refused = await cli(['lockfile', 'migrate'], { cwd: ws, env });
      expect(refused.exitCode).not.toBe(0);
      expect(`${refused.stdout}${refused.stderr}`).toMatch(/--harness/);
      expect(await readFile(path.join(ws, 'prompt-registry.lock.json'), 'utf8')).toBe(original);
      const done = await cli(['lockfile', 'migrate', '--harness', 'vscode'], { cwd: ws, env });
      expect(done.exitCode).toBe(0);
      const result = done.data as { backup: string; migrated: unknown[]; commitGuidance?: string };
      expect(await readFile(result.backup, 'utf8')).toBe(original);
      expect(result.migrated).toHaveLength(1);
      expect(result.commitGuidance).toMatch(/commit/i);
      expect(JSON.parse(await readFile(path.join(ws, 'prompt-registry.lock.json'), 'utf8')).version).toBe('3.0.0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lockfile migrate requires the gate and changes nothing when it is off', async () => {
    const { root, ws, env } = await sandbox(false);
    try {
      const original = await legacyLock(ws);
      const r = await cli(['lockfile', 'migrate', '--harness', 'vscode'], { cwd: ws, env });
      expect(r.exitCode).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain('experimental.targetManagement');
      expect(await readFile(path.join(ws, 'prompt-registry.lock.json'), 'utf8')).toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
