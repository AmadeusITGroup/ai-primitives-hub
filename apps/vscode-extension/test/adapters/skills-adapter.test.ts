/**
 * SkillsAdapter Tests
 * Tests for GitHub-based Anthropic-style skills repository adapter
 */

import * as assert from 'node:assert';
import nock from 'nock';
import * as sinon from 'sinon';
import {
  SkillsAdapter,
} from '../../src/adapters/skills-adapter';
import {
  RegistrySource,
} from '../../src/types/registry';

suite('SkillsAdapter Tests', () => {
  const mockSource: RegistrySource = {
    id: 'test-skills-source',
    name: 'Test Skills Source',
    type: 'skills',
    url: 'https://github.com/test-owner/test-skills-repo',
    enabled: true,
    priority: 1,
    token: 'test-token'
  };

  /**
   * Helper to set up mock GitHub API responses for skills structure
   * @param options
   * @param options.skills
   * @param options.skillsDirectoryExists
   */
  const setupSkillsStructureMocks = (options: {
    skills?: {
      id: string;
      name: string;
      description: string;
      license?: string;
      files?: string[];
    }[];
    skillsDirectoryExists?: boolean;
  }): void => {
    const { skills = [], skillsDirectoryExists = true } = options;

    if (!skillsDirectoryExists) {
      nock('https://api.github.com')
        .get('/repos/test-owner/test-skills-repo/contents/skills')
        .reply(404, { message: 'Not Found' });
      return;
    }

    // Mock skills/ directory listing (persist to allow multiple calls during validation)
    const skillDirs = skills.map((skill) => ({
      name: skill.id,
      path: `skills/${skill.id}`,
      type: 'dir' as const
    }));

    nock('https://api.github.com')
      .persist()
      .get('/repos/test-owner/test-skills-repo/contents/skills')
      .reply(200, skillDirs);

    // Mock each skill directory contents and SKILL.md
    for (const skill of skills) {
      const skillFiles = [
        {
          name: 'SKILL.md',
          path: `skills/${skill.id}/SKILL.md`,
          type: 'file' as const,
          download_url: `https://raw.githubusercontent.com/test-owner/test-skills-repo/main/skills/${skill.id}/SKILL.md`
        },
        ...(skill.files || []).map((f) => ({
          name: f,
          path: `skills/${skill.id}/${f}`,
          type: 'file' as const,
          download_url: `https://raw.githubusercontent.com/test-owner/test-skills-repo/main/skills/${skill.id}/${f}`
        }))
      ];

      nock('https://api.github.com')
        .get(`/repos/test-owner/test-skills-repo/contents/skills/${skill.id}`)
        .reply(200, skillFiles);

      // Mock SKILL.md download
      const skillMdContent = `---
name: ${skill.name}
description: ${skill.description}
${skill.license ? `license: ${skill.license}` : ''}
---

# ${skill.name}

Instructions for ${skill.name}
`;

      nock('https://raw.githubusercontent.com')
        .get(`/test-owner/test-skills-repo/main/skills/${skill.id}/SKILL.md`)
        .reply(200, skillMdContent);
    }
  };

  /**
   * Helper to set up GitHub repository validation mocks
   */
  const setupValidationMocks = (): void => {
    // Mock GitHub releases endpoint for GitHubAdapter validation
    nock('https://api.github.com')
      .get('/repos/test-owner/test-skills-repo/releases')
      .reply(200, []);

    // Mock repository info endpoint (may be called during validation)
    nock('https://api.github.com')
      .get('/repos/test-owner/test-skills-repo')
      .reply(200, {
        name: 'test-skills-repo',
        full_name: 'test-owner/test-skills-repo',
        default_branch: 'main'
      });
  };

  setup(() => {
    nock.cleanAll();
  });

  teardown(() => {
    nock.cleanAll();
    sinon.restore();
  });

  suite('Constructor', () => {
    test('should create adapter with valid GitHub URL', () => {
      const adapter = new SkillsAdapter(mockSource);
      assert.strictEqual(adapter.type, 'skills');
    });

    test('should throw error for invalid URL', () => {
      const invalidSource: RegistrySource = {
        ...mockSource,
        url: 'https://example.com/owner/repo'
      };

      assert.throws(() => {
        new SkillsAdapter(invalidSource);
      }, /Invalid GitHub URL/);
    });
  });

  suite('fetchBundles()', () => {
    test('should discover skills from skills/ directory', async () => {
      setupSkillsStructureMocks({
        skills: [{
          id: 'algorithmic-art',
          name: 'algorithmic-art',
          description: 'Creating algorithmic art using p5.js',
          license: 'Apache-2.0',
          files: ['README.md']
        }]
      });

      const adapter = new SkillsAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 1);
      assert.strictEqual(bundles[0].name, 'algorithmic-art');
      assert.strictEqual(bundles[0].description, 'Creating algorithmic art using p5.js');
      assert.strictEqual(bundles[0].id, 'skills-test-owner-test-skills-repo-algorithmic-art');
      assert.ok(bundles[0].tags.includes('skill'));
      assert.ok(bundles[0].tags.includes('anthropic'));
    });

    test('should discover multiple skills', async () => {
      setupSkillsStructureMocks({
        skills: [
          {
            id: 'algorithmic-art',
            name: 'algorithmic-art',
            description: 'Creating algorithmic art'
          },
          {
            id: 'code-review',
            name: 'code-review',
            description: 'Code review skill'
          },
          {
            id: 'testing',
            name: 'testing',
            description: 'Testing skill'
          }
        ]
      });

      const adapter = new SkillsAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 3);

      const artBundle = bundles.find((b) => b.name === 'algorithmic-art');
      const reviewBundle = bundles.find((b) => b.name === 'code-review');
      const testingBundle = bundles.find((b) => b.name === 'testing');

      assert.ok(artBundle);
      assert.ok(reviewBundle);
      assert.ok(testingBundle);
    });

    test('should include nested files when hashing remote skills', async () => {
      const mockNestedSkill = (assetSha: string) => {
        nock.cleanAll();

        nock('https://api.github.com')
          .get('/repos/test-owner/test-skills-repo/contents/skills')
          .reply(200, [
            { name: 'deep-skill', path: 'skills/deep-skill', type: 'dir' }
          ]);

        nock('https://api.github.com')
          .get('/repos/test-owner/test-skills-repo/contents/skills/deep-skill')
          .reply(200, [
            {
              name: 'SKILL.md',
              path: 'skills/deep-skill/SKILL.md',
              type: 'file',
              download_url: 'https://raw.githubusercontent.com/test-owner/test-skills-repo/main/skills/deep-skill/SKILL.md',
              sha: 'sha-skill'
            },
            {
              name: 'assets',
              path: 'skills/deep-skill/assets',
              type: 'dir'
            }
          ]);

        nock('https://api.github.com')
          .get('/repos/test-owner/test-skills-repo/contents/skills/deep-skill/assets')
          .reply(200, [
            {
              name: 'diagram.png',
              path: 'skills/deep-skill/assets/diagram.png',
              type: 'file',
              download_url: 'https://raw.githubusercontent.com/test-owner/test-skills-repo/main/skills/deep-skill/assets/diagram.png',
              sha: assetSha
            }
          ]);

        nock('https://raw.githubusercontent.com')
          .get('/test-owner/test-skills-repo/main/skills/deep-skill/SKILL.md')
          .reply(200, '---\nname: Deep Skill\ndescription: Deep skill description\n---\n\n# Deep Skill');
      };

      mockNestedSkill('sha-diagram');
      let adapter = new SkillsAdapter(mockSource);
      let bundles = await adapter.fetchBundles();
      assert.strictEqual(bundles.length, 1);
      const versionWithOriginalAsset = bundles[0].version;

      mockNestedSkill('sha-diagram-updated');
      adapter = new SkillsAdapter(mockSource);
      bundles = await adapter.fetchBundles();
      const versionWithUpdatedAsset = bundles[0].version;

      assert.notStrictEqual(versionWithOriginalAsset, versionWithUpdatedAsset);
      assert.ok(versionWithUpdatedAsset.startsWith('hash:'), 'Version should be hash-based');
    });

    test('should handle many skills efficiently', async () => {
      // Create 10 skills to verify the adapter handles multiple skills correctly
      const manySkills = Array.from({ length: 10 }, (_, i) => ({
        id: `skill-${i}`,
        name: `Skill ${i}`,
        description: `Description for skill ${i}`
      }));

      setupSkillsStructureMocks({ skills: manySkills });

      const adapter = new SkillsAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 10);

      // Verify all skills were discovered
      for (let i = 0; i < 10; i++) {
        const bundle = bundles.find((b) => b.name === `Skill ${i}`);
        assert.ok(bundle, `Should find skill-${i}`);
        assert.strictEqual(bundle.description, `Description for skill ${i}`);
      }
    });

    test('should skip directories without SKILL.md', async () => {
      // Mock skills/ directory with one valid skill and one without SKILL.md
      nock('https://api.github.com')
        .get('/repos/test-owner/test-skills-repo/contents/skills')
        .reply(200, [
          { name: 'valid-skill', path: 'skills/valid-skill', type: 'dir' },
          { name: 'invalid-skill', path: 'skills/invalid-skill', type: 'dir' }
        ]);

      // Valid skill with SKILL.md
      nock('https://api.github.com')
        .get('/repos/test-owner/test-skills-repo/contents/skills/valid-skill')
        .reply(200, [
          { name: 'SKILL.md', path: 'skills/valid-skill/SKILL.md', type: 'file', download_url: 'https://raw.githubusercontent.com/test-owner/test-skills-repo/main/skills/valid-skill/SKILL.md' }
        ]);

      nock('https://raw.githubusercontent.com')
        .get('/test-owner/test-skills-repo/main/skills/valid-skill/SKILL.md')
        .reply(200, '---\nname: valid-skill\ndescription: A valid skill\n---\n\nInstructions');

      // Invalid skill without SKILL.md
      nock('https://api.github.com')
        .get('/repos/test-owner/test-skills-repo/contents/skills/invalid-skill')
        .reply(200, [
          { name: 'README.md', path: 'skills/invalid-skill/README.md', type: 'file' }
        ]);

      const adapter = new SkillsAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 1);
      assert.strictEqual(bundles[0].name, 'valid-skill');
    });
  });

  suite('validate()', () => {
    test('should validate repository with skills/ directory', async () => {
      setupValidationMocks();
      setupSkillsStructureMocks({
        skills: [{
          id: 'test-skill',
          name: 'test-skill',
          description: 'Test skill'
        }]
      });

      const adapter = new SkillsAdapter(mockSource);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
      assert.strictEqual(result.bundlesFound, 1);
    });

    test('should fail validation when skills/ directory is missing', async () => {
      setupValidationMocks();

      // Mock 404 for skills directory
      nock('https://api.github.com')
        .get('/repos/test-owner/test-skills-repo/contents/skills')
        .reply(404, { message: 'Not Found' });

      const adapter = new SkillsAdapter(mockSource);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('skills')));
    });

    test('should warn when no valid skills found', async () => {
      setupValidationMocks();

      // Empty skills directory - need to mock twice (once for validate check, once for scan)
      nock('https://api.github.com')
        .get('/repos/test-owner/test-skills-repo/contents/skills')
        .reply(200, [])
        .get('/repos/test-owner/test-skills-repo/contents/skills')
        .reply(200, []);

      const adapter = new SkillsAdapter(mockSource);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, true);
      assert.ok(result.warnings.some((w) => w.includes('No valid skills')));
    });
  });

  suite('getManifestUrl()', () => {
    test('should return correct manifest URL for skill', () => {
      const adapter = new SkillsAdapter(mockSource);
      const url = adapter.getManifestUrl('skills-test-owner-test-skills-repo-algorithmic-art');

      assert.strictEqual(url, 'https://raw.githubusercontent.com/test-owner/test-skills-repo/main/skills/algorithmic-art/SKILL.md');
    });
  });

  suite('getDownloadUrl()', () => {
    test('should return repository archive URL', () => {
      const adapter = new SkillsAdapter(mockSource);
      const url = adapter.getDownloadUrl('skills-test-owner-test-skills-repo-algorithmic-art');

      assert.strictEqual(url, 'https://github.com/test-owner/test-skills-repo/archive/refs/heads/main.zip');
    });
  });
});
