import * as assert from 'node:assert';
import {
  calculateContentHash,
  formatSkillVersion,
  mapSkillToBundle,
  parseSkillMd,
} from '../../../src/adapters/helpers/skill-parser';
import type {
  SkillItem,
} from '../../../src/types/skills';

suite('skill-parser', () => {
  suite('parseSkillMd()', () => {
    test('parses valid SKILL.md with frontmatter', () => {
      const content = '---\nname: my-skill\ndescription: A test skill\nlicense: MIT\n---\n\n# Instructions\n\nDo the thing.';
      const result = parseSkillMd(content);
      assert.strictEqual(result.frontmatter.name, 'my-skill');
      assert.strictEqual(result.frontmatter.description, 'A test skill');
      assert.ok(result.content.includes('# Instructions'));
    });
    test('handles missing frontmatter gracefully', () => {
      const content = '# Just markdown\n\nNo frontmatter here.';
      const result = parseSkillMd(content);
      assert.strictEqual(result.frontmatter.name, '');
      assert.strictEqual(result.raw, content);
    });
  });

  suite('calculateContentHash()', () => {
    test('produces stable hash for same inputs', () => {
      const files = [{ path: 'a.md', sha: 'abc' }, { path: 'b.md', sha: 'def' }];
      assert.strictEqual(calculateContentHash(files), calculateContentHash(files));
    });
    test('sorts files by path for stability', () => {
      const a = [{ path: 'b.md', sha: 'b' }, { path: 'a.md', sha: 'a' }];
      const b = [{ path: 'a.md', sha: 'a' }, { path: 'b.md', sha: 'b' }];
      assert.strictEqual(calculateContentHash(a), calculateContentHash(b));
    });
  });

  suite('formatSkillVersion()', () => {
    test('returns hash: prefixed version for content-addressable comparison', () => {
      const v = formatSkillVersion('abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
      assert.ok(v.startsWith('hash:'));
      assert.strictEqual(v, 'hash:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
    });
    test('returns 1.0.0 for empty hash', () => {
      assert.strictEqual(formatSkillVersion(''), '1.0.0');
    });
  });

  suite('mapSkillToBundle()', () => {
    test('maps SkillItem to Bundle', () => {
      const skill: SkillItem = {
        id: 'my-skill', name: 'My Skill', description: 'great', license: 'MIT',
        path: 'skills/my-skill', skillMdPath: 'skills/my-skill/SKILL.md',
        files: ['SKILL.md', 'h.ts'],
        contentHash: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1'
      };
      const bundle = mapSkillToBundle(skill, 'octocat', 'repo', 'src-1', 'https://github.com/octocat/repo');
      assert.strictEqual(bundle.name, 'My Skill');
      assert.strictEqual(bundle.author, 'octocat');
      assert.ok(bundle.id.includes('my-skill'));
    });
  });
});
