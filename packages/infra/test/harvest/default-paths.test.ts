import * as os from 'node:os';
import * as path from 'node:path';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  defaultCacheDir,
  defaultHubCacheDir,
  defaultIndexFile,
  DefaultPathEnv,
  defaultProgressFile,
} from '../../src/harvest/default-paths';

describe('primitive-index / default-paths', () => {
  const homeDir = os.homedir();

  it('uses PROMPT_REGISTRY_CACHE when set (highest precedence)', () => {
    const env: DefaultPathEnv = { PROMPT_REGISTRY_CACHE: '/custom/cache' };
    expect(defaultCacheDir(env)).toBe('/custom/cache');
  });

  it('falls back to XDG_CACHE_HOME/prompt-registry when PROMPT_REGISTRY_CACHE unset', () => {
    const env: DefaultPathEnv = { XDG_CACHE_HOME: '/xdg/cache' };
    expect(defaultCacheDir(env)).toBe('/xdg/cache/prompt-registry');
  });

  it('falls back to ~/.cache/prompt-registry when no env set', () => {
    const env: DefaultPathEnv = {};
    expect(defaultCacheDir(env)).toBe(path.join(homeDir, '.cache', 'prompt-registry'));
  });

  it('defaultIndexFile composes off defaultCacheDir', () => {
    const env: DefaultPathEnv = { PROMPT_REGISTRY_CACHE: '/c' };
    expect(defaultIndexFile(env)).toBe(path.join('/c', 'primitive-index.json'));
  });

  it('defaultHubCacheDir namespaces per-hub (one non-alphanum → one underscore)', () => {
    const env: DefaultPathEnv = { PROMPT_REGISTRY_CACHE: '/c' };
    expect(
      defaultHubCacheDir('owner/repo', env)
    ).toBe(path.join('/c', 'hubs', 'owner_repo'));
  });

  it('defaultHubCacheDir uses the "local" namespace when no hub id is given', () => {
    const env: DefaultPathEnv = { PROMPT_REGISTRY_CACHE: '/c' };
    expect(
      defaultHubCacheDir(undefined, env)
    ).toBe(path.join('/c', 'hubs', 'local'));
  });

  it('defaultProgressFile lives inside the per-hub cache', () => {
    const env: DefaultPathEnv = { PROMPT_REGISTRY_CACHE: '/c' };
    expect(
      defaultProgressFile('owner/repo', env)
    ).toBe(path.join('/c', 'hubs', 'owner_repo', 'progress.jsonl'));
  });

  it('slashes/spaces/quotes in hub id are sanitised for filesystem safety', () => {
    const env: DefaultPathEnv = { PROMPT_REGISTRY_CACHE: '/c' };
    expect(
      defaultHubCacheDir('my/weird hub!', env)
    ).toBe(path.join('/c', 'hubs', 'my_weird_hub_'));
  });
});
