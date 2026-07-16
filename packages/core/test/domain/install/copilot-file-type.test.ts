import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  determineFileType,
  getFileExtension,
  getRepositoryTargetDirectory,
  getSkillName,
  getTargetFileName,
  isSkillDirectory,
  normalizePromptId,
} from '../../../src/domain/install/copilot-file-type';

describe('normalizePromptId', () => {
  it('replaces unsafe characters with hyphens', () => {
    expect(normalizePromptId('my prompt!@#')).toBe('my-prompt---');
  });

  it('leaves alphanumeric, hyphen, and underscore untouched', () => {
    expect(normalizePromptId('my-prompt_123')).toBe('my-prompt_123');
  });

  it('stringifies numeric ids from YAML parsing', () => {
    expect(normalizePromptId(42)).toBe('42');
  });
});

describe('determineFileType', () => {
  it('detects by file extension, highest priority', () => {
    expect(determineFileType('foo.prompt.md')).toBe('prompt');
    expect(determineFileType('foo.instructions.md')).toBe('instructions');
    expect(determineFileType('foo.chatmode.md')).toBe('chatmode');
    expect(determineFileType('foo.agent.md')).toBe('agent');
  });

  it('is case-insensitive on extension', () => {
    expect(determineFileType('FOO.PROMPT.MD')).toBe('prompt');
  });

  it('strips directory components before matching', () => {
    expect(determineFileType('skills/my-skill/SKILL.md')).toBe('skill');
    expect(determineFileType('a\\b\\foo.agent.md')).toBe('agent');
  });

  it('detects SKILL.md by special file name', () => {
    expect(determineFileType('SKILL.md')).toBe('skill');
    expect(determineFileType('skill.md')).toBe('skill');
  });

  it('falls back to tags when extension is generic', () => {
    expect(determineFileType('foo.md', ['instructions'])).toBe('instructions');
    expect(determineFileType('foo.md', ['chatmode'])).toBe('chatmode');
    expect(determineFileType('foo.md', ['mode'])).toBe('chatmode');
    expect(determineFileType('foo.md', ['agent'])).toBe('agent');
    expect(determineFileType('foo.md', ['skill'])).toBe('skill');
  });

  it('extension patterns take priority over tags', () => {
    expect(determineFileType('foo.prompt.md', ['agent'])).toBe('prompt');
  });

  it('falls back to filename pattern when no tags match', () => {
    expect(determineFileType('coding-instructions.md')).toBe('instructions');
  });

  it('defaults to prompt when nothing else matches', () => {
    expect(determineFileType('foo.md')).toBe('prompt');
    expect(determineFileType('foo.md', [])).toBe('prompt');
    expect(determineFileType('foo.md', ['unrelated'])).toBe('prompt');
  });
});

describe('getTargetFileName', () => {
  it('appends the type-specific extension to the id', () => {
    expect(getTargetFileName('my-id', 'prompt')).toBe('my-id.prompt.md');
    expect(getTargetFileName('my-id', 'instructions')).toBe('my-id.instructions.md');
    expect(getTargetFileName('my-id', 'chatmode')).toBe('my-id.chatmode.md');
    expect(getTargetFileName('my-id', 'agent')).toBe('my-id.agent.md');
  });

  it('always returns SKILL.md for skill type, ignoring the id', () => {
    expect(getTargetFileName('anything', 'skill')).toBe('SKILL.md');
  });
});

describe('getRepositoryTargetDirectory', () => {
  it('returns a .github/ subdirectory for every type', () => {
    expect(getRepositoryTargetDirectory('prompt')).toBe('.github/prompts/');
    expect(getRepositoryTargetDirectory('instructions')).toBe('.github/instructions/');
    expect(getRepositoryTargetDirectory('agent')).toBe('.github/agents/');
    expect(getRepositoryTargetDirectory('skill')).toBe('.github/skills/');
  });

  it('routes chatmode into the agents directory', () => {
    expect(getRepositoryTargetDirectory('chatmode')).toBe(getRepositoryTargetDirectory('agent'));
  });
});

describe('getFileExtension', () => {
  it('returns the extension for file-based types and empty string for skill', () => {
    expect(getFileExtension('prompt')).toBe('.prompt.md');
    expect(getFileExtension('instructions')).toBe('.instructions.md');
    expect(getFileExtension('chatmode')).toBe('.chatmode.md');
    expect(getFileExtension('agent')).toBe('.agent.md');
    expect(getFileExtension('skill')).toBe('');
  });
});

describe('isSkillDirectory', () => {
  it('recognizes paths under a skills/ directory', () => {
    expect(isSkillDirectory('skills/my-skill')).toBe(true);
    expect(isSkillDirectory('path/to/skills/my-skill')).toBe(true);
    expect(isSkillDirectory('skills\\my-skill')).toBe(true);
  });

  it('rejects unrelated paths', () => {
    expect(isSkillDirectory('prompts/my-prompt.md')).toBe(false);
  });
});

describe('getSkillName', () => {
  it('extracts the skill name from a skills/ path', () => {
    expect(getSkillName('skills/my-skill')).toBe('my-skill');
    expect(getSkillName('path/to/skills/my-skill/SKILL.md')).toBe('my-skill');
  });

  it('returns null for a path with no skills/ segment', () => {
    expect(getSkillName('prompts/my-prompt.md')).toBeNull();
  });
});
