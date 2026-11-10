import {
  createHash,
} from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BuiltInOnlyLayoutConfigLoader,
  NodeRuntimeProjectionFileSystem,
  ScopedRuntimeTargetStore,
  XdgAppStorage,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  applyLegacyMigration,
  hasLegacyLockfile,
  planLegacyLockfileMigration,
} from '../../src/runtime-target/legacy-migration';
import type {
  RuntimeSessionOptions,
} from '../../src/runtime-target/session';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const hex = (text: string) => createHash('sha256').update(text).digest('hex');

async function setup() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rt-migrate-')));
  roots.push(root);
  const workspace = path.join(root, 'ws');
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const env = { HOME: path.join(root, 'home'), XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state') };
  await fs.mkdir(env.HOME, { recursive: true });
  const storage = new XdgAppStorage(env);
  const opts: RuntimeSessionOptions = {
    storage, env, workspaceRoot: workspace,
    store: new ScopedRuntimeTargetStore({ storage, workspaceRoot: workspace }),
    fs: new NodeRuntimeProjectionFileSystem(),
    layoutLoader: new BuiltInOnlyLayoutConfigLoader()
  };
  const write = async (relative: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(workspace, relative)), { recursive: true });
    await fs.writeFile(path.join(workspace, relative), text);
  };
  const entry = (relative: string, content: string) => ({
    version: '1.0.0', sourceId: 'src', sourceType: 'local', installedAt: '2026-01-01T00:00:00.000Z',
    files: [{ path: relative, checksum: hex(content) }]
  });
  const lock = (name: string, bundles: Record<string, unknown>) => fs.writeFile(path.join(workspace, name), `${JSON.stringify({
    version: '2.0.0', generatedAt: '2026-01-01T00:00:00.000Z', generatedBy: 'prompt-registry@0.0.1', bundles,
    sources: { src: { type: 'local', url: '/elsewhere' } }
  }, null, 2)}\n`);
  return { root, workspace, env, opts, write, entry, lock, state: env.XDG_STATE_HOME };
}

describe('legacy lockfile migration', () => {
  it('plans a single-harness entry as ready and a shared .github entry as ambiguous', async () => {
    const t = await setup();
    await t.write('.windsurf/rules/a.prompt.md', 'A');
    await t.write('.github/prompts/b.prompt.md', 'B');
    await t.lock('prompt-registry.lock.json', {
      a: t.entry('.windsurf/rules/a.prompt.md', 'A'), b: t.entry('.github/prompts/b.prompt.md', 'B')
    });
    expect(await hasLegacyLockfile(t.opts, t.workspace)).toBe(true);
    const plan = await planLegacyLockfileMigration(t.opts);
    expect(plan.entries.find((e) => e.bundleId === 'a')).toMatchObject({ outcome: 'ready', candidates: ['windsurf'] });
    const ambiguous = plan.entries.find((e) => e.bundleId === 'b')!;
    expect(ambiguous.outcome).toBe('ambiguous');
    expect(ambiguous.candidates).toEqual(expect.arrayContaining(['vscode', 'vscode-insiders', 'copilot-cli']));
    expect(plan.ambiguousSets).toHaveLength(1);
  });

  it('reports modified and missing files without migrating them', async () => {
    const t = await setup();
    await t.write('.windsurf/rules/a.prompt.md', 'edited');
    await t.lock('prompt-registry.lock.json', {
      a: t.entry('.windsurf/rules/a.prompt.md', 'A'), gone: t.entry('.windsurf/rules/gone.prompt.md', 'G')
    });
    const plan = await planLegacyLockfileMigration(t.opts);
    expect(plan.entries.map((e) => [e.bundleId, e.outcome, e.files[0].status])).toEqual([
      ['a', 'skipped', 'modified'], ['gone', 'skipped', 'missing']
    ]);
  });

  it('applies atomically: v3 records, byte-exact backup, journal, sources and commit guidance', async () => {
    const t = await setup();
    await t.write('.windsurf/rules/a.prompt.md', 'A');
    await t.write('.windsurf/rules/m.prompt.md', 'edited');
    await t.lock('prompt-registry.lock.json', { a: t.entry('.windsurf/rules/a.prompt.md', 'A'), m: t.entry('.windsurf/rules/m.prompt.md', 'M') });
    const original = await fs.readFile(path.join(t.workspace, 'prompt-registry.lock.json'), 'utf8');
    const plan = await planLegacyLockfileMigration(t.opts);
    const result = await applyLegacyMigration(t.opts, plan);
    expect(result.migrated).toEqual([{ bundleId: 'a', harness: 'windsurf', lockfile: 'commit' }]);
    expect(result.skipped).toMatchObject([{ bundleId: 'm' }]);
    expect(await fs.readFile(result.backup, 'utf8')).toBe(original);
    expect(result.commitGuidance).toMatch(/git add prompt-registry\.lock\.json/);
    const migrated = JSON.parse(await fs.readFile(path.join(t.workspace, 'prompt-registry.lock.json'), 'utf8'));
    expect(migrated.version).toBe('3.0.0');
    expect(migrated.sources).toEqual({ src: { type: 'local', url: '/elsewhere' } });
    expect(JSON.stringify(migrated)).not.toContain(t.workspace);
    const state = await t.opts.store.load();
    expect(Object.values(state.receipts)).toHaveLength(1);
    expect(await fs.readFile(path.join(t.workspace, '.windsurf/rules/m.prompt.md'), 'utf8')).toBe('edited');
    const journal = JSON.parse(await fs.readFile(path.join(t.state, 'ai-primitives-hub', 'migrations.json'), 'utf8'));
    expect(journal.migrations).toHaveLength(1);
    expect(await hasLegacyLockfile(t.opts, t.workspace)).toBe(false);
  });

  it('needs a choice for ambiguous sets and writes nothing without one', async () => {
    const t = await setup();
    await t.write('.github/prompts/b.prompt.md', 'B');
    await t.lock('prompt-registry.lock.json', { b: t.entry('.github/prompts/b.prompt.md', 'B') });
    const original = await fs.readFile(path.join(t.workspace, 'prompt-registry.lock.json'), 'utf8');
    const plan = await planLegacyLockfileMigration(t.opts);
    await expect(applyLegacyMigration(t.opts, plan, {})).rejects.toThrow(/choose a harness/);
    expect(await fs.readFile(path.join(t.workspace, 'prompt-registry.lock.json'), 'utf8')).toBe(original);
    const set = plan.ambiguousSets[0].join(',');
    const result = await applyLegacyMigration(t.opts, plan, { [set]: 'copilot-cli' });
    expect(result.migrated[0].harness).toBe('copilot-cli');
  });

  it('keeps local-only entries local-only and gives no commit guidance for them', async () => {
    const t = await setup();
    await t.write('.windsurf/rules/a.prompt.md', 'A');
    await t.lock('prompt-registry.local.lock.json', { a: t.entry('.windsurf/rules/a.prompt.md', 'A') });
    const plan = await planLegacyLockfileMigration(t.opts);
    const result = await applyLegacyMigration(t.opts, plan);
    expect(result.migrated).toEqual([{ bundleId: 'a', harness: 'windsurf', lockfile: 'local-only' }]);
    expect(result.commitGuidance).toBeUndefined();
    const [row] = Object.values((await t.opts.store.load()).receipts);
    expect(row.commitMode).toBe('local-only');
    await expect(fs.stat(path.join(t.workspace, 'prompt-registry.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves the v2 file untouched when publication fails', async () => {
    const t = await setup();
    await t.write('.windsurf/rules/a.prompt.md', 'A');
    await t.lock('prompt-registry.lock.json', { a: t.entry('.windsurf/rules/a.prompt.md', 'A') });
    const original = await fs.readFile(path.join(t.workspace, 'prompt-registry.lock.json'), 'utf8');
    const plan = await planLegacyLockfileMigration(t.opts);
    const failing = {
      ...t.opts,
      store: Object.assign(Object.create(t.opts.store), {
        publishLegacyMigration: async () => {
          throw new Error('injected');
        },
        withExclusive: <T>(fn: () => Promise<T>) => fn()
      })
    };
    await expect(applyLegacyMigration(failing, plan)).rejects.toThrow('injected');
    expect(await fs.readFile(path.join(t.workspace, 'prompt-registry.lock.json'), 'utf8')).toBe(original);
  });
});
