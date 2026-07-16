import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  XdgAppStorage,
} from '../../src/storage/xdg-app-storage';
import {
  createTempDir,
} from '../helpers/temp-dir';

let tmp: string;
let cleanup: () => void;

beforeEach(() => {
  [tmp, cleanup] = createTempDir('pi-appstorage-');
});

afterEach(() => {
  cleanup();
});

describe('XdgAppStorage.getPaths', () => {
  it('splits config/cache/data across their respective XDG bases', () => {
    const storage = new XdgAppStorage({
      XDG_CONFIG_HOME: path.join(tmp, 'config'),
      XDG_CACHE_HOME: path.join(tmp, 'cache'),
      XDG_DATA_HOME: path.join(tmp, 'data')
    });
    const paths = storage.getPaths();

    expect(paths.config).toBe(path.join(tmp, 'config', 'ai-primitives-hub', 'config.json'));
    expect(paths.cache).toBe(path.join(tmp, 'cache', 'ai-primitives-hub'));
    expect(paths.sourcesCache).toBe(path.join(tmp, 'cache', 'ai-primitives-hub', 'sources'));
    expect(paths.bundlesCache).toBe(path.join(tmp, 'cache', 'ai-primitives-hub', 'bundles'));
    expect(paths.root).toBe(path.join(tmp, 'data', 'ai-primitives-hub'));
    expect(paths.installed).toBe(path.join(tmp, 'data', 'ai-primitives-hub', 'installed'));
    expect(paths.userInstalled).toBe(path.join(tmp, 'data', 'ai-primitives-hub', 'installed', 'user'));
    expect(paths.profilesInstalled).toBe(path.join(tmp, 'data', 'ai-primitives-hub', 'installed', 'profiles'));
    expect(paths.profiles).toBe(path.join(tmp, 'data', 'ai-primitives-hub', 'profiles'));
    expect(paths.logs).toBe(path.join(tmp, 'data', 'ai-primitives-hub', 'logs'));
  });

  it('getPaths returns a fresh copy each call (callers cannot mutate internal state)', () => {
    const storage = new XdgAppStorage({ XDG_DATA_HOME: tmp });
    const first = storage.getPaths();
    first.root = '/tampered';
    expect(storage.getPaths().root).not.toBe('/tampered');
  });
});

describe('XdgAppStorage.getState/setState', () => {
  it('returns the default value when nothing has been set', async () => {
    const storage = new XdgAppStorage({ XDG_DATA_HOME: tmp });
    const value = await storage.getState('missing-key', { fallback: true });
    expect(value).toEqual({ fallback: true });
  });

  it('round-trips a value written by setState', async () => {
    const storage = new XdgAppStorage({ XDG_DATA_HOME: tmp });
    await storage.setState('bundleUpdatePreferences', { 'bundle-1': { autoUpdate: true } });
    const value = await storage.getState('bundleUpdatePreferences', {});
    expect(value).toEqual({ 'bundle-1': { autoUpdate: true } });
  });

  it('preserves other keys already present when setting a new one', async () => {
    const storage = new XdgAppStorage({ XDG_DATA_HOME: tmp });
    await storage.setState('key-a', 'value-a');
    await storage.setState('key-b', 'value-b');

    expect(await storage.getState('key-a', '')).toBe('value-a');
    expect(await storage.getState('key-b', '')).toBe('value-b');
  });

  it('persists across separate XdgAppStorage instances pointed at the same data dir', async () => {
    const first = new XdgAppStorage({ XDG_DATA_HOME: tmp });
    await first.setState('key', 'persisted');

    const second = new XdgAppStorage({ XDG_DATA_HOME: tmp });
    expect(await second.getState('key', '')).toBe('persisted');
  });
});
