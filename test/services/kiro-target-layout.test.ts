import * as assert from 'node:assert';
import {
  resolveTargetLayout,
} from '../../src/services/target-layout-registry';
import type {
  Target,
} from '../../src/types/target';

suite('Kiro target layout registry', () => {
  suite('user scope', () => {
    test('resolves a complete layout for kiro user scope', () => {
      const target: Target = { type: 'kiro', scope: 'user' };
      const layout = resolveTargetLayout(target);

      assert.strictEqual(layout.targetType, 'kiro');
      assert.strictEqual(layout.scope, 'user');
      assert.ok(layout.routes.prompt, 'kiro user scope must route prompts');
      assert.ok(layout.routes.skill, 'kiro user scope must route skills');
    });

    test('user-scope layout passes validation for kiro-supported resource kinds', () => {
      const layout = resolveTargetLayout({ type: 'kiro', scope: 'user' });

      assert.ok(layout.routes.prompt);
      assert.ok(layout.routes.skill);
    });
  });

  suite('repository scope', () => {
    test('resolves a complete layout for kiro repository scope', () => {
      const target: Target = { type: 'kiro', scope: 'repository' };
      const layout = resolveTargetLayout(target);

      assert.strictEqual(layout.targetType, 'kiro');
      assert.strictEqual(layout.scope, 'repository');
      assert.ok(layout.routes.prompt, 'kiro repository scope must route prompts');
      assert.ok(layout.routes.skill, 'kiro repository scope must route skills');
    });

    test('repository-scope layout routes prompts to .github/prompts', () => {
      const layout = resolveTargetLayout({ type: 'kiro', scope: 'repository' });

      assert.ok(layout.routes.prompt);
      assert.ok(layout.routes.skill);
    });
  });

  suite('route coverage', () => {
    test('prompt and skill routes exist in both scopes', () => {
      const scopes: Target['scope'][] = ['user', 'repository'];

      for (const scope of scopes) {
        const layout = resolveTargetLayout({ type: 'kiro', scope });

        assert.ok(layout.routes.prompt, `missing prompt route for ${scope}`);
        assert.ok(layout.routes.skill, `missing skill route for ${scope}`);
      }
    });

    test('kiro does not route instruction or agent resources', () => {
      const userLayout = resolveTargetLayout({ type: 'kiro', scope: 'user' });
      const repoLayout = resolveTargetLayout({ type: 'kiro', scope: 'repository' });

      assert.strictEqual(userLayout.routes.instruction, undefined);
      assert.strictEqual(userLayout.routes.agent, undefined);
      assert.strictEqual(repoLayout.routes.instruction, undefined);
      assert.strictEqual(repoLayout.routes.agent, undefined);
    });
  });
});
