/**
 * Tests for the built-in layout defaults.
 *
 * `defaultLayouts` narrows the raw JSON import to `TargetLayoutsConfig` with an
 * assertion, because TypeScript widens JSON string literals and so cannot check the
 * `McpServersKey` union structurally. These tests are what make that assertion
 * trustworthy: without them a typo such as `"serversKey": "server"` would compile,
 * pass CI, and produce a config no IDE reads.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  defaultLayouts,
  validateBuiltInLayouts,
} from '../../src/writers/default-layouts';

describe('built-in default layouts', () => {
  it('satisfies the same runtime validator as user-supplied layout files', () => {
    expect(() => validateBuiltInLayouts()).not.toThrow();
  });

  it('defines a user layout for every target', () => {
    const types = Object.keys(defaultLayouts.layouts);
    expect(types.length).toBeGreaterThan(0);
    for (const type of types) {
      expect(defaultLayouts.layouts[type].user, `${type}.user`).toBeDefined();
      expect(typeof defaultLayouts.layouts[type].user.baseDir).toBe('string');
    }
  });

  it('uses only known serversKey values in every mcpConfig', () => {
    for (const [type, def] of Object.entries(defaultLayouts.layouts)) {
      for (const scope of ['user', 'repository'] as const) {
        const mcpConfig = def[scope]?.mcpConfig;
        if (!mcpConfig) {
          continue;
        }
        expect(['servers', 'mcpServers'], `${type}.${scope}.serversKey`)
          .toContain(mcpConfig.serversKey);
      }
    }
  });

  it('gives every mcpConfig path a token appropriate to its scope', () => {
    // A user path must not be workspace-relative and a repository path must be, or
    // the file would resolve outside the scope the caller asked for.
    for (const [type, def] of Object.entries(defaultLayouts.layouts)) {
      const userPath = def.user.mcpConfig?.path;
      if (userPath) {
        expect(userPath, `${type}.user.path`).not.toContain('${workspaceRoot}');
      }
      const repoPath = def.repository?.mcpConfig?.path;
      if (repoPath) {
        expect(repoPath, `${type}.repository.path`).toContain('${workspaceRoot}');
      }
    }
  });

  it('leaves no unresolved token style other than the supported ones', () => {
    const supported = new Set(['HOME', 'workspaceRoot', 'vscodeUserDir']);
    for (const [type, def] of Object.entries(defaultLayouts.layouts)) {
      for (const scope of ['user', 'repository'] as const) {
        const templatePath = def[scope]?.mcpConfig?.path;
        if (!templatePath) {
          continue;
        }
        for (const match of templatePath.matchAll(/\$\{([^}]+)\}/g)) {
          expect(supported, `${type}.${scope} uses unknown token \${${match[1]}}`)
            .toContain(match[1]);
        }
      }
    }
  });
});
