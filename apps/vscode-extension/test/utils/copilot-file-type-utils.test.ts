/**
 * Copilot File Type Utilities Tests
 *
 * Tests for shared utilities that determine file types, generate target file names,
 * and map file types to repository directories.
 *
 * Requirements: 1.2-1.7, 10.1-10.5
 */

import * as assert from 'node:assert';
import {
  CopilotFileType,
  determineFileType,
  getFileExtension,
  getRepositoryTargetDirectory,
  getSkillName,
  getTargetFileName,
  isSkillDirectory,
  normalizePromptId,
} from '../../src/utils/copilot-file-type-utils';

suite('copilotFileTypeUtils', () => {
  suite('normalizePromptId', () => {
    test('should return string unchanged when already valid', () => {
      assert.strictEqual(normalizePromptId('my-prompt'), 'my-prompt');
      assert.strictEqual(normalizePromptId('test_prompt'), 'test_prompt');
      assert.strictEqual(normalizePromptId('prompt123'), 'prompt123');
    });

    test('should replace special characters with hyphens', () => {
      assert.strictEqual(normalizePromptId('my prompt'), 'my-prompt');
      assert.strictEqual(normalizePromptId('my.prompt'), 'my-prompt');
      assert.strictEqual(normalizePromptId('my/prompt'), 'my-prompt');
      assert.strictEqual(normalizePromptId('my@prompt!'), 'my-prompt-');
    });

    test('should handle numeric IDs from YAML parsing', () => {
      assert.strictEqual(normalizePromptId(6), '6');
      assert.strictEqual(normalizePromptId(123), '123');
      assert.strictEqual(normalizePromptId(0), '0');
    });

    test('should preserve alphanumeric characters, hyphens, and underscores', () => {
      assert.strictEqual(normalizePromptId('ABC-123_test'), 'ABC-123_test');
      assert.strictEqual(normalizePromptId('a-b_c'), 'a-b_c');
    });

    test('should handle empty string', () => {
      assert.strictEqual(normalizePromptId(''), '');
    });

    test('should handle string with only special characters', () => {
      assert.strictEqual(normalizePromptId('...'), '---');
      assert.strictEqual(normalizePromptId('@#$'), '---');
    });
  });

  suite('determineFileType', () => {
    suite('detection from file name', () => {
      test('should detect prompt type from .prompt.md extension', () => {
        assert.strictEqual(determineFileType('my-prompt.prompt.md'), 'prompt');
        assert.strictEqual(determineFileType('test.prompt.md'), 'prompt');
      });

      test('should detect instructions type from .instructions.md extension', () => {
        assert.strictEqual(determineFileType('coding-standards.instructions.md'), 'instructions');
        assert.strictEqual(determineFileType('test.instructions.md'), 'instructions');
      });

      test('should detect chatmode type from .chatmode.md extension', () => {
        assert.strictEqual(determineFileType('expert.chatmode.md'), 'chatmode');
        assert.strictEqual(determineFileType('test.chatmode.md'), 'chatmode');
      });

      test('should detect agent type from .agent.md extension', () => {
        assert.strictEqual(determineFileType('code-reviewer.agent.md'), 'agent');
        assert.strictEqual(determineFileType('test.agent.md'), 'agent');
      });

      test('should detect skill type from SKILL.md file', () => {
        assert.strictEqual(determineFileType('SKILL.md'), 'skill');
      });

      test('should detect instructions from filename containing "instructions"', () => {
        assert.strictEqual(determineFileType('my-instructions.md'), 'instructions');
        assert.strictEqual(determineFileType('coding_instructions.md'), 'instructions');
      });

      test('should default to prompt for unrecognized .md files', () => {
        assert.strictEqual(determineFileType('unknown.md'), 'prompt');
        assert.strictEqual(determineFileType('readme.md'), 'prompt');
      });
    });

    suite('detection from tags', () => {
      test('should detect instructions type from tags', () => {
        assert.strictEqual(determineFileType('file.md', ['instructions']), 'instructions');
        assert.strictEqual(determineFileType('file.md', ['other', 'instructions']), 'instructions');
      });

      test('should detect chatmode type from tags', () => {
        assert.strictEqual(determineFileType('file.md', ['chatmode']), 'chatmode');
        assert.strictEqual(determineFileType('file.md', ['mode']), 'chatmode');
      });

      test('should detect agent type from tags', () => {
        assert.strictEqual(determineFileType('file.md', ['agent']), 'agent');
      });

      test('should detect skill type from tags', () => {
        assert.strictEqual(determineFileType('file.md', ['skill']), 'skill');
      });

      test('should prioritize file extension over tags', () => {
        // File extension should take precedence
        assert.strictEqual(determineFileType('test.agent.md', ['instructions']), 'agent');
        assert.strictEqual(determineFileType('test.instructions.md', ['agent']), 'instructions');
      });

      test('should use tags when file extension is generic', () => {
        assert.strictEqual(determineFileType('generic.md', ['agent']), 'agent');
        assert.strictEqual(determineFileType('generic.md', ['chatmode']), 'chatmode');
      });
    });

    suite('edge cases', () => {
      test('should handle empty tags array', () => {
        assert.strictEqual(determineFileType('test.prompt.md', []), 'prompt');
      });

      test('should handle undefined tags', () => {
        assert.strictEqual(determineFileType('test.prompt.md'), 'prompt');
      });

      test('should handle case-insensitive file extensions', () => {
        assert.strictEqual(determineFileType('TEST.PROMPT.MD'), 'prompt');
        assert.strictEqual(determineFileType('Test.Instructions.Md'), 'instructions');
      });

      test('should handle paths with directories', () => {
        assert.strictEqual(determineFileType('prompts/my-prompt.prompt.md'), 'prompt');
        assert.strictEqual(determineFileType('agents/code-reviewer.agent.md'), 'agent');
      });
    });
  });

  suite('getTargetFileName', () => {
    test('should generate prompt file name', () => {
      assert.strictEqual(getTargetFileName('my-prompt', 'prompt'), 'my-prompt.prompt.md');
    });

    test('should generate instructions file name', () => {
      assert.strictEqual(getTargetFileName('coding-standards', 'instructions'), 'coding-standards.instructions.md');
    });

    test('should generate chatmode file name', () => {
      assert.strictEqual(getTargetFileName('expert-mode', 'chatmode'), 'expert-mode.chatmode.md');
    });

    test('should generate agent file name', () => {
      assert.strictEqual(getTargetFileName('code-reviewer', 'agent'), 'code-reviewer.agent.md');
    });

    test('should generate skill file name (SKILL.md)', () => {
      // Skills use SKILL.md as the main file
      assert.strictEqual(getTargetFileName('my-skill', 'skill'), 'SKILL.md');
    });

    test('should handle IDs with special characters', () => {
      assert.strictEqual(getTargetFileName('my_prompt-v1', 'prompt'), 'my_prompt-v1.prompt.md');
    });
  });

  suite('getRepositoryTargetDirectory', () => {
    test('should return .github/prompts/ for prompt type', () => {
      assert.strictEqual(getRepositoryTargetDirectory('prompt'), '.github/prompts/');
    });

    test('should return .github/instructions/ for instructions type', () => {
      assert.strictEqual(getRepositoryTargetDirectory('instructions'), '.github/instructions/');
    });

    test('should return .github/prompts/ for chatmode type', () => {
      // Chatmodes go to prompts directory per VS Code Copilot conventions
      assert.strictEqual(getRepositoryTargetDirectory('chatmode'), '.github/prompts/');
    });

    test('should return .github/agents/ for agent type', () => {
      assert.strictEqual(getRepositoryTargetDirectory('agent'), '.github/agents/');
    });

    test('should return .github/skills/ for skill type', () => {
      assert.strictEqual(getRepositoryTargetDirectory('skill'), '.github/skills/');
    });

    test('should return paths with trailing slash', () => {
      const types: CopilotFileType[] = ['prompt', 'instructions', 'chatmode', 'agent', 'skill'];
      for (const type of types) {
        const dir = getRepositoryTargetDirectory(type);
        assert.ok(dir.endsWith('/'), `Directory for ${type} should end with /`);
      }
    });

    test('should return paths starting with .github/', () => {
      const types: CopilotFileType[] = ['prompt', 'instructions', 'chatmode', 'agent', 'skill'];
      for (const type of types) {
        const dir = getRepositoryTargetDirectory(type);
        assert.ok(dir.startsWith('.github/'), `Directory for ${type} should start with .github/`);
      }
    });
  });

  suite('getFileExtension', () => {
    test('should return .prompt.md for prompt type', () => {
      assert.strictEqual(getFileExtension('prompt'), '.prompt.md');
    });

    test('should return .instructions.md for instructions type', () => {
      assert.strictEqual(getFileExtension('instructions'), '.instructions.md');
    });

    test('should return .chatmode.md for chatmode type', () => {
      assert.strictEqual(getFileExtension('chatmode'), '.chatmode.md');
    });

    test('should return .agent.md for agent type', () => {
      assert.strictEqual(getFileExtension('agent'), '.agent.md');
    });

    test('should return empty string for skill type (skills are directories)', () => {
      // Skills are directories, not single files
      assert.strictEqual(getFileExtension('skill'), '');
    });
  });

  suite('isSkillDirectory', () => {
    test('should return true for paths under skills/ directory', () => {
      assert.strictEqual(isSkillDirectory('skills/my-skill'), true);
      assert.strictEqual(isSkillDirectory('skills/another-skill/'), true);
    });

    test('should return true for nested skills paths', () => {
      assert.strictEqual(isSkillDirectory('path/to/skills/my-skill'), true);
      assert.strictEqual(isSkillDirectory('bundles/test/skills/skill-name'), true);
    });

    test('should return false for non-skill paths', () => {
      assert.strictEqual(isSkillDirectory('prompts/my-prompt.prompt.md'), false);
      assert.strictEqual(isSkillDirectory('agents/my-agent.agent.md'), false);
      assert.strictEqual(isSkillDirectory('my-file.md'), false);
    });

    test('should handle Windows-style paths', () => {
      assert.strictEqual(isSkillDirectory('skills\\my-skill'), true);
      assert.strictEqual(isSkillDirectory('path\\to\\skills\\my-skill'), true);
    });

    test('should be case-insensitive for skills directory', () => {
      assert.strictEqual(isSkillDirectory('Skills/my-skill'), true);
      assert.strictEqual(isSkillDirectory('SKILLS/my-skill'), true);
    });
  });

  suite('getSkillName', () => {
    test('should extract skill name from simple path', () => {
      assert.strictEqual(getSkillName('skills/my-skill'), 'my-skill');
      assert.strictEqual(getSkillName('skills/another-skill'), 'another-skill');
    });

    test('should extract skill name from nested path', () => {
      assert.strictEqual(getSkillName('path/to/skills/my-skill'), 'my-skill');
      assert.strictEqual(getSkillName('bundles/test/skills/skill-name'), 'skill-name');
    });

    test('should extract skill name from path with trailing content', () => {
      assert.strictEqual(getSkillName('skills/my-skill/SKILL.md'), 'my-skill');
      assert.strictEqual(getSkillName('skills/my-skill/src/index.js'), 'my-skill');
    });

    test('should return null for non-skill paths', () => {
      assert.strictEqual(getSkillName('prompts/my-prompt.prompt.md'), null);
      assert.strictEqual(getSkillName('agents/my-agent.agent.md'), null);
      assert.strictEqual(getSkillName('my-file.md'), null);
    });

    test('should handle Windows-style paths', () => {
      assert.strictEqual(getSkillName('skills\\my-skill'), 'my-skill');
      assert.strictEqual(getSkillName('path\\to\\skills\\my-skill'), 'my-skill');
    });

    test('should be case-insensitive for skills directory', () => {
      assert.strictEqual(getSkillName('Skills/my-skill'), 'my-skill');
      assert.strictEqual(getSkillName('SKILLS/my-skill'), 'my-skill');
    });
  });
});
