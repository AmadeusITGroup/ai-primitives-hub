/**
 * Tests for app/install/layout-resolver.ts.
 *
 * The resolver is pure (no IO), so tests are simple unit assertions
 * over different target/layer configurations.
 */
import type {
  Target,
  TargetLayoutsConfig,
} from '@prompt-registry/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  resolveLayoutFromLayers,
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
      name: 't', type: 'vscode', scope: 'repository', workspaceRoot: '/ws'
    };
    const cfg = minimalConfig('vscode', '${HOME}/.vscode', '${workspaceRoot}');
    const result = resolveLayoutFromLayers(target, [cfg]);
    expect(result).not.toBeNull();
    expect(result!.baseDir).toBe('/ws');
    expect(result!.kindRoutes['prompts/']).toBe('.tool/prompts/');
  });

  it('falls back to user scope when no repository def exists', () => {
    const target: Target = {
      name: 't', type: 'vscode', scope: 'repository', workspaceRoot: '/ws'
    };
    const cfg = minimalConfig('vscode', '${HOME}/.vscode'); // no repository def
    const result = resolveLayoutFromLayers(target, [cfg]);
    expect(result).not.toBeNull();
    expect(result!.baseDir).toBe('${HOME}/.vscode'); // user baseDir, not workspaceRoot
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

  it('resolves ${workspaceRoot} from target.workspaceRoot', () => {
    const target: Target = {
      name: 't', type: 'vscode', scope: 'repository', workspaceRoot: '/projects/foo'
    };
    const cfg = minimalConfig('vscode', '${HOME}/.vscode', '${workspaceRoot}');
    const result = resolveLayoutFromLayers(target, [cfg]);
    expect(result!.baseDir).toBe('/projects/foo');
  });

  it('resolves ${workspaceRoot} from target.path when workspaceRoot absent', () => {
    const target: Target = {
      name: 't', type: 'vscode', scope: 'repository', path: '/projects/bar'
    };
    const cfg = minimalConfig('vscode', '${HOME}/.vscode', '${workspaceRoot}');
    const result = resolveLayoutFromLayers(target, [cfg]);
    expect(result!.baseDir).toBe('/projects/bar');
  });

  it('resolves ${workspaceRoot} to "." when neither workspaceRoot nor path set', () => {
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
});
