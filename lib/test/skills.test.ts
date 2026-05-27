/**
 * Skills module tests
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createSkill,
  generateSkillContent,
  parseFrontmatter,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_DESCRIPTION_MIN_LENGTH,
  SKILL_NAME_MAX_LENGTH,
  validateAllSkills,
  validateSkillDescription,
  validateSkillFolder,
  validateSkillName,
} from '@prompt-registry/cli';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('Skills Module', () => {
  describe('validateSkillName()', () => {
    it('should accept valid lowercase names', () => {
      assert.strictEqual(validateSkillName('my-skill'), null);
      assert.strictEqual(validateSkillName('skill123'), null);
      assert.strictEqual(validateSkillName('a-b-c'), null);
    });

    it('should reject empty name', () => {
      assert.ok(validateSkillName(''));
      assert.ok(validateSkillName(null));
      assert.ok(validateSkillName(undefined));
    });

    it('should reject uppercase', () => {
      const error = validateSkillName('MySkill');
      assert.ok(error?.includes('lowercase'));
    });

    it('should reject spaces', () => {
      const error = validateSkillName('my skill');
      assert.ok(error?.includes('lowercase'));
    });

    it('should reject names exceeding max length', () => {
      const longName = 'a'.repeat(SKILL_NAME_MAX_LENGTH + 1);
      const error = validateSkillName(longName);
      assert.ok(error?.includes('exceed'));
    });
  });

  describe('validateSkillDescription()', () => {
    it('should accept valid descriptions', () => {
      assert.strictEqual(validateSkillDescription('This is a valid description'), null);
    });

    it('should reject empty description', () => {
      assert.ok(validateSkillDescription(''));
      assert.ok(validateSkillDescription(null));
    });

    it('should reject too short descriptions', () => {
      const error = validateSkillDescription('short');
      assert.ok(error?.includes(`${SKILL_DESCRIPTION_MIN_LENGTH}`));
    });

    it('should reject too long descriptions', () => {
      const longDesc = 'a'.repeat(SKILL_DESCRIPTION_MAX_LENGTH + 1);
      const error = validateSkillDescription(longDesc);
      assert.ok(error?.includes('exceed'));
    });
  });

  describe('parseFrontmatter()', () => {
    it('should parse valid frontmatter', () => {
      const content = `---
name: my-skill
description: "A test skill"
---

# Content`;
      const result = parseFrontmatter(content);
      assert.strictEqual(result?.name, 'my-skill');
      assert.strictEqual(result?.description, 'A test skill');
    });

    it('should return null for missing frontmatter', () => {
      const content = '# No frontmatter here';
      assert.strictEqual(parseFrontmatter(content), null);
    });

    it('should return null for invalid YAML', () => {
      const content = `---
invalid: yaml: content:
---`;
      assert.strictEqual(parseFrontmatter(content), null);
    });
  });

  describe('validateSkillFolder()', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir('skills-folder-test-');
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    it('should validate valid skill folder', () => {
      const skillDir = path.join(tempDir, 'my-skill');
      fs.mkdirSync(skillDir);
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: my-skill
description: "A valid skill description"
---

# My Skill`);

      const result = validateSkillFolder(skillDir, 'my-skill');
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    it('should report missing SKILL.md', () => {
      const skillDir = path.join(tempDir, 'empty-skill');
      fs.mkdirSync(skillDir);

      const result = validateSkillFolder(skillDir, 'empty-skill');
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('Missing SKILL.md')));
    });

    it('should report name mismatch', () => {
      const skillDir = path.join(tempDir, 'folder-name');
      fs.mkdirSync(skillDir);
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: different-name
description: "A valid skill description"
---`);

      const result = validateSkillFolder(skillDir, 'folder-name');
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('does not match')));
    });
  });

  describe('validateAllSkills()', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir('skills-all-test-');
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    it('should return valid for empty skills directory', () => {
      const result = validateAllSkills(tempDir, 'skills');
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.totalSkills, 0);
    });

    it('should validate multiple skills', () => {
      const skillsDir = path.join(tempDir, 'skills');
      fs.mkdirSync(skillsDir);

      const skill1 = path.join(skillsDir, 'skill-one');
      fs.mkdirSync(skill1);
      fs.writeFileSync(path.join(skill1, 'SKILL.md'), `---
name: skill-one
description: "First skill description"
---`);

      const skill2 = path.join(skillsDir, 'skill-two');
      fs.mkdirSync(skill2);
      fs.writeFileSync(path.join(skill2, 'SKILL.md'), `---
name: skill-two
description: "Second skill description"
---`);

      const result = validateAllSkills(tempDir, 'skills');
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.totalSkills, 2);
      assert.strictEqual(result.validSkills, 2);
    });

    it('should detect duplicate skill names', () => {
      const skillsDir = path.join(tempDir, 'skills');
      fs.mkdirSync(skillsDir);

      // First skill - folder name matches skill name
      const skill1 = path.join(skillsDir, 'duplicate-name');
      fs.mkdirSync(skill1);
      fs.writeFileSync(path.join(skill1, 'SKILL.md'), `---
name: duplicate-name
description: "First skill description"
---`);

      // Second skill - different folder but same skill name in SKILL.md
      // This will fail validation for name mismatch AND duplicate
      const skill2 = path.join(skillsDir, 'another-folder');
      fs.mkdirSync(skill2);
      fs.writeFileSync(path.join(skill2, 'SKILL.md'), `---
name: duplicate-name
description: "Second skill description"
---`);

      const result = validateAllSkills(tempDir, 'skills');
      assert.strictEqual(result.valid, false);
      // The second skill should have a "does not match" error
      assert.ok(result.skills.some((s) => s.errors.some((e: string) => e.includes('does not match'))));
    });
  });

  describe('createSkill()', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir('skills-create-test-');
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    it('should create skill directory and SKILL.md', () => {
      const result = createSkill(tempDir, 'new-skill', 'A description for the new skill', 'skills');

      assert.strictEqual(result.success, true);
      assert.ok(fs.existsSync(result.path));
      assert.ok(fs.existsSync(path.join(result.path, 'SKILL.md')));
    });

    it('should reject invalid skill name', () => {
      const result = createSkill(tempDir, 'Invalid Name', 'A valid description', 'skills');

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('lowercase'));
    });

    it('should reject existing skill', () => {
      const skillsDir = path.join(tempDir, 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });
      fs.mkdirSync(path.join(skillsDir, 'existing-skill'));

      const result = createSkill(tempDir, 'existing-skill', 'A valid description', 'skills');

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('already exists'));
    });
  });

  describe('generateSkillContent()', () => {
    it('should generate valid SKILL.md content', () => {
      const content = generateSkillContent('my-skill', 'A test description');

      assert.ok(content.includes('name: my-skill'));
      assert.ok(content.includes('description: "A test description"'));
      assert.ok(content.includes('# my-skill'));
    });
  });
});
