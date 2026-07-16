import * as os from 'node:os';
import * as path from 'node:path';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  resolveUserConfigPaths,
} from '../../src/registry/user-config-paths';

const homeDir = os.homedir();

describe('resolveUserConfigPaths', () => {
  it('resolves under XDG_CONFIG_HOME when set', () => {
    const paths = resolveUserConfigPaths({ XDG_CONFIG_HOME: '/xdg-config' });

    expect(paths.root).toBe(path.join('/xdg-config', 'ai-primitives-hub'));
  });

  it('falls back to ~/.config/ai-primitives-hub when XDG_CONFIG_HOME is unset', () => {
    const paths = resolveUserConfigPaths({});

    expect(paths.root).toBe(path.join(homeDir, '.config', 'ai-primitives-hub'));
  });

  it('derives every sub-path from root', () => {
    const paths = resolveUserConfigPaths({ XDG_CONFIG_HOME: '/xdg-config' });
    const root = path.join('/xdg-config', 'ai-primitives-hub');

    expect(paths.hubs).toBe(path.join(root, 'hubs'));
    expect(paths.profileActivations).toBe(path.join(root, 'profile-activations'));
    expect(paths.activeHub).toBe(path.join(root, 'active-hub.json'));
    expect(paths.userTargets).toBe(path.join(root, 'targets.yml'));
    expect(paths.tokenCache).toBe(path.join(root, 'token'));
    expect(paths.userLockfile).toBe(path.join(root, 'ai-primitives-hub.lock.json'));
  });
});
