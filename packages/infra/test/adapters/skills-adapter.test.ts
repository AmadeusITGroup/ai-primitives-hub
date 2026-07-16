import * as crypto from 'node:crypto';
import type {
  Bundle,
  EtaggedResult,
  GitHubApi,
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  SkillsAdapter,
} from '../../src/adapters/skills-adapter';
import {
  FakeGitHubApi,
} from '../helpers/fake-github-api';
import {
  FixedClock,
} from '../helpers/fixed-clock';

/** Minimal `GitHubApi` wrapper that fails one specific path/URL with a caller-supplied error, delegating everything else to `inner`. */
class FailingGitHubApi implements GitHubApi {
  public constructor(
    private readonly inner: GitHubApi,
    private readonly failPath: string,
    private readonly error: Error
  ) {}

  public getJson<T>(pathOrUrl: string): Promise<T> {
    return pathOrUrl === this.failPath ? Promise.reject(this.error) : this.inner.getJson(pathOrUrl);
  }

  public getText(pathOrUrl: string): Promise<string> {
    return pathOrUrl === this.failPath ? Promise.reject(this.error) : this.inner.getText(pathOrUrl);
  }

  public download(pathOrUrl: string): Promise<Uint8Array> {
    return pathOrUrl === this.failPath ? Promise.reject(this.error) : this.inner.download(pathOrUrl);
  }

  public getJsonWithEtag<T>(pathOrUrl: string, etag?: string): Promise<EtaggedResult<T>> {
    return pathOrUrl === this.failPath ? Promise.reject(this.error) : this.inner.getJsonWithEtag<T>(pathOrUrl, etag);
  }
}

function makeSource(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    id: 'skills-test',
    name: 'Skills Test',
    type: 'skills',
    url: 'https://github.com/owner/repo',
    enabled: true,
    priority: 0,
    ...overrides
  };
}

const TREE_PATH = '/repos/owner/repo/git/trees/main?recursive=1';
const RAW_BASE = 'https://raw.githubusercontent.com/owner/repo/main';

function skillMdContent(fields: { name?: string; description?: string; license?: string } = {}): string {
  const lines = ['---'];
  if (fields.name !== undefined) {
    lines.push(`name: ${fields.name}`);
  }
  if (fields.description !== undefined) {
    lines.push(`description: ${fields.description}`);
  }
  if (fields.license !== undefined) {
    lines.push(`license: ${fields.license}`);
  }
  lines.push('---', '', 'Instructions body.');
  return lines.join('\n');
}

interface AdapterOverrides {
  source?: RegistrySource;
  githubApi?: GitHubApi;
  clock?: FixedClock;
}

function makeAdapter(overrides: AdapterOverrides = {}): SkillsAdapter {
  return new SkillsAdapter(overrides.source ?? makeSource(), overrides.githubApi ?? new FakeGitHubApi(), overrides.clock ?? new FixedClock(0));
}

describe('SkillsAdapter', () => {
  describe('constructor', () => {
    it('accepts an https:// GitHub URL', () => {
      expect(() => makeAdapter()).not.toThrow();
    });

    it('accepts a git@ GitHub URL', () => {
      expect(() => makeAdapter({ source: makeSource({ url: 'git@github.com:owner/repo.git' }) })).not.toThrow();
    });

    it('rejects a non-GitHub URL', () => {
      expect(() => makeAdapter({ source: makeSource({ url: 'https://example.com/owner/repo' }) })).toThrow('Invalid GitHub URL for skills source');
    });
  });

  describe('getManifestUrl / getDownloadUrl', () => {
    it('builds the raw SKILL.md URL for a bundle id, on the default branch', () => {
      expect(makeAdapter().getManifestUrl('skills-owner-repo-my-skill')).toBe(`${RAW_BASE}/skills/my-skill/SKILL.md`);
    });

    it('builds the repo archive URL, independent of any bundle id', () => {
      expect(makeAdapter().getDownloadUrl()).toBe('https://github.com/owner/repo/archive/refs/heads/main.zip');
    });

    it('respects a configured branch for both URLs', () => {
      const adapter = makeAdapter({ source: makeSource({ config: { branch: 'dev' } }) });
      expect(adapter.getManifestUrl('skills-owner-repo-my-skill')).toBe('https://raw.githubusercontent.com/owner/repo/dev/skills/my-skill/SKILL.md');
      expect(adapter.getDownloadUrl()).toBe('https://github.com/owner/repo/archive/refs/heads/dev.zip');
    });
  });

  describe('requiresAuthentication', () => {
    it('defaults to false when the source is not marked private', () => {
      expect(makeAdapter().requiresAuthentication()).toBe(false);
    });

    it('is true when the source is marked private', () => {
      expect(makeAdapter({ source: makeSource({ private: true }) }).requiresAuthentication()).toBe(true);
    });
  });

  describe('fetchBundles', () => {
    it('discovers a skill from a single skills/<id>/SKILL.md tree entry', async () => {
      const api = new FakeGitHubApi()
        .seedJson(TREE_PATH, { tree: [{ path: 'skills/my-skill/SKILL.md', type: 'blob', sha: 'sha-1' }] })
        .seedText(`${RAW_BASE}/skills/my-skill/SKILL.md`, skillMdContent({ name: 'My Skill', description: 'Does things', license: 'MIT' }));

      const [bundle] = await makeAdapter({ githubApi: api }).fetchBundles();

      expect(bundle).toMatchObject({
        id: 'skills-owner-repo-my-skill',
        name: 'My Skill',
        description: 'Does things',
        license: 'MIT',
        author: 'owner',
        sourceId: 'skills-test',
        environments: ['claude', 'vscode', 'claude-code'],
        tags: ['skill', 'anthropic'],
        dependencies: [],
        repository: 'https://github.com/owner/repo',
        homepage: 'https://github.com/owner/repo/tree/main/skills/my-skill',
        manifestUrl: `${RAW_BASE}/skills/my-skill/SKILL.md`,
        downloadUrl: 'https://github.com/owner/repo/archive/refs/heads/main.zip'
      });
      expect(bundle.version).toMatch(/^hash:[0-9a-f]{64}$/);
      expect(bundle.size).toBe('4.0 KB');
    });

    it('computes the version hash as sha256 over sorted "path:sha|" pairs across every file in the skill', async () => {
      const entries = [
        { path: 'skills/x/SKILL.md', sha: 'sha-skillmd' },
        { path: 'skills/x/nested/file.txt', sha: 'sha-nested' }
      ];
      const api = new FakeGitHubApi()
        .seedJson(TREE_PATH, { tree: entries.map((entry) => ({ ...entry, type: 'blob' })) })
        .seedText(`${RAW_BASE}/skills/x/SKILL.md`, skillMdContent({ name: 'X' }));

      const [bundle] = await makeAdapter({ githubApi: api }).fetchBundles();

      const expected = crypto.createHash('sha256');
      for (const entry of entries.toSorted((a, b) => a.path.localeCompare(b.path))) {
        expected.update(entry.path).update(':').update(entry.sha).update('|');
      }
      expect(bundle.version).toBe(`hash:${expected.digest('hex')}`);
    });

    it('changes the version when a nested file\'s sha changes', async () => {
      const buildBundles = async (assetSha: string) => {
        const api = new FakeGitHubApi()
          .seedJson(TREE_PATH, {
            tree: [
              { path: 'skills/deep/SKILL.md', type: 'blob', sha: 'sha-skillmd' },
              { path: 'skills/deep/assets/diagram.png', type: 'blob', sha: assetSha }
            ]
          })
          .seedText(`${RAW_BASE}/skills/deep/SKILL.md`, skillMdContent({ name: 'Deep' }));
        return makeAdapter({ githubApi: api }).fetchBundles();
      };

      const [v1] = await buildBundles('sha-v1');
      const [v2] = await buildBundles('sha-v2');
      expect(v1.version).not.toBe(v2.version);
    });

    it('discovers multiple skills from the same tree', async () => {
      const api = new FakeGitHubApi()
        .seedJson(TREE_PATH, {
          tree: [
            { path: 'skills/alpha/SKILL.md', type: 'blob', sha: 's1' },
            { path: 'skills/beta/SKILL.md', type: 'blob', sha: 's2' }
          ]
        })
        .seedText(`${RAW_BASE}/skills/alpha/SKILL.md`, skillMdContent({ name: 'Alpha' }))
        .seedText(`${RAW_BASE}/skills/beta/SKILL.md`, skillMdContent({ name: 'Beta' }));

      const bundles = await makeAdapter({ githubApi: api }).fetchBundles();
      expect(bundles.map((b) => b.name).toSorted()).toEqual(['Alpha', 'Beta']);
    });

    it('discovers more skills than fit in a single concurrency batch', async () => {
      const skillIds = Array.from({ length: 12 }, (_, i) => `skill-${i}`);
      const api = new FakeGitHubApi().seedJson(TREE_PATH, {
        tree: skillIds.map((id) => ({ path: `skills/${id}/SKILL.md`, type: 'blob', sha: `sha-${id}` }))
      });
      for (const id of skillIds) {
        api.seedText(`${RAW_BASE}/skills/${id}/SKILL.md`, skillMdContent({ name: id }));
      }

      const bundles = await makeAdapter({ githubApi: api }).fetchBundles();
      expect(bundles).toHaveLength(12);
    });

    it('ignores blobs directly under skills/ with no skill subfolder', async () => {
      const api = new FakeGitHubApi()
        .seedJson(TREE_PATH, {
          tree: [
            { path: 'skills/README.md', type: 'blob', sha: 's1' },
            { path: 'skills/valid/SKILL.md', type: 'blob', sha: 's2' }
          ]
        })
        .seedText(`${RAW_BASE}/skills/valid/SKILL.md`, skillMdContent({ name: 'Valid' }));

      const bundles = await makeAdapter({ githubApi: api }).fetchBundles();
      expect(bundles.map((b) => b.name)).toEqual(['Valid']);
    });

    it('skips a skills/ subfolder that has no top-level SKILL.md', async () => {
      const api = new FakeGitHubApi()
        .seedJson(TREE_PATH, {
          tree: [
            { path: 'skills/valid/SKILL.md', type: 'blob', sha: 's1' },
            { path: 'skills/invalid/README.md', type: 'blob', sha: 's2' }
          ]
        })
        .seedText(`${RAW_BASE}/skills/valid/SKILL.md`, skillMdContent({ name: 'Valid' }));

      const bundles = await makeAdapter({ githubApi: api }).fetchBundles();
      expect(bundles.map((b) => b.id)).toEqual(['skills-owner-repo-valid']);
    });

    it('defaults description to "No description" and license to "Unknown" when the frontmatter omits them', async () => {
      const api = new FakeGitHubApi()
        .seedJson(TREE_PATH, { tree: [{ path: 'skills/bare/SKILL.md', type: 'blob', sha: 's1' }] })
        .seedText(`${RAW_BASE}/skills/bare/SKILL.md`, skillMdContent({ name: 'Bare' }));

      const [bundle] = await makeAdapter({ githubApi: api }).fetchBundles();
      expect(bundle.description).toBe('No description');
      expect(bundle.license).toBe('Unknown');
    });

    it('falls back to the skill id as the name when the frontmatter has no name', async () => {
      const api = new FakeGitHubApi()
        .seedJson(TREE_PATH, { tree: [{ path: 'skills/my-skill/SKILL.md', type: 'blob', sha: 's1' }] })
        .seedText(`${RAW_BASE}/skills/my-skill/SKILL.md`, skillMdContent({ description: 'desc only' }));

      const [bundle] = await makeAdapter({ githubApi: api }).fetchBundles();
      expect(bundle.name).toBe('my-skill');
    });

    it('skips a skill whose SKILL.md fetch fails, without failing the whole scan', async () => {
      const api = new FakeGitHubApi()
        .seedJson(TREE_PATH, {
          tree: [
            { path: 'skills/good/SKILL.md', type: 'blob', sha: 's1' },
            { path: 'skills/broken/SKILL.md', type: 'blob', sha: 's2' }
          ]
        })
        .seedText(`${RAW_BASE}/skills/good/SKILL.md`, skillMdContent({ name: 'Good' }));
      // 'broken' skill's SKILL.md is intentionally left unseeded, so getText() rejects for it.

      const bundles = await makeAdapter({ githubApi: api }).fetchBundles();
      expect(bundles.map((b) => b.name)).toEqual(['Good']);
    });

    it('wraps a git-tree fetch failure with a descriptive error', async () => {
      await expect(makeAdapter({ githubApi: new FakeGitHubApi() }).fetchBundles()).rejects.toThrow('Failed to fetch skills:');
    });

    it('uses a configured branch for both the tree call and the raw SKILL.md URL', async () => {
      const api = new FakeGitHubApi()
        .seedJson('/repos/owner/repo/git/trees/dev?recursive=1', { tree: [{ path: 'skills/my-skill/SKILL.md', type: 'blob', sha: 's1' }] })
        .seedText('https://raw.githubusercontent.com/owner/repo/dev/skills/my-skill/SKILL.md', skillMdContent({ name: 'My Skill' }));

      const bundles = await makeAdapter({ source: makeSource({ config: { branch: 'dev' } }), githubApi: api }).fetchBundles();
      expect(bundles).toHaveLength(1);
    });
  });

  describe('downloadBundle', () => {
    it('produces a real ZIP archive containing the deployment manifest and skill files (flat + nested)', async () => {
      const skillMd = skillMdContent({ name: 'My Skill', description: 'd' });
      const api = new FakeGitHubApi()
        .seedJson('/repos/owner/repo/contents/skills/my-skill', [
          { name: 'SKILL.md', path: 'skills/my-skill/SKILL.md', type: 'file', download_url: `${RAW_BASE}/skills/my-skill/SKILL.md` },
          { name: 'assets', path: 'skills/my-skill/assets', type: 'dir' }
        ])
        .seedText(`${RAW_BASE}/skills/my-skill/SKILL.md`, skillMd)
        .seedBytes(`${RAW_BASE}/skills/my-skill/SKILL.md`, new TextEncoder().encode(skillMd))
        .seedJson('/repos/owner/repo/contents/skills/my-skill/assets', [
          {
            name: 'diagram.png',
            path: 'skills/my-skill/assets/diagram.png',
            type: 'file',
            download_url: `${RAW_BASE}/skills/my-skill/assets/diagram.png`
          }
        ])
        .seedBytes(`${RAW_BASE}/skills/my-skill/assets/diagram.png`, new Uint8Array([1, 2, 3]));

      const zip = await makeAdapter({ githubApi: api }).downloadBundle({ id: 'skills-owner-repo-my-skill' } as Bundle);

      // ZIP local-file-header magic number: "PK\x03\x04".
      expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4B, 0x03, 0x04]));
      expect(zip.length).toBeGreaterThan(0);
    });

    it('throws a descriptive error when the skill cannot be found', async () => {
      await expect(makeAdapter({ githubApi: new FakeGitHubApi() }).downloadBundle({ id: 'skills-owner-repo-missing' } as Bundle)).rejects.toThrow(
        'Failed to download skill missing: Skill not found: missing'
      );
    });
  });

  describe('fetchMetadata', () => {
    it('reports the owner/repo name, skill count, and a fixed version', async () => {
      const api = new FakeGitHubApi()
        .seedJson(TREE_PATH, { tree: [{ path: 'skills/a/SKILL.md', type: 'blob', sha: 's1' }] })
        .seedText(`${RAW_BASE}/skills/a/SKILL.md`, skillMdContent({ name: 'A' }));
      const clock = new FixedClock(1_700_000_000_000);

      const metadata = await makeAdapter({ githubApi: api, clock }).fetchMetadata();

      expect(metadata).toEqual({
        name: 'owner/repo',
        description: 'Skills Repository',
        bundleCount: 1,
        lastUpdated: new Date(1_700_000_000_000).toISOString(),
        version: '1.0.0'
      });
    });

    it('wraps a scan failure with a descriptive error', async () => {
      await expect(makeAdapter({ githubApi: new FakeGitHubApi() }).fetchMetadata()).rejects.toThrow('Failed to fetch skills repository metadata:');
    });
  });

  describe('validate', () => {
    it('is invalid when the repository itself cannot be accessed', async () => {
      const result = await makeAdapter({ githubApi: new FakeGitHubApi() }).validate();
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Skills repository validation failed');
      expect(result.bundlesFound).toBe(0);
    });

    it('is invalid with a specific message when the skills/ directory is missing (404)', async () => {
      const api = new FakeGitHubApi().seedJson('/repos/owner/repo', { name: 'repo' });
      const result = await makeAdapter({ githubApi: api }).validate();
      expect(result).toEqual({
        valid: false,
        errors: [`Missing required 'skills' directory at repository root`],
        warnings: [],
        bundlesFound: 0
      });
    });

    it('is invalid with a generic message when the skills/ directory check fails for a non-404 reason', async () => {
      const base = new FakeGitHubApi().seedJson('/repos/owner/repo', { name: 'repo' });
      const api = new FailingGitHubApi(base, '/repos/owner/repo/contents/skills', new Error('ECONNRESET'));

      const result = await makeAdapter({ githubApi: api }).validate();
      expect(result).toEqual({
        valid: false,
        errors: ['Failed to access skills directory: ECONNRESET'],
        warnings: [],
        bundlesFound: 0
      });
    });

    it('is valid with a warning when the skills/ directory exists but has no valid skills', async () => {
      const api = new FakeGitHubApi()
        .seedJson('/repos/owner/repo', { name: 'repo' })
        .seedJson('/repos/owner/repo/contents/skills', [])
        .seedJson(TREE_PATH, { tree: [] });

      const result = await makeAdapter({ githubApi: api }).validate();
      expect(result).toEqual({
        valid: true,
        errors: [],
        warnings: ['No valid skills found in skills/ directory (skills must have SKILL.md file)'],
        bundlesFound: 0
      });
    });

    it('is valid with the skill count when the skills/ directory has valid skills', async () => {
      const api = new FakeGitHubApi()
        .seedJson('/repos/owner/repo', { name: 'repo' })
        .seedJson('/repos/owner/repo/contents/skills', [])
        .seedJson(TREE_PATH, { tree: [{ path: 'skills/a/SKILL.md', type: 'blob', sha: 's1' }] })
        .seedText(`${RAW_BASE}/skills/a/SKILL.md`, skillMdContent({ name: 'A' }));

      const result = await makeAdapter({ githubApi: api }).validate();
      expect(result).toEqual({ valid: true, errors: [], warnings: [], bundlesFound: 1 });
    });
  });
});
