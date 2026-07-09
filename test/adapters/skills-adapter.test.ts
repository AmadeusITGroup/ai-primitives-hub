/**
 * SkillsAdapter Tests
 * Tests for GitHub-based Anthropic-style skills repository adapter
 */

import * as assert from 'node:assert';
import * as crypto from 'node:crypto';
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
   * Helper to compute the expected hash for a set of tree entries.
   * Mirrors calculateContentHash: sort blobs by path, hash path + ':' + sha + '|'.
   * @param treeEntries
   */
  const computeExpectedHash = (treeEntries: { path: string; type: string; sha: string }[]): string => {
    const hash = crypto.createHash('sha256');
    const files = treeEntries
      .filter((e) => e.type === 'blob')
      .toSorted((a, b) => a.path.localeCompare(b.path));
    for (const file of files) {
      hash.update(file.path);
      hash.update(':');
      hash.update(file.sha ?? '');
      hash.update('|');
    }
    return hash.digest('hex');
  };

  /**
   * Helper to set up tree-based mock GitHub API responses.
   * Mocks one GET /repos/.../git/trees/main?recursive=1 and one raw SKILL.md per skill.
   * @param skills
   */
  const setupSkillsTreeMocks = (skills: {
    id: string;
    name: string;
    description: string;
    license?: string;
    nestedFiles?: { path: string; sha: string }[];
  }[]): nock.Scope => {
    const treeEntries: { path: string; type: string; sha: string }[] = [];

    for (const skill of skills) {
      treeEntries.push({
        path: `skills/${skill.id}/SKILL.md`,
        type: 'blob',
        sha: `sha-skillmd-${skill.id}`
      });

      for (const nf of skill.nestedFiles ?? []) {
        treeEntries.push({ path: nf.path, type: 'blob', sha: nf.sha });
      }
    }

    const treeScope = nock('https://api.github.com')
      .get('/repos/test-owner/test-skills-repo/git/trees/main?recursive=1')
      .reply(200, { tree: treeEntries, truncated: false });

    for (const skill of skills) {
      const licenceLine = skill.license ? `license: ${skill.license}\n` : '';
      const skillMdContent = `---\nname: ${skill.name}\ndescription: ${skill.description}\n${licenceLine}---\n\n# ${skill.name}\n\nInstructions for ${skill.name}\n`;

      nock('https://raw.githubusercontent.com')
        .get(`/test-owner/test-skills-repo/main/skills/${skill.id}/SKILL.md`)
        .reply(200, skillMdContent);
    }

    return treeScope;
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
      setupSkillsTreeMocks([{
        id: 'algorithmic-art',
        name: 'algorithmic-art',
        description: 'Creating algorithmic art using p5.js',
        license: 'Apache-2.0',
        nestedFiles: [{ path: 'skills/algorithmic-art/README.md', sha: 'sha-readme' }]
      }]);

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
      setupSkillsTreeMocks([
        { id: 'algorithmic-art', name: 'algorithmic-art', description: 'Creating algorithmic art' },
        { id: 'code-review', name: 'code-review', description: 'Code review skill' },
        { id: 'testing', name: 'testing', description: 'Testing skill' }
      ]);

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
      const buildMocks = (assetSha: string) => {
        nock.cleanAll();
        setupSkillsTreeMocks([{
          id: 'deep-skill',
          name: 'Deep Skill',
          description: 'Deep skill description',
          nestedFiles: [{ path: 'skills/deep-skill/assets/diagram.png', sha: assetSha }]
        }]);
      };

      buildMocks('sha-diagram');
      let adapter = new SkillsAdapter(mockSource);
      let bundles = await adapter.fetchBundles();
      assert.strictEqual(bundles.length, 1);
      const versionWithOriginalAsset = bundles[0].version;

      buildMocks('sha-diagram-updated');
      adapter = new SkillsAdapter(mockSource);
      bundles = await adapter.fetchBundles();
      const versionWithUpdatedAsset = bundles[0].version;

      assert.notStrictEqual(versionWithOriginalAsset, versionWithUpdatedAsset);
      assert.ok(versionWithUpdatedAsset.startsWith('hash:'), 'Version should be hash-based');
    });

    test('should handle many skills efficiently', async () => {
      const manySkills = Array.from({ length: 10 }, (_, i) => ({
        id: `skill-${i}`,
        name: `Skill ${i}`,
        description: `Description for skill ${i}`
      }));

      setupSkillsTreeMocks(manySkills);

      const adapter = new SkillsAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 10);

      for (let i = 0; i < 10; i++) {
        const bundle = bundles.find((b) => b.name === `Skill ${i}`);
        assert.ok(bundle, `Should find skill-${i}`);
        assert.strictEqual(bundle.description, `Description for skill ${i}`);
      }
    });
  });

  suite('fetchBundles() — Git Trees API', () => {
    test('uses a single tree call and no per-directory contents calls', async () => {
      const treeScope = setupSkillsTreeMocks([{
        id: 'my-skill',
        name: 'My Skill',
        description: 'A skill'
      }]);

      // Poison the old Contents path — if hit, the test process would get a 500 error
      const contentsScope = nock('https://api.github.com')
        .get(/\/contents\/skills/)
        .reply(500, { message: 'should not be called' });

      const adapter = new SkillsAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 1);
      assert.ok(treeScope.isDone(), 'tree endpoint should have been called');
      assert.ok(!contentsScope.isDone(), 'contents endpoint should NOT have been called');
    });

    test('produces byte-identical hash from tree blobs', async () => {
      const nestedFiles = [{ path: 'skills/deep/assets/diagram.png', sha: 'sha-diagram' }];
      setupSkillsTreeMocks([{
        id: 'deep',
        name: 'Deep Skill',
        description: 'Deep skill description',
        nestedFiles
      }]);

      const adapter = new SkillsAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 1);
      assert.ok(bundles[0].version.startsWith('hash:'), 'version should be hash-based');

      const treeEntries = [
        { path: 'skills/deep/SKILL.md', type: 'blob', sha: 'sha-skillmd-deep' },
        ...nestedFiles.map((f) => ({ ...f, type: 'blob' }))
      ];
      const expectedHash = computeExpectedHash(treeEntries);
      assert.strictEqual(bundles[0].version, `hash:${expectedHash}`);
    });

    test('changing a nested blob sha changes the version', async () => {
      const buildMocks = (assetSha: string) => {
        nock.cleanAll();
        setupSkillsTreeMocks([{
          id: 'sens',
          name: 'Sens',
          description: 'Sensitive skill',
          nestedFiles: [{ path: 'skills/sens/file.txt', sha: assetSha }]
        }]);
      };

      buildMocks('sha-v1');
      const bundles1 = await new SkillsAdapter(mockSource).fetchBundles();
      const v1 = bundles1[0].version;

      buildMocks('sha-v2');
      const bundles2 = await new SkillsAdapter(mockSource).fetchBundles();
      const v2 = bundles2[0].version;

      assert.notStrictEqual(v1, v2);

      buildMocks('sha-v1');
      const bundles3 = await new SkillsAdapter(mockSource).fetchBundles();
      assert.strictEqual(bundles3[0].version, v1);
    });

    test('skips skills without SKILL.md in the tree', async () => {
      // Build tree manually: valid skill has SKILL.md, invalid skill only has README.md
      const treeEntries = [
        { path: 'skills/valid/SKILL.md', type: 'blob', sha: 'sha-valid' },
        { path: 'skills/invalid/README.md', type: 'blob', sha: 'sha-invalid' }
      ];

      nock('https://api.github.com')
        .get('/repos/test-owner/test-skills-repo/git/trees/main?recursive=1')
        .reply(200, { tree: treeEntries, truncated: false });

      nock('https://raw.githubusercontent.com')
        .get('/test-owner/test-skills-repo/main/skills/valid/SKILL.md')
        .reply(200, '---\nname: valid\ndescription: Valid skill\n---\n\nInstructions');

      const adapter = new SkillsAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 1);
      assert.ok(bundles[0].id.includes('valid'));
    });
  });

  suite('validate()', () => {
    test('should validate repository with skills/ directory', async () => {
      setupValidationMocks();
      // Existence probe (contents/skills) returns 200
      nock('https://api.github.com')
        .get('/repos/test-owner/test-skills-repo/contents/skills')
        .reply(200, []);
      // Tree scan returns one skill (no raw SKILL.md interceptor registered — validate must not fetch it)
      nock('https://api.github.com')
        .get('/repos/test-owner/test-skills-repo/git/trees/main?recursive=1')
        .reply(200, { tree: [{ path: 'skills/test-skill/SKILL.md', type: 'blob', sha: 'sha-test' }], truncated: false });
      // Register a raw SKILL.md scope; assert it is NOT consumed (validate must not download SKILL.md)
      const rawScope = nock('https://raw.githubusercontent.com')
        .get('/test-owner/test-skills-repo/main/skills/test-skill/SKILL.md')
        .reply(200, '---\nname: test-skill\ndescription: Test skill\n---\n\nInstructions');

      const adapter = new SkillsAdapter(mockSource);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
      assert.strictEqual(result.bundlesFound, 1);
      assert.ok(!rawScope.isDone(), 'validate() must not download SKILL.md files');
    });

    test('should fail validation when skills/ directory is missing', async () => {
      setupValidationMocks();

      // Mock 404 for skills directory existence probe
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

      // Existence probe returns 200 (directory exists)
      nock('https://api.github.com')
        .get('/repos/test-owner/test-skills-repo/contents/skills')
        .reply(200, []);
      // Tree scan returns no SKILL.md entries
      nock('https://api.github.com')
        .get('/repos/test-owner/test-skills-repo/git/trees/main?recursive=1')
        .reply(200, { tree: [], truncated: false });

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

  suite('fetchBundles() — progressive streaming', () => {
    // Use 20 skills so we always exceed the current CONCURRENCY_LIMIT (15) and get 2+ chunks.
    const makeSkills = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: `skill-${i}`,
        name: `Skill ${i}`,
        description: `Description ${i}`
      }));

    test('calls onPartialBundles more than once when skills exceed one chunk', async () => {
      setupSkillsTreeMocks(makeSkills(20));

      const adapter = new SkillsAdapter(mockSource);
      const snapshots: number[] = [];

      await adapter.fetchBundles((partial) => {
        snapshots.push(partial.length);
      });

      assert.ok(snapshots.length > 1, `Expected >1 callback invocation, got ${snapshots.length}`);
    });

    test('each partial payload is monotonically non-decreasing in length', async () => {
      setupSkillsTreeMocks(makeSkills(20));

      const adapter = new SkillsAdapter(mockSource);
      const snapshots: number[] = [];

      await adapter.fetchBundles((partial) => {
        snapshots.push(partial.length);
      });

      for (let i = 1; i < snapshots.length; i++) {
        assert.ok(
          snapshots[i] >= snapshots[i - 1],
          `Expected non-decreasing lengths: ${snapshots.join(', ')}`
        );
      }
    });

    test('each partial payload is a distinct array (snapshot, not shared mutable ref)', async () => {
      setupSkillsTreeMocks(makeSkills(20));

      const adapter = new SkillsAdapter(mockSource);
      const refs: unknown[][] = [];

      await adapter.fetchBundles((partial) => {
        refs.push(partial);
      });

      // All collected refs must be distinct array instances
      for (let i = 0; i < refs.length; i++) {
        for (let j = i + 1; j < refs.length; j++) {
          assert.notStrictEqual(refs[i], refs[j], 'Each callback invocation should receive a distinct array');
        }
      }
    });

    test('final returned bundles equal the last partial payload', async () => {
      setupSkillsTreeMocks(makeSkills(20));

      const adapter = new SkillsAdapter(mockSource);
      let lastPartial: unknown[] = [];

      const finalBundles = await adapter.fetchBundles((partial) => {
        lastPartial = partial;
      });

      assert.strictEqual(finalBundles.length, lastPartial.length);
      for (const bundle of finalBundles) {
        assert.ok(lastPartial.some((b: any) => b.id === bundle.id), `Bundle ${bundle.id} missing from last partial`);
      }
    });

    test('final bundle set is identical with or without callback (regression for concurrency change)', async () => {
      const skills = makeSkills(20);

      // Without callback
      setupSkillsTreeMocks(skills);
      const withoutCb = await new SkillsAdapter(mockSource).fetchBundles();

      // With callback
      nock.cleanAll();
      setupSkillsTreeMocks(skills);
      const withCb = await new SkillsAdapter(mockSource).fetchBundles(() => {});

      assert.strictEqual(withCb.length, withoutCb.length, 'Bundle count must be identical with or without callback');

      const withoutIds = new Set(withoutCb.map((b) => b.id));
      for (const bundle of withCb) {
        assert.ok(withoutIds.has(bundle.id), `Bundle ${bundle.id} present with callback but missing without`);
      }
    });
  });
});
