/**
 * Tests for infra/host-app/host-app-target.ts — the pure appName/uriScheme
 * → TargetType mapping (no vscode dependency).
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  resolveHostApp,
} from '../../src/host-app/host-app-target';

describe('resolveHostApp', () => {
  it.each([
    // [appName, uriScheme, expected]
    ['Kiro', '', 'kiro'],
    ['Visual Studio Code', 'kiro', 'kiro'], // uriScheme wins when appName is generic
    ['Windsurf', '', 'windsurf'],
    ['Devin', '', 'windsurf'], // Devin is a Windsurf rebrand
    ['Visual Studio Code - Insiders', '', 'vscode-insiders'],
    ['Visual Studio Code', '', 'vscode'],
    ['', '', 'vscode'], // fallback
    ['Kiro Insiders', '', 'kiro'] // more specific rule wins
  ] as const)('resolves (%s, %s) -> %s', (appName, uriScheme, expected) => {
    expect(resolveHostApp(appName, uriScheme)).toBe(expected);
  });

  it('is case-insensitive', () => {
    expect(resolveHostApp('MY-KIRO-BUILD', '')).toBe('kiro');
  });
});
