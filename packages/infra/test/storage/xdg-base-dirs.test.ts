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

describe('injected home directory', () => {
  // The env map, not the process, decides the home fallback, so a caller
  // that sandboxes HOME (e.g. `doctor diagnostics`) can't leak into the
  // real user's dirs when it leaves an XDG var unset. os.homedir() reads
  // USERPROFILE on Windows and HOME elsewhere; the resolver mirrors that.
  const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const injectedHome = path.join(path.sep, 'sandbox', 'home');
  const env: XdgEnv = { [homeKey]: injectedHome };

  it('xdgDataDir falls back to the injected home', () => {
    expect(xdgDataDir(env)).toBe(path.join(injectedHome, '.local', 'share', 'ai-primitives-hub'));
  });

  it('xdgConfigDir falls back to the injected home', () => {
    expect(xdgConfigDir(env)).toBe(path.join(injectedHome, '.config', 'ai-primitives-hub'));
  });

  it('xdgCacheDir falls back to the injected home', () => {
    expect(xdgCacheDir(env)).toBe(path.join(injectedHome, '.cache', 'ai-primitives-hub'));
  });

  it('XDG vars still take precedence over the injected home', () => {
    expect(xdgDataDir({ ...env, XDG_DATA_HOME: '/xdg/data' })).toBe(path.join('/xdg/data', 'ai-primitives-hub'));
  });

  it('ignores an empty injected home and falls back to os.homedir()', () => {
    expect(xdgDataDir({ [homeKey]: '' })).toBe(path.join(homeDir, '.local', 'share', 'ai-primitives-hub'));
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
