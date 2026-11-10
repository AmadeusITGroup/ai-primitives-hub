import {
  createHash,
} from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  decodeLockfileV3,
  emptyRuntimeTargetState,
  LOCKFILE_V3_SCHEMA_ID,
  LOCKFILE_V3_VERSION,
  runtimePayloadId,
  runtimeReceiptId,
  type RuntimeTargetState,
  validateRuntimePayload,
} from '@ai-primitives-hub/core';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  ScopedRuntimeTargetStore,
} from '../../src/runtime-target/scoped-runtime-target-store';
import {
  XdgAppStorage,
} from '../../src/storage/xdg-app-storage';

const roots: string[] = [];
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rt-scoped-'));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  const storage = new XdgAppStorage({
    HOME: path.join(root, 'home'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache')
  });
  const options = { storage, workspaceRoot: workspace };
  const store = new ScopedRuntimeTargetStore({ ...options, toolVersion: '1.2.3' });
  return {
    root, workspace, storage, store, options,
    repoFile: path.join(workspace, 'prompt-registry.lock.json'),
    selectionFile: path.join(root, 'state', 'ai-primitives-hub', 'target-selection.json'),
    payloadsDir: path.join(root, 'data', 'ai-primitives-hub', 'payloads'),
    importsFile: path.join(root, 'data', 'ai-primitives-hub', 'imports.json')
  };
}

function addReceipt(state: RuntimeTargetState, scope: 'user' | 'repository', root: string, contextRoot?: string, version = '1.0.0') {
  const files = new Map([
    ['deployment-manifest.yml', Buffer.from(`id: demo\nversion: ${version}\nname: Demo\n`)],
    ['prompts/a.prompt.md', Buffer.from(`# ${version}\n`)]
  ]);
  const payload = validateRuntimePayload(files, 'src');
  const payloadId = runtimePayloadId('src', payload.manifest, payload.files);
  state.payloads[payloadId] = {
    ...payload, payloadId, sourceId: 'src', manifestId: 'demo', version,
    createdAt: '2026-01-01T00:00:00.000Z'
  };
  const receiptId = runtimeReceiptId('devin', scope, root, 'src', 'demo', contextRoot);
  state.receipts[receiptId] = {
    receiptId, instance: { type: 'devin', scope, root },
    collection: { sourceId: 'src', manifestId: 'demo' },
    payloadId, version, installedAt: '2026-01-01T00:00:00.000Z',
    outputs: {
      [path.join(root, '.devin/rules/a.prompt.md')]: {
        sha256: `sha256:${createHash('sha256').update(files.get('prompts/a.prompt.md')!).digest('hex')}`,
        mode: 0o644
      }
    },
    ...(contextRoot === undefined ? {} : { contextRoot, commitMode: 'commit' as const })
  };
  state.revision += 1;
  return receiptId;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('ScopedRuntimeTargetStore', () => {
  it('publishes records-only scope lockfiles with the published schema URL and no schema copy', async () => {
    const { root, workspace, store, repoFile } = await setup();
    const state = emptyRuntimeTargetState();
    state.selections.workspaces[workspace] = { type: 'devin' };
    state.revision = 1;
    await store.withExclusive(() => store.save(state));
    await expect(fs.stat(repoFile)).rejects.toMatchObject({ code: 'ENOENT' });

    addReceipt(state, 'repository', workspace, workspace);
    addReceipt(state, 'user', path.join(root, 'home'), undefined, '2.0.0');
    await store.withExclusive(() => store.save(state));
    for (const [file, scope] of [[repoFile, 'repository'], [store.statePath, 'user']] as const) {
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      expect(raw.version).toBe(LOCKFILE_V3_VERSION);
      expect(raw.$schema).toBe(LOCKFILE_V3_SCHEMA_ID);
      expect(raw.generatedBy).toBe('ai-primitives-hub@1.2.3');
      expect(Object.keys(raw).toSorted()).toEqual(['$schema', 'bundles', 'generatedAt', 'generatedBy', 'sources', 'version']);
      expect(JSON.stringify(raw)).not.toMatch(/b64|poc/i);
      const rows = Object.values(decodeLockfileV3(raw, scope === 'repository' ? { repositoryRoot: workspace } : {}).receipts);
      expect(rows).toHaveLength(1);
      expect(rows[0].instance.scope).toBe(scope);
    }
    await expect(fs.stat(path.join(workspace, '.ai-primitives-hub'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(Object.values((await store.load()).receipts)).toHaveLength(2);
    await fs.rm(repoFile);
    expect(Object.values((await store.load()).receipts).map((r) => r.instance.scope)).toEqual(['user']);
  });

  it('keeps selection and revision in the state directory and payload bytes in the data directory', async () => {
    const { root, workspace, store, selectionFile, payloadsDir } = await setup();
    const state = emptyRuntimeTargetState();
    state.selections.workspaces[workspace] = { type: 'devin' };
    state.selections.userDefault = { type: 'kiro' };
    const id = addReceipt(state, 'user', path.join(root, 'home'));
    await store.withExclusive(() => store.save(state));

    const selection = JSON.parse(await fs.readFile(selectionFile, 'utf8'));
    expect(selection).toEqual({
      workspaces: { [workspace]: { type: 'devin' } },
      userDefault: { type: 'kiro' },
      revision: 1
    });
    const payloadId = state.receipts[id].payloadId;
    expect(await fs.readFile(path.join(payloadsDir, payloadId, 'files', 'prompts', 'a.prompt.md'), 'utf8')).toBe('# 1.0.0\n');
    expect(JSON.stringify(JSON.parse(await fs.readFile(store.statePath, 'utf8')))).not.toContain('# 1.0.0');

    const loaded = await store.load();
    expect(loaded.revision).toBe(1);
    expect(loaded.selections).toEqual(state.selections);
    expect(loaded.payloads[payloadId].manifest.id).toBe('demo');
    expect(Buffer.from(loaded.payloads[payloadId].files.get('prompts/a.prompt.md')!).toString()).toBe('# 1.0.0\n');
  });

  it('lists a receipt whose payload is missing instead of failing the whole state', async () => {
    const { root, store, payloadsDir } = await setup();
    const state = emptyRuntimeTargetState();
    const id = addReceipt(state, 'user', path.join(root, 'home'));
    await store.withExclusive(() => store.save(state));
    await fs.rm(payloadsDir, { recursive: true });
    const loaded = await store.load();
    expect(loaded.receipts[id]).toBeDefined();
    expect(loaded.payloads[state.receipts[id].payloadId]).toBeUndefined();
  });

  it('prunes payloads no receipt or import references after a save', async () => {
    const { root, store, payloadsDir } = await setup();
    const state = emptyRuntimeTargetState();
    const id = addReceipt(state, 'user', path.join(root, 'home'));
    await store.withExclusive(() => store.save(state));
    const first = state.receipts[id].payloadId;
    delete state.receipts[id];
    await store.withExclusive(() => store.save(state));
    expect(await fs.readdir(payloadsDir)).not.toContain(first);
  });

  it('keeps imports in imports.json and their payloads available', async () => {
    const { root, store, importsFile } = await setup();
    const state = emptyRuntimeTargetState();
    const id = addReceipt(state, 'user', path.join(root, 'home'));
    const payloadId = state.receipts[id].payloadId;
    state.imports['import-1'] = {
      importId: 'import-1', payloadId, sourceId: 'src', manifestId: 'demo',
      provenance: 'legacy-install', importedAt: '2026-01-01T00:00:00.000Z'
    };
    delete state.receipts[id];
    await store.withExclusive(() => store.save(state));
    expect(Object.keys(JSON.parse(await fs.readFile(importsFile, 'utf8')).imports)).toEqual(['import-1']);
    expect(Object.keys((await store.load()).imports)).toEqual(['import-1']);
  });

  it('restores every authority when a later publication fails', async () => {
    const { root, workspace, store, repoFile, options } = await setup();
    const state = emptyRuntimeTargetState();
    addReceipt(state, 'repository', workspace, workspace);
    addReceipt(state, 'user', path.join(root, 'home'));
    await store.withExclusive(() => store.save(state));
    const before = await Promise.all([repoFile, store.statePath].map((f) => fs.readFile(f)));
    const next = await store.load();
    addReceipt(next, 'repository', workspace, workspace, '2.0.0');
    let armed = true;
    const failing = new ScopedRuntimeTargetStore({
      ...options,
      fileSystem: {
        ...fs,
        rename: async (from, to) => {
          if (String(to) === repoFile && armed) {
            armed = false;
            throw Object.assign(new Error('injected late publication error'), { code: 'EIO' });
          }
          return fs.rename(from, to);
        }
      }
    });
    next.receipts[Object.keys(next.receipts).find((k) => next.receipts[k].instance.scope === 'user')!].version = '1.0.0';
    await expect(failing.withExclusive(() => failing.save(next))).rejects.toThrow('injected');
    expect(await Promise.all([repoFile, store.statePath].map((f) => fs.readFile(f)))).toEqual(before);
    expect(Object.values((await store.load()).receipts).map((r) => r.version)).toEqual(['1.0.0', '1.0.0']);
  });

  it('never adopts or overwrites unresolved legacy repository records', async () => {
    const { root, workspace, store, repoFile } = await setup();
    const legacy = '{"version":"2.0.0","bundles":{"old":{"version":"1.0.0"}}}';
    await fs.writeFile(repoFile, legacy);
    const state = await store.load();
    expect(Object.values(state.receipts)).toEqual([]);
    expect(await store.getMutationConflicts({ type: 'devin', scope: 'repository', root: workspace }))
      .toMatchObject([{ code: 'LOCKFILE.LEGACY_UNRESOLVED' }]);
    addReceipt(state, 'user', path.join(root, 'home'));
    await store.withExclusive(() => store.save(state));
    expect(await fs.readFile(repoFile, 'utf8')).toBe(legacy);
    addReceipt(state, 'repository', workspace, workspace);
    await expect(store.withExclusive(() => store.save(state))).rejects.toThrow(/legacy|unresolved/i);
    expect(await fs.readFile(repoFile, 'utf8')).toBe(legacy);
  });

  it('does not accept a repository-supplied repository index or extra sections', async () => {
    const { workspace, store, repoFile } = await setup();
    const state = emptyRuntimeTargetState();
    addReceipt(state, 'repository', workspace, workspace);
    await store.withExclusive(() => store.save(state));
    const raw = JSON.parse(await fs.readFile(repoFile, 'utf8'));
    raw.repositories = ['/not-an-authorized-repository'];
    await fs.writeFile(repoFile, JSON.stringify(raw));
    await expect(store.load()).rejects.toThrow(/unexpected top-level/);
  });

  it('rejects a symlinked lockfile without writing through it', async () => {
    const { root, workspace, store, repoFile } = await setup();
    const outside = path.join(root, 'outside.json');
    await fs.writeFile(outside, '{}');
    await fs.symlink(outside, repoFile);
    const state = emptyRuntimeTargetState();
    addReceipt(state, 'repository', workspace, workspace);
    await expect(store.withExclusive(() => store.save(state))).rejects.toThrow(/symlink|regular/i);
    expect(await fs.readFile(outside, 'utf8')).toBe('{}');
  });

  it('requires a storage that provides a state directory', () => {
    expect(() => new ScopedRuntimeTargetStore({ storage: { getPaths: () => ({ root: '/x' }) as never } }))
      .toThrow(/state directory/);
  });
});
