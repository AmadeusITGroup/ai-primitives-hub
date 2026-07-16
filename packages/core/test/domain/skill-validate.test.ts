/**
 * Coverage tests for domain/skill/validate.ts.
 *
 * Tests skill validation functions: parseFrontmatter, validateSkillName, validateSkillDescription.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  parseFrontmatter,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_DESCRIPTION_MIN_LENGTH,
  SKILL_NAME_MAX_LENGTH,
  validateSkillDescription,
  validateSkillName,
} from '../../src/domain/skill/validate';

describe('parseFrontmatter', () => {
  it('parses valid YAML frontmatter', () => {
    const content = `---
name: test-skill
description: A test skill
---
Some content`;
    const result = parseFrontmatter(content);
    expect(result).toEqual({
      name: 'test-skill',
      description: 'A test skill'
    });
  });

  it('returns null for content without frontmatter', () => {
    const content = 'No frontmatter here';
    const result = parseFrontmatter(content);
    expect(result).toBeNull();
  });

  it('returns null for malformed YAML', () => {
    const content = `---
name: test-skill
description: : invalid yaml
---
Content`;
    const result = parseFrontmatter(content);
    expect(result).toBeNull();
  });

  it('handles empty frontmatter', () => {
    const content = `---
---
Content`;
    const result = parseFrontmatter(content);
    expect(result).toBeNull();
  });
});

describe('validateSkillName', () => {
  it('accepts valid skill name', () => {
    expect(validateSkillName('my-skill')).toBeNull();
    expect(validateSkillName('test123')).toBeNull();
    expect(validateSkillName('a-b-c')).toBeNull();
  });

  it('rejects missing name', () => {
    expect(validateSkillName('')).toBe('name is required and must be a string');
    expect(validateSkillName(null)).toBe('name is required and must be a string');
    expect(validateSkillName(undefined)).toBe('name is required and must be a string');
  });

  it('rejects non-string name', () => {
    expect(validateSkillName(123)).toBe('name is required and must be a string');
    expect(validateSkillName({})).toBe('name is required and must be a string');
  });

  it('rejects name with invalid characters', () => {
    expect(validateSkillName('My_Skill')).toBe('name must contain only lowercase letters, numbers, and hyphens');
    expect(validateSkillName('my.skill')).toBe('name must contain only lowercase letters, numbers, and hyphens');
    expect(validateSkillName('my skill')).toBe('name must contain only lowercase letters, numbers, and hyphens');
    expect(validateSkillName('MySkill')).toBe('name must contain only lowercase letters, numbers, and hyphens');
  });

  it('rejects name exceeding max length', () => {
    const longName = 'a'.repeat(SKILL_NAME_MAX_LENGTH + 1);
    const result = validateSkillName(longName);
    expect(result).toContain(`must not exceed ${SKILL_NAME_MAX_LENGTH}`);
  });

  it('accepts name at max length boundary', () => {
    const maxName = 'a'.repeat(SKILL_NAME_MAX_LENGTH);
    expect(validateSkillName(maxName)).toBeNull();
  });
});

describe('validateSkillDescription', () => {
  it('accepts valid description', () => {
    expect(validateSkillDescription('A valid description that is long enough')).toBeNull();
  });

  it('rejects missing description', () => {
    expect(validateSkillDescription('')).toBe('description is required and must be a string');
    expect(validateSkillDescription(null)).toBe('description is required and must be a string');
    expect(validateSkillDescription(undefined)).toBe('description is required and must be a string');
  });

  it('rejects non-string description', () => {
    expect(validateSkillDescription(123)).toBe('description is required and must be a string');
  });

  it('rejects description below min length', () => {
    const shortDesc = 'a'.repeat(SKILL_DESCRIPTION_MIN_LENGTH - 1);
    const result = validateSkillDescription(shortDesc);
    expect(result).toContain(`at least ${SKILL_DESCRIPTION_MIN_LENGTH}`);
  });

  it('accepts description at min length boundary', () => {
    const minDesc = 'a'.repeat(SKILL_DESCRIPTION_MIN_LENGTH);
    expect(validateSkillDescription(minDesc)).toBeNull();
  });

  it('rejects description exceeding max length', () => {
    const longDesc = 'a'.repeat(SKILL_DESCRIPTION_MAX_LENGTH + 1);
    const result = validateSkillDescription(longDesc);
    expect(result).toContain(`must not exceed ${SKILL_DESCRIPTION_MAX_LENGTH}`);
  });

  it('accepts description at max length boundary', () => {
    const maxDesc = 'a'.repeat(SKILL_DESCRIPTION_MAX_LENGTH);
    expect(validateSkillDescription(maxDesc)).toBeNull();
  });
});
