/**
 * host-app adapter tests.
 *
 * `detectHostApp` is a thin delivery wrapper that forwards its (injectable)
 * appName/uriScheme args to infra's `resolveHostApp`. The full detection
 * matrix is covered in infra (`host-app/host-app-target.test.ts`); here we
 * only smoke-test the delegation and the safe fallback.
 */

import * as assert from 'node:assert';
import {
  detectHostApp,
} from '../../src/utils/host-app';

suite('host-app', () => {
  suite('detectHostApp', () => {
    test('forwards appName to the resolver (Kiro -> kiro)', () => {
      assert.strictEqual(detectHostApp('Kiro', ''), 'kiro');
    });

    test('forwards uriScheme to the resolver (generic appName, kiro scheme)', () => {
      assert.strictEqual(detectHostApp('Visual Studio Code', 'kiro'), 'kiro');
    });

    test('falls back to vscode for an unknown host app', () => {
      assert.strictEqual(detectHostApp('Unknown Editor', 'unknown'), 'vscode');
    });
  });
});
