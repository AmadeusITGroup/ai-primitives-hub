/**
 * Tests for infra/stores/layout-config-store.ts.
 *
 * Tests built-in loading, filesystem hierarchy loading, validation
 * error handling, and the XDG config dir resolution.
 */
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  BuiltInOnlyLayoutConfigLoader,
  FileSystemLayoutConfigLoader,
  LAYOUTS_CONFIG_FILE,
  resolveUserConfigDir,
} from '../../src/stores/layout-config-store';
import type {
  LayoutConfigFs,
} from '../../src/stores/layout-config-store';

describe('resolveUserConfigDir', () => {
  it('uses XDG_CONFIG_HOME when set', () => {
    const dir = resolveUserConfigDir({ XDG_CONFIG_HOME: '/xdg/config' });
    expect(dir).toBe('/xdg/config/prompt-registry');
  });

  it('falls back to ~/.config/prompt-registry when XDG not set', () => {
    const dir = resolveUserConfigDir({});
    // Can't know exact home in CI, but must end with /prompt-registry
    expect(dir.endsWith('/prompt-registry')).toBe(true);
    expect(dir).not.toContain('XDG');
  });
});

describe('BuiltInOnlyLayoutConfigLoader', () => {
  it('returns exactly one layer', async () => {
    const loader = new BuiltInOnlyLayoutConfigLoader();
    const layers = await loader.load();
    expect(layers).toHaveLength(1);
  });

  it('built-in layer contains vscode layout', async () => {
    const loader = new BuiltInOnlyLayoutConfigLoader();
    const [builtIn] = await loader.load();
    expect(builtIn.layouts).toHaveProperty('vscode');
    expect(builtIn.layouts.vscode.user.kindRoutes['prompts/']).toBe('prompts/');
  });

  it('built-in layer contains all standard target types', async () => {
    const loader = new BuiltInOnlyLayoutConfigLoader();
    const [builtIn] = await loader.load();
    for (const type of ['vscode', 'vscode-insiders', 'copilot-cli', 'kiro', 'windsurf', 'claude-code']) {
      expect(builtIn.layouts).toHaveProperty(type);
    }
  });

  it('built-in kiro repository scope routes prompts to .kiro/steering/', async () => {
    const loader = new BuiltInOnlyLayoutConfigLoader();
    const [builtIn] = await loader.load();
    expect(builtIn.layouts.kiro.repository?.kindRoutes['prompts/']).toBe('.kiro/steering/');
  });
});

describe('FileSystemLayoutConfigLoader', () => {
  const makeFs = (files: Record<string, string>): LayoutConfigFs => ({
    readFile: async (p: string): Promise<string> => {
      if (Object.prototype.hasOwnProperty.call(files, p)) {
        return files[p];
      }
      throw new Error(`ENOENT: ${p}`);
    },
    exists: async (p: string): Promise<boolean> =>
      Object.prototype.hasOwnProperty.call(files, p)
  });

  it('returns only built-in when no override files exist', async () => {
    const loader = new FileSystemLayoutConfigLoader({
      cwd: '/project',
      fs: makeFs({}),
      userConfigDir: '/home/user/.config/prompt-registry'
    });
    const layers = await loader.load();
    expect(layers).toHaveLength(1);
    expect(layers[0].layouts).toHaveProperty('vscode');
  });

  it('loads user config as second layer', async () => {
    const userFile = `/home/user/.config/prompt-registry/${LAYOUTS_CONFIG_FILE}`;
    const loader = new FileSystemLayoutConfigLoader({
      cwd: '/project',
      fs: makeFs({
        [userFile]: `
layouts:
  vscode:
    user:
      baseDir: "/custom/user/vscode"
      kindRoutes:
        "prompts/": "custom-prompts/"
`
      }),
      userConfigDir: '/home/user/.config/prompt-registry'
    });
    const layers = await loader.load();
    expect(layers).toHaveLength(2);
    expect(layers[1].layouts.vscode.user.baseDir).toBe('/custom/user/vscode');
  });

  it('loads project config as third layer', async () => {
    const projectFile = `/project/${LAYOUTS_CONFIG_FILE}`;
    const loader = new FileSystemLayoutConfigLoader({
      cwd: '/project',
      fs: makeFs({
        [projectFile]: `
layouts:
  kiro:
    user:
      baseDir: "/project/.kiro"
      kindRoutes:
        "prompts/": "steering/"
`
      }),
      userConfigDir: '/home/user/.config/prompt-registry'
    });
    const layers = await loader.load();
    expect(layers).toHaveLength(2);
    expect(layers[1].layouts.kiro.user.baseDir).toBe('/project/.kiro');
  });

  it('loads both user and project configs as layers 2 and 3', async () => {
    const userFile = `/home/user/.config/prompt-registry/${LAYOUTS_CONFIG_FILE}`;
    const projectFile = `/project/${LAYOUTS_CONFIG_FILE}`;
    const loader = new FileSystemLayoutConfigLoader({
      cwd: '/project',
      fs: makeFs({
        [userFile]: `
layouts:
  vscode:
    user:
      baseDir: "/user/vscode"
      kindRoutes:
        "prompts/": "prompts/"
`,
        [projectFile]: `
layouts:
  kiro:
    user:
      baseDir: "/project/.kiro"
      kindRoutes:
        "prompts/": "steering/"
`
      }),
      userConfigDir: '/home/user/.config/prompt-registry'
    });
    const layers = await loader.load();
    expect(layers).toHaveLength(3);
    expect(layers[1].layouts.vscode.user.baseDir).toBe('/user/vscode');
    expect(layers[2].layouts.kiro.user.baseDir).toBe('/project/.kiro');
  });

  it('walks up from cwd to find project config', async () => {
    const projectFile = `/workspace/${LAYOUTS_CONFIG_FILE}`;
    const loader = new FileSystemLayoutConfigLoader({
      cwd: '/workspace/subdir/deeper',
      fs: makeFs({
        [projectFile]: `
layouts:
  vscode:
    user:
      baseDir: "/workspace/.vscode"
      kindRoutes:
        "prompts/": "prompts/"
`
      }),
      userConfigDir: '/home/user/.config/prompt-registry'
    });
    const layers = await loader.load();
    expect(layers).toHaveLength(2);
    expect(layers[1].layouts.vscode.user.baseDir).toBe('/workspace/.vscode');
  });

  it('skips and warns on invalid user config file', async () => {
    const userFile = `/home/user/.config/prompt-registry/${LAYOUTS_CONFIG_FILE}`;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loader = new FileSystemLayoutConfigLoader({
      cwd: '/project',
      fs: makeFs({ [userFile]: 'this is not valid yaml: {{{ bad' }),
      userConfigDir: '/home/user/.config/prompt-registry'
    });
    const layers = await loader.load();
    expect(layers).toHaveLength(1); // only built-in
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping invalid layout config'));
    warnSpy.mockRestore();
  });

  it('skips and warns on semantically invalid config', async () => {
    const userFile = `/home/user/.config/prompt-registry/${LAYOUTS_CONFIG_FILE}`;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loader = new FileSystemLayoutConfigLoader({
      cwd: '/project',
      fs: makeFs({
        [userFile]: `
layouts:
  vscode:
    user: "this should be an object, not a string"
`
      }),
      userConfigDir: '/home/user/.config/prompt-registry'
    });
    const layers = await loader.load();
    expect(layers).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
