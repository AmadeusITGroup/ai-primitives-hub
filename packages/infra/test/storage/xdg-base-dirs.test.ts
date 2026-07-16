import * as os from 'node:os';
import * as path from 'node:path';
import {
  describe,
  expect,
  it,
} from 'vitest';
import type {
  XdgEnv,
} from '../../src/storage/xdg-base-dirs';
import {
  xdgCacheDir,
  xdgConfigDir,
  xdgDataDir,
} from '../../src/storage/xdg-base-dirs';

const homeDir = os.homedir();

describe('xdgDataDir', () => {
  it('uses XDG_DATA_HOME when set', () => {
    const env: XdgEnv = { XDG_DATA_HOME: '/xdg/data' };
    expect(xdgDataDir(env)).toBe(path.join('/xdg/data', 'ai-primitives-hub'));
  });

  it('falls back to ~/.local/share/ai-primitives-hub when unset', () => {
    expect(xdgDataDir({})).toBe(path.join(homeDir, '.local', 'share', 'ai-primitives-hub'));
  });
});

describe('xdgConfigDir', () => {
  it('uses XDG_CONFIG_HOME when set', () => {
    const env: XdgEnv = { XDG_CONFIG_HOME: '/xdg/config' };
    expect(xdgConfigDir(env)).toBe(path.join('/xdg/config', 'ai-primitives-hub'));
  });

  it('falls back to ~/.config/ai-primitives-hub when unset', () => {
    expect(xdgConfigDir({})).toBe(path.join(homeDir, '.config', 'ai-primitives-hub'));
  });
});

describe('xdgCacheDir', () => {
  it('uses AI_PRIMITIVES_HUB_CACHE when set (highest precedence)', () => {
    const env: XdgEnv = { AI_PRIMITIVES_HUB_CACHE: '/custom/cache', XDG_CACHE_HOME: '/xdg/cache' };
    expect(xdgCacheDir(env)).toBe('/custom/cache');
  });

  it('falls back to XDG_CACHE_HOME/ai-primitives-hub when AI_PRIMITIVES_HUB_CACHE unset', () => {
    const env: XdgEnv = { XDG_CACHE_HOME: '/xdg/cache' };
    expect(xdgCacheDir(env)).toBe(path.join('/xdg/cache', 'ai-primitives-hub'));
  });

  it('falls back to ~/.cache/ai-primitives-hub when no env set', () => {
    expect(xdgCacheDir({})).toBe(path.join(homeDir, '.cache', 'ai-primitives-hub'));
  });
});
