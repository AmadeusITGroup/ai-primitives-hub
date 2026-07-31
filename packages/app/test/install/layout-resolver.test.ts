/**
 * Tests for app/install/layout-resolver.ts.
 *
 * The resolver is pure (no IO), so tests are simple unit assertions
 * over different target/layer configurations.
 */
import type {
  McpLayoutConfig,
  Target,
  TargetLayoutsConfig,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  resolveLayoutFromLayers,
  resolveMcpLayoutConfig,
} from '../../src/install/layout-resolver';

const minimalConfig = (
  type: string,
  userBase: string,
  repoBase?: string
): TargetLayoutsConfig => ({
  layouts: {
    [type]: {
      user: {
        baseDir: userBase,
        kindRoutes: { 'prompts/': 'prompts/' },
        skipPaths: ['deployment-manifest.yml']
      },
      ...(repoBase === undefined
        ? {}
        : {
          repository: {
            baseDir: repoBase,
            kindRoutes: { 'prompts/': '.tool/prompts/' },
            skipPaths: ['deployment-manifest.yml']
          }
        })
    }
  }
});

describe('resolveLayoutFromLayers', () => {
  it('returns null when no layer defines the target type', () => {
    const target: Target = { name: 'test', type: 'vscode', scope: 'user' };
    const result = resolveLayoutFromLayers(target, []);
    expect(result).toBeNull();
  });

  it('resolves user scope from single layer', () => {
    const target: Target = { name: 't', type: 'vscode', scope: 'user' };
    const cfg = minimalConfig('vscode', '${HOME}/.config/Code/User');
    const result = resolveLayoutFromLayers(target, [cfg]);
    expect(result).not.toBeNull();
    expect(result!.baseDir).toBe('${HOME}/.config/Code/User');
    expect(result!.kindRoutes['prompts/']).toBe('prompts/');
  });

  it('resolves repository scope using repository def', () => {
    const target: Target = {
      name: 't', type: 'vscode', scope: 'repository', rootPath: '/ws'
    };
    const cfg = minimalConfig('vscode', '${HOME}/.vscode', '${workspaceRoot}');
    const result = resolveLayoutFromLayers(target, [cfg]);
    expect(result).not.toBeNull();
    expect(result!.baseDir).toBe('/ws');
    expect(result!.kindRoutes['prompts/']).toBe('.tool/prompts/');
  });

  it('falls back to user scope when no repository def exists', () => {
    const target: Target = {
      name: 't', type: 'vscode', scope: 'repository', rootPath: '/ws'
    };
    const cfg = minimalConfig('vscode', '${HOME}/.vscode'); // no repository def
    const result = resolveLayoutFromLayers(target, [cfg]);
    expect(result).not.toBeNull();
    expect(result!.baseDir).toBe('${HOME}/.vscode'); // user baseDir, not workspaceRoot
    expect(result!.kindRoutes['prompts/']).toBe('prompts/');
  });

  it('treats workspace scope like user scope (no reference-branch equivalent)', () => {
    const target: Target = {
      name: 't', type: 'vscode', scope: 'workspace', rootPath: '/ws'
    } as unknown as Target;
    const cfg = minimalConfig('vscode', '${HOME}/.vscode', '${workspaceRoot}');
    const result = resolveLayoutFromLayers(target, [cfg]);
    expect(result).not.toBeNull();
    expect(result!.baseDir).toBe('${HOME}/.vscode');
    expect(result!.kindRoutes['prompts/']).toBe('prompts/');
  });

  it('deep-merges kindRoutes across layers', () => {
    const target: Target = { name: 't', type: 'vscode', scope: 'user' };
    const base: TargetLayoutsConfig = {
      layouts: {
        vscode: {
          user: {
            baseDir: '${HOME}/base',
            kindRoutes: { 'prompts/': 'prompts/', 'skills/': 'skills/' }
          }
        }
      }
    };
    const override: TargetLayoutsConfig = {
      layouts: {
        vscode: {
          user: {
            baseDir: '${HOME}/override',
            kindRoutes: { 'skills/': 'custom-skills/' } // only override skills
          }
        }
      }
    };
    const result = resolveLayoutFromLayers(target, [base, override]);
    expect(result).not.toBeNull();
    expect(result!.baseDir).toBe('${HOME}/override');
    expect(result!.kindRoutes['prompts/']).toBe('prompts/'); // preserved from base
    expect(result!.kindRoutes['skills/']).toBe('custom-skills/'); // overridden
  });

  it('later layer baseDir replaces earlier layer', () => {
    const target: Target = { name: 't', type: 'kiro', scope: 'user' };
    const base = minimalConfig('kiro', '${HOME}/.kiro');
    const proj = minimalConfig('kiro', '/custom/kiro');
    const result = resolveLayoutFromLayers(target, [base, proj]);
    expect(result!.baseDir).toBe('/custom/kiro');
  });

  it('skipPaths replaced by later layer when specified', () => {
    const target: Target = { name: 't', type: 'kiro', scope: 'user' };
    const base: TargetLayoutsConfig = {
      layouts: {
        kiro: {
          user: {
            baseDir: 'x',
            kindRoutes: {},
            skipPaths: ['a.yml']
          }
        }
      }
    };
    const override: TargetLayoutsConfig = {
      layouts: {
        kiro: {
          user: {
            baseDir: 'x',
            kindRoutes: {},
            skipPaths: ['b.yml', 'c.yml']
          }
        }
      }
    };
    const result = resolveLayoutFromLayers(target, [base, override]);
    expect(result!.skipPaths).toEqual(['b.yml', 'c.yml']);
  });

  it('skipPaths preserved from base when later layer omits it', () => {
    const target: Target = { name: 't', type: 'kiro', scope: 'user' };
    const base: TargetLayoutsConfig = {
      layouts: {
        kiro: {
          user: {
            baseDir: 'x',
            kindRoutes: {},
            skipPaths: ['base.yml']
          }
        }
      }
    };
    const override: TargetLayoutsConfig = {
      layouts: {
        kiro: {
          user: {
            baseDir: 'x',
            kindRoutes: {} // skipPaths absent
          }
        }
      }
    };
    const result = resolveLayoutFromLayers(target, [base, override]);
    expect(result!.skipPaths).toEqual(['base.yml']);
  });

  it('adds new target type defined only in a higher layer', () => {
    const target: Target = { name: 't', type: 'vscode', scope: 'user' };
    const base = minimalConfig('kiro', '${HOME}/.kiro'); // no vscode
    const extra = minimalConfig('vscode', '/my/vscode');
    const result = resolveLayoutFromLayers(target, [base, extra]);
    expect(result).not.toBeNull();
    expect(result!.baseDir).toBe('/my/vscode');
  });

  it('resolves ${workspaceRoot} from target.rootPath', () => {
    const target: Target = {
      name: 't', type: 'vscode', scope: 'repository', rootPath: '/projects/foo'
    };
    const cfg = minimalConfig('vscode', '${HOME}/.vscode', '${workspaceRoot}');
    const result = resolveLayoutFromLayers(target, [cfg]);
    expect(result!.baseDir).toBe('/projects/foo');
  });

  it('resolves ${workspaceRoot} from target.path when rootPath absent', () => {
    const target: Target = {
      name: 't', type: 'vscode', scope: 'repository', path: '/projects/bar'
    };
    const cfg = minimalConfig('vscode', '${HOME}/.vscode', '${workspaceRoot}');
    const result = resolveLayoutFromLayers(target, [cfg]);
    expect(result!.baseDir).toBe('/projects/bar');
  });

  it('resolves ${workspaceRoot} to "." when neither rootPath nor path set', () => {
    const target: Target = { name: 't', type: 'vscode', scope: 'repository' };
    const cfg = minimalConfig('vscode', '${HOME}/.vscode', '${workspaceRoot}');
    const result = resolveLayoutFromLayers(target, [cfg]);
    expect(result!.baseDir).toBe('.');
  });

  it('does not modify the baseDir when no workspaceRoot token', () => {
    const target: Target = { name: 't', type: 'vscode', scope: 'repository' };
    const cfg = minimalConfig('vscode', '${HOME}/.vscode', '/absolute/path');
    const result = resolveLayoutFromLayers(target, [cfg]);
    expect(result!.baseDir).toBe('/absolute/path');
  });

  it('substitutes ${workspaceRoot} inside a longer baseDir (e.g. "${workspaceRoot}/.github")', () => {
    const target: Target = { name: 't', type: 'vscode', scope: 'repository', rootPath: '/ws' };
    const cfg = minimalConfig('vscode', '${HOME}/.vscode', '${workspaceRoot}/.github');
    const result = resolveLayoutFromLayers(target, [cfg]);
    expect(result!.baseDir).toBe('/ws/.github');
  });

  it('substitutes ${workspaceRoot} for a .kiro repository baseDir', () => {
    const target: Target = { name: 't', type: 'kiro', scope: 'repository', rootPath: '/ws' };
    const cfg = minimalConfig('kiro', '${HOME}/.kiro', '${workspaceRoot}/.kiro');
    const result = resolveLayoutFromLayers(target, [cfg]);
    expect(result!.baseDir).toBe('/ws/.kiro');
  });

  it('does not recurse when the resolved workspaceRoot itself contains the token text', () => {
    // Defensive: split/join substitutes once and never re-scans the inserted
    // value, so a workspaceRoot that literally contains "${workspaceRoot}"
    // stays intact rather than being re-substituted.
    const target: Target = {
      name: 't', type: 'vscode', scope: 'repository', rootPath: '/home/${workspaceRoot}/proj'
    };
    const cfg = minimalConfig('vscode', '${HOME}/.vscode', '${workspaceRoot}/.github');
    const result = resolveLayoutFromLayers(target, [cfg]);
    expect(result!.baseDir).toBe('/home/${workspaceRoot}/proj/.github');
  });
});

describe('resolveMcpLayoutConfig', () => {
  const scoped = (baseDir: string, mcpConfig?: McpLayoutConfig) => ({
    baseDir,
    kindRoutes: { 'prompts/': 'prompts/' },
    skipPaths: [],
    ...(mcpConfig === undefined ? {} : { mcpConfig })
  });

  // Layer with an optional mcpConfig on each scope independently.
  const mcpLayer = (
    type: string,
    userMcp?: McpLayoutConfig,
    repoMcp?: McpLayoutConfig,
    withRepositoryScope = true
  ): TargetLayoutsConfig => ({
    layouts: {
      [type]: {
        user: scoped(`\${HOME}/.${type}`, userMcp),
        ...(withRepositoryScope
          ? { repository: scoped(`\${workspaceRoot}/.${type}`, repoMcp) }
          : {})
      }
    }
  });

  const kiroUserMcp: McpLayoutConfig = {
    path: '${HOME}/.kiro/settings/mcp.json',
    serversKey: 'mcpServers'
  };

  const kiroRepoMcp: McpLayoutConfig = {
    path: '${workspaceRoot}/.kiro/settings/mcp.json',
    serversKey: 'mcpServers'
  };

  const vscodeUserMcp: McpLayoutConfig = {
    path: '${vscodeUserDir}/mcp.json',
    serversKey: 'servers'
  };

  it('returns undefined when there are no layers', () => {
    expect(resolveMcpLayoutConfig('kiro', 'user', [])).toBeUndefined();
  });

  it('returns undefined for a target type no layer defines', () => {
    expect(resolveMcpLayoutConfig('emacs', 'user', [mcpLayer('kiro', kiroUserMcp)])).toBeUndefined();
  });

  it('returns undefined when the scope defines no mcpConfig', () => {
    expect(resolveMcpLayoutConfig('kiro', 'user', [mcpLayer('kiro')])).toBeUndefined();
  });

  it('returns the mcpConfig for the requested scope', () => {
    const layers = [mcpLayer('kiro', kiroUserMcp, kiroRepoMcp)];
    expect(resolveMcpLayoutConfig('kiro', 'user', layers)).toEqual(kiroUserMcp);
    expect(resolveMcpLayoutConfig('kiro', 'repository', layers)).toEqual(kiroRepoMcp);
  });

  it('does NOT fall back from repository to user scope', () => {
    // Windsurf and Copilot CLI have no workspace-level MCP file. Inheriting the
    // user entry would make a repository-scope install write into the user's
    // home config, so absence must stay meaningful.
    const layers = [mcpLayer('kiro', kiroUserMcp, undefined)];
    expect(resolveMcpLayoutConfig('kiro', 'repository', layers)).toBeUndefined();
    expect(resolveMcpLayoutConfig('kiro', 'user', layers)).toEqual(kiroUserMcp);
  });

  it('returns undefined for repository scope when the target has no repository branch', () => {
    const layers = [mcpLayer('kiro', kiroUserMcp, undefined, false)];
    expect(resolveMcpLayoutConfig('kiro', 'repository', layers)).toBeUndefined();
  });

  it('lets a later layer override an earlier one entirely', () => {
    const result = resolveMcpLayoutConfig('kiro', 'user', [
      mcpLayer('kiro', kiroUserMcp),
      mcpLayer('kiro', vscodeUserMcp)
    ]);
    expect(result).toEqual(vscodeUserMcp);
  });

  it('keeps the earlier layer when a later layer omits mcpConfig', () => {
    const result = resolveMcpLayoutConfig('kiro', 'user', [
      mcpLayer('kiro', kiroUserMcp),
      mcpLayer('kiro')
    ]);
    expect(result).toEqual(kiroUserMcp);
  });

  it('resolves each target type independently', () => {
    const layers = [mcpLayer('kiro', kiroUserMcp), mcpLayer('vscode', vscodeUserMcp)];
    expect(resolveMcpLayoutConfig('kiro', 'user', layers)).toEqual(kiroUserMcp);
    expect(resolveMcpLayoutConfig('vscode', 'user', layers)).toEqual(vscodeUserMcp);
  });
});
