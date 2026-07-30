/**
 * Tests for core/domain/install/layout.ts.
 *
 * `expandPath` and `expandMcpUserFilePath` are pure (no IO), so these are plain
 * unit assertions. They live at the core layer because that is where the
 * functions are defined — the `app` package only re-exports `expandPath` for
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
  expandMcpUserFilePath,
  expandPath,
  HOME_TOKEN,
} from '../../../src/domain/install/layout';

describe('HOME_TOKEN', () => {
  it('is the ${HOME} placeholder used in userFile templates', () => {
    expect(HOME_TOKEN).toBe('${HOME}');
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
    expect(expandPath('${UNKNOWN}/x', {})).toBe('/x');
  });

  it('expands multiple tokens in one template', () => {
    expect(expandPath('${HOME}/${SUB}/f.json', { HOME: '/h', SUB: 'a' })).toBe('/h/a/f.json');
  });

  it('passes through a template with no tokens', () => {
    expect(expandPath('/absolute/path/mcp.json', {})).toBe('/absolute/path/mcp.json');
  });

  it('leaves a ~ that is not at the start untouched', () => {
    expect(expandPath('/tmp/~backup', { HOME: '/home/alice' })).toBe('/tmp/~backup');
  });

  it('uses an empty home when neither HOME nor USERPROFILE is set', () => {
    expect(expandPath('~/x', {})).toBe('/x');
  });
});

describe('expandMcpUserFilePath', () => {
  const config = (userFile: string | null): McpLayoutConfig => ({
    userFile,
    workspaceFile: null,
    serversKey: 'mcpServers'
  });

  it('returns null when userFile is null', () => {
    // null means the IDE resolves its user path by other means
    // (VS Code derives it from globalStorageUri).
    expect(expandMcpUserFilePath(config(null), '/home/alice')).toBeNull();
  });

  it('expands ${HOME} using the provided home directory', () => {
    const result = expandMcpUserFilePath(config('${HOME}/.kiro/settings/mcp.json'), '/home/alice');
    expect(result).toBe('/home/alice/.kiro/settings/mcp.json');
  });

  it('supplies the home directory as the USERPROFILE fallback too', () => {
    const result = expandMcpUserFilePath(config('${USERPROFILE}/.kiro/mcp.json'), 'C:/Users/alice');
    expect(result).toBe('C:/Users/alice/.kiro/mcp.json');
  });

  it('expands a leading ~ using the provided home directory', () => {
    expect(expandMcpUserFilePath(config('~/.claude.json'), '/home/alice')).toBe('/home/alice/.claude.json');
  });

  it('passes through a userFile with no token', () => {
    expect(expandMcpUserFilePath(config('/etc/mcp.json'), '/home/alice')).toBe('/etc/mcp.json');
  });

  it('does not treat an empty-string userFile as a path', () => {
    // Empty string is falsy, so it is treated the same as null rather than
    // producing a bare home directory.
    expect(expandMcpUserFilePath(config(''), '/home/alice')).toBeNull();
  });
});
