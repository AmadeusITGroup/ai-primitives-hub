/**
 * Coverage tests for infra/resolvers/skills-resolver.ts.
 *
 * No equivalent test existed in the reference branch this module was
 * ported from (a pre-existing gap there, not something dropped during
 * this port) — written fresh against the three resolvers' actual
 * behavior.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  LocalAwesomeCopilotBundleResolver,
  LocalSkillsBundleResolver,
  SkillsBundleResolver,
} from '../../src/resolvers/skills-resolver';
import {
  FakeGitHubApi,
} from '../helpers/fake-github-api';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';
import {
  RecordingGitHubApi,
} from '../helpers/recording-github-api';

describe('SkillsBundleResolver', () => {
  const CONTENTS_PATH = '/repos/anthropics/skills/contents/skills/my-skill';

  it('returns null when the skill directory does not exist', async () => {
    // Nothing seeded -> FakeGitHubApi.getJson throws a 404-shaped error.
    const resolver = new SkillsBundleResolver({ repoSlug: 'anthropics/skills', githubApi: new FakeGitHubApi() });

    const result = await resolver.resolve({ bundleId: 'my-skill' });
    expect(result).toBeNull();
  });

  it('builds a zip from every file in the skill directory', async () => {
    const githubApi = new FakeGitHubApi()
      .seedJson(CONTENTS_PATH, [
        { name: 'SKILL.md', path: 'skills/my-skill/SKILL.md', type: 'file', download_url: 'https://raw/SKILL.md', url: 'https://api/skill' }
      ])
      .seedBytes('https://raw/SKILL.md', new TextEncoder().encode('---\nname: My Skill\ndescription: Does things\n---\n# My Skill'));
    const resolver = new SkillsBundleResolver({ repoSlug: 'anthropics/skills', githubApi });

    const result = await resolver.resolve({ bundleId: 'my-skill', bundleVersion: '1.2.3' });
    expect(result).not.toBeNull();
    expect(result?.ref.sourceType).toBe('skills');
    expect(result?.ref.bundleVersion).toBe('1.2.3');
    expect(result?.inlineBytes?.length).toBeGreaterThan(0);
  });

  it('recurses into subdirectories', async () => {
    const githubApi = new FakeGitHubApi()
      .seedJson(CONTENTS_PATH, [
        { name: 'sub', path: 'skills/my-skill/sub', type: 'dir', url: 'https://api/sub' }
      ])
      .seedJson('/repos/anthropics/skills/contents/skills/my-skill/sub', [
        { name: 'file.md', path: 'skills/my-skill/sub/file.md', type: 'file', download_url: 'https://raw/file.md', url: 'https://api/file' }
      ])
      .seedBytes('https://raw/file.md', new TextEncoder().encode('content'));
    const resolver = new SkillsBundleResolver({ repoSlug: 'anthropics/skills', githubApi });

    const result = await resolver.resolve({ bundleId: 'my-skill' });
    expect(result).not.toBeNull();
  });

  it('defaults name/description when SKILL.md is absent', async () => {
    const githubApi = new FakeGitHubApi()
      .seedJson(CONTENTS_PATH, [
        { name: 'notes.md', path: 'skills/my-skill/notes.md', type: 'file', download_url: 'https://raw/notes.md', url: 'https://api/notes' }
      ])
      .seedBytes('https://raw/notes.md', new TextEncoder().encode('content'));
    const resolver = new SkillsBundleResolver({ repoSlug: 'anthropics/skills', githubApi });

    const result = await resolver.resolve({ bundleId: 'my-skill' });
    expect(result).not.toBeNull();
    expect(result?.ref.bundleVersion).toBe('0.0.0');
  });

  it('calls the contents endpoint through the shared GitHubApi', async () => {
    const inner = new FakeGitHubApi()
      .seedJson(CONTENTS_PATH, [
        { name: 'SKILL.md', path: 'skills/my-skill/SKILL.md', type: 'file', download_url: 'https://raw/SKILL.md', url: 'https://api/skill' }
      ])
      .seedBytes('https://raw/SKILL.md', new TextEncoder().encode('# Skill'));
    const githubApi = new RecordingGitHubApi(inner);
    const resolver = new SkillsBundleResolver({ repoSlug: 'anthropics/skills', githubApi });

    await resolver.resolve({ bundleId: 'my-skill' });
    expect(githubApi.calls).toEqual([
      { method: 'getJson', pathOrUrl: CONTENTS_PATH },
      { method: 'download', pathOrUrl: 'https://raw/SKILL.md' }
    ]);
  });
});

describe('LocalSkillsBundleResolver', () => {
  const makeFs = (): InMemoryFileSystem => {
    const fs = new InMemoryFileSystem();
    fs.seed('/repo/skills/my-skill/SKILL.md', '---\nname: My Skill\ndescription: Local skill\n---\n# Body');
    fs.seed('/repo/skills/my-skill/sub/extra.md', 'extra content');
    return fs;
  };

  it('returns null when the skill directory is missing', async () => {
    const resolver = new LocalSkillsBundleResolver({ rootPath: '/repo', fs: new InMemoryFileSystem() });
    const result = await resolver.resolve({ bundleId: 'missing-skill' });
    expect(result).toBeNull();
  });

  it('walks the local skill directory recursively', async () => {
    const resolver = new LocalSkillsBundleResolver({ rootPath: '/repo', fs: makeFs() });
    const result = await resolver.resolve({ bundleId: 'my-skill', bundleVersion: '2.0.0' });
    expect(result).not.toBeNull();
    expect(result?.ref.sourceType).toBe('local-skills');
    expect(result?.ref.bundleVersion).toBe('2.0.0');
  });

  it('strips a file:// prefix from rootPath', async () => {
    const resolver = new LocalSkillsBundleResolver({ rootPath: 'file:///repo', fs: makeFs() });
    const result = await resolver.resolve({ bundleId: 'my-skill' });
    expect(result).not.toBeNull();
  });
});

describe('LocalAwesomeCopilotBundleResolver', () => {
  const makeFs = (): InMemoryFileSystem => {
    const fs = new InMemoryFileSystem();
    fs.seed('/repo/collections/test.collection.yml', 'id: test\nname: Test\nitems:\n  - path: prompts/test.md\n    kind: prompt');
    fs.seed('/repo/prompts/test.md', '# Test Prompt');
    return fs;
  };

  it('returns null when the collection file is missing', async () => {
    const resolver = new LocalAwesomeCopilotBundleResolver({ rootPath: '/repo', fs: new InMemoryFileSystem() });
    const result = await resolver.resolve({ bundleId: 'missing' });
    expect(result).toBeNull();
  });

  it('builds a zip bundle from the local collection', async () => {
    const resolver = new LocalAwesomeCopilotBundleResolver({ rootPath: '/repo', fs: makeFs() });
    const result = await resolver.resolve({ bundleId: 'test', bundleVersion: 'latest' });
    expect(result).not.toBeNull();
    expect(result?.ref.sourceType).toBe('local-awesome-copilot');
    expect(result?.inlineBytes?.length).toBeGreaterThan(0);
  });

  it('skips missing item files', async () => {
    const fs = makeFs();
    // Reference a missing file via a second collection item.
    fs.seed('/repo/collections/test.collection.yml', 'id: test\nname: Test\nitems:\n  - path: prompts/test.md\n    kind: prompt\n  - path: prompts/missing.md\n    kind: prompt');
    const resolver = new LocalAwesomeCopilotBundleResolver({ rootPath: '/repo', fs });
    const result = await resolver.resolve({ bundleId: 'test' });
    expect(result).not.toBeNull();
  });
});
