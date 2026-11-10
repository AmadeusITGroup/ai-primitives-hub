/**
 * XDG shared hub storage interoperability tests (ADR-0011).
 *
 * Exercises the shared XDG hub-storage composition:
 * the real CLI bin (`packages/cli/bin/ai-primitives-hub.js`) and the
 * extension's public HubStorage/HubManager facade pointed at the same
 * synthetic XDG roots. No mocks of the units under test; only the VS Code
 * boundary is faked and the child CLI gets an explicit allowlist env plus a
 * `nock.disableNetConnect()` preload.
 *
 * The parent process's env is overridden per-test with the same synthetic
 * roots (and restored in teardown) so any app-layer call that falls back to
 * `process.env` also lands inside the sandbox. No in-process nock toggling
 * happens here: all in-process providers are local and the CLI child is
 * fenced by its own preload.
 */

import * as assert from 'node:assert';
import {
  execFile,
} from 'node:child_process';
import * as fs from 'node:fs';
import {
  createRequire,
} from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  promisify,
} from 'node:util';
import {
  buildIndex,
  resolveUserConfigPaths,
  searchIndex,
  SearchIndexError,
} from '@ai-primitives-hub/app';
import {
  AppStoragePrimitiveIndexStore,
  FavoritesStore,
  HubStore,
  LocalFolderBundleProvider,
  NodeFileSystem,
  XdgAppStorage,
} from '@ai-primitives-hub/infra';
import * as yaml from 'js-yaml';
import * as vscode from 'vscode';
import {
  HubManager,
} from '../../src/services/hub-manager';
import {
  PrimitiveIndexService,
} from '../../src/services/primitive-index-service';
import {
  SchemaValidator,
} from '../../src/services/schema-validator';
import {
  createHubStorage,
} from '../../src/storage/create-hub-storage';
import {
  HubStorage,
} from '../../src/storage/hub-storage';
import {
  HubConfig,
} from '../../src/types/hub';

const execFileAsync = promisify(execFile);

const require2 = createRequire(__filename);
const CLI_BIN = path.resolve(process.cwd(), '..', '..', 'packages', 'cli', 'bin', 'ai-primitives-hub.js');
const NOCK_MODULE = require2.resolve('nock');
const FIXTURE_HUB_CONFIG = path.join(process.cwd(), 'test', 'fixtures', 'hubs', 'valid-hub-config.yml');
const HUB_ID = 'shared-hub';
const SENTINEL_FILE = 'sentinel.txt';
const SENTINEL_CONTENT = 'IDE-GLOBAL-STORAGE-SENTINEL: must remain byte-for-byte identical';

const SANDBOX_ENV_KEYS = [
  'HOME', 'USERPROFILE',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'TMPDIR', 'TMP', 'TEMP',
  'AI_PRIMITIVES_HUB_CACHE'
] as const;

interface Sandbox {
  root: string;
  env: Record<string, string>;
  ideStorageDir: string;
  fixtureFile: string;
}

function makeSandboxEnv(root: string): Record<string, string> {
  const xdg = (name: string): string => path.join(root, 'xdg', name);
  const env: Record<string, string> = {
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    XDG_CONFIG_HOME: xdg('config'),
    XDG_DATA_HOME: xdg('data'),
    XDG_CACHE_HOME: xdg('cache'),
    XDG_STATE_HOME: xdg('state'),
    TMPDIR: path.join(root, 'tmp'),
    TMP: path.join(root, 'tmp'),
    TEMP: path.join(root, 'tmp'),
    AI_PRIMITIVES_HUB_CACHE: path.join(root, 'aph-cache')
  };
  if (process.env.PATH) {
    env.PATH = process.env.PATH;
  }
  if (process.env.SystemRoot) {
    env.SystemRoot = process.env.SystemRoot;
  }
  return env;
}

async function makeSandbox(): Promise<Sandbox> {
  const base = process.env.HUB_TEST_SANDBOX_ROOT ?? os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = await fs.promises.mkdtemp(path.join(base, 'xdg-hub-interop-'));
  const env = makeSandboxEnv(root);
  for (const dir of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME, env.TMPDIR, env.AI_PRIMITIVES_HUB_CACHE]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const fixtureFile = path.join(root, 'fixture-hub-config.yml');
  fs.copyFileSync(FIXTURE_HUB_CONFIG, fixtureFile);
  const ideStorageDir = path.join(root, 'ide-global-storage-sentinel');
  fs.mkdirSync(ideStorageDir, { recursive: true });
  fs.writeFileSync(path.join(ideStorageDir, SENTINEL_FILE), SENTINEL_CONTENT);
  return { root, env, ideStorageDir, fixtureFile };
}

/**
 * Snapshot the process.env keys the sandbox overrides; returns a restore fn.
 * @param env
 */
function overrideProcessEnv(env: Record<string, string>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const key of SANDBOX_ENV_KEYS) {
    saved.set(key, process.env[key]);
    process.env[key] = env[key];
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

interface CliEnvelope<T> {
  schemaVersion: number;
  command: string;
  status: string;
  data: T;
}

function parseEnvelope<T>(stdout: string, command: string): CliEnvelope<T> {
  const envelope = JSON.parse(stdout) as CliEnvelope<T>;
  assert.strictEqual(envelope.schemaVersion, 1);
  assert.strictEqual(envelope.command, command);
  assert.strictEqual(envelope.status, 'ok');
  return envelope;
}

/**
 * Run the real CLI bin in a child process. The `-e` preload disables network
 * in the child before the bin executes; `CLI_BIN` lands at argv[1] so the
 * bin's `process.argv.slice(2)` sees exactly `args`.
 * @param env
 * @param cwd
 * @param args
 */
async function runCli(env: Record<string, string>, cwd: string, args: string[]): Promise<string> {
  const preload = `require(${JSON.stringify(NOCK_MODULE)}).disableNetConnect();`
    + `require(${JSON.stringify(CLI_BIN)});`;
  const { stdout } = await execFileAsync(
    process.execPath,
    ['-e', preload, CLI_BIN, ...args],
    { env, cwd }
  );
  return stdout;
}

async function cliAddHub(sandbox: Sandbox): Promise<void> {
  const stdout = await runCli(sandbox.env, sandbox.root, [
    'hub', 'add', '--type', 'local', '--location', sandbox.fixtureFile,
    '--id', HUB_ID, '--no-sync', '--no-use', '-o', 'json'
  ]);
  parseEnvelope<unknown>(stdout, 'hub.add');
}

interface HubListData {
  hubs: { id: string; name: string }[];
  activeId: string | null;
}

async function cliListHubs(sandbox: Sandbox): Promise<HubListData> {
  const stdout = await runCli(sandbox.env, sandbox.root, ['hub', 'list', '-o', 'json']);
  const envelope = parseEnvelope<HubListData>(stdout, 'hub.list');
  assert.ok(Object.prototype.hasOwnProperty.call(envelope.data, 'activeId'), 'list data must carry activeId');
  return envelope.data;
}

/** Context whose host-storage getters throw if the portable branch touches them. */
function throwingContext(): vscode.ExtensionContext {
  return {
    get globalStorageUri(): never {
      throw new Error('globalStorageUri must not be read in XDG composition');
    },
    get globalState(): never {
      throw new Error('globalState must not be read in XDG composition');
    },
    get secrets(): never {
      throw new Error('secrets must not be read in XDG composition');
    }
  } as unknown as vscode.ExtensionContext;
}

function makeManager(storage: HubStorage): HubManager {
  return new HubManager(storage, new SchemaValidator(process.cwd()), process.cwd(), undefined, undefined);
}

function readYaml(file: string): HubConfig {
  return yaml.load(fs.readFileSync(file, 'utf8')) as HubConfig;
}

function assertSentinelIntact(sandbox: Sandbox, allowSiblingWrites: boolean): void {
  const sentinelPath = path.join(sandbox.ideStorageDir, SENTINEL_FILE);
  assert.ok(fs.existsSync(sentinelPath), 'IDE sentinel file must still exist');
  assert.strictEqual(fs.readFileSync(sentinelPath, 'utf8'), SENTINEL_CONTENT,
    'IDE sentinel file must be byte-for-byte unchanged');
  if (!allowSiblingWrites) {
    assert.deepStrictEqual(fs.readdirSync(sandbox.ideStorageDir).toSorted(), [SENTINEL_FILE],
      'XDG storage must not create any file under IDE global storage');
  }
}

async function writeBundleFixture(root: string): Promise<string> {
  const bundlesRoot = path.join(root, 'bundles');
  const bundleDir = path.join(bundlesRoot, 'local-bundle');
  await fs.promises.mkdir(path.join(bundleDir, 'prompts'), { recursive: true });
  await fs.promises.writeFile(
    path.join(bundleDir, 'deployment-manifest.yml'),
    'id: local-bundle\nversion: 1.0.0\nname: Local Bundle\nitems:\n  - path: prompts/hello.prompt.md\n    kind: prompt\n'
  );
  await fs.promises.writeFile(
    path.join(bundleDir, 'prompts', 'hello.prompt.md'),
    '# Hello Prompt\n\nA diagnostic prompt.\n'
  );
  return bundlesRoot;
}

suite('XDG shared hub storage interoperability', function () {
  this.timeout(30_000);
  let sandbox: Sandbox;
  let restoreEnv: () => void;

  setup(async () => {
    sandbox = await makeSandbox();
    restoreEnv = overrideProcessEnv(sandbox.env);
  });

  teardown(async () => {
    try {
      assertSentinelIntact(sandbox, false);
    } finally {
      restoreEnv();
      if (!process.env.HUB_TEST_PRESERVE_SANDBOX) {
        await fs.promises.rm(sandbox.root, { recursive: true, force: true });
      }
    }
  });

  test('CLI hub add is visible to the extension facade and manager over shared XDG paths', async () => {
    await cliAddHub(sandbox);

    const paths = resolveUserConfigPaths(sandbox.env);
    const storage = createHubStorage(sandbox.env);
    const manager = makeManager(storage);

    const ids = (await manager.listHubs()).map((h) => h.id);
    assert.ok(ids.includes(HUB_ID), `manager.listHubs should include ${HUB_ID}: ${ids.join(', ')}`);

    const loaded = await storage.loadHub(HUB_ID);
    assert.strictEqual(loaded.config.metadata.name, 'Official Prompt Registry Hub');
    assert.strictEqual(loaded.reference.type, 'local');

    // Canonical CLI layout: <id>.yml + <id>.meta.json under paths.hubs.
    assert.ok(fs.existsSync(path.join(paths.hubs, `${HUB_ID}.yml`)), 'canonical hub YAML exists');
    assert.ok(fs.existsSync(path.join(paths.hubs, `${HUB_ID}.meta.json`)), 'canonical hub sidecar exists');
    assert.ok(!fs.existsSync(path.join(paths.hubs, 'activeHubId.json')),
      'legacy pointer must not appear inside the shared hubs dir');
  });

  test('extension facade saveHub is visible to a fresh CLI hub list', async () => {
    await cliAddHub(sandbox);

    const paths = resolveUserConfigPaths(sandbox.env);
    const storage = createHubStorage(sandbox.env);
    const loaded = await storage.loadHub(HUB_ID);
    const edited: HubConfig = {
      ...loaded.config,
      metadata: { ...loaded.config.metadata, name: 'Edited Hub Name' }
    };
    await storage.saveHub(HUB_ID, edited, loaded.reference);

    const data = await cliListHubs(sandbox);
    const entry = data.hubs.find((h) => h.id === HUB_ID);
    assert.ok(entry, `CLI hub list must contain ${HUB_ID}`);
    assert.strictEqual(entry.name, 'Edited Hub Name');

    const persisted = readYaml(path.join(paths.hubs, `${HUB_ID}.yml`));
    assert.strictEqual(persisted.metadata.name, 'Edited Hub Name');
  });

  test('active hub pointer round-trips through canonical active-hub.json in both directions', async () => {
    await cliAddHub(sandbox);
    const paths = resolveUserConfigPaths(sandbox.env);
    const storage = createHubStorage(sandbox.env);
    const manager = makeManager(storage);

    // CLI set -> extension sees it, canonical file written.
    const useOut = await runCli(sandbox.env, sandbox.root, ['hub', 'use', HUB_ID, '-o', 'json']);
    const useEnv = parseEnvelope<{ activeId: string | null }>(useOut, 'hub.use');
    assert.strictEqual(useEnv.data.activeId, HUB_ID);
    assert.strictEqual(await storage.getActiveHubId(), HUB_ID);
    const pointer = JSON.parse(fs.readFileSync(paths.activeHub, 'utf8')) as { hubId?: string; setAt?: string };
    assert.strictEqual(pointer.hubId, HUB_ID);
    assert.ok(!Number.isNaN(Date.parse(pointer.setAt ?? '')), 'active-hub.json setAt must parse as a timestamp');
    assert.ok(!fs.existsSync(path.join(paths.hubs, 'activeHubId.json')),
      'legacy activeHubId.json must not appear under the shared hubs dir');

    // Extension clear -> CLI sees null.
    await manager.setActiveHub(null, { loadSources: false });
    const cleared = await cliListHubs(sandbox);
    assert.strictEqual(cleared.activeId, null, 'CLI must observe the extension clearing the active hub');

    // Extension set -> CLI sees the exact id (proves CLI reads the extension's write).
    await manager.setActiveHub(HUB_ID, { loadSources: false });
    const listed = await cliListHubs(sandbox);
    assert.strictEqual(listed.activeId, HUB_ID, 'CLI must observe the extension setting the active hub');

    // CLI clear -> extension sees null.
    const clearOut = await runCli(sandbox.env, sandbox.root, ['hub', 'use', '--clear', '-o', 'json']);
    const clearEnv = parseEnvelope<{ activeId: string | null }>(clearOut, 'hub.use');
    assert.strictEqual(clearEnv.data.activeId, null);
    assert.strictEqual(await storage.getActiveHubId(), null);
  });

  test('favorites are shared through paths.hubs/favorites.json in both directions', async () => {
    const paths = resolveUserConfigPaths(sandbox.env);
    const storage = createHubStorage(sandbox.env);
    const favoritesPath = path.join(paths.hubs, 'favorites.json');

    // extension -> shared SDK
    await storage.saveFavoriteProfiles({ [HUB_ID]: ['fullstack-developer'] });
    const sdkStore = new FavoritesStore(favoritesPath, new NodeFileSystem());
    assert.deepStrictEqual(await sdkStore.get(), { [HUB_ID]: ['fullstack-developer'] });

    // shared SDK -> extension
    await sdkStore.save({ [HUB_ID]: ['frontend-specialist', 'fullstack-developer'] });
    assert.deepStrictEqual(await storage.getFavoriteProfiles(), {
      [HUB_ID]: ['frontend-specialist', 'fullstack-developer']
    });
  });

  test('facade loadHub sees CLI hub sync updates without forceReload (stateless)', async () => {
    await cliAddHub(sandbox);
    const storage = createHubStorage(sandbox.env);

    // Prime the same facade read path; a stateless facade must not pin this snapshot.
    const primed = await storage.loadHub(HUB_ID);
    assert.strictEqual(primed.config.metadata.name, 'Official Prompt Registry Hub');

    const editedFixture = readYaml(sandbox.fixtureFile);
    editedFixture.metadata = { ...editedFixture.metadata, name: 'Synced Hub Name' };
    fs.writeFileSync(sandbox.fixtureFile, yaml.dump(editedFixture));
    const syncOut = await runCli(sandbox.env, sandbox.root, ['hub', 'sync', HUB_ID, '-o', 'json']);
    parseEnvelope<{ id: string }>(syncOut, 'hub.sync');

    const reloaded = await storage.loadHub(HUB_ID);
    assert.strictEqual(reloaded.config.metadata.name, 'Synced Hub Name');
  });

  test('shared primitive index: app.buildIndex then extension service.search reuses the snapshot', async () => {
    const bundlesRoot = await writeBundleFixture(sandbox.root);

    // Independently composed app- and extension-side storage/index-store instances
    // must still resolve the same canonical path for the same key.
    const appStorage = new XdgAppStorage(sandbox.env);
    const appIndexStore = new AppStoragePrimitiveIndexStore(appStorage);
    const extStorage = new XdgAppStorage(sandbox.env);
    const extIndexStore = new AppStoragePrimitiveIndexStore(extStorage);
    const indexKey = { hubId: HUB_ID, sourceRevision: 'rev-1', searchProfileId: 'bm25-v1' as const };

    const built = await buildIndex({
      provider: new LocalFolderBundleProvider({ root: bundlesRoot, sourceId: 'local' }),
      indexStore: appIndexStore,
      indexKey,
      hubId: HUB_ID,
      profile: 'bm25-v1'
    });
    const expectedPath = appIndexStore.getIndexPath(indexKey);
    assert.strictEqual(built.outFile, expectedPath);
    assert.ok(fs.existsSync(expectedPath), 'shared index snapshot persisted');

    const service = new PrimitiveIndexService(throwingContext(), {
      profile: 'bm25-v1',
      storage: extStorage,
      indexStore: extIndexStore,
      indexKey,
      providerFactory: () => {
        throw new Error('providerFactory must not run when a shared snapshot exists');
      }
    });
    try {
      assert.strictEqual(service.getIndexPath(), expectedPath);
      const result = await service.search({ q: 'hello', limit: 5 });
      assert.strictEqual(result.hits.length, 1);
      assert.strictEqual(result.hits[0]?.primitive.title, 'Hello Prompt');
    } finally {
      service.dispose();
    }
  });

  test('shared primitive index: extension rebuild then app.searchIndex reads it; foreign keys are rejected', async () => {
    const bundlesRoot = await writeBundleFixture(sandbox.root);

    const extStorage = new XdgAppStorage(sandbox.env);
    const extIndexStore = new AppStoragePrimitiveIndexStore(extStorage);
    const appStorage = new XdgAppStorage(sandbox.env);
    const appIndexStore = new AppStoragePrimitiveIndexStore(appStorage);
    const indexKey = { hubId: HUB_ID, sourceRevision: 'rev-1', searchProfileId: 'bm25-v1' as const };

    const service = new PrimitiveIndexService(throwingContext(), {
      profile: 'bm25-v1',
      storage: extStorage,
      indexStore: extIndexStore,
      indexKey,
      providerFactory: () => new LocalFolderBundleProvider({ root: bundlesRoot, sourceId: 'local' })
    });
    try {
      await service.rebuild();
    } finally {
      service.dispose();
    }
    const builtPath = appIndexStore.getIndexPath(indexKey);
    assert.ok(fs.existsSync(builtPath), 'extension rebuild persisted the shared snapshot');

    const result = await searchIndex({ indexStore: appIndexStore, indexKey, query: { q: 'hello', limit: 5 } });
    assert.strictEqual(result.hits.length, 1);
    assert.strictEqual(result.hits[0]?.primitive.title, 'Hello Prompt');

    // Any foreign key component resolves to a distinct, absent path; strict search must fail.
    const foreignKeys = [
      { ...indexKey, hubId: 'other-hub' },
      { ...indexKey, sourceRevision: 'rev-2' },
      { ...indexKey, searchProfileId: 'other-profile' }
    ];
    for (const foreignKey of foreignKeys) {
      const foreignPath = appIndexStore.getIndexPath(foreignKey);
      assert.notStrictEqual(foreignPath, builtPath);
      assert.ok(!fs.existsSync(foreignPath), `foreign index path must be absent: ${foreignPath}`);
      await assert.rejects(
        () => searchIndex({ indexStore: appIndexStore, indexKey: foreignKey, query: { q: 'hello', limit: 5 } })
      );
    }

    // An explicitly supplied snapshot whose metadata disagrees with the key is rejected.
    await assert.rejects(
      () => searchIndex({
        indexPath: builtPath,
        indexKey: { hubId: 'other-hub', sourceRevision: 'rev-1', searchProfileId: 'bm25-v1' },
        query: { q: 'hello', limit: 5 }
      }),
      (error: unknown) => error instanceof SearchIndexError && error.code === 'HUB_MISMATCH'
    );
    await assert.rejects(
      () => searchIndex({
        indexPath: builtPath,
        indexKey: { hubId: HUB_ID, sourceRevision: 'rev-2', searchProfileId: 'bm25-v1' },
        query: { q: 'hello', limit: 5 }
      }),
      (error: unknown) => error instanceof SearchIndexError && error.code === 'SOURCE_REVISION_MISMATCH'
    );
  });
});

suite('HubStorage constructor compatibility', () => {
  let sandbox: Sandbox;
  let restoreEnv: () => void;

  setup(async () => {
    sandbox = await makeSandbox();
    restoreEnv = overrideProcessEnv(sandbox.env);
  });

  teardown(async () => {
    try {
      // Legacy mode may write next to the sentinel; the sentinel itself stays frozen.
      assertSentinelIntact(sandbox, true);
    } finally {
      restoreEnv();
      if (!process.env.HUB_TEST_PRESERVE_SANDBOX) {
        await fs.promises.rm(sandbox.root, { recursive: true, force: true });
      }
    }
  });

  test('legacy constructor string stays compatible and cache pins saves until forceReload', async () => {
    const dir = path.join(sandbox.root, 'legacy-ctor');
    const storage = new HubStorage(dir);
    const config = readYaml(FIXTURE_HUB_CONFIG);
    await storage.saveHub(HUB_ID, config, { type: 'local', location: FIXTURE_HUB_CONFIG });

    // An external HubStore write is invisible to the cached facade until forceReload.
    const store = new HubStore(dir, new NodeFileSystem());
    const edited: HubConfig = { ...config, metadata: { ...config.metadata, name: 'Externally Edited' } };
    await store.save(HUB_ID, edited, { type: 'local', location: FIXTURE_HUB_CONFIG });

    const cached = await storage.loadHub(HUB_ID);
    assert.strictEqual(cached.config.metadata.name, 'Official Prompt Registry Hub');
    const fresh = await storage.loadHub(HUB_ID, true);
    assert.strictEqual(fresh.config.metadata.name, 'Externally Edited');
  });

  test('stateless cache mode sees external writes without forceReload', async () => {
    const dir = path.join(sandbox.root, 'stateless-ctor');
    const storage = new HubStorage(dir, { cacheMode: 'stateless' });
    const config = readYaml(FIXTURE_HUB_CONFIG);
    await storage.saveHub(HUB_ID, config, { type: 'local', location: FIXTURE_HUB_CONFIG });
    await storage.loadHub(HUB_ID); // would populate the cache in legacy mode

    const store = new HubStore(dir, new NodeFileSystem());
    const edited: HubConfig = { ...config, metadata: { ...config.metadata, name: 'Externally Edited' } };
    await store.save(HUB_ID, edited, { type: 'local', location: FIXTURE_HUB_CONFIG });

    const observed = await storage.loadHub(HUB_ID);
    assert.strictEqual(observed.config.metadata.name, 'Externally Edited');
    const forced = await storage.loadHub(HUB_ID, true);
    assert.strictEqual(forced.config.metadata.name, 'Externally Edited');
  });

  test('XDG composition reads only the injected env, never IDE host storage', async () => {
    const storage = createHubStorage(sandbox.env);
    const paths = resolveUserConfigPaths(sandbox.env);
    const config = readYaml(FIXTURE_HUB_CONFIG);
    await storage.saveHub(HUB_ID, config, { type: 'local', location: FIXTURE_HUB_CONFIG });
    assert.ok(fs.existsSync(path.join(paths.hubs, `${HUB_ID}.yml`)));
    await storage.setActiveHubId(HUB_ID);
    assert.ok(fs.existsSync(paths.activeHub), 'active pointer lands at canonical active-hub.json');
    assert.ok(!fs.existsSync(path.join(paths.hubs, 'activeHubId.json')),
      'legacy pointer must not appear inside the shared hubs dir');
  });
});
