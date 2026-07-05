import * as assert from 'node:assert';
import * as path from 'node:path';
import {
  resolveTargetLayout,
} from '../../src/services/target-layout-registry';
import {
  readTargetFileTree,
} from '../helpers/target-golden';

const FIXTURE_ROOT = path.join(process.cwd(), 'test', 'fixtures', 'golden');

suite('Golden output fixtures for target layouts', () => {
  suite('VS Code user scope', () => {
    test('golden fixture contains only expected prompt and skill files', async () => {
      const tree = await readTargetFileTree(path.join(FIXTURE_ROOT, 'vscode-user'));

      const filePaths = tree.files.map((f) => f.path);
      assert.ok(filePaths.includes('prompts/review.prompt.md'));
      assert.ok(filePaths.includes('prompts/coding.instructions.md'));
      assert.ok(filePaths.includes('prompts/planner.agent.md'));
      assert.ok(filePaths.some((p) => p.startsWith('skills/') && p.endsWith('SKILL.md')));
    });

    test('golden fixture routes match resolveTargetLayout for vscode user scope', () => {
      const layout = resolveTargetLayout({ type: 'vscode', scope: 'user' });

      assert.strictEqual(layout.routes.prompt, 'prompts');
      assert.strictEqual(layout.routes.skill, 'skills');
    });
  });

  suite('VS Code repository scope', () => {
    test('golden fixture contains .github prompt and skill files', async () => {
      const tree = await readTargetFileTree(path.join(FIXTURE_ROOT, 'vscode-repository'));

      const filePaths = tree.files.map((f) => f.path);
      assert.ok(filePaths.some((p) => p.startsWith('.github/prompts/')));
      assert.ok(filePaths.some((p) => p.startsWith('.github/instructions/')));
      assert.ok(filePaths.some((p) => p.startsWith('.github/agents/')));
      assert.ok(filePaths.some((p) => p.startsWith('.github/skills/')));
    });

    test('golden fixture routes match resolveTargetLayout for vscode repository scope', () => {
      const layout = resolveTargetLayout({ type: 'vscode', scope: 'repository' });

      assert.strictEqual(layout.routes.prompt, '.github/prompts');
      assert.strictEqual(layout.routes.instruction, '.github/instructions');
      assert.strictEqual(layout.routes.agent, '.github/agents');
      assert.strictEqual(layout.routes.skill, '.github/skills');
    });
  });

  suite('Kiro user scope', () => {
    test('golden fixture contains only prompt and skill files (no instructions or agents)', async () => {
      const tree = await readTargetFileTree(path.join(FIXTURE_ROOT, 'kiro-user'));

      const filePaths = tree.files.map((f) => f.path);
      assert.ok(filePaths.some((p) => p.startsWith('prompts/')), 'kiro-user should have prompts');
      assert.ok(filePaths.some((p) => p.startsWith('skills/')), 'kiro-user should have skills');
      assert.ok(!filePaths.some((p) => p.includes('instruction')), 'kiro-user should not have instructions');
      assert.ok(!filePaths.some((p) => p.includes('agent')), 'kiro-user should not have agents');
    });

    test('golden fixture routes match resolveTargetLayout for kiro user scope', () => {
      const layout = resolveTargetLayout({ type: 'kiro', scope: 'user' });

      assert.ok(layout.routes.prompt);
      assert.ok(layout.routes.skill);
      assert.strictEqual(layout.routes.instruction, undefined);
      assert.strictEqual(layout.routes.agent, undefined);
    });
  });

  suite('Kiro repository scope', () => {
    test('golden fixture contains .github prompt and skill files only', async () => {
      const tree = await readTargetFileTree(path.join(FIXTURE_ROOT, 'kiro-repository'));

      const filePaths = tree.files.map((f) => f.path);
      assert.ok(filePaths.some((p) => p.startsWith('.github/prompts/')), 'kiro-repository should have prompts');
      assert.ok(filePaths.some((p) => p.startsWith('.github/skills/')), 'kiro-repository should have skills');
      assert.ok(!filePaths.some((p) => p.includes('instruction')), 'kiro-repository should not have instructions');
      assert.ok(!filePaths.some((p) => p.includes('agent')), 'kiro-repository should not have agents');
    });

    test('golden fixture routes match resolveTargetLayout for kiro repository scope', () => {
      const layout = resolveTargetLayout({ type: 'kiro', scope: 'repository' });

      assert.ok(layout.routes.prompt);
      assert.ok(layout.routes.skill);
      assert.strictEqual(layout.routes.instruction, undefined);
      assert.strictEqual(layout.routes.agent, undefined);
    });
  });
});
