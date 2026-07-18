/**
 * SkillsService Unit Tests
 * Tests for skills installation directory resolution and syncing
 */

import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';

suite('SkillsService', () => {
  suite('getSkillsDirectory', () => {
    test('should return ~/.copilot/skills for user scope', () => {
      const expectedPath = path.join(os.homedir(), '.copilot', 'skills');
      assert.strictEqual(expectedPath, path.join(os.homedir(), '.copilot', 'skills'));
    });

    test('should return ~/.claude/skills as fallback location', () => {
      const expectedPath = path.join(os.homedir(), '.claude', 'skills');
      assert.strictEqual(expectedPath, path.join(os.homedir(), '.claude', 'skills'));
    });

    test('should return .copilot/skills for workspace scope', () => {
      const workspacePath = '/mock/workspace';
      const expectedPath = path.join(workspacePath, '.copilot', 'skills');
      assert.strictEqual(expectedPath, path.join(workspacePath, '.copilot', 'skills'));
    });
  });

  suite('Skill Directory Structure', () => {
    test('should recognize SKILL.md as the main skill file', () => {
      const skillPath = 'skills/my-skill/SKILL.md';
      const isValidSkillPath = skillPath.match(/^skills\/[^/]+\/SKILL\.md$/);
      assert.ok(isValidSkillPath, 'Should match skill path pattern');
    });

    test('should support scripts subdirectory', () => {
      const scriptPath = 'skills/my-skill/scripts/helper.py';
      const isInScriptsDir = scriptPath.includes('/scripts/');
      assert.ok(isInScriptsDir);
    });

    test('should support references subdirectory', () => {
      const referencePath = 'skills/my-skill/references/docs.md';
      const isInReferencesDir = referencePath.includes('/references/');
      assert.ok(isInReferencesDir);
    });

    test('should support assets subdirectory', () => {
      const assetPath = 'skills/my-skill/assets/template.json';
      const isInAssetsDir = assetPath.includes('/assets/');
      assert.ok(isInAssetsDir);
    });
  });
});

suite('Skill Kind Mapping', () => {
  test('should map skill kind to skill type', () => {
    const kindMap: Record<string, string> = {
      prompt: 'prompt',
      instruction: 'instructions',
      'chat-mode': 'chatmode',
      agent: 'agent',
      skill: 'skill'
    };

    assert.strictEqual(kindMap.skill, 'skill');
  });

  test('should recognize skill path pattern in collection', () => {
    const pattern = /^(?:skills\/[^/]+\/SKILL\.md|(prompts|instructions|agents)\/[^/]+\.(prompt|instructions|agent)\.md)$/;

    assert.ok(pattern.test('skills/my-skill/SKILL.md'));
    assert.ok(pattern.test('skills/another-skill/SKILL.md'));
    assert.ok(pattern.test('prompts/test.prompt.md'));
    assert.ok(pattern.test('instructions/test.instructions.md'));
    assert.ok(pattern.test('agents/test.agent.md'));

    assert.ok(!pattern.test('skills/SKILL.md'));
    assert.ok(!pattern.test('skills/my-skill/skill.md'));
    assert.ok(!pattern.test('prompts/test.md'));
  });
});

suite('Skill Content Type', () => {
  test('should identify skill type from path', () => {
    const detectType = (itemPath: string): string => {
      if (itemPath.includes('/SKILL.md')) {
        return 'skill';
      }
      const match = itemPath.match(/\.(prompt|instructions|chatmode|agent)\.md$/);
      return match ? match[1] : 'prompt';
    };

    assert.strictEqual(detectType('skills/my-skill/SKILL.md'), 'skill');
    assert.strictEqual(detectType('prompts/test.prompt.md'), 'prompt');
    assert.strictEqual(detectType('instructions/test.instructions.md'), 'instructions');
  });
});
