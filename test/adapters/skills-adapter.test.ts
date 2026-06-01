/**
 * SkillsAdapter Tests
 * Tests for GitHub-based Anthropic-style skills repository adapter
 * Uses sinon stubs for GitHubClient (no nock/HTTP mocking)
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import {
  SkillsAdapter,
} from '../../src/adapters/skills-adapter';
import {
  GitHubClient,
  GitHubContentItem,
} from '../../src/services/github-client';
import {
  GitHubNotFoundError,
} from '../../src/services/github-client-errors';
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

  let mockClient: sinon.SinonStubbedInstance<GitHubClient>;

  /**
   * Create a stubbed GitHubClient with owner/repo properties
   */
  const createMockClient = (): sinon.SinonStubbedInstance<GitHubClient> => {
    const client = sinon.createStubInstance(GitHubClient);
    Object.defineProperty(client, 'owner', { value: 'test-owner', writable: false });
    Object.defineProperty(client, 'repo', { value: 'test-skills-repo', writable: false });
    return client;
  };

  /**
   * Helper to set up mock responses for a skills structure
   * @param options
   * @param options.skills
   * @param options.skillsDirectoryExists
   */
  const setupSkillsMocks = (options: {
    skills?: {
      id: string;
      name: string;
      description: string;
      license?: string;
      files?: { name: string; sha?: string }[];
    }[];
    skillsDirectoryExists?: boolean;
  }): void => {
    const { skills = [], skillsDirectoryExists = true } = options;

    if (!skillsDirectoryExists) {
      mockClient.getContents.withArgs('skills').rejects(
        new GitHubNotFoundError('test-owner', 'test-skills-repo', 'skills')
      );
      return;
    }

    // Mock skills/ directory listing
    const skillDirs: GitHubContentItem[] = skills.map((skill) => ({
      name: skill.id,
      path: `skills/${skill.id}`,
      type: 'dir' as const
    }));
    mockClient.getContents.withArgs('skills').resolves(skillDirs);

    // Mock each skill directory contents and SKILL.md
    for (const skill of skills) {
      const additionalFiles = (skill.files || []).map((f) => ({
        name: f.name,
        path: `skills/${skill.id}/${f.name}`,
        type: 'file' as const,
        download_url: `https://raw.githubusercontent.com/test-owner/test-skills-repo/main/skills/${skill.id}/${f.name}`,
        sha: f.sha || `sha-${f.name}`
      }));

      const skillFiles: GitHubContentItem[] = [
        {
          name: 'SKILL.md',
          path: `skills/${skill.id}/SKILL.md`,
          type: 'file' as const,
          download_url: `https://raw.githubusercontent.com/test-owner/test-skills-repo/main/skills/${skill.id}/SKILL.md`,
          sha: `sha-skill-md-${skill.id}`
        },
        ...additionalFiles
      ];

      mockClient.getContents.withArgs(`skills/${skill.id}`).resolves(skillFiles);

      // Mock SKILL.md file content
      const skillMdContent = `---
name: ${skill.name}
description: ${skill.description}
${skill.license ? `license: ${skill.license}` : ''}
---

# ${skill.name}

Instructions for ${skill.name}
`;
      mockClient.getFileContent.withArgs(`skills/${skill.id}/SKILL.md`).resolves(
        Buffer.from(skillMdContent)
      );
    }
  };

  setup(() => {
    mockClient = createMockClient();
  });

  teardown(() => {
    sinon.restore();
  });

  suite('Constructor', () => {
    test('should create adapter with valid GitHub URL', () => {
      const adapter = new SkillsAdapter(mockSource, mockClient);
      assert.strictEqual(adapter.type, 'skills');
    });

    test('should throw error for invalid URL when no client provided', () => {
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
      setupSkillsMocks({
        skills: [{
          id: 'algorithmic-art',
          name: 'algorithmic-art',
          description: 'Creating algorithmic art using p5.js',
          license: 'Apache-2.0',
          files: [{ name: 'README.md' }]
        }]
      });

      const adapter = new SkillsAdapter(mockSource, mockClient);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 1);
      assert.strictEqual(bundles[0].name, 'algorithmic-art');
      assert.strictEqual(bundles[0].description, 'Creating algorithmic art using p5.js');
      assert.strictEqual(bundles[0].id, 'skills-test-owner-test-skills-repo-algorithmic-art');
      assert.ok(bundles[0].tags.includes('skill'));
      assert.ok(bundles[0].tags.includes('anthropic'));
    });

    test('should discover multiple skills', async () => {
      setupSkillsMocks({
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

      const adapter = new SkillsAdapter(mockSource, mockClient);
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
      const setupNestedSkill = (assetSha: string) => {
        mockClient.getContents.reset();
        mockClient.getFileContent.reset();

        mockClient.getContents.withArgs('skills').resolves([
          { name: 'deep-skill', path: 'skills/deep-skill', type: 'dir' as const }
        ]);

        mockClient.getContents.withArgs('skills/deep-skill').resolves([
          {
            name: 'SKILL.md',
            path: 'skills/deep-skill/SKILL.md',
            type: 'file' as const,
            download_url: 'https://raw.githubusercontent.com/test-owner/test-skills-repo/main/skills/deep-skill/SKILL.md',
            sha: 'sha-skill'
          },
          {
            name: 'assets',
            path: 'skills/deep-skill/assets',
            type: 'dir' as const
          }
        ]);

        mockClient.getContents.withArgs('skills/deep-skill/assets').resolves([
          {
            name: 'diagram.png',
            path: 'skills/deep-skill/assets/diagram.png',
            type: 'file' as const,
            download_url: 'https://raw.githubusercontent.com/test-owner/test-skills-repo/main/skills/deep-skill/assets/diagram.png',
            sha: assetSha
          }
        ]);

        mockClient.getFileContent.withArgs('skills/deep-skill/SKILL.md').resolves(
          Buffer.from('---\nname: Deep Skill\ndescription: Deep skill description\n---\n\n# Deep Skill')
        );
      };

      setupNestedSkill('sha-diagram');
      let adapter = new SkillsAdapter(mockSource, mockClient);
      let bundles = await adapter.fetchBundles();
      assert.strictEqual(bundles.length, 1);
      const versionWithOriginalAsset = bundles[0].version;

      setupNestedSkill('sha-diagram-updated');
      adapter = new SkillsAdapter(mockSource, mockClient);
      bundles = await adapter.fetchBundles();
      const versionWithUpdatedAsset = bundles[0].version;

      // Versions differ when nested file content changes
      assert.notStrictEqual(versionWithOriginalAsset, versionWithUpdatedAsset);
    });

    test('should handle many skills efficiently', async () => {
      const manySkills = Array.from({ length: 10 }, (_, i) => ({
        id: `skill-${i}`,
        name: `Skill ${i}`,
        description: `Description for skill ${i}`
      }));

      setupSkillsMocks({ skills: manySkills });

      const adapter = new SkillsAdapter(mockSource, mockClient);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 10);

      for (let i = 0; i < 10; i++) {
        const bundle = bundles.find((b) => b.name === `Skill ${i}`);
        assert.ok(bundle, `Should find skill-${i}`);
        assert.strictEqual(bundle.description, `Description for skill ${i}`);
      }
    });

    test('should skip directories without SKILL.md', async () => {
      mockClient.getContents.withArgs('skills').resolves([
        { name: 'valid-skill', path: 'skills/valid-skill', type: 'dir' as const },
        { name: 'invalid-skill', path: 'skills/invalid-skill', type: 'dir' as const }
      ]);

      // Valid skill with SKILL.md
      mockClient.getContents.withArgs('skills/valid-skill').resolves([
        { name: 'SKILL.md', path: 'skills/valid-skill/SKILL.md', type: 'file' as const, download_url: 'https://example.com/SKILL.md', sha: 'sha1' }
      ]);
      mockClient.getFileContent.withArgs('skills/valid-skill/SKILL.md').resolves(
        Buffer.from('---\nname: valid-skill\ndescription: A valid skill\n---\n\nInstructions')
      );

      // Invalid skill without SKILL.md
      mockClient.getContents.withArgs('skills/invalid-skill').resolves([
        { name: 'README.md', path: 'skills/invalid-skill/README.md', type: 'file' as const }
      ]);

      const adapter = new SkillsAdapter(mockSource, mockClient);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 1);
      assert.strictEqual(bundles[0].name, 'valid-skill');
    });
  });

  suite('validate()', () => {
    test('should validate repository with skills/ directory', async () => {
      mockClient.getRepository.resolves({
        name: 'test-skills-repo',
        description: 'Test',
        updatedAt: new Date().toISOString()
      });

      setupSkillsMocks({
        skills: [{
          id: 'test-skill',
          name: 'test-skill',
          description: 'Test skill'
        }]
      });

      const adapter = new SkillsAdapter(mockSource, mockClient);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
      assert.strictEqual(result.bundlesFound, 1);
    });

    test('should fail validation when skills/ directory is missing', async () => {
      mockClient.getRepository.resolves({
        name: 'test-skills-repo',
        description: 'Test',
        updatedAt: new Date().toISOString()
      });

      setupSkillsMocks({ skillsDirectoryExists: false });

      const adapter = new SkillsAdapter(mockSource, mockClient);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('skills')));
    });

    test('should warn when no valid skills found', async () => {
      mockClient.getRepository.resolves({
        name: 'test-skills-repo',
        description: 'Test',
        updatedAt: new Date().toISOString()
      });

      // Empty skills directory
      mockClient.getContents.withArgs('skills').resolves([]);

      const adapter = new SkillsAdapter(mockSource, mockClient);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, true);
      assert.ok(result.warnings.some((w) => w.includes('No valid skills')));
    });
  });

  suite('getManifestUrl()', () => {
    test('should return correct manifest URL for skill', () => {
      const adapter = new SkillsAdapter(mockSource, mockClient);
      const url = adapter.getManifestUrl('skills-test-owner-test-skills-repo-algorithmic-art');

      assert.strictEqual(url, 'https://raw.githubusercontent.com/test-owner/test-skills-repo/main/skills/algorithmic-art/SKILL.md');
    });
  });

  suite('getDownloadUrl()', () => {
    test('should return repository archive URL', () => {
      const adapter = new SkillsAdapter(mockSource, mockClient);
      const url = adapter.getDownloadUrl('skills-test-owner-test-skills-repo-algorithmic-art');

      assert.strictEqual(url, 'https://github.com/test-owner/test-skills-repo/archive/refs/heads/main.zip');
    });
  });

  suite('downloadBundle()', () => {
    test('should package skill as ZIP with deployment manifest', async () => {
      // Setup for single skill fetch
      mockClient.getContents.withArgs('skills/my-skill').resolves([
        { name: 'SKILL.md', path: 'skills/my-skill/SKILL.md', type: 'file' as const, download_url: 'https://example.com/SKILL.md', sha: 'sha1' }
      ]);
      mockClient.getFileContent.withArgs('skills/my-skill/SKILL.md').resolves(
        Buffer.from('---\nname: My Skill\ndescription: A test skill\n---\n\n# My Skill\nInstructions')
      );

      const adapter = new SkillsAdapter(mockSource, mockClient);
      const bundle = {
        id: 'skills-test-owner-test-skills-repo-my-skill',
        name: 'My Skill',
        version: '1.0.0',
        description: 'A test skill',
        author: 'test-owner',
        sourceId: 'test-skills-source',
        environments: ['claude'],
        tags: ['skill'],
        lastUpdated: new Date().toISOString(),
        size: '1 files',
        dependencies: [],
        license: 'MIT',
        repository: mockSource.url,
        homepage: '',
        manifestUrl: '',
        downloadUrl: ''
      };

      const zipBuffer = await adapter.downloadBundle(bundle);
      assert.ok(Buffer.isBuffer(zipBuffer));
      assert.ok(zipBuffer.length > 0);
    });
  });

  suite('fetchMetadata()', () => {
    test('should return skill count metadata', async () => {
      setupSkillsMocks({
        skills: [
          { id: 'skill-a', name: 'Skill A', description: 'First' },
          { id: 'skill-b', name: 'Skill B', description: 'Second' }
        ]
      });

      const adapter = new SkillsAdapter(mockSource, mockClient);
      const metadata = await adapter.fetchMetadata();

      assert.strictEqual(metadata.bundleCount, 2);
      assert.strictEqual(metadata.name, 'test-owner/test-skills-repo');
      assert.strictEqual(metadata.description, 'Skills Repository');
    });
  });
});
