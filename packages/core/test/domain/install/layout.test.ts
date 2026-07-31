/**
 * Tests for core/domain/install/layout.ts.
 *
 * `expandPath`, `resolvePathTokens` and `resolveMcpConfigPath` are pure (no IO), so
 * these are plain unit assertions. They live at the core layer because that is where
 * the functions are defined — the `app` package only re-exports `expandPath` for
 * backwards compatibility.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import type {
  McpLayoutConfig,
} from '../../../src/domain/install/layout';
import {
  expandPath,
  HOME_TOKEN,
  resolveMcpConfigPath,
  resolvePathTokens,
  UnresolvedPathTokenError,
  VSCODE_USER_DIR_TOKEN,
  WORKSPACE_ROOT_TOKEN,
} from '../../../src/domain/install/layout';

describe('path tokens', () => {
  it('exposes the tokens used in layout templates', () => {
    expect(HOME_TOKEN).toBe('${HOME}');
    expect(WORKSPACE_ROOT_TOKEN).toBe('${workspaceRoot}');
    expect(VSCODE_USER_DIR_TOKEN).toBe('${vscodeUserDir}');
  });
});

describe('expandPath', () => {
  it('expands a ${VAR} token from the provided env', () => {
    expect(expandPath('${HOME}/.config', { HOME: '/home/alice' })).toBe('/home/alice/.config');
  });

  it('expands a leading ~ using HOME', () => {
    expect(expandPath('~/.config', { HOME: '/home/alice' })).toBe('/home/alice/.config');
  });

  it('falls back to USERPROFILE for a leading ~ on Windows', () => {
    expect(expandPath('~/.config', { USERPROFILE: 'C:/Users/alice' })).toBe('C:/Users/alice/.config');
  });

  it('replaces an unknown ${VAR} with an empty string', () => {
    // Legacy behaviour, retained for baseDir compatibility. New MCP path
    // resolution uses resolvePathTokens, which throws instead.
    expect(expandPath('${UNKNOWN}/x', {})).toBe('/x');
  });

  it('passes through a template with no tokens', () => {
    expect(expandPath('/absolute/path/mcp.json', {})).toBe('/absolute/path/mcp.json');
  });
});

describe('resolvePathTokens', () => {
  it('resolves an uppercase token', () => {
    expect(resolvePathTokens('${HOME}/.kiro/mcp.json', { HOME: '/home/alice' }))
      .toBe('/home/alice/.kiro/mcp.json');
  });

  it('resolves a camelCase token, which expandPath cannot match', () => {
    // expandPath's pattern is uppercase-only, so camelCase tokens used to survive
    // into the resolved path and create a directory literally named ${...}.
    expect(resolvePathTokens('${workspaceRoot}/.vscode/mcp.json', { workspaceRoot: '/ws' }))
      .toBe('/ws/.vscode/mcp.json');
    expect(resolvePathTokens('${vscodeUserDir}/mcp.json', { vscodeUserDir: '/ud/User' }))
      .toBe('/ud/User/mcp.json');
  });

  it('resolves several tokens in one template', () => {
    expect(resolvePathTokens('${a}/${b}/f.json', { a: '/x', b: 'y' })).toBe('/x/y/f.json');
  });

  it('resolves repeated occurrences of the same token', () => {
    expect(resolvePathTokens('${r}/sub/${r}', { r: '/ws' })).toBe('/ws/sub//ws');
  });

  it('passes through a template with no tokens', () => {
    expect(resolvePathTokens('/etc/mcp.json', {})).toBe('/etc/mcp.json');
  });

  it('throws on a token the caller did not supply', () => {
    expect(() => resolvePathTokens('${nope}/mcp.json', { HOME: '/h' }))
      .toThrow(UnresolvedPathTokenError);
  });

  it('throws rather than substituting an empty value', () => {
    // An empty ${HOME} would turn ${HOME}/.kiro/mcp.json into an absolute
    // /.kiro/mcp.json, writing outside the user's home directory.
    expect(() => resolvePathTokens('${HOME}/.kiro/mcp.json', { HOME: '' }))
      .toThrow(UnresolvedPathTokenError);
  });

  it('throws when a token value is undefined', () => {
    expect(() => resolvePathTokens('${workspaceRoot}/x', { workspaceRoot: undefined }))
      .toThrow(UnresolvedPathTokenError);
  });

  it('reports the offending token and template on the error', () => {
    try {
      resolvePathTokens('${vscodeUserDir}/mcp.json', {});
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnresolvedPathTokenError);
      const typed = error as UnresolvedPathTokenError;
      expect(typed.token).toBe('${vscodeUserDir}');
      expect(typed.template).toBe('${vscodeUserDir}/mcp.json');
      expect(typed.message).toContain('${vscodeUserDir}');
    }
  });
});

describe('resolveMcpConfigPath', () => {
  const config = (templatePath: string): McpLayoutConfig => ({
    path: templatePath,
    serversKey: 'mcpServers'
  });

  it('resolves a HOME-relative user path', () => {
    expect(resolveMcpConfigPath(config('${HOME}/.kiro/settings/mcp.json'), { HOME: '/home/alice' }))
      .toBe('/home/alice/.kiro/settings/mcp.json');
  });

  it('resolves a workspace-relative repository path', () => {
    expect(resolveMcpConfigPath(config('${workspaceRoot}/.kiro/settings/mcp.json'), { workspaceRoot: '/ws' }))
      .toBe('/ws/.kiro/settings/mcp.json');
  });

  it('resolves a root-level repository file such as Claude Code .mcp.json', () => {
    expect(resolveMcpConfigPath(config('${workspaceRoot}/.mcp.json'), { workspaceRoot: '/ws' }))
      .toBe('/ws/.mcp.json');
  });

  it('resolves the vscodeUserDir token', () => {
    expect(resolveMcpConfigPath(config('${vscodeUserDir}/mcp.json'), { vscodeUserDir: '/ud/User' }))
      .toBe('/ud/User/mcp.json');
  });

  it('throws when the required token is missing', () => {
    expect(() => resolveMcpConfigPath(config('${workspaceRoot}/.mcp.json'), { HOME: '/h' }))
      .toThrow(UnresolvedPathTokenError);
  });
});
