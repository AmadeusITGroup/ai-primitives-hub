import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  AppStoragePrimitiveIndexStore,
  XdgAppStorage,
} from '../../src/storage';

describe('AppStoragePrimitiveIndexStore', () => {
  it('resolves a hub, source revision, and profile namespaced index path', () => {
    const storage = new XdgAppStorage({ XDG_CACHE_HOME: '/tmp/shared-cache' });
    const store = new AppStoragePrimitiveIndexStore(storage);

    expect(store.getIndexPath({
      hubId: 'owner/repository',
      sourceRevision: 'refs/heads/main@abc123',
      searchProfileId: 'ternlight-dual-v1'
    })).toBe(path.join(
      '/tmp/shared-cache',
      'ai-primitives-hub',
      'indexes',
      'owner_repository',
      'refs_heads_main_abc123',
      'ternlight-dual-v1',
      'primitive-index.v2.json'
    ));
  });

  it('does not allow key values to escape the cache root', () => {
    const storage = new XdgAppStorage({ XDG_CACHE_HOME: '/tmp/shared-cache' });
    const store = new AppStoragePrimitiveIndexStore(storage);
    const indexPath = store.getIndexPath({
      hubId: '../../outside',
      sourceRevision: '../revision',
      searchProfileId: 'profile/with/slashes'
    });

    expect(indexPath.startsWith(path.join('/tmp/shared-cache', 'ai-primitives-hub', 'indexes'))).toBe(true);
    expect(indexPath).not.toContain('..');
  });

  it('finds existing timestamp-suffixed snapshots through the stable hub namespace', async () => {
    const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-index-store-test-'));
    const storage = new XdgAppStorage({ XDG_CACHE_HOME: cacheRoot });
    const store = new AppStoragePrimitiveIndexStore(storage);
    const legacyPath = store.getIndexPath({
      hubId: 'amadeus-hub-788228',
      sourceRevision: 'legacy-revision',
      searchProfileId: 'ternlight-dual-v1'
    });
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, JSON.stringify({ primitives: [{ id: 'primitive-1' }] }));

    await expect(store.findLatestIndexPath('amadeus-hub', 'ternlight-dual-v1')).resolves.toBe(legacyPath);
    await fs.rm(cacheRoot, { recursive: true, force: true });
  });

  it('prefers a source-compatible snapshot over a newer incompatible snapshot', async () => {
    const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-index-store-compatibility-test-'));
    const storage = new XdgAppStorage({ XDG_CACHE_HOME: cacheRoot });
    const store = new AppStoragePrimitiveIndexStore(storage);
    const compatiblePath = store.getIndexPath({
      hubId: 'amadeus-hub',
      sourceRevision: 'older-compatible-revision',
      searchProfileId: 'ternlight-dual-v1'
    });
    const incompatiblePath = store.getIndexPath({
      hubId: 'amadeus-hub',
      sourceRevision: 'newer-incompatible-revision',
      searchProfileId: 'ternlight-dual-v1'
    });
    await fs.mkdir(path.dirname(compatiblePath), { recursive: true });
    await fs.mkdir(path.dirname(incompatiblePath), { recursive: true });
    await fs.writeFile(compatiblePath, JSON.stringify({
      primitives: [{ bundle: { sourceId: 'current-source' } }]
    }));
    await fs.writeFile(incompatiblePath, JSON.stringify({
      primitives: [{ bundle: { sourceId: 'legacy-source' } }]
    }));
    const now = Date.now() / 1000;
    await fs.utimes(compatiblePath, now - 10, now - 10);
    await fs.utimes(incompatiblePath, now, now);

    await expect(store.findLatestIndexPath(
      'amadeus-hub',
      'ternlight-dual-v1',
      ['current-source']
    )).resolves.toBe(compatiblePath);
    await fs.rm(cacheRoot, { recursive: true, force: true });
  });
});
