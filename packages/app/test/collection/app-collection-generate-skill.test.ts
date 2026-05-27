import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  createSkill,
  generateSkillContent,
  validateAllSkills,
  validateSkillFolder,
} from '../../src/collection/generate-skill';
import {
  createTempDir,
} from '../helpers/install-test-helpers';

let tempDir: string;
let cleanup: () => void;

beforeEach(() => {
  [tempDir, cleanup] = createTempDir('generate-skill-test-');
});

afterEach(() => {
  cleanup();
});

describe('generate-skill', () => {
  describe('validateSkillFolder()', () => {
    it('should return error when SKILL.md is missing', () => {
      const skillPath = path.join(tempDir, 'test-skill');
      fs.mkdirSync(skillPath, { recursive: true });

      const result = validateSkillFolder(skillPath, 'test-skill');

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing SKILL.md file');
    });

    it('should return error when frontmatter parsing fails', () => {
      const skillPath = path.join(tempDir, 'test-skill');
      fs.mkdirSync(skillPath, { recursive: true });
      fs.writeFileSync(
        path.join(skillPath, 'SKILL.md'),
        'invalid frontmatter\n---\nno yaml'
      );

      const result = validateSkillFolder(skillPath, 'test-skill');

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Failed to parse SKILL.md frontmatter');
    });

    it('should validate skill name from frontmatter', () => {
      const skillPath = path.join(tempDir, 'test-skill');
      fs.mkdirSync(skillPath, { recursive: true });
      fs.writeFileSync(
        path.join(skillPath, 'SKILL.md'),
        '---\nname: my-skill\ndescription: "A test skill"\n---\n'
      );

      const result = validateSkillFolder(skillPath, 'test-skill');

      expect(result.valid).toBe(false); // folder name doesn't match skill name
      expect(result.errors).toContain('Folder name "test-skill" does not match skill name "my-skill"');
    });

    it('should validate skill description', () => {
      const skillPath = path.join(tempDir, 'test-skill');
      fs.mkdirSync(skillPath, { recursive: true });
      fs.writeFileSync(
        path.join(skillPath, 'SKILL.md'),
        '---\nname: test-skill\n---\n'
      );

      const result = validateSkillFolder(skillPath, 'test-skill');

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('description'))).toBe(true);
    });

    it('should detect oversized bundled assets', () => {
      const skillPath = path.join(tempDir, 'test-skill');
      fs.mkdirSync(skillPath, { recursive: true });
      fs.writeFileSync(
        path.join(skillPath, 'SKILL.md'),
        '---\nname: test-skill\ndescription: "A test skill"\n---\n'
      );

      // Create a large file (>5MB)
      const largeFile = Buffer.alloc(6 * 1024 * 1024, 'x'); // 6MB
      fs.writeFileSync(path.join(skillPath, 'large.bin'), largeFile);

      const result = validateSkillFolder(skillPath, 'test-skill');

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('exceeds maximum size'))).toBe(true);
    });

    it('should return valid result for correct skill', () => {
      const skillPath = path.join(tempDir, 'test-skill');
      fs.mkdirSync(skillPath, { recursive: true });
      fs.writeFileSync(
        path.join(skillPath, 'SKILL.md'),
        '---\nname: test-skill\ndescription: "A test skill"\n---\n'
      );

      const result = validateSkillFolder(skillPath, 'test-skill');

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  describe('validateAllSkills()', () => {
    it('should return valid result when skills directory does not exist', () => {
      const result = validateAllSkills(tempDir);

      expect(result.valid).toBe(true);
      expect(result.totalSkills).toBe(0);
    });

    it('should return valid result when skills directory is empty', () => {
      fs.mkdirSync(path.join(tempDir, 'skills'), { recursive: true });

      const result = validateAllSkills(tempDir);

      expect(result.valid).toBe(true);
      expect(result.totalSkills).toBe(0);
    });

    it('should detect duplicate skill names', () => {
      const skill1Path = path.join(tempDir, 'skills', 'skill1');
      const skill2Path = path.join(tempDir, 'skills', 'skill2');
      fs.mkdirSync(skill1Path, { recursive: true });
      fs.mkdirSync(skill2Path, { recursive: true });

      const skillContent = '---\nname: duplicate-name\ndescription: "A skill"\n---\n';
      fs.writeFileSync(path.join(skill1Path, 'SKILL.md'), skillContent);
      fs.writeFileSync(path.join(skill2Path, 'SKILL.md'), skillContent);

      const result = validateAllSkills(tempDir);

      expect(result.valid).toBe(false);
      expect(result.invalidSkills).toBe(2);
    });

    it('should validate multiple skills', () => {
      const skill1Path = path.join(tempDir, 'skills', 'skill1');
      const skill2Path = path.join(tempDir, 'skills', 'skill2');
      fs.mkdirSync(skill1Path, { recursive: true });
      fs.mkdirSync(skill2Path, { recursive: true });

      fs.writeFileSync(
        path.join(skill1Path, 'SKILL.md'),
        '---\nname: skill1\ndescription: "A comprehensive skill that does something useful"\n---\n'
      );
      fs.writeFileSync(
        path.join(skill2Path, 'SKILL.md'),
        '---\nname: skill2\ndescription: "Another comprehensive skill that does something else"\n---\n'
      );

      const result = validateAllSkills(tempDir);

      expect(result.valid).toBe(true);
      expect(result.totalSkills).toBe(2);
      expect(result.validSkills).toBe(2);
    });
  });

  describe('generateSkillContent()', () => {
    it('should generate valid SKILL.md content', () => {
      const content = generateSkillContent('my-skill', 'A test skill');

      expect(content).toContain('name: my-skill');
      expect(content).toContain('description: "A test skill"');
      expect(content).toContain('# my-skill');
      expect(content).toContain('## Capabilities');
      expect(content).toContain('## Usage');
      expect(content).toContain('## Examples');
    });
  });

  describe('createSkill()', () => {
    it('should return error for invalid skill name', () => {
      const result = createSkill(tempDir, 'Invalid Name', 'description');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should return error for invalid description', () => {
      const result = createSkill(tempDir, 'valid-name', '');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should return error when skill already exists', () => {
      const skillPath = path.join(tempDir, 'skills', 'existing-skill');
      fs.mkdirSync(skillPath, { recursive: true });

      const result = createSkill(tempDir, 'existing-skill', 'A description');

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('should create skill directory and SKILL.md', () => {
      const result = createSkill(tempDir, 'new-skill', 'A new skill');

      expect(result.success).toBe(true);
      expect(result.path).toBe(path.join(tempDir, 'skills', 'new-skill'));
      expect(fs.existsSync(path.join(tempDir, 'skills', 'new-skill', 'SKILL.md'))).toBe(true);
    });

    it('should create skills directory if it does not exist', () => {
      const result = createSkill(tempDir, 'new-skill', 'A new skill');

      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'skills'))).toBe(true);
    });
  });
});
