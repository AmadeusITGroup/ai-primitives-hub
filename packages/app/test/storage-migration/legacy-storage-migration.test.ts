import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  NodeFileSystem,
  XdgAppStorage,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  detectLegacyStorage,
  getLegacyStorageConflictNotice,
  markLegacyStorageConflictsNotified,
  migrateLegacyStorage,
} from '../../src/storage-migration/legacy-storage-migration';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-migrate-'));
  roots.push(root);
  const env = {
    HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state'), XDG_CACHE_HOME: path.join(root, 'cache')
  };
  const legacy = path.join(root, 'ide', 'globalStorage', 'ext');
  await fs.mkdir(legacy, { recursive: true });
  const deps = { fs: new NodeFileSystem(), storage: new XdgAppStorage(env), env };
  const put = async (file: string, text: string) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };
  return { root, env, legacy, deps, put, config: path.join(env.XDG_CONFIG_HOME, 'ai-primitives-hub'), data: path.join(env.XDG_DATA_HOME, 'ai-primitives-hub') };
}

const snapshot = async (dir: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(p);
      } else {
        out[p] = await fs.readFile(p, 'utf8');
      }
    }
  };
  await walk(dir);
  return out;
};

describe('legacy storage migration', () => {
  it('detects known artifacts and ignores an empty or unrelated root', async () => {
    const t = await setup();
    expect(await detectLegacyStorage(t.deps, t.legacy)).toMatchObject({ present: false });
    await t.put(path.join(t.legacy, 'unrelated.txt'), 'x');
    expect((await detectLegacyStorage(t.deps, t.legacy)).present).toBe(false);
    await t.put(path.join(t.legacy, 'config.json'), '{}');
    expect(await detectLegacyStorage(t.deps, t.legacy)).toMatchObject({ present: true, completed: false, artifacts: ['config.json'] });
  });

  it('copies and transforms every inventory item, journals it and leaves the legacy root untouched', async () => {
    const t = await setup();
    await t.put(path.join(t.legacy, 'config.json'), JSON.stringify({ version: '1', sources: [{ id: 's1', name: 'One' }], profiles: [], settings: { a: 1 } }));
    await t.put(path.join(t.legacy, 'hub1.yml'), 'name: hub\n');
    await t.put(path.join(t.legacy, 'hub1.meta.json'), '{"reference":{}}');
    await t.put(path.join(t.legacy, 'activeHubId.json'), '{"hubId":"hub1"}');
    await t.put(path.join(t.legacy, 'favorites.json'), '{"hub1":["p1"]}');
    await t.put(path.join(t.legacy, 'profile-activations', 'hub1_p1.json'), '{}');
    await t.put(path.join(t.legacy, 'installed', 'user', 'a.json'), '{"x":1}');
    await t.put(path.join(t.legacy, 'bundles', 'b1', 'deployment-manifest.yml'), 'id: b1\n');
    const before = await snapshot(t.legacy);
    const result = await migrateLegacyStorage(t.deps, { legacyRoot: t.legacy, host: 'Test IDE' });
    expect(await snapshot(t.legacy)).toEqual(before);
    expect(JSON.parse(await fs.readFile(path.join(t.config, 'config.json'), 'utf8')).sources).toEqual([{ id: 's1', name: 'One' }]);
    expect(await fs.readFile(path.join(t.config, 'hubs', 'hub1.yml'), 'utf8')).toBe('name: hub\n');
    expect(JSON.parse(await fs.readFile(path.join(t.config, 'active-hub.json'), 'utf8'))).toEqual({ hubId: 'hub1' });
    expect(JSON.parse(await fs.readFile(path.join(t.config, 'hubs', 'favorites.json'), 'utf8'))).toEqual({ hub1: ['p1'] });
    expect(await fs.readFile(path.join(t.config, 'hubs', 'profile-activations', 'hub1_p1.json'), 'utf8')).toBe('{}');
    expect(await fs.readFile(path.join(t.data, 'installed', 'user', 'a.json'), 'utf8')).toBe('{"x":1}');
    expect(await fs.readFile(path.join(t.data, 'bundles', 'b1', 'deployment-manifest.yml'), 'utf8')).toBe('id: b1\n');
    expect(result.conflicts).toEqual([]);
    const journal = JSON.parse(await fs.readFile(path.join(t.env.XDG_STATE_HOME, 'ai-primitives-hub', 'migrations.json'), 'utf8'));
    expect(journal.migrations[0]).toMatchObject({ legacyRoot: t.legacy, host: 'Test IDE' });
    expect(await detectLegacyStorage(t.deps, t.legacy)).toMatchObject({ completed: true });
  });

  it('merges by id and union, never overwrites, and reports conflicts', async () => {
    const t = await setup();
    await t.put(path.join(t.config, 'config.json'), JSON.stringify({ sources: [{ id: 's1', name: 'Kept' }, { id: 's2', name: 'Two' }], settings: { a: 2 } }));
    await t.put(path.join(t.legacy, 'config.json'), JSON.stringify({ sources: [{ id: 's1', name: 'Other' }, { id: 's3', name: 'Three' }], settings: { a: 1, b: 1 } }));
    await t.put(path.join(t.config, 'hubs', 'favorites.json'), '{"hub1":["p1"]}');
    await t.put(path.join(t.legacy, 'favorites.json'), '{"hub1":["p2"],"hub2":["q"]}');
    await t.put(path.join(t.config, 'active-hub.json'), '{"hubId":"existing"}');
    await t.put(path.join(t.legacy, 'activeHubId.json'), '{"hubId":"legacy"}');
    await t.put(path.join(t.config, 'hubs', 'h.yml'), 'a: 1\n');
    await t.put(path.join(t.legacy, 'h.yml'), 'a: 2\n');
    const result = await migrateLegacyStorage(t.deps, { legacyRoot: t.legacy, host: 'Other IDE' });
    const config = JSON.parse(await fs.readFile(path.join(t.config, 'config.json'), 'utf8'));
    expect(config.sources.map((s: { id: string }) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(config.sources[0].name).toBe('Kept');
    expect(config.settings).toEqual({ a: 2, b: 1 });
    expect(JSON.parse(await fs.readFile(path.join(t.config, 'hubs', 'favorites.json'), 'utf8'))).toEqual({ hub1: ['p1', 'p2'], hub2: ['q'] });
    expect(JSON.parse(await fs.readFile(path.join(t.config, 'active-hub.json'), 'utf8'))).toEqual({ hubId: 'existing' });
    expect(await fs.readFile(path.join(t.config, 'hubs', 'h.yml'), 'utf8')).toBe('a: 1\n');
    expect(result.conflicts.map((c) => path.basename(c.path.split('#')[0])).toSorted()).toEqual(['active-hub.json', 'config.json', 'h.yml']);
    const activeHubConflict = result.conflicts.find((c) => path.basename(c.path) === 'active-hub.json');
    expect(activeHubConflict?.reason).toContain('legacy active hub "legacy"');
    expect(activeHubConflict?.reason).toContain('shared XDG active hub "existing"');
    const notice = await getLegacyStorageConflictNotice(t.deps, t.legacy);
    expect(notice).toEqual({ legacyHubId: 'legacy', sharedHubId: 'existing', otherConflicts: 2 });
    await markLegacyStorageConflictsNotified(t.deps, t.legacy);
    expect(await getLegacyStorageConflictNotice(t.deps, t.legacy)).toBeUndefined();
    expect(result.merged.length).toBe(2);
  });

  it('is idempotent and lets several IDE roots migrate into the same XDG state', async () => {
    const t = await setup();
    await t.put(path.join(t.legacy, 'config.json'), JSON.stringify({ sources: [{ id: 's1' }] }));
    await migrateLegacyStorage(t.deps, { legacyRoot: t.legacy, host: 'A' });
    const again = await migrateLegacyStorage(t.deps, { legacyRoot: t.legacy, host: 'A' });
    expect(again.conflicts).toEqual([]);
    expect(again.merged).toEqual([]);
    const second = path.join(t.root, 'ide2');
    await t.put(path.join(second, 'config.json'), JSON.stringify({ sources: [{ id: 's2' }] }));
    await migrateLegacyStorage(t.deps, { legacyRoot: second, host: 'B' });
    expect(JSON.parse(await fs.readFile(path.join(t.config, 'config.json'), 'utf8')).sources.map((s: { id: string }) => s.id)).toEqual(['s1', 's2']);
    expect(await detectLegacyStorage(t.deps, second)).toMatchObject({ completed: true });
  });
});
