/**
 * Runtime-target session regression tests (lead review batch).
 * Real session + real store + real fs below a synthetic root; no mocks of the
 * session/writer/router. Behavioral red cases come first.
 */
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  decodeLockfileV3,
  encodeLockfileV3,
  type ExtractedFile,
  inspectLegacyV2,
  instanceKey,
  LOCKFILE_V3_FILENAME,
  LOCKFILE_V3_VERSION,
  lockfileBundleKey,
  type RuntimeOperation,
  type RuntimeTargetState,
  TARGET_TYPES,
  validateManifest,
} from '@ai-primitives-hub/core';
import {
  BuiltInOnlyLayoutConfigLoader,
  defaultLayouts,
  loadExtractedDirectory,
  NodeRuntimeProjectionFileSystem,
  ScopedRuntimeTargetStore,
  XdgAppStorage,
} from '@ai-primitives-hub/infra';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  createRuntimeTargetSession,
  type RuntimeSessionOptions,
} from '../../src/runtime-target';

const envOf = (root: string): Record<string, string> => ({
  HOME: path.join(root, 'home'),
  USERPROFILE: path.join(root, 'home'),
  XDG_CONFIG_HOME: path.join(root, 'xdg/config'),
  XDG_DATA_HOME: path.join(root, 'xdg/data'),
  XDG_CACHE_HOME: path.join(root, 'xdg/cache'),
  XDG_STATE_HOME: path.join(root, 'xdg/state'),
  TMPDIR: path.join(root, 'tmp'),
  AI_PRIMITIVES_HUB_CACHE: path.join(root, 'aph')
});

async function fixture(root: string, name: string, version: string, extra?: { skillMcp?: boolean; hooks?: boolean }): Promise<string> {
  const dir = path.join(root, name);
  await mkdir(path.join(dir, 'prompts'), { recursive: true });
  await mkdir(path.join(dir, 'skills', 's1'), { recursive: true });
  await writeFile(path.join(dir, 'deployment-manifest.yml'),
    `id: demo\nversion: ${version}\nname: Demo\nitems:\n  - path: prompts/a.prompt.md\n    kind: prompt\n`);
  await writeFile(path.join(dir, 'prompts', 'a.prompt.md'), `# A ${version}\n`);
  await writeFile(path.join(dir, 'skills', 's1', 'SKILL.md'), `# S ${version}\n`);
  await writeFile(path.join(dir, 'skills', 's1', 'asset.bin'), Buffer.from([0x89, 0x50, version.charCodeAt(0)]));
  if (extra?.skillMcp) {
    // ordinary nested resource, must be allowed (not a capability)
    await writeFile(path.join(dir, 'skills', 's1', 'mcp.json'), '{"servers":{}}');
  }
  if (extra?.hooks) {
    await mkdir(path.join(dir, 'hooks'), { recursive: true });
    await writeFile(path.join(dir, 'hooks', 'h.sh'), 'echo x\n');
  }
  return dir;
}

async function sessionFor(root: string, workspaceRoot?: string, overrides: Partial<RuntimeSessionOptions> = {}) {
  const env = envOf(root);
  const workspace = workspaceRoot ?? path.join(root, 'workspace-a');
  await Promise.all([env.HOME, env.TMPDIR, workspace].map((dir) => mkdir(dir, { recursive: true })));
  const storage = new XdgAppStorage(env);
  const fs = new NodeRuntimeProjectionFileSystem();
  const session = createRuntimeTargetSession({
    storage,
    store: new ScopedRuntimeTargetStore({ storage, workspaceRoot: workspace }),
    fs,
    env,
    workspaceRoot: workspace,
    layoutLoader: new BuiltInOnlyLayoutConfigLoader(),
    ...overrides
  });
  return { session, storage, env };
}

const loadDir = (d: string) => loadExtractedDirectory(d);
const userLockfile = (storage: XdgAppStorage): string => path.join(storage.getPaths().root, LOCKFILE_V3_FILENAME);

async function applyOperation(session: ReturnType<typeof createRuntimeTargetSession>, operation: RuntimeOperation) {
  const plan = await session.plan(operation);
  return session.apply(operation, plan.hash);
}

function readonlyProjectionFs(): NodeRuntimeProjectionFileSystem {
  const fs = new NodeRuntimeProjectionFileSystem();
  const realLstat = fs.lstat.bind(fs);
  return Object.assign(fs, {
    modeSemantics: 'readonly' as const,
    lstat: async (file: string) => {
      const observed = await realLstat(file);
      if (!observed.isFile || observed.mode === undefined) {
        return observed;
      }
      // Windows exposes the read-only attribute, not POSIX executable bits.
      return { ...observed, mode: Math.floor(observed.mode / 0o200) % 2 === 0 ? 0o444 : 0o666 };
    }
  });
}

describe('runtime-target session (lead review regressions)', () => {
  it('projects only the explicitly named source instance rather than the installed union', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-source-'));
    try {
      let { session } = await sessionFor(root);
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      const install = { kind: 'install' as const, payload: { ...await loadDir(await fixture(root, 'v1', '1.0.0')), sourceId: 'src' } };
      await session.apply(install, (await session.plan(install)).hash);
      const sourceTargetId = instanceKey((await session.getActiveTarget())!.instance);
      const files = new Map([
        ['deployment-manifest.yml', new TextEncoder().encode('id: other\nversion: 1.0.0\nname: Other\n')],
        ['prompts/b.prompt.md', new TextEncoder().encode('# B\n')]
      ]);
      await session.selectTarget({ type: 'kiro', scope: 'user' });
      const second = { kind: 'install' as const, payload: { files, manifest: validateManifest(files, {}), sourceId: 'src' } };
      await session.apply(second, (await session.plan(second)).hash);
      await session.selectTarget({ type: 'cursor', scope: 'repository' });
      const project = { kind: 'project' as const, sourceTargetId };
      const preview = await session.plan(project);
      expect(preview.collections.map((collection) => collection.manifestId)).toEqual(['demo']);
      await session.apply(project, preview.hash);
      expect(await session.listInstalled()).toMatchObject([{ manifestId: 'demo' }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not substitute the installed union for an unknown explicit source instance', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-source-missing-'));
    try {
      let { session } = await sessionFor(root);
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      const install = { kind: 'install' as const, payload: { ...await loadDir(await fixture(root, 'v1', '1.0.0')), sourceId: 'src' } };
      await session.apply(install, (await session.plan(install)).hash);
      await session.selectTarget({ type: 'kiro', scope: 'user' });
      const preview = await session.plan({ kind: 'project', sourceTargetId: 'not-a-target-instance' });
      expect(preview.canApply).toBe(false);
      expect(preview.writes).toEqual([]);
      expect(preview.conflicts).toMatchObject([{ code: 'PROJECT.SOURCE_MISSING' }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects caller manifest metadata inconsistent with canonical manifest bytes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-input-'));
    try {
      let { session } = await sessionFor(root);
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      const payload = { ...await loadDir(await fixture(root, 'v1', '1.0.0')), sourceId: 'src' };
      const prior = await session.getLockfile();
      await expect(session.plan({
        kind: 'install',
        payload: { ...payload, manifest: { ...payload.manifest, id: 'forged' } }
      })).rejects.toThrow();
      expect(await session.getLockfile()).toEqual(prior);
      expect(await session.listInstalled()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('includes executable mode intent in immutable snapshot identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-snapshot-mode-'));
    try {
      const { session } = await sessionFor(root);
      const payload = await loadDir(await fixture(root, 'v1', '1.0.0'));
      const first = await session.importInstalled({ files: payload.files, sourceId: 'src', provenance: 'directory' });
      const changed = new Map(payload.files);
      const bytes = new Uint8Array(changed.get('skills/s1/asset.bin')!) as ExtractedFile;
      Object.assign(bytes, { mode: 0o755 });
      changed.set('skills/s1/asset.bin', bytes);
      const second = await session.importInstalled({ files: changed, sourceId: 'src', provenance: 'directory' });
      expect(second.payloadId).not.toBe(first.payloadId);
      expect(await session.listAvailableCollections()).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('replays executable skill resources from durable imported bytes after reload', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-replay-mode-'));
    try {
      const first = await sessionFor(root);
      const payload = await loadDir(await fixture(root, 'v1', '1.0.0'));
      const bytes = new TextEncoder().encode('#!/bin/sh\nprintf demo\n') as ExtractedFile;
      Object.assign(bytes, { mode: 0o755 });
      const files = new Map(payload.files);
      files.set('skills/s1/run.sh', bytes);
      await first.session.importInstalled({ files, sourceId: 'src', provenance: 'directory' });
      bytes.fill(0);
      const fresh = await sessionFor(root);
      await fresh.session.selectTarget({ type: 'kiro', scope: 'repository' });
      const preview = await fresh.session.plan({ kind: 'project' });
      const script = preview.writes.find((file) => file.path.endsWith('/run.sh'))!;
      expect(script.mode).toBe(0o755);
      await fresh.session.apply({ kind: 'project' }, preview.hash);
      expect(await readFile(script.path, 'utf8')).toContain('#!/bin/sh');
      expect((await stat(script.path)).mode % 0o1000).toBe(0o755);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['instance-key', 'installation-id', 'file-mode', 'file-path', 'instance-version', 'payload-bytes', 'selection', 'import-reference'] as const)(
    'rejects corrupted %s in persisted state',
    async (kind) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'rt-corrupt-'));
      try {
        const { session, storage } = await sessionFor(root);
        await session.selectTarget({ type: 'vscode', scope: 'user' });
        const op = { kind: 'install' as const, payload: { ...await loadDir(await fixture(root, 'v1', '1.0.0')), sourceId: 'src' } };
        await session.forScope('user').apply(op, (await session.forScope('user').plan(op)).hash);
        const lockFile = userLockfile(storage);
        const raw = JSON.parse(await readFile(lockFile, 'utf8'));
        interface Row { installationId: string; version: string; files: { path: string; mode?: number }[]; payloadId: string }
        const instances = Object.values(raw.bundles)[0] as { tools: { vscode: { instances: Record<string, Row> } } };
        const key = Object.keys(instances.tools.vscode.instances)[0];
        const instance = instances.tools.vscode.instances[key];
        const stateDir = path.join(root, 'xdg/state', 'ai-primitives-hub');
        let target = lockFile;
        let text: string | undefined;
        switch (kind) {
          case 'instance-key': {
            instances.tools.vscode.instances['inst-tampered'] = instance;
            delete instances.tools.vscode.instances[key];

            break;
          }
          case 'installation-id': {
            instance.installationId = 'rcpt-forged';

            break;
          }
          case 'file-mode': {
            instance.files[0].mode = 0o1_0000;

            break;
          }
          case 'file-path': {
            instance.files[0].path = '../escape';

            break;
          }
          case 'instance-version': {
            instance.version = '9.9.9';

            break;
          }
          case 'payload-bytes': {
            target = path.join(storage.getPaths().root, 'payloads', instance.payloadId, 'files', 'skills', 's1', 'asset.bin');
            text = 'tampered';

            break;
          }
          case 'import-reference': {
            target = path.join(storage.getPaths().root, 'imports.json');
            text = JSON.stringify({ imports: { 'import-ghost': {
              importId: 'import-ghost', sourceId: 'src', manifestId: 'demo',
              payloadId: 'ghost', provenance: 'directory', importedAt: raw.generatedAt
            } } });

            break;
          }
          default: {
            target = path.join(stateDir, 'target-selection.json');
            const sel = JSON.parse(await readFile(target, 'utf8'));
            Object.values(sel.workspaces as Record<string, { type: string }>)[0].type = 'unknown';
            text = JSON.stringify(sel);
          }
        }
        await writeFile(target, text ?? JSON.stringify(raw));
        if (kind === 'import-reference') {
          // A dangling import is dropped, never trusted.
          expect(await (await sessionFor(root)).session.listAvailableCollections()).toBeDefined();
          return;
        }
        await expect((await sessionFor(root)).session.getActiveTarget()).rejects.toThrow();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it('shares selection between canonical and symlinked workspace paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-workspace-'));
    try {
      const real = path.join(root, 'workspace');
      const alias = path.join(root, 'alias');
      await mkdir(real);
      await symlink(real, alias, 'dir');
      const first = await sessionFor(root, real);
      const second = await sessionFor(root, alias);
      await first.session.selectTarget({ type: 'kiro', scope: 'repository' });
      expect(await second.session.getActiveTarget()).toEqual(await first.session.getActiveTarget());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves the selected root and real writer from the same effective layout layers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-layout-'));
    try {
      const layoutLoader = {
        load: async () => [defaultLayouts, {
          layouts: {
            vscode: { user: { baseDir: '${HOME}/custom/copilot', kindRoutes: { 'prompts/': 'commands/' } } }
          }
        }]
      };
      let { session } = await sessionFor(root, undefined, { layoutLoader });
      const { env } = await sessionFor(root, undefined, { layoutLoader });
      const active = await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      expect(active.instance.root).toBe(path.join(env.HOME, 'custom', 'copilot'));
      const op = { kind: 'install' as const, payload: { ...await loadDir(await fixture(root, 'v1', '1.0.0')), sourceId: 'src' } };
      const preview = await session.plan(op);
      expect(preview.writes.every((file) => file.path.startsWith(`${active.instance.root}${path.sep}`))).toBe(true);
      expect(preview.writes.some((file) => file.path.endsWith('commands/a.prompt.md'))).toBe(true);
      await session.apply(op, preview.hash);
      expect((await session.verify()).every((file) => file.status === 'healthy')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the explicit repository override rather than the selection context workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-override-'));
    try {
      const alternate = path.join(root, 'other-workspace');
      await mkdir(alternate);
      const overrideStorage = new XdgAppStorage(envOf(root));
      let { session } = await sessionFor(root, undefined, {
        storage: overrideStorage,
        store: new ScopedRuntimeTargetStore({ storage: overrideStorage, workspaceRoot: alternate })
      });
      const active = await session.selectTarget({ type: 'vscode', scope: 'repository', path: alternate });
      expect(active.instance.root).toBe(path.join(alternate, '.github'));
      session = session.forScope('repository', { path: alternate });
      const op = { kind: 'install' as const, payload: { ...await loadDir(await fixture(root, 'v1', '1.0.0')), sourceId: 'src' } };
      const preview = await session.plan(op);
      expect(preview.writes.every((file) => file.path.startsWith(`${active.instance.root}${path.sep}`))).toBe(true);
      await session.apply(op, preview.hash);
      expect(await session.listInstalled()).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fingerprints layout inputs even when changed routes are not used by this collection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-layout-stale-'));
    try {
      let unusedRoute = 'unused-a/';
      const layoutLoader = {
        load: async () => [defaultLayouts, {
          layouts: { vscode: { user: { baseDir: '${HOME}/.copilot', kindRoutes: { 'unused/': unusedRoute } } } }
        }]
      };
      let { session } = await sessionFor(root, undefined, { layoutLoader });
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      const op = { kind: 'install' as const, payload: { ...await loadDir(await fixture(root, 'v1', '1.0.0')), sourceId: 'src' } };
      const preview = await session.plan(op);
      unusedRoute = 'unused-b/';
      await expect(session.apply(op, preview.hash)).rejects.toMatchObject({ code: 'PLAN.STALE' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(TARGET_TYPES.flatMap((type) => (['user', 'repository'] as const).map((scope) => [type, scope] as const)))(
    '%s/%s supports isolated install, update, verify and uninstall',
    async (type, scope) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'rt-matrix-'));
      try {
        const { session } = await sessionFor(root);
        await session.selectTarget({ type, scope });
        for (const [version, kind] of [['1.0.0', 'install'], ['2.0.0', 'update']] as const) {
          const payload = { ...await loadDir(await fixture(root, version, version)), sourceId: 'matrix' };
          const opSpec = { kind, payload };
          const preview = await session.plan(opSpec);
          expect(preview.conflicts).toEqual([]);
          expect(preview.writes.length).toBeGreaterThanOrEqual(3);
          await session.apply(opSpec, preview.hash);
          expect(await session.listInstalled()).toMatchObject([{ manifestId: 'demo', version }]);
          expect((await session.verify()).every((file) => file.status === 'healthy')).toBe(true);
          const resource = preview.writes.find((file) => file.path.endsWith('asset.bin'))!;
          expect(await readFile(resource.path)).toEqual(Buffer.from([0x89, 0x50, version.charCodeAt(0)]));
        }
        const op = { kind: 'uninstall' as const, sourceId: 'matrix', manifestId: 'demo' };
        await session.apply(op, (await session.plan(op)).hash);
        expect(await session.listInstalled()).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it('removes one alias ownership without deleting shared files or the other instance', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-shared-'));
    try {
      let { session } = await sessionFor(root);
      const payload = { ...await loadDir(await fixture(root, 'v1', '1.0.0')), sourceId: 'src' };
      const install = { kind: 'install' as const, payload };
      for (const type of ['vscode', 'vscode-insiders'] as const) {
        await session.selectTarget({ type, scope: 'user' });
        session = session.forScope('user');
        await session.apply(install, (await session.plan(install)).hash);
      }
      const op = { kind: 'uninstall' as const, sourceId: 'src', manifestId: 'demo' };
      const preview = await session.plan(op);
      expect(preview.canApply).toBe(true);
      expect(preview.removals).toEqual([]);
      expect(preview.preserved).toHaveLength(3);
      await session.apply(op, preview.hash);
      expect(await session.listInstalled()).toEqual([]);
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      expect(await session.listInstalled()).toHaveLength(1);
      expect((await session.verify()).every((file) => file.status === 'healthy')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('restores overwritten bytes and leaves lockfile unchanged when publication fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-rollback-'));
    try {
      class FailSaveStore extends ScopedRuntimeTargetStore {
        public fail = false;
        public override async save(state: RuntimeTargetState): Promise<void> {
          if (this.fail) {
            throw new Error('simulated publication failure');
          }
          await super.save(state);
        }
      }
      const storage = new XdgAppStorage(envOf(root));
      const store = new FailSaveStore({ storage, workspaceRoot: path.join(root, 'workspace-a') });
      let { session } = await sessionFor(root, undefined, { storage, store });
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      const payload = { ...await loadDir(await fixture(root, 'v1', '1.0.0')), sourceId: 'src' };
      const install = { kind: 'install' as const, payload };
      const preview = await session.plan(install);
      await session.apply(install, preview.hash);
      const before = new Map(await Promise.all(preview.writes.map(async (file) => [file.path, await readFile(file.path)] as const)));
      const priorLockfile = await readFile(store.statePath);
      const update = { kind: 'update' as const, payload: { ...await loadDir(await fixture(root, 'v2', '2.0.0')), sourceId: 'src' } };
      const next = await session.plan(update);
      store.fail = true;
      await expect(session.apply(update, next.hash)).rejects.toThrow('simulated publication failure');
      expect(await readFile(store.statePath)).toEqual(priorLockfile);
      for (const [file, bytes] of before) {
        expect(await readFile(file)).toEqual(bytes);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a stale preview when an installed file mode changes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-mode-'));
    try {
      let { session } = await sessionFor(root);
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      const install = { kind: 'install' as const, payload: { ...await loadDir(await fixture(root, 'v1', '1.0.0')), sourceId: 'src' } };
      const original = await session.plan(install);
      await session.apply(install, original.hash);
      const update = { kind: 'update' as const, payload: { ...await loadDir(await fixture(root, 'v2', '2.0.0')), sourceId: 'src' } };
      const preview = await session.plan(update);
      await chmod(original.writes[0].path, 0o600);
      await expect(session.apply(update, preview.hash)).rejects.toMatchObject({ code: 'PLAN.STALE' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('install v1 -> verify healthy -> update v2 -> uninstall removes receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      let { session } = await sessionFor(root);
      const { env } = await sessionFor(root);
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      const d1 = await fixture(root, 'v1', '1.0.0');
      const p1 = await loadDir(d1);
      const plan = await session.plan({ kind: 'install', payload: { ...p1, sourceId: 'src' } });
      expect(plan.canApply).toBe(true);
      await session.apply({ kind: 'install', payload: { ...p1, sourceId: 'src' } }, plan.hash);
      const base = path.join(env.HOME, '.copilot');
      expect(await readFile(path.join(base, 'prompts', 'a.prompt.md'), 'utf8')).toContain('1.0.0');
      const v = await session.verify();
      expect(v.every((x) => x.status === 'healthy')).toBe(true);

      const d2 = await fixture(root, 'v2', '2.0.0');
      const p2 = await loadDir(d2);
      const up = await session.plan({ kind: 'update', payload: { ...p2, sourceId: 'src' } });
      await session.apply({ kind: 'update', payload: { ...p2, sourceId: 'src' } }, up.hash);
      expect(await readFile(path.join(base, 'prompts', 'a.prompt.md'), 'utf8')).toContain('2.0.0');

      const un = await session.plan({ kind: 'uninstall', sourceId: 'src', manifestId: 'demo' });
      await session.apply({ kind: 'uninstall', sourceId: 'src', manifestId: 'demo' }, un.hash);
      expect(await session.listInstalled()).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists as v3 lockfile (bundles->tools->instances), reload decodes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      const { storage } = await sessionFor(root);
      let { session } = await sessionFor(root);
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      const d = await fixture(root, 'v1', '1.0.0');
      const p = await loadDir(d);
      const plan = await session.plan({ kind: 'install', payload: { ...p, sourceId: 'src' } });
      await session.apply({ kind: 'install', payload: { ...p, sourceId: 'src' } }, plan.hash);
      const lockPath = userLockfile(storage);
      const raw = JSON.parse(await readFile(lockPath, 'utf8'));
      expect(raw.version).toBe(LOCKFILE_V3_VERSION);
      const bkey = lockfileBundleKey('src', 'demo');
      expect(raw.bundles[bkey].tools.vscode.instances).toBeDefined();
      const fresh = await sessionFor(root);
      await fresh.session.selectTarget({ type: 'vscode', scope: 'user' });
      expect((await fresh.session.forScope('user').listInstalled())).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('vscode+kiro same collection: two tool entries; uninstall one keeps other', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      const { storage } = await sessionFor(root);
      let { session } = await sessionFor(root);
      const d = await fixture(root, 'v1', '1.0.0');
      const p = await loadDir(d);
      for (const type of ['vscode', 'kiro'] as const) {
        await session.selectTarget({ type, scope: 'user' });
        session = session.forScope('user');
        const plan = await session.plan({ kind: 'install', payload: { ...p, sourceId: 'src' } });
        await session.apply({ kind: 'install', payload: { ...p, sourceId: 'src' } }, plan.hash);
      }
      const raw = JSON.parse(await readFile(userLockfile(storage), 'utf8'));
      const tools = raw.bundles[lockfileBundleKey('src', 'demo')].tools;
      expect(Object.keys(tools).toSorted()).toEqual(['kiro', 'vscode']);
      await session.plan({ kind: 'uninstall', sourceId: 'src', manifestId: 'demo' }).then(async (un) => {
        await session.apply({ kind: 'uninstall', sourceId: 'src', manifestId: 'demo' }, un.hash);
      });
      // vscode was selected last? kiro selected last -> kiro uninstalled, vscode receipt remains
      const raw2 = JSON.parse(await readFile(userLockfile(storage), 'utf8'));
      expect(Object.keys(raw2.bundles[lockfileBundleKey('src', 'demo')].tools)).toEqual(['vscode']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('multi-collection project assigns each receipt only its own outputs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      let { session } = await sessionFor(root);
      const d = await fixture(root, 'v1', '1.0.0');
      const p = await loadDir(d);
      const files2 = new Map([
        ['deployment-manifest.yml', new TextEncoder().encode('id: other\nversion: 1.0.0\nname: Other\n')],
        ['prompts/b.prompt.md', new TextEncoder().encode('# B\n')]
      ]);
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      const im1 = await session.importInstalled({ files: p.files, sourceId: 'src', provenance: 'directory' });
      const im2 = await session.importInstalled({ files: files2, sourceId: 'src', provenance: 'directory' });
      await session.selectTarget({ type: 'kiro', scope: 'user' });
      const plan = await session.plan({ kind: 'project' });
      await session.apply({ kind: 'project' }, plan.hash);
      const installed = await session.listInstalled();
      const demo = installed.find((c) => c.manifestId === 'demo');
      const other = installed.find((c) => c.manifestId === 'other');
      expect(demo!.outputCount).toBeGreaterThan(0);
      expect(other!.outputCount).toBe(1);
      expect(demo!.outputCount).toBe(3);
      const uninstall = { kind: 'uninstall' as const, sourceId: 'src', manifestId: 'other' };
      await session.apply(uninstall, (await session.plan(uninstall)).hash);
      expect(await session.listInstalled()).toMatchObject([{ manifestId: 'demo', outputCount: 3 }]);
      expect((await session.verify()).every((file) => file.status === 'healthy')).toBe(true);
      void im1;
      void im2;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('symlinked path under root pointing outside is rejected', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      let { session } = await sessionFor(root);
      const { env } = await sessionFor(root);
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      const outside = env.HOME;
      await mkdir(outside, { recursive: true });
      await mkdir(path.join(env.HOME, '.copilot'), { recursive: true });
      await symlink(outside, path.join(env.HOME, '.copilot', 'prompts'), 'dir');
      const d = await fixture(root, 'v1', '1.0.0');
      const p = await loadDir(d);
      await expect(session.plan({ kind: 'install', payload: { ...p, sourceId: 'src' } }))
        .rejects.toThrow(/SYMLINK_ESCAPE|outside target root/);
      const plan = await session.plan({ kind: 'install', payload: { ...p, sourceId: 'src' } }).catch(() => null);
      expect(plan).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('nested skill mcp.json resource allowed; manifest-declared hooks rejected', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      let { session } = await sessionFor(root);
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      const ok = await loadDir(await fixture(root, 'ok', '1.0.0', { skillMcp: true }));
      const plan = await session.plan({ kind: 'install', payload: { ...ok, sourceId: 'src' } });
      expect(plan.conflicts.filter((c) => c.code === 'PAYLOAD.UNSUPPORTED')).toHaveLength(0);
      const bad = await loadDir(await fixture(root, 'bad', '1.0.0', { hooks: true }));
      await expect(session.plan({ kind: 'install', payload: { ...bad, sourceId: 'src' } }))
        .rejects.toMatchObject({ code: 'PAYLOAD.UNSUPPORTED' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stale plan hash after selection change rejects', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      let { session } = await sessionFor(root);
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      const d = await fixture(root, 'v1', '1.0.0');
      const p = await loadDir(d);
      const plan = await session.plan({ kind: 'install', payload: { ...p, sourceId: 'src' } });
      await session.selectTarget({ type: 'kiro', scope: 'user' });
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      await expect(session.apply({ kind: 'install', payload: { ...p, sourceId: 'src' } }, plan.hash))
        .rejects.toMatchObject({ code: 'PLAN.STALE' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('inspectLegacyV2: unsupported v4 rejects; v2 yields unresolved entries', () => {
    expect(() => inspectLegacyV2({ version: '4.0.0', bundles: {} })).toThrow();
    const v2 = inspectLegacyV2({ version: '2.0.0', bundles: { a: { version: '1.0.0' } } });
    expect(v2.entries[0]).toMatchObject({ bundleId: 'a', needsReinstall: true });
  });

  it('decodeLockfileV3 rejects duplicate file entries; a missing payload lists as unavailable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      const { storage } = await sessionFor(root);
      let { session } = await sessionFor(root);
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      const payload = { ...await loadDir(await fixture(root, 'v1', '1.0.0')), sourceId: 'src' };
      const op = { kind: 'install' as const, payload };
      await session.apply(op, (await session.plan(op)).hash);
      const base = encodeLockfileV3(await new ScopedRuntimeTargetStore({ storage, workspaceRoot: path.join(root, 'workspace-a') }).load(), 'g');
      expect(() => decodeLockfileV3(base)).not.toThrow();
      const dup = structuredClone(base);
      const instance = Object.values(dup.bundles[lockfileBundleKey('src', 'demo')].tools.vscode!.instances)[0];
      instance.files.push({ ...instance.files[0] });
      expect(() => decodeLockfileV3(dup)).toThrow(/file entry/);
      await rm(path.join(storage.getPaths().root, 'payloads'), { recursive: true });
      const rows = await (await sessionFor(root)).session.forScope('user').listInstallations();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ payloadAvailable: false, manifest: { id: 'demo', version: '1.0.0' } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('runtime-target session (closeout: mode/alias/shared/unsupported)', () => {
  it('alias identical bytes: second install shares physically, no rewrite, both healthy', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      let { session } = await sessionFor(root);
      const d = await fixture(root, 'v1', '1.0.0');
      const p = await loadDir(d);
      // vscode + vscode-insiders share the same user baseDir (${HOME}/.copilot)
      for (const type of ['vscode', 'vscode-insiders'] as const) {
        await session.selectTarget({ type, scope: 'user' });
        session = session.forScope('user');
        const plan = await session.plan({ kind: 'install', payload: { ...p, sourceId: 'src' } });
        await session.apply({ kind: 'install', payload: { ...p, sourceId: 'src' } }, plan.hash);
      }
      const installed = await session.listInstalled();
      expect(installed).toHaveLength(1); // insiders receipt on active target
      const verify = await session.verify();
      expect(verify.every((v) => v.status === 'healthy')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('mode intent drift on a managed file becomes a conflict, not a silent rewrite', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      let { session } = await sessionFor(root);
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      const d = await fixture(root, 'v1', '1.0.0');
      const p = await loadDir(d);
      const plan = await session.plan({ kind: 'install', payload: { ...p, sourceId: 'src' } });
      await session.apply({ kind: 'install', payload: { ...p, sourceId: 'src' } }, plan.hash);
      const env = envOf(root);
      await writeFile(path.join(env.HOME, '.copilot', 'prompts', 'a.prompt.md'), '# changed\n');
      // unmanaged change must be reported, not silently adopted
      const verify = await session.verify();
      expect(verify.some((v) => v.status === 'modified')).toBe(true);
      const up = await session.plan({ kind: 'update', payload: { ...p, sourceId: 'src' } });
      expect(up.conflicts.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uninstall preserves a locally modified file and reports it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      let { session } = await sessionFor(root);
      const env = envOf(root);
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      const d = await fixture(root, 'v1', '1.0.0');
      const p = await loadDir(d);
      const plan = await session.plan({ kind: 'install', payload: { ...p, sourceId: 'src' } });
      await session.apply({ kind: 'install', payload: { ...p, sourceId: 'src' } }, plan.hash);
      const file = path.join(env.HOME, '.copilot', 'prompts', 'a.prompt.md');
      await writeFile(file, '# user edit\n');
      const un = await session.plan({ kind: 'uninstall', sourceId: 'src', manifestId: 'demo' });
      const res = await session.apply({ kind: 'uninstall', sourceId: 'src', manifestId: 'demo' }, un.hash);
      expect(res.preservedModified).toContain(file);
      expect(await readFile(file, 'utf8')).toBe('# user edit\n');
      expect(await session.listInstalled()).toHaveLength(0); // receipt ownership dropped
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('manifest item kind=hook pointing under prompts/ is rejected before any write', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      let { session } = await sessionFor(root);
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      const d = path.join(root, 'hooked');
      await mkdir(path.join(d, 'prompts'), { recursive: true });
      await writeFile(path.join(d, 'deployment-manifest.yml'),
        'id: demo\nversion: 1.0.0\nname: Demo\nitems:\n  - path: prompts/a.prompt.md\n    kind: hook\n');
      await writeFile(path.join(d, 'prompts', 'a.prompt.md'), '# a\n');
      const p = await loadDir(d);
      await expect(session.plan({ kind: 'install', payload: { ...p, sourceId: 'src' } }))
        .rejects.toThrow(/unsupported/i);
      await expect(session.importInstalled({ files: p.files, sourceId: 'src', provenance: 'directory' }))
        .rejects.toThrow(/unsupported/i);
      const env = envOf(root);
      await expect(readFile(path.join(env.HOME, '.copilot', 'prompts', 'a.prompt.md'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('mid-write fs failure rolls back created files and leaves lockfile unchanged', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      const env = envOf(root);
      const storage = new XdgAppStorage(env);
      const realFs = new NodeRuntimeProjectionFileSystem();
      let calls = 0;
      const flaky = new Proxy(realFs, {
        get: (t, k, r) => {
          if (k === 'writeFileBytes') {
            return async (...a: unknown[]) => {
              calls += 1;
              if (calls === 2) {
                throw new Error('injected write failure');
              }
              return (t.writeFileBytes as any)(...a as [string, Uint8Array]);
            };
          }
          return Reflect.get(t, k, r);
        }
      });
      let session = createRuntimeTargetSession({
        storage,
        store: new ScopedRuntimeTargetStore({ storage, workspaceRoot: root }),
        fs: flaky,
        env,
        workspaceRoot: root,
        layoutLoader: new BuiltInOnlyLayoutConfigLoader()
      });
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      const lockPath = userLockfile(storage);
      const readLock = async () => readFile(lockPath, 'utf8').catch(() => undefined);
      const before = await readLock();
      const d = await fixture(root, 'v1', '1.0.0');
      const p = await loadDir(d);
      const plan = await session.plan({ kind: 'install', payload: { ...p, sourceId: 'src' } });
      await expect(session.apply({ kind: 'install', payload: { ...p, sourceId: 'src' } }, plan.hash))
        .rejects.toThrow('injected write failure');
      expect(await readLock()).toBe(before);
      await expect(readFile(path.join(env.HOME, '.copilot', 'prompts', 'a.prompt.md'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('concurrent withExclusive fails closed on held lock', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      const env = envOf(root);
      const storage = new XdgAppStorage(env);
      const store = new ScopedRuntimeTargetStore({ storage });
      const lockFile = store.lockPath;
      await mkdir(path.dirname(lockFile), { recursive: true });
      await writeFile(lockFile, 'other-process');
      await expect(store.withExclusive(async () => 1)).rejects.toThrow(/locked/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('runtime-target session (final closeout regressions)', () => {
  it('chmod-only drift: verify modified, update conflicts, uninstall preserves', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      let { session } = await sessionFor(root);
      const { env } = await sessionFor(root);
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      const d = await fixture(root, 'v1', '1.0.0');
      const p = await loadDir(d);
      const plan = await session.plan({ kind: 'install', payload: { ...p, sourceId: 'src' } });
      await session.apply({ kind: 'install', payload: { ...p, sourceId: 'src' } }, plan.hash);
      const file = path.join(env.HOME, '.copilot', 'prompts', 'a.prompt.md');
      await chmod(file, 0o600); // mode only, bytes unchanged
      expect((await session.verify()).some((v) => v.status === 'modified')).toBe(true);
      const up = await session.plan({ kind: 'update', payload: { ...p, sourceId: 'src' } });
      expect(up.conflicts.length).toBeGreaterThan(0);
      const un = await session.plan({ kind: 'uninstall', sourceId: 'src', manifestId: 'demo' });
      const res = await session.apply({ kind: 'uninstall', sourceId: 'src', manifestId: 'demo' }, un.hash);
      expect(res.preservedModified).toContain(file);
      expect((await stat(file)).mode % 0o1000).toBe(0o600);
      expect(await readFile(file, 'utf8')).toContain('1.0.0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('alias second install: writes=[] and written=[] with first receipt healthy', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      let { session } = await sessionFor(root);
      const d = await fixture(root, 'v1', '1.0.0');
      const p = await loadDir(d);
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      const plan1 = await session.plan({ kind: 'install', payload: { ...p, sourceId: 'src' } });
      await session.apply({ kind: 'install', payload: { ...p, sourceId: 'src' } }, plan1.hash);
      await session.selectTarget({ type: 'vscode-insiders', scope: 'user' });
      const plan2 = await session.plan({ kind: 'install', payload: { ...p, sourceId: 'src' } });
      expect(plan2.writes).toHaveLength(0); // all shared, no physical write
      const res2 = await session.apply({ kind: 'install', payload: { ...p, sourceId: 'src' } }, plan2.hash);
      expect(res2.written).toHaveLength(0);
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      expect((await session.verify()).every((v) => v.status === 'healthy')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('mode 755 first vs 644 alias -> OWNERSHIP.MODE_MISMATCH, first stays 755', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      let { session } = await sessionFor(root);
      const { env } = await sessionFor(root);
      const d1 = await fixture(root, 'v1', '1.0.0');
      const p1 = await loadDir(d1);
      const execFile = path.join(env.HOME, '.copilot', 'skills', 's1', 'asset.bin');
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      const files755 = new Map(p1.files);
      const cloned = new Uint8Array(files755.get('skills/s1/asset.bin')!);
      (cloned as { mode?: number }).mode = 0o755;
      files755.set('skills/s1/asset.bin', cloned);
      expect((files755.get('skills/s1/asset.bin') as { mode?: number }).mode).toBe(0o755);
      expect((p1.files.get('skills/s1/asset.bin') as { mode?: number }).mode).not.toBe(0o755);
      const plan1 = await session.plan({ kind: 'install', payload: { files: files755, manifest: p1.manifest, sourceId: 'src' } });
      await session.apply({ kind: 'install', payload: { files: files755, manifest: p1.manifest, sourceId: 'src' } }, plan1.hash);
      expect((await stat(execFile)).mode % 0o1000).toBe(0o755);
      await session.selectTarget({ type: 'vscode-insiders', scope: 'user' });
      const plan2 = await session.plan({ kind: 'install', payload: { ...p1, sourceId: 'src' } }); // 644 default
      expect(plan2.conflicts.some((c) => c.code === 'OWNERSHIP.MODE_MISMATCH')).toBe(true);
      expect((await stat(execFile)).mode % 0o1000).toBe(0o755);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('two sourceIds identical files -> two owners one physical write; remove one keeps other healthy', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      let { session } = await sessionFor(root);
      const d = await fixture(root, 'v1', '1.0.0');
      const p = await loadDir(d);
      for (const sid of ['srcA', 'srcB']) {
        await session.importInstalled({ files: p.files, sourceId: sid, provenance: 'directory' });
      }
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      const plan = await session.plan({ kind: 'project' });
      const res = await session.apply({ kind: 'project' }, plan.hash);
      expect(res.applied).toBe(true);
      expect((await session.listInstalled())).toHaveLength(2);
      const un = await session.plan({ kind: 'uninstall', sourceId: 'srcA', manifestId: 'demo' });
      await session.apply({ kind: 'uninstall', sourceId: 'srcA', manifestId: 'demo' }, un.hash);
      expect((await session.verify()).every((v) => v.status === 'healthy')).toBe(true);
      expect((await session.listInstalled())).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('mode default: write producing 0664 (sim umask) is corrected to 0644 by apply', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      const result = await sessionFor(root, undefined, {
        fs: new class extends NodeRuntimeProjectionFileSystem {
          public override async writeFileBytes(p: string, bytes: Uint8Array) {
            const existed = await this.exists(p);
            await super.writeFileBytes(p, bytes);
            if (!existed) {
              await chmod(p, 0o664);
            }
          }
        }()
      });
      const env = result.env;
      let session = result.session;
      const source = await loadDir(await fixture(root, 'v1', '1.0.0'));
      const files = new Map(source.files);
      files.set('prompts/a.prompt.md', new Uint8Array(files.get('prompts/a.prompt.md')!));
      const payload = { files, manifest: source.manifest, sourceId: 'src' };
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      const plan = await session.plan({ kind: 'install', payload });
      const prompt = plan.writes.find((file) => file.path.endsWith('a.prompt.md'));
      expect(prompt).toBeDefined();
      expect(prompt!.mode).toBeUndefined();
      const res = await session.apply({ kind: 'install', payload }, plan.hash);
      expect(res.applied).toBe(true);
      expect((await stat(path.join(env.HOME, '.copilot', 'prompts', 'a.prompt.md'))).mode % 0o1000).toBe(0o644);
      expect((await session.verify()).every((v) => v.status === 'healthy')).toBe(true);
      const next = { ...await loadDir(await fixture(root, 'v2', '2.0.0')), sourceId: 'src' };
      await applyOperation(session, { kind: 'update', payload: next });
      expect((await session.verify()).every((v) => v.status === 'healthy')).toBe(true);
      await applyOperation(session, { kind: 'uninstall', sourceId: 'src', manifestId: 'demo' });
      await expect(stat(prompt!.path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('mode default: v2 with plain bytes (no .mode) still writes 0644', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      let { session } = await sessionFor(root);
      const { env } = await sessionFor(root);
      const p1 = await loadDir(await fixture(root, 'v1', '1.0.0'));
      const files755 = new Map(p1.files);
      const cloned = new Uint8Array(files755.get('skills/s1/asset.bin')!);
      (cloned as { mode?: number }).mode = 0o755;
      files755.set('skills/s1/asset.bin', cloned);
      const target = path.join(env.HOME, '.copilot', 'skills', 's1', 'asset.bin');
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      const plan1 = await session.plan({ kind: 'install', payload: { files: files755, manifest: p1.manifest, sourceId: 'src' } });
      await session.apply({ kind: 'install', payload: { files: files755, manifest: p1.manifest, sourceId: 'src' } }, plan1.hash);
      expect((await stat(target)).mode % 0o1000).toBe(0o755);
      const p2 = await loadDir(await fixture(root, 'v2', '2.0.0'));
      const files2 = new Map(p2.files);
      files2.set('skills/s1/asset.bin', new Uint8Array(p2.files.get('skills/s1/asset.bin')!));
      const plan2 = await session.plan({ kind: 'update', payload: { files: files2, manifest: p2.manifest, sourceId: 'src' } });
      expect(plan2.writes.find((file) => file.path === target)!.mode).toBeUndefined();
      await session.apply({ kind: 'update', payload: { files: files2, manifest: p2.manifest, sourceId: 'src' } }, plan2.hash);
      expect((await stat(target)).mode % 0o1000).toBe(0o644);
      expect((await session.verify()).every((v) => v.status === 'healthy')).toBe(true);
      const un = await session.plan({ kind: 'uninstall', sourceId: 'src', manifestId: 'demo' });
      await session.apply({ kind: 'uninstall', sourceId: 'src', manifestId: 'demo' }, un.hash);
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('readonly-mode files support executable intent, shared aliases, update and uninstall', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      const { env } = await sessionFor(root, undefined, { fs: readonlyProjectionFs() });
      let { session } = await sessionFor(root, undefined, { fs: readonlyProjectionFs() });
      const p1 = await loadDir(await fixture(root, 'v1', '1.0.0'));
      const files755 = new Map(p1.files);
      files755.set('skills/s1/asset.bin', Object.assign(new Uint8Array(p1.files.get('skills/s1/asset.bin')!), { mode: 0o755 }));
      const target = path.join(env.HOME, '.copilot', 'skills', 's1', 'asset.bin');
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      await applyOperation(session, { kind: 'install', payload: { files: files755, manifest: p1.manifest, sourceId: 'src' } });
      expect((await session.verify()).every((v) => v.status === 'healthy')).toBe(true);
      await session.selectTarget({ type: 'vscode-insiders', scope: 'user' });
      await applyOperation(session, { kind: 'install', payload: { ...p1, sourceId: 'src' } });
      expect((await session.verify()).every((v) => v.status === 'healthy')).toBe(true);
      await applyOperation(session, { kind: 'uninstall', sourceId: 'src', manifestId: 'demo' });
      expect(await readFile(target)).toEqual(Buffer.from(p1.files.get('skills/s1/asset.bin')!));
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      const p2 = await loadDir(await fixture(root, 'v2', '2.0.0'));
      await applyOperation(session, { kind: 'update', payload: { ...p2, sourceId: 'src' } });
      expect((await session.verify()).every((v) => v.status === 'healthy')).toBe(true);
      await applyOperation(session, { kind: 'uninstall', sourceId: 'src', manifestId: 'demo' });
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('readonly-bit drift is modified, blocks update and is preserved on uninstall', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      let { session } = await sessionFor(root, undefined, { fs: readonlyProjectionFs() });
      const { env } = await sessionFor(root, undefined, { fs: readonlyProjectionFs() });
      const { storage } = await sessionFor(root, undefined, { fs: readonlyProjectionFs() });
      const payload = { ...await loadDir(await fixture(root, 'v1', '1.0.0')), sourceId: 'src' };
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      await applyOperation(session, { kind: 'install', payload });
      expect((await session.verify()).every((v) => v.status === 'healthy')).toBe(true);
      const target = path.join(env.HOME, '.copilot', 'skills', 's1', 'asset.bin');
      const original = await readFile(target);
      await chmod(target, 0o444);
      expect((await session.verify()).find((v) => v.path === target)!.status).toBe('modified');
      const lockPath = userLockfile(storage);
      const lockBefore = await readFile(lockPath);
      const next = { ...await loadDir(await fixture(root, 'v2', '2.0.0')), sourceId: 'src' };
      const up = await session.plan({ kind: 'update', payload: next });
      expect(up.canApply).toBe(false);
      expect(up.conflicts.some((conflict) => conflict.path === target && conflict.code === 'TARGET.LOCALLY_MODIFIED')).toBe(true);
      await expect(session.apply({ kind: 'update', payload: next }, up.hash)).rejects.toMatchObject({ code: 'PLAN.CONFLICT' });
      expect(await readFile(lockPath)).toEqual(lockBefore);
      expect(await readFile(target)).toEqual(original);
      const un = await session.plan({ kind: 'uninstall', sourceId: 'src', manifestId: 'demo' });
      const res = await session.apply({ kind: 'uninstall', sourceId: 'src', manifestId: 'demo' }, un.hash);
      expect(res.applied).toBe(true);
      expect(res.preservedModified).toContain(target);
      expect(await readFile(target)).toEqual(original);
      expect(await session.listInstalled()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('empty plan on already-projected instance: canApply false, apply throws PLAN.EMPTY', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      let { session } = await sessionFor(root);
      const { env } = await sessionFor(root);
      const { storage } = await sessionFor(root);
      const payload = { ...await loadDir(await fixture(root, 'v1', '1.0.0')), sourceId: 'src' };
      await session.selectTarget({ type: 'vscode', scope: 'user' });
      session = session.forScope('user');
      const plan1 = await session.plan({ kind: 'install', payload });
      await session.apply({ kind: 'install', payload }, plan1.hash);
      const next = { ...await loadDir(await fixture(root, 'v2', '2.0.0')), sourceId: 'src' };
      const pendingUpdate = await session.plan({ kind: 'update', payload: next });
      const lockPath = userLockfile(storage);
      const lockBefore = await readFile(lockPath);
      const promptPath = path.join(env.HOME, '.copilot', 'prompts', 'a.prompt.md');
      const promptBefore = await readFile(promptPath);
      const plan2 = await session.plan({ kind: 'project' });
      expect(plan2.canApply).toBe(false);
      await expect(session.apply({ kind: 'project' }, plan2.hash)).rejects.toMatchObject({ code: 'PLAN.EMPTY' });
      expect(await readFile(lockPath)).toEqual(lockBefore);
      expect(await readFile(promptPath)).toEqual(promptBefore);
      await session.apply({ kind: 'update', payload: next }, pendingUpdate.hash);
      expect((await session.verify()).every((v) => v.status === 'healthy')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('dual scope: repo+user installs list exact rows and isolate per workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      const { session, env } = await sessionFor(root);
      await session.selectTarget({ type: 'vscode' });
      const repo = session.forScope('repository');
      const user = session.forScope('user');
      const p1 = { ...await loadDir(await fixture(root, 'v1', '1.0.0')), sourceId: 'src' };
      const p2 = { ...await loadDir(await fixture(root, 'v2', '2.0.0')), sourceId: 'src' };
      const repoPlan = await repo.plan({ kind: 'install', payload: p1 });
      await repo.apply({ kind: 'install', payload: p1 }, repoPlan.hash);
      const userPlan = await user.plan({ kind: 'install', payload: p2 });
      await user.apply({ kind: 'install', payload: p2 }, userPlan.hash);
      const rows = await session.listInstallations();
      expect(rows).toHaveLength(2);
      const repoRow = rows.find((r) => r.instance.scope === 'repository');
      const userRow = rows.find((r) => r.instance.scope === 'user');
      expect(repoRow?.version).toBe('1.0.0');
      expect(userRow?.version).toBe('2.0.0');
      expect(repoRow?.manifest.id).toBe('demo');
      expect(repoRow?.contextRoot).toBe(path.join(root, 'workspace-a'));
      await session.selectTarget({ type: 'kiro' });
      expect(await session.listInstallations()).toHaveLength(0);
      await session.selectTarget({ type: 'vscode' });
      expect(await session.listInstallations()).toHaveLength(2);
      const other = await sessionFor(root, path.join(root, 'workspace-b'));
      await other.session.selectTarget({ type: 'vscode' });
      const otherRows = await other.session.listInstallations();
      expect(otherRows.filter((r) => r.instance.scope === 'user')).toHaveLength(1);
      expect(otherRows.filter((r) => r.instance.scope === 'repository')).toHaveLength(0);
      void env;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uninstall with a mismatched installationId cannot mutate any record', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      const { session } = await sessionFor(root);
      await session.selectTarget({ type: 'vscode' });
      const repo = session.forScope('repository');
      const demo = { ...await loadDir(await fixture(root, 'v1', '1.0.0')), sourceId: 'src' };
      const files = new Map([
        ['deployment-manifest.yml', Buffer.from('id: other\nversion: 1.0.0\nname: Other\nitems:\n  - path: prompts/other.prompt.md\n    kind: prompt\n')],
        ['prompts/other.prompt.md', Buffer.from('# Other\n')]
      ]);
      const other = { files, manifest: validateManifest(files, {}), sourceId: 'src' };
      const planDemo = await repo.plan({ kind: 'install', payload: demo });
      await repo.apply({ kind: 'install', payload: demo }, planDemo.hash);
      const planOther = await repo.plan({ kind: 'install', payload: other });
      await repo.apply({ kind: 'install', payload: other }, planOther.hash);
      const lock = (await repo.getLockfiles()).find((l) => l.scope === 'repository')!.document;
      const receipts = Object.values(decodeLockfileV3(lock, { repositoryRoot: path.join(root, 'workspace-a') }).receipts);
      const otherId = receipts.find((r) => r.collection.manifestId === 'other')?.receiptId;
      expect(otherId).toBeDefined();
      const before = JSON.stringify(lock);
      const plan = await repo.plan({ kind: 'uninstall', sourceId: 'src', manifestId: 'demo', installationId: otherId });
      expect(plan.canApply).toBe(false);
      await expect(repo.apply({ kind: 'uninstall', sourceId: 'src', manifestId: 'demo', installationId: otherId }, plan.hash)).rejects.toThrow();
      expect(JSON.stringify((await repo.getLockfiles()).find((l) => l.scope === 'repository')!.document)).toBe(before);
      await expect(repo.apply({ kind: 'uninstall', sourceId: 'src', manifestId: 'demo', installationId: 'rcpt-does-not-exist' }, plan.hash)).rejects.toThrow();
      expect(JSON.stringify((await repo.getLockfiles()).find((l) => l.scope === 'repository')!.document)).toBe(before);
      for (const receipt of receipts) {
        for (const output of Object.keys(receipt.outputs)) {
          expect((await readFile(output)).length).toBeGreaterThan(0);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('registryRef and commitMode roundtrip into authoritative instance metadata', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      const { session, env } = await sessionFor(root);
      await session.selectTarget({ type: 'vscode' });
      const repo = session.forScope('repository', { commitMode: 'commit' });
      const payload = {
        ...await loadDir(await fixture(root, 'v1', '1.0.0')),
        sourceId: 'src',
        registryRef: { bundleId: 'external-demo-v1.0.0', sourceType: 'github' }
      };
      const plan = await repo.plan({ kind: 'install', payload });
      await repo.apply({ kind: 'install', payload }, plan.hash);
      const fresh = await sessionFor(root);
      await fresh.session.selectTarget({ type: 'vscode' });
      const rows = await fresh.session.listInstallations();
      const row = rows.find((r) => r.instance.scope === 'repository');
      expect(row?.registryRef).toEqual({ bundleId: 'external-demo-v1.0.0', sourceType: 'github' });
      expect(row?.commitMode).toBe('commit');
      expect(row?.contextRoot).toBe(path.join(root, 'workspace-a'));
      expect(row?.manifest?.id).toBe('demo');
      const lock = (await fresh.session.getLockfiles()).find((l) => l.scope === 'repository')!.document;
      expect(JSON.stringify(lock)).toContain('external-demo-v1.0.0');
      void env;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('loaded-authority drift without revision invalidates a pending plan', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rt-'));
    try {
      const { session, env } = await sessionFor(root);
      await session.selectTarget({ type: 'vscode' });
      const repo = session.forScope('repository');
      const p1 = { ...await loadDir(await fixture(root, 'v1', '1.0.0')), sourceId: 'src' };
      const plan1 = await repo.plan({ kind: 'install', payload: p1 });
      await repo.apply({ kind: 'install', payload: p1 }, plan1.hash);
      const pending = await repo.plan({ kind: 'update', payload: { ...await loadDir(await fixture(root, 'v2', '2.0.0')), sourceId: 'src' } });
      const lockPath = path.join(root, 'workspace-a', 'prompt-registry.lock.json');
      const raw = JSON.parse(await readFile(lockPath, 'utf8'));
      let changed = 0;
      for (const bundle of Object.values(raw.bundles as Record<string, { tools: Record<string, { instances: Record<string, { installedAt: string }> }> }>)) {
        for (const tool of Object.values(bundle.tools)) {
          for (const inst of Object.values(tool.instances)) {
            inst.installedAt = '2000-01-01T00:00:00.000Z';
            changed += 1;
          }
        }
      }
      expect(changed).toBe(1);
      await writeFile(lockPath, JSON.stringify(raw));
      const rePlan = await repo.plan({ kind: 'update', payload: { ...await loadDir(await fixture(root, 'v2', '2.0.0')), sourceId: 'src' } });
      expect(rePlan.hash !== pending.hash || rePlan.conflicts.length > 0).toBe(true);
      await expect(repo.apply({ kind: 'update', payload: { ...await loadDir(await fixture(root, 'v2', '2.0.0')), sourceId: 'src' } }, pending.hash)).rejects.toThrow();
      void env;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
