/**
 * Tests for infra/host/host-target.ts.
 *
 * `resolveHostTargetType` is the pure, framework-free helper that maps a
 * host's identity signals (appName + uriScheme) to a TargetType. No vscode
 * dependency, so it is a plain unit test — mirroring the xdg-base-dirs helper.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  resolveHostTargetType,
} from '../../src/host/host-target';

describe('resolveHostTargetType', () => {
  describe('appName signal', () => {
    it('maps Kiro to kiro', () => {
      expect(resolveHostTargetType('Kiro', '')).toBe('kiro');
    });

    it('maps Windsurf to windsurf', () => {
      expect(resolveHostTargetType('Windsurf', '')).toBe('windsurf');
    });

    it('maps Devin to windsurf (Windsurf rebrand)', () => {
      expect(resolveHostTargetType('Devin', '')).toBe('windsurf');
    });

    it('maps VS Code Insiders to vscode-insiders', () => {
      expect(resolveHostTargetType('Visual Studio Code - Insiders', '')).toBe('vscode-insiders');
    });

    it('maps plain VS Code to vscode', () => {
      expect(resolveHostTargetType('Visual Studio Code', '')).toBe('vscode');
    });

    it('maps Claude to vscode (not a VS Code fork)', () => {
      expect(resolveHostTargetType('Claude', '')).toBe('vscode');
    });
  });

  describe('uriScheme signal', () => {
    it('detects kiro from uriScheme even when appName is generic', () => {
      expect(resolveHostTargetType('Visual Studio Code', 'kiro')).toBe('kiro');
    });

    it('detects windsurf from uriScheme', () => {
      expect(resolveHostTargetType('Code', 'windsurf')).toBe('windsurf');
    });

    it('detects windsurf from a devin uriScheme', () => {
      expect(resolveHostTargetType('Code', 'devin')).toBe('windsurf');
    });
  });

  describe('fallback & precedence', () => {
    it('falls back to vscode for empty/undefined signals', () => {
      expect(resolveHostTargetType()).toBe('vscode');
      expect(resolveHostTargetType('', '')).toBe('vscode');
      expect(resolveHostTargetType('Unknown Editor', 'unknown')).toBe('vscode');
    });

    it('is case-insensitive', () => {
      expect(resolveHostTargetType('MY-KIRO-BUILD', '')).toBe('kiro');
      expect(resolveHostTargetType('', 'WINDSURF')).toBe('windsurf');
    });

    it('prioritizes kiro over insiders', () => {
      expect(resolveHostTargetType('Kiro Insiders', '')).toBe('kiro');
    });
  });
});
