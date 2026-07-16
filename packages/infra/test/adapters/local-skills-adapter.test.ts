import * as crypto from 'node:crypto';
import type {
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  LocalSkillsAdapter,
} from '../../src/adapters/local-skills-adapter';
import {
  FixedClock,
} from '../helpers/fixed-clock';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

function makeSource(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    id: 'local-skills-test',
    name: 'Local Skills Test',
    type: 'local-skills',
    url: '/skills-root',
    enabled: true,
    priority: 0,
    ...overrides
  };
}

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

function makeAdapter(overrides: { source?: RegistrySource; fs?: InMemoryFileSystem; clock?: FixedClock } = {}): LocalSkillsAdapter {
  return new LocalSkillsAdapter(overrides.source ?? makeSource(), overrides.fs ?? new InMemoryFileSystem(), overrides.clock ?? new FixedClock(0));
}

describe('LocalSkillsAdapter', () => {
  describe('constructor', () => {
    it('rejects a source URL that is neither file://, absolute, ~/, nor ./', () => {
      expect(() => makeAdapter({ source: makeSource({ url: 'not-a-path' }) })).toThrow('Invalid local skills path');
    });

    it('accepts file://, absolute, ~/, and ./ URLs', () => {
      for (const url of ['file:///skills-root', '/skills-root', '~/skills-root', './skills-root']) {
        expect(() => makeAdapter({ source: makeSource({ url }) })).not.toThrow();
      }
    });
  });

  it('never requires authentication', () => {
    expect(makeAdapter().requiresAuthentication()).toBe(false);
  });

  describe('getManifestUrl / getDownloadUrl', () => {
    it('builds file:// URLs for a skill by extracting its id from the bundle id', () => {
      const adapter = makeAdapter();
      expect(adapter.getManifestUrl('local-skills-skills-root-my-skill')).toBe('file:///skills-root/skills/my-skill/SKILL.md');
      expect(adapter.getDownloadUrl('local-skills-skills-root-my-skill')).toBe('file:///skills-root/skills/my-skill');
    });
  });

  describe('getSkillSourcePath / getSkillName', () => {
    it('resolves the on-disk skill directory by extracting the id from the bundle id', () => {
      const adapter = makeAdapter();
      const bundle = { id: 'local-skills-skills-root-my-skill' } as never;
      expect(adapter.getSkillSourcePath(bundle)).toBe('/skills-root/skills/my-skill');
    });

    it('extracts the skill name/id from the bundle id', () => {
      const adapter = makeAdapter();
      const bundle = { id: 'local-skills-skills-root-my-skill' } as never;
      expect(adapter.getSkillName(bundle)).toBe('my-skill');
    });
  });

  describe('fetchBundles', () => {
    it('discovers a skill directory containing a SKILL.md', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/skills-root/skills/my-skill/SKILL.md', skillMdContent({ name: 'My Skill', description: 'Does things', license: 'MIT' }));

      const [bundle] = await makeAdapter({ fs }).fetchBundles();

      expect(bundle).toMatchObject({
        id: 'local-skills-skills-root-my-skill',
        name: 'My Skill',
        description: 'Does things',
        license: 'MIT',
        author: 'Local',
        sourceId: 'local-skills-test',
        environments: ['claude', 'vscode', 'claude-code'],
        tags: ['skill', 'anthropic', 'local'],
        dependencies: [],
        repository: '/skills-root',
        homepage: '/skills-root',
        manifestUrl: 'file:///skills-root/skills/my-skill/SKILL.md',
        downloadUrl: 'file:///skills-root/skills/my-skill'
      });
      expect(bundle.version).toMatch(/^hash:[0-9a-f]{64}$/);
    });

    it('computes the version hash as sha256 over sorted "file:content|" pairs', async () => {
      const fs = new InMemoryFileSystem();
      const skillMd = skillMdContent({ name: 'X' });
      fs.seed('/skills-root/skills/x/SKILL.md', skillMd);
      fs.seed('/skills-root/skills/x/reference.md', '# Reference');

      const [bundle] = await makeAdapter({ fs }).fetchBundles();

      const expected = crypto.createHash('sha256');
      for (const [file, content] of [['SKILL.md', skillMd], ['reference.md', '# Reference']].toSorted((a, b) => a[0].localeCompare(b[0]))) {
        expected.update(file).update(':').update(content).update('|');
      }
      expect(bundle.version).toBe(`hash:${expected.digest('hex')}`);
    });

    it('changes the version when a file\'s content changes', async () => {
      const buildBundles = async (content: string) => {
        const fs = new InMemoryFileSystem();
        fs.seed('/skills-root/skills/my-skill/SKILL.md', skillMdContent({ name: 'My Skill' }));
        fs.seed('/skills-root/skills/my-skill/data.txt', content);
        return makeAdapter({ fs }).fetchBundles();
      };

      const [v1] = await buildBundles('version one');
      const [v2] = await buildBundles('version two');
      expect(v1.version).not.toBe(v2.version);
    });

    it('discovers multiple skills', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/skills-root/skills/alpha/SKILL.md', skillMdContent({ name: 'Alpha' }));
      fs.seed('/skills-root/skills/beta/SKILL.md', skillMdContent({ name: 'Beta' }));

      const bundles = await makeAdapter({ fs }).fetchBundles();
      expect(bundles.map((b) => b.name).toSorted()).toEqual(['Alpha', 'Beta']);
    });

    it('skips a skills/ subfolder that has no SKILL.md', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/skills-root/skills/valid/SKILL.md', skillMdContent({ name: 'Valid' }));
      fs.seed('/skills-root/skills/invalid/README.md', 'no SKILL.md here');

      const bundles = await makeAdapter({ fs }).fetchBundles();
      expect(bundles.map((b) => b.name)).toEqual(['Valid']);
    });

    it('defaults description to "No description" and license to "Unknown" when the frontmatter omits them', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/skills-root/skills/bare/SKILL.md', skillMdContent({ name: 'Bare' }));

      const [bundle] = await makeAdapter({ fs }).fetchBundles();
      expect(bundle.description).toBe('No description');
      expect(bundle.license).toBe('Unknown');
    });

    it('falls back to the skill id as the name when the frontmatter has no name', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/skills-root/skills/my-skill/SKILL.md', skillMdContent({ description: 'desc only' }));

      const [bundle] = await makeAdapter({ fs }).fetchBundles();
      expect(bundle.name).toBe('my-skill');
    });

    it('resolves to an empty list, rather than throwing, when the skills/ directory has no entries', async () => {
      // InMemoryFileSystem models directories as implicit: an empty/nonexistent
      // directory is indistinguishable from one with no matching entries, so this
      // exercises the same code path a real ENOENT would hit without one being
      // simulable here (see validate()'s tests for the directory-missing case).
      await expect(makeAdapter().fetchBundles()).resolves.toEqual([]);
    });
  });

  describe('downloadBundle', () => {
    it('produces a real ZIP archive containing the deployment manifest and every skill file', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/skills-root/skills/my-skill/SKILL.md', skillMdContent({ name: 'My Skill', description: 'd' }));
      fs.seed('/skills-root/skills/my-skill/assets/diagram.md', '# Diagram');

      const adapter = makeAdapter({ fs });
      const [bundle] = await adapter.fetchBundles();
      const zip = await adapter.downloadBundle(bundle);

      // ZIP local-file-header magic number: "PK\x03\x04".
      expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4B, 0x03, 0x04]));
      expect(zip.length).toBeGreaterThan(0);
    });

    it('throws a descriptive error when the skill cannot be found', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/skills-root/skills/.keep', '');

      await expect(
        makeAdapter({ fs }).downloadBundle({ id: 'local-skills-skills-root-missing' } as never)
      ).rejects.toThrow('Failed to download skill missing: Skill not found: missing');
    });
  });

  describe('fetchMetadata', () => {
    it('reports the directory name and skill count', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/skills-root/skills/a/SKILL.md', skillMdContent({ name: 'A' }));

      const metadata = await makeAdapter({ fs }).fetchMetadata();
      expect(metadata).toMatchObject({ name: 'skills-root', description: 'Local Skills Repository', bundleCount: 1, version: '1.0.0' });
    });

    it('wraps a scan failure with a descriptive error', async () => {
      await expect(makeAdapter().fetchMetadata()).rejects.toThrow('Failed to fetch local skills metadata');
    });
  });

  describe('validate', () => {
    it('is invalid when the root directory does not exist', async () => {
      const result = await makeAdapter().validate();
      expect(result).toEqual({ valid: false, errors: ['Directory does not exist: /skills-root'], warnings: [], bundlesFound: 0 });
    });

    it('is invalid when the skills/ directory is missing', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/skills-root/.keep', '');

      const result = await makeAdapter({ fs }).validate();
      expect(result).toEqual({
        valid: false,
        errors: [`Missing required 'skills' directory: /skills-root/skills`],
        warnings: [],
        bundlesFound: 0
      });
    });

    it('is valid with a warning when the skills/ directory has no valid skills', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/skills-root/skills/.keep', '');

      const result = await makeAdapter({ fs }).validate();
      expect(result).toEqual({
        valid: true,
        errors: [],
        warnings: ['No valid skills found in skills/ directory (skills must have SKILL.md file)'],
        bundlesFound: 0
      });
    });

    it('is valid with the skill count when valid skills are found', async () => {
      const fs = new InMemoryFileSystem();
      fs.seed('/skills-root/skills/a/SKILL.md', skillMdContent({ name: 'A' }));

      const result = await makeAdapter({ fs }).validate();
      expect(result).toEqual({ valid: true, errors: [], warnings: [], bundlesFound: 1 });
    });
  });
});
