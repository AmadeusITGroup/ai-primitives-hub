/**
 * host-editor Unit Tests
 *
 * Tests host-editor detection: mapping `vscode.env.appName` variations to
 * the correct `TargetType`, with a safe fallback to `vscode` for unknown
 * hosts (no regression).
 */

import * as assert from 'node:assert';
import type {
  TargetType,
} from '@ai-primitives-hub/core';
import {
  detectHostTargetType,
} from '../../src/utils/host-editor';

suite('host-editor', () => {
  suite('detectHostTargetType', () => {
    // appName-driven detection (empty uriScheme).
    const cases: { appName: string; expected: TargetType }[] = [
      { appName: 'Kiro', expected: 'kiro' },
      { appName: 'kiro', expected: 'kiro' },
      { appName: 'Visual Studio Code', expected: 'vscode' },
      { appName: 'Visual Studio Code - Insiders', expected: 'vscode-insiders' },
      { appName: 'Windsurf', expected: 'windsurf' },
      // Devin is a Windsurf rebrand sharing its paths -> windsurf.
      { appName: 'Devin', expected: 'windsurf' },
      // Claude Code is not a VS Code fork; it never runs this extension, so
      // an appName matching it falls back to vscode.
      { appName: 'Claude', expected: 'vscode' },
      { appName: '', expected: 'vscode' },
      { appName: 'Unknown Editor', expected: 'vscode' }
    ];

    for (const { appName, expected } of cases) {
      test(`maps appName "${appName}" to "${expected}"`, () => {
        assert.strictEqual(detectHostTargetType(appName, ''), expected);
      });
    }

    // uriScheme-driven detection (generic appName) — the signal that the
    // repo-scope path previously missed.
    const uriCases: { uriScheme: string; expected: TargetType }[] = [
      { uriScheme: 'kiro', expected: 'kiro' },
      { uriScheme: 'windsurf', expected: 'windsurf' },
      { uriScheme: 'devin', expected: 'windsurf' },
      { uriScheme: 'vscode', expected: 'vscode' },
      { uriScheme: 'vscode-insiders', expected: 'vscode-insiders' }
    ];

    for (const { uriScheme, expected } of uriCases) {
      test(`maps uriScheme "${uriScheme}" (generic appName) to "${expected}"`, () => {
        assert.strictEqual(detectHostTargetType('Code', uriScheme), expected);
      });
    }

    test('matches case-insensitively across both signals', () => {
      assert.strictEqual(detectHostTargetType('MY-KIRO-BUILD', ''), 'kiro');
      assert.strictEqual(detectHostTargetType('', 'WINDSURF'), 'windsurf');
    });

    test('prioritizes kiro over insiders when both appear', () => {
      assert.strictEqual(detectHostTargetType('Kiro Insiders', ''), 'kiro');
    });

    test('detects the host from uriScheme even when appName is generic', () => {
      // Regression: a fork whose appName does not contain "kiro" but whose
      // uriScheme does must still resolve to kiro (repo-scope parity with
      // the user-scope path).
      assert.strictEqual(detectHostTargetType('Visual Studio Code', 'kiro'), 'kiro');
    });
  });
});
