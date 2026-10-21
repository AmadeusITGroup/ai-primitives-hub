/**
 * Tests for core/domain/mcp/env-placeholders.ts.
 *
 * Regression coverage for secrets being written to MCP config files: install
 * must translate `${env:VAR}` placeholders, never resolve them.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  validateTargetLayoutsConfig,
} from '../../../src/domain/install/layout';
import {
  rewriteEnvPlaceholders,
} from '../../../src/domain/mcp/env-placeholders';

describe('rewriteEnvPlaceholders', () => {
  it('keeps ${env:VAR} verbatim for prefixed hosts', () => {
    expect(rewriteEnvPlaceholders('Token ${env:JIRA_PAT}', 'prefixed')).toBe('Token ${env:JIRA_PAT}');
  });

  it('translates ${env:VAR} to ${VAR} for bare hosts', () => {
    expect(rewriteEnvPlaceholders('Token ${env:JIRA_PAT}', 'bare')).toBe('Token ${JIRA_PAT}');
  });

  it('preserves a :- default suffix', () => {
    expect(rewriteEnvPlaceholders('${env:VAR:-}', 'bare')).toBe('${VAR:-}');
    expect(rewriteEnvPlaceholders('${env:VAR:-x}', 'prefixed')).toBe('${env:VAR:-x}');
  });

  it('translates every placeholder and leaves other tokens untouched', () => {
    expect(rewriteEnvPlaceholders('${env:A}:${input:b}:${env:C}', 'bare')).toBe('${A}:${input:b}:${C}');
  });
});

describe('validateTargetLayoutsConfig envPlaceholderStyle', () => {
  const layouts = (envPlaceholderStyle: unknown): unknown => ({
    layouts: {
      kiro: {
        user: {
          baseDir: '${HOME}/.kiro',
          kindRoutes: {},
          mcpConfig: { path: '${HOME}/.kiro/settings/mcp.json', serversKey: 'mcpServers', envPlaceholderStyle }
        }
      }
    }
  });

  it('accepts a known style', () => {
    expect(() => validateTargetLayoutsConfig(layouts('bare'))).not.toThrow();
  });

  it('rejects an unknown style', () => {
    expect(() => validateTargetLayoutsConfig(layouts('shell'))).toThrow(/envPlaceholderStyle/);
  });
});
