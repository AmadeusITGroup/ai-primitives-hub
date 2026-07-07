import * as assert from 'node:assert';
import {
  resolveTargetLayout,
} from '../../src/services/target-layout-registry';
import {
  validateTargetLayout,
} from '../../src/types/target';
import type {
  Target,
  TargetLayout,
} from '../../src/types/target';

suite('VS Code target layout registry', () => {
  suite('user scope', () => {
    test('resolves a complete layout for vscode user scope', () => {
      const target: Target = { type: 'vscode', scope: 'user' };
      const layout = resolveTargetLayout(target);

      assert.strictEqual(layout.targetType, 'vscode');
      assert.strictEqual(layout.scope, 'user');
      assert.strictEqual(layout.basePath, 'user');
      assert.deepStrictEqual(layout.routes, {
        prompt: 'prompts',
        instruction: 'prompts',
        agent: 'prompts',
        skill: 'skills',
        plugin: 'plugins',
        hook: 'hooks'
      });
    });

    test('user-scope layout passes validation for all resource kinds', () => {
      const layout = resolveTargetLayout({ type: 'vscode', scope: 'user' });
      const result = validateTargetLayout(layout);

      assert.strictEqual(result.valid, true);
      assert.deepStrictEqual(result.errors, []);
    });

    test('vscode-insiders user scope resolves the same layout as vscode', () => {
      const vscodeLayout = resolveTargetLayout({ type: 'vscode', scope: 'user' });
      const insidersLayout = resolveTargetLayout({ type: 'vscode-insiders', scope: 'user' });

      assert.deepStrictEqual(insidersLayout.routes, vscodeLayout.routes);
      assert.strictEqual(insidersLayout.basePath, vscodeLayout.basePath);
    });
  });

  suite('repository scope', () => {
    test('resolves a complete layout for vscode repository scope', () => {
      const target: Target = { type: 'vscode', scope: 'repository' };
      const layout = resolveTargetLayout(target);

      assert.strictEqual(layout.targetType, 'vscode');
      assert.strictEqual(layout.scope, 'repository');
      assert.strictEqual(layout.basePath, 'repository');
      assert.deepStrictEqual(layout.routes, {
        prompt: '.github/prompts',
        instruction: '.github/instructions',
        agent: '.github/agents',
        skill: '.github/skills',
        plugin: '.github/plugins',
        hook: '.github/hooks'
      });
    });

    test('repository-scope layout passes validation for all resource kinds', () => {
      const layout = resolveTargetLayout({ type: 'vscode', scope: 'repository' });
      const result = validateTargetLayout(layout);

      assert.strictEqual(result.valid, true);
      assert.deepStrictEqual(result.errors, []);
    });

    test('vscode-insiders repository scope resolves the same layout as vscode', () => {
      const vscodeLayout = resolveTargetLayout({ type: 'vscode', scope: 'repository' });
      const insidersLayout = resolveTargetLayout({ type: 'vscode-insiders', scope: 'repository' });

      assert.deepStrictEqual(insidersLayout.routes, vscodeLayout.routes);
      assert.strictEqual(insidersLayout.basePath, vscodeLayout.basePath);
    });
  });

  suite('route coverage', () => {
    test('every resource kind has a route in both scopes', () => {
      const scopes: Target['scope'][] = ['user', 'repository'];

      for (const scope of scopes) {
        const layout: TargetLayout = resolveTargetLayout({ type: 'vscode', scope });

        assert.ok(layout.routes.prompt, `missing prompt route for ${scope}`);
        assert.ok(layout.routes.instruction, `missing instruction route for ${scope}`);
        assert.ok(layout.routes.agent, `missing agent route for ${scope}`);
        assert.ok(layout.routes.skill, `missing skill route for ${scope}`);
        assert.ok(layout.routes.plugin, `missing plugin route for ${scope}`);
        assert.ok(layout.routes.hook, `missing hook route for ${scope}`);
      }
    });
  });
});
