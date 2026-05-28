/**
 * LocalSkillsAdapter Tests
 * Tests for local filesystem Anthropic-style skills repository adapter
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import {
  LocalSkillsAdapter,
} from '../../src/adapters/local-skills-adapter';
import {
  RegistrySource,
} from '../../src/types/registry';

suite('LocalSkillsAdapter Tests', () => {
  let tempDir: string;
  let skillsDir: string;

  /**
   * Create a temporary directory structure for testing
   */
  const createTempSkillsStructure = (): string => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
    skillsDir = path.join(tempDir, 'skills');
    fs.mkdirSync(skillsDir);
    return tempDir;
  };

  /**
   * Create a skill in the temporary directory
   * @param skillId
   * @param options
   * @param options.name
   * @param options.description
   * @param options.license
   * @param options.additionalFiles
   */
  const createSkill = (skillId: string, options: {
    name?: string;
    description?: string;
    license?: string;
    additionalFiles?: string[];
  } = {}): void => {
    const skillPath = path.join(skillsDir, skillId);
    fs.mkdirSync(skillPath, { recursive: true });

    const name = options.name || skillId;
    const description = options.description || `Description for ${skillId}`;
    const license = options.license ? `license: ${options.license}` : '';

    const skillMdContent = `---
name: ${name}
description: ${description}
${license}
---

# ${name}

Instructions for ${name}
`;

    fs.writeFileSync(path.join(skillPath, 'SKILL.md'), skillMdContent);

    for (const file of options.additionalFiles || []) {
      fs.writeFileSync(path.join(skillPath, file), `Content of ${file}`);
    }
  };

  /**
   * Clean up temporary directory
   */
  const cleanupTempDir = (): void => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };

  setup(() => {
    createTempSkillsStructure();
  });

  teardown(() => {
    cleanupTempDir();
    sinon.restore();
  });

  suite('Constructor', () => {
    test('should create adapter with valid local path', () => {
      const source: RegistrySource = {
        id: 'test-local-skills',
        name: 'Test Local Skills',
        type: 'local-skills',
        url: tempDir,
        enabled: true,
        priority: 1
      };

      const adapter = new LocalSkillsAdapter(source);
      assert.strictEqual(adapter.type, 'local-skills');
    });

    test('should create adapter with file:// URL', () => {
      const source: RegistrySource = {
        id: 'test-local-skills',
        name: 'Test Local Skills',
        type: 'local-skills',
        url: `file://${tempDir}`,
        enabled: true,
        priority: 1
      };

      const adapter = new LocalSkillsAdapter(source);
      assert.strictEqual(adapter.type, 'local-skills');
    });

    test('should throw error for invalid path', () => {
      const source: RegistrySource = {
        id: 'test-local-skills',
        name: 'Test Local Skills',
        type: 'local-skills',
        url: 'https://github.com/owner/repo',
        enabled: true,
        priority: 1
      };

      assert.throws(() => {
        new LocalSkillsAdapter(source);
      }, /Invalid local skills path/);
    });
  });

  suite('fetchBundles()', () => {
    test('should discover skills from skills/ directory', async () => {
      createSkill('algorithmic-art', {
        name: 'algorithmic-art',
        description: 'Creating algorithmic art using p5.js',
        license: 'Apache-2.0',
        additionalFiles: ['README.md']
      });

      const source: RegistrySource = {
        id: 'test-local-skills',
        name: 'Test Local Skills',
        type: 'local-skills',
        url: tempDir,
        enabled: true,
        priority: 1
      };

      const adapter = new LocalSkillsAdapter(source);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 1);
      assert.strictEqual(bundles[0].name, 'algorithmic-art');
      assert.strictEqual(bundles[0].description, 'Creating algorithmic art using p5.js');
      assert.ok(bundles[0].id.includes('algorithmic-art'));
      assert.ok(bundles[0].tags.includes('skill'));
      assert.ok(bundles[0].tags.includes('local'));
    });

    test('should discover multiple skills', async () => {
      createSkill('skill-one', { description: 'First skill' });
      createSkill('skill-two', { description: 'Second skill' });
      createSkill('skill-three', { description: 'Third skill' });

      const source: RegistrySource = {
        id: 'test-local-skills',
        name: 'Test Local Skills',
        type: 'local-skills',
        url: tempDir,
        enabled: true,
        priority: 1
      };

      const adapter = new LocalSkillsAdapter(source);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 3);

      const skillOne = bundles.find((b) => b.name === 'skill-one');
      const skillTwo = bundles.find((b) => b.name === 'skill-two');
      const skillThree = bundles.find((b) => b.name === 'skill-three');

      assert.ok(skillOne);
      assert.ok(skillTwo);
      assert.ok(skillThree);
    });

    test('should skip directories without SKILL.md', async () => {
      createSkill('valid-skill', { description: 'Valid skill' });

      // Create invalid skill directory without SKILL.md
      const invalidSkillPath = path.join(skillsDir, 'invalid-skill');
      fs.mkdirSync(invalidSkillPath);
      fs.writeFileSync(path.join(invalidSkillPath, 'README.md'), 'No SKILL.md here');

      const source: RegistrySource = {
        id: 'test-local-skills',
        name: 'Test Local Skills',
        type: 'local-skills',
        url: tempDir,
        enabled: true,
        priority: 1
      };

      const adapter = new LocalSkillsAdapter(source);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 1);
      assert.strictEqual(bundles[0].name, 'valid-skill');
    });

    test('should handle empty skills directory', async () => {
      const source: RegistrySource = {
        id: 'test-local-skills',
        name: 'Test Local Skills',
        type: 'local-skills',
        url: tempDir,
        enabled: true,
        priority: 1
      };

      const adapter = new LocalSkillsAdapter(source);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 0);
    });
  });

  suite('validate()', () => {
    test('should validate directory with skills/ subdirectory', async () => {
      createSkill('test-skill', { description: 'Test skill' });

      const source: RegistrySource = {
        id: 'test-local-skills',
        name: 'Test Local Skills',
        type: 'local-skills',
        url: tempDir,
        enabled: true,
        priority: 1
      };

      const adapter = new LocalSkillsAdapter(source);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
      assert.strictEqual(result.bundlesFound, 1);
    });

    test('should fail validation when skills/ directory is missing', async () => {
      // Remove skills directory
      fs.rmSync(skillsDir, { recursive: true });

      const source: RegistrySource = {
        id: 'test-local-skills',
        name: 'Test Local Skills',
        type: 'local-skills',
        url: tempDir,
        enabled: true,
        priority: 1
      };

      const adapter = new LocalSkillsAdapter(source);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('skills')));
    });

    test('should fail validation when directory does not exist', async () => {
      const source: RegistrySource = {
        id: 'test-local-skills',
        name: 'Test Local Skills',
        type: 'local-skills',
        url: '/nonexistent/path/to/skills',
        enabled: true,
        priority: 1
      };

      const adapter = new LocalSkillsAdapter(source);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('not exist') || e.includes('not accessible')));
    });

    test('should warn when no valid skills found', async () => {
      // skills/ directory exists but is empty
      const source: RegistrySource = {
        id: 'test-local-skills',
        name: 'Test Local Skills',
        type: 'local-skills',
        url: tempDir,
        enabled: true,
        priority: 1
      };

      const adapter = new LocalSkillsAdapter(source);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, true);
      assert.ok(result.warnings.some((w) => w.includes('No valid skills')));
    });
  });

  suite('fetchMetadata()', () => {
    test('should return correct metadata', async () => {
      createSkill('skill-one', { description: 'First skill' });
      createSkill('skill-two', { description: 'Second skill' });

      const source: RegistrySource = {
        id: 'test-local-skills',
        name: 'Test Local Skills',
        type: 'local-skills',
        url: tempDir,
        enabled: true,
        priority: 1
      };

      const adapter = new LocalSkillsAdapter(source);
      const metadata = await adapter.fetchMetadata();

      assert.strictEqual(metadata.bundleCount, 2);
      assert.strictEqual(metadata.description, 'Local Skills Repository');
      assert.ok(metadata.name);
      assert.ok(metadata.lastUpdated);
    });
  });

  suite('getManifestUrl()', () => {
    test('should return file:// URL for skill manifest', () => {
      const source: RegistrySource = {
        id: 'test-local-skills',
        name: 'Test Local Skills',
        type: 'local-skills',
        url: tempDir,
        enabled: true,
        priority: 1
      };

      const adapter = new LocalSkillsAdapter(source);
      const sourceName = path.basename(tempDir);
      const url = adapter.getManifestUrl(`local-skills-${sourceName}-test-skill`);

      assert.ok(url.startsWith('file://'));
      assert.ok(url.includes('SKILL.md'));
    });
  });

  suite('getDownloadUrl()', () => {
    test('should return file:// URL for skill directory', () => {
      const source: RegistrySource = {
        id: 'test-local-skills',
        name: 'Test Local Skills',
        type: 'local-skills',
        url: tempDir,
        enabled: true,
        priority: 1
      };

      const adapter = new LocalSkillsAdapter(source);
      const sourceName = path.basename(tempDir);
      const url = adapter.getDownloadUrl(`local-skills-${sourceName}-test-skill`);

      assert.ok(url.startsWith('file://'));
      assert.ok(url.includes('test-skill'));
    });
  });

  suite('downloadBundle()', () => {
    test('should package skill as ZIP buffer', async () => {
      createSkill('test-skill', {
        description: 'Test skill for download',
        additionalFiles: ['helper.md']
      });

      const source: RegistrySource = {
        id: 'test-local-skills',
        name: 'Test Local Skills',
        type: 'local-skills',
        url: tempDir,
        enabled: true,
        priority: 1
      };

      const adapter = new LocalSkillsAdapter(source);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 1);

      const zipBuffer = await adapter.downloadBundle(bundles[0]);

      assert.ok(Buffer.isBuffer(zipBuffer));
      assert.ok(zipBuffer.length > 0);

      // Verify it's a valid ZIP (starts with PK signature)
      assert.strictEqual(zipBuffer[0], 0x50); // 'P'
      assert.strictEqual(zipBuffer[1], 0x4B); // 'K'
    });

    test('should throw error for non-existent skill', async () => {
      const source: RegistrySource = {
        id: 'test-local-skills',
        name: 'Test Local Skills',
        type: 'local-skills',
        url: tempDir,
        enabled: true,
        priority: 1
      };

      const adapter = new LocalSkillsAdapter(source);

      const fakeBundle = {
        id: `local-skills-${path.basename(tempDir)}-nonexistent`,
        name: 'nonexistent',
        version: '1.0.0',
        description: 'Does not exist',
        author: 'test',
        sourceId: 'test-local-skills',
        environments: [],
        tags: [],
        lastUpdated: new Date().toISOString(),
        size: '0 B',
        dependencies: [],
        license: 'Unknown'
      };

      await assert.rejects(
        adapter.downloadBundle(fakeBundle as any),
        /Skill not found/
      );
    });
  });

  suite('getSkillSourcePath()', () => {
    test('should return absolute path to skill directory', () => {
      createSkill('test-skill', { description: 'Test skill' });

      const source: RegistrySource = {
        id: 'test-local-skills',
        name: 'Test Local Skills',
        type: 'local-skills',
        url: tempDir,
        enabled: true,
        priority: 1
      };

      const adapter = new LocalSkillsAdapter(source);
      const sourceName = path.basename(tempDir);

      const mockBundle = {
        id: `local-skills-${sourceName}-test-skill`,
        name: 'test-skill',
        version: '1.0.0',
        description: 'Test skill',
        author: 'test',
        sourceId: 'test-local-skills',
        environments: [],
        tags: [],
        lastUpdated: new Date().toISOString(),
        size: '0 B',
        dependencies: [],
        license: 'Unknown'
      };

      const skillPath = adapter.getSkillSourcePath(mockBundle as any);

      assert.ok(path.isAbsolute(skillPath));
      assert.ok(skillPath.includes('test-skill'));
      assert.strictEqual(skillPath, path.join(tempDir, 'skills', 'test-skill'));
    });
  });

  suite('getSkillName()', () => {
    test('should extract skill name from bundle ID', () => {
      const source: RegistrySource = {
        id: 'test-local-skills',
        name: 'Test Local Skills',
        type: 'local-skills',
        url: tempDir,
        enabled: true,
        priority: 1
      };

      const adapter = new LocalSkillsAdapter(source);
      const sourceName = path.basename(tempDir);

      const mockBundle = {
        id: `local-skills-${sourceName}-my-awesome-skill`,
        name: 'my-awesome-skill',
        version: '1.0.0',
        description: 'Test skill',
        author: 'test',
        sourceId: 'test-local-skills',
        environments: [],
        tags: [],
        lastUpdated: new Date().toISOString(),
        size: '0 B',
        dependencies: [],
        license: 'Unknown'
      };

      const skillName = adapter.getSkillName(mockBundle as any);

      assert.strictEqual(skillName, 'my-awesome-skill');
    });
  });
});
