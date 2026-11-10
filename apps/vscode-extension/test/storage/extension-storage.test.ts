/**
 * All extension storage resolves under the shared XDG layout of the injected environment.
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createExtensionStorage,
  extensionDataDir,
  extensionStateDir,
  SharedStateFile,
} from '../../src/storage/extension-storage';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';

suite('extension storage', () => {
  const env = { HOME: '/h', XDG_CONFIG_HOME: '/x/config', XDG_DATA_HOME: '/x/data', XDG_STATE_HOME: '/x/state', XDG_CACHE_HOME: '/x/cache' };

  test('resolves config, data, state and cache from the injected XDG environment', () => {
    const storage = createExtensionStorage(env);
    const paths = storage.getPaths();
    assert.strictEqual(paths.config, path.join('/x/config', 'ai-primitives-hub', 'config.json'));
    assert.strictEqual(extensionDataDir(storage), path.join('/x/data', 'ai-primitives-hub'));
    assert.strictEqual(extensionStateDir(storage), path.join('/x/state', 'ai-primitives-hub'));
    assert.strictEqual(paths.cache, path.join('/x/cache', 'ai-primitives-hub'));
  });

  test('defaults to the standard locations under HOME when XDG variables are unset', () => {
    const paths = createExtensionStorage({ HOME: '/h' }).getPaths();
    assert.strictEqual(paths.config, path.join('/h', '.config', 'ai-primitives-hub', 'config.json'));
    assert.strictEqual(paths.state, path.join('/h', '.local', 'state', 'ai-primitives-hub'));
  });

  test('RegistryStorage writes its config under XDG and never under the IDE global storage', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-storage-'));
    const ide = path.join(root, 'ide');
    fs.mkdirSync(ide);
    try {
      const storage = new RegistryStorage({ globalStorageUri: { fsPath: ide }, globalState: { get: () => undefined, update: async () => undefined } } as never);
      await storage.initialize();
      const config = createExtensionStorage(process.env).getPaths().config;
      assert.ok(fs.existsSync(config), `config at ${config}`);
      assert.deepStrictEqual(fs.readdirSync(ide), [], 'IDE global storage untouched');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('shared state is a Memento-shaped JSON file under the state directory', async () => {
    const state = new SharedStateFile('extension-state');
    await state.update('k', { a: 1 });
    assert.deepStrictEqual(new SharedStateFile('extension-state').get('k'), { a: 1 });
    assert.strictEqual(new SharedStateFile('extension-state').get('missing', 'dflt'), 'dflt');
    await state.update('k', undefined);
    assert.deepStrictEqual([...new SharedStateFile('extension-state').keys()], []);
    assert.ok(fs.existsSync(path.join(extensionStateDir(), 'extension-state.json')));
  });

  test('RegistryStorage sees an externally written config after its cache is invalidated', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-storage-'));
    try {
      const storage = new RegistryStorage({ globalStorageUri: { fsPath: root }, globalState: { get: () => undefined, update: async () => undefined } } as never);
      await storage.initialize();
      assert.deepStrictEqual(await storage.getSources(), []);
      const config = createExtensionStorage(process.env).getPaths().config;
      const doc = JSON.parse(fs.readFileSync(config, 'utf8'));
      doc.sources = [{ id: 'external', name: 'External', type: 'local', url: root, enabled: true, priority: 1 }];
      fs.writeFileSync(config, JSON.stringify(doc));
      assert.deepStrictEqual(await storage.getSources(), [], 'cached until invalidated');
      storage.invalidateConfigCache();
      assert.deepStrictEqual((await storage.getSources()).map((x) => x.id), ['external']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
