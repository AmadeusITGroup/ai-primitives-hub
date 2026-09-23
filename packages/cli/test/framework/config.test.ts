/**
 * Tests for `framework/config.ts`.
 *
 * `loadConfig` implements the layered precedence chain (defaults, user
 * config, project config, env vars, explicit --config file). These tests
 * use a hand-rolled in-memory `ConfigFs` so the loader is exercised in
 * isolation without touching real disk.
 */
import * as path from 'node:path';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  loadConfig,
  resolveProjectConfigPath,
} from '../../src/framework';

interface Inode {
  [path: string]: string;
}

const workspacePath = path.join(path.sep, 'workspace');
const userConfigHome = path.join(path.sep, 'home', 'user', '.config');
const workspaceFile = (name: string): string => path.join(workspacePath, name);

const makeFs = (files: Inode) => {
  const map = new Map<string, string>(Object.entries(files));
  return {
    readFile: (p: string): Promise<string> => {
      const content = map.get(p);
      if (content === undefined) {
        return Promise.reject(new Error(`ENOENT: ${p}`));
      }
      return Promise.resolve(content);
    },
    exists: (p: string): Promise<boolean> => Promise.resolve(map.has(p))
  };
};

describe('loadConfig', () => {
  it('returns built-in defaults when no config files exist', async () => {
    const config = await loadConfig({
      cwd: workspacePath,
      env: {},
      fs: makeFs({})
    });
    expect(config).toEqual({
      version: 1,
      output: 'text',
      verbose: false,
      quiet: false
    });
  });

  it('loads a project config from cwd', async () => {
    const config = await loadConfig({
      cwd: workspacePath,
      env: {},
      fs: makeFs({
        [workspaceFile('ai-primitives-hub.yml')]: 'output: json\nfoo: bar\n'
      })
    });
    expect(config).toMatchObject({
      version: 1,
      output: 'json',
      foo: 'bar'
    });
  });

  it('walks upward Cargo-style to find a project config', async () => {
    const config = await loadConfig({
      cwd: workspaceFile('packages/cli'),
      env: {},
      fs: makeFs({
        [workspaceFile('ai-primitives-hub.yml')]: 'output: yaml\n'
      })
    });
    expect(config.output).toBe('yaml');
  });

  it('prefers the .yaml filename over .yml when both are present', async () => {
    const config = await loadConfig({
      cwd: workspacePath,
      env: {},
      fs: makeFs({
        [workspaceFile('ai-primitives-hub.yml')]: 'output: yml\n',
        [workspaceFile('ai-primitives-hub.yaml')]: 'output: yaml\n'
      })
    });
    expect(config.output).toBe('yaml');
  });

  it('loads a user config from XDG_CONFIG_HOME', async () => {
    const config = await loadConfig({
      cwd: workspacePath,
      env: { XDG_CONFIG_HOME: userConfigHome },
      fs: makeFs({
        [path.join(userConfigHome, 'ai-primitives-hub', 'config.yml')]: 'output: json\nverbose: true\n'
      })
    });
    expect(config.output).toBe('json');
    expect(config.verbose).toBe(true);
  });

  it('project config overrides user config', async () => {
    const config = await loadConfig({
      cwd: workspacePath,
      env: { XDG_CONFIG_HOME: userConfigHome },
      fs: makeFs({
        [path.join(userConfigHome, 'ai-primitives-hub', 'config.yml')]: 'output: json\n',
        [workspaceFile('ai-primitives-hub.yml')]: 'output: yaml\n'
      })
    });
    expect(config.output).toBe('yaml');
  });

  it('env vars override project config and coerce booleans/numbers', async () => {
    const config = await loadConfig({
      cwd: workspacePath,
      env: {
        XDG_CONFIG_HOME: userConfigHome,
        AI_PRIMITIVES_HUB_OUTPUT: 'ndjson',
        AI_PRIMITIVES_HUB_VERBOSE: 'true',
        AI_PRIMITIVES_HUB_INDEX__TTL: '120'
      },
      fs: makeFs({
        [path.join(userConfigHome, 'ai-primitives-hub', 'config.yml')]: 'output: json\nverbose: false\n'
      })
    });
    expect(config.output).toBe('ndjson');
    expect(config.verbose).toBe(true);
    expect(config.index).toEqual({ ttl: 120 });
  });

  it('camelCases single-underscore env keys and treats double underscores as nested paths', async () => {
    const config = await loadConfig({
      cwd: workspacePath,
      env: {
        AI_PRIMITIVES_HUB_CACHE_PATH: '/tmp',
        AI_PRIMITIVES_HUB_HUB__TIMEOUT: '30'
      },
      fs: makeFs({})
    });
    expect(config.cachePath).toBe('/tmp');
    expect(config.hub).toEqual({ timeout: 30 });
  });

  it('explicit --config file overrides all earlier layers', async () => {
    const config = await loadConfig({
      cwd: workspacePath,
      env: { AI_PRIMITIVES_HUB_OUTPUT: 'ndjson' },
      configFile: workspaceFile('override.yml'),
      fs: makeFs({
        [workspaceFile('ai-primitives-hub.yml')]: 'output: json\n',
        [workspaceFile('override.yml')]: 'output: text\nquiet: true\n'
      })
    });
    expect(config.output).toBe('text');
    expect(config.quiet).toBe(true);
  });

  it('throws when an explicit --config file does not exist', async () => {
    await expect(loadConfig({
      cwd: workspacePath,
      env: {},
      configFile: workspaceFile('missing.yml'),
      fs: makeFs({})
    })).rejects.toThrow('Config file not found');
  });

  it('deep-merges nested objects instead of replacing them', async () => {
    const config = await loadConfig({
      cwd: workspacePath,
      env: {},
      fs: makeFs({
        [workspaceFile('ai-primitives-hub.yml')]: 'github:\n  token: abc\n  timeout: 5\n'
      })
    });
    expect(config.github).toEqual({ token: 'abc', timeout: 5 });
  });

  it('later nested layers override leaves while preserving siblings', async () => {
    const config = await loadConfig({
      cwd: workspacePath,
      env: { AI_PRIMITIVES_HUB_GITHUB__TIMEOUT: '10' },
      fs: makeFs({
        [workspaceFile('ai-primitives-hub.yml')]: 'github:\n  token: abc\n  timeout: 5\n'
      })
    });
    expect(config.github).toEqual({ token: 'abc', timeout: 10 });
  });
});

describe('resolveProjectConfigPath', () => {
  it('returns undefined when no project config exists', async () => {
    const result = await resolveProjectConfigPath({
      cwd: workspacePath,
      env: {},
      fs: makeFs({})
    });
    expect(result).toBeUndefined();
  });

  it('returns the absolute path to the first found config file', async () => {
    const result = await resolveProjectConfigPath({
      cwd: workspacePath,
      env: {},
      fs: makeFs({
        [workspaceFile('ai-primitives-hub.yml')]: 'output: json\n'
      })
    });
    expect(result).toBe(workspaceFile('ai-primitives-hub.yml'));
  });
});
