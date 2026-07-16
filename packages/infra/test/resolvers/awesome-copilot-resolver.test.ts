import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  AwesomeCopilotBundleResolver,
} from '../../src/resolvers/awesome-copilot-resolver';
import {
  FakeGitHubApi,
} from '../helpers/fake-github-api';

const COLLECTION_URL = 'https://raw.githubusercontent.com/test/repo/main/collections/test.collection.yml';
const PROMPT_URL = 'https://raw.githubusercontent.com/test/repo/main/prompts/test.md';

describe('AwesomeCopilotBundleResolver', () => {
  it('returns null when collection file not found', async () => {
    // Nothing seeded -> FakeGitHubApi.getText throws a 404-shaped error.
    const resolver = new AwesomeCopilotBundleResolver({ repoSlug: 'test/repo', githubApi: new FakeGitHubApi() });

    const result = await resolver.resolve({ bundleId: 'test', bundleVersion: 'latest' });
    expect(result).toBeNull();
  });

  it('returns null when collection has no items', async () => {
    const githubApi = new FakeGitHubApi().seedText(COLLECTION_URL, 'id: test\nname: Test\nitems: []');
    const resolver = new AwesomeCopilotBundleResolver({ repoSlug: 'test/repo', githubApi });

    const result = await resolver.resolve({ bundleId: 'test', bundleVersion: 'latest' });
    expect(result).toBeNull();
  });

  it('returns null when collection YAML is invalid', async () => {
    const githubApi = new FakeGitHubApi().seedText(COLLECTION_URL, 'invalid: yaml: [unclosed');
    const resolver = new AwesomeCopilotBundleResolver({ repoSlug: 'test/repo', githubApi });

    const result = await resolver.resolve({ bundleId: 'test', bundleVersion: 'latest' });
    expect(result).toBeNull();
  });

  it('builds zip bundle with collection items', async () => {
    const githubApi = new FakeGitHubApi()
      .seedText(COLLECTION_URL, 'id: test\nname: Test\nitems:\n  - path: prompts/test.md\n    kind: prompt')
      .seedText(PROMPT_URL, '# Test Prompt');
    const resolver = new AwesomeCopilotBundleResolver({ repoSlug: 'test/repo', githubApi });

    const result = await resolver.resolve({ bundleId: 'test', bundleVersion: 'latest' });
    expect(result).not.toBeNull();
    expect(result?.inlineBytes).toBeDefined();
    if (result?.inlineBytes) {
      expect(result.inlineBytes.length).toBeGreaterThan(0);
    }
    expect(result?.ref.bundleId).toBe('test');
    expect(result?.ref.sourceType).toBe('awesome-copilot');
  });

  it('skips missing items', async () => {
    const githubApi = new FakeGitHubApi()
      .seedText(COLLECTION_URL, 'id: test\nname: Test\nitems:\n  - path: prompts/test.md\n    kind: prompt\n  - path: prompts/missing.md\n    kind: prompt')
      .seedText(PROMPT_URL, '# Test Prompt');
    // prompts/missing.md intentionally not seeded -> treated as 404 -> skipped.
    const resolver = new AwesomeCopilotBundleResolver({ repoSlug: 'test/repo', githubApi });

    const result = await resolver.resolve({ bundleId: 'test', bundleVersion: 'latest' });
    expect(result).not.toBeNull();
    expect(result?.inlineBytes).toBeDefined();
    if (result?.inlineBytes) {
      expect(result.inlineBytes.length).toBeGreaterThan(0);
    }
  });

  it('uses custom branch', async () => {
    const githubApi = new FakeGitHubApi()
      .seedText('https://raw.githubusercontent.com/test/repo/develop/collections/test.collection.yml', 'id: test\nname: Test\nitems:\n  - path: prompts/test.md\n    kind: prompt')
      .seedText('https://raw.githubusercontent.com/test/repo/develop/prompts/test.md', '# Test Prompt');
    const resolver = new AwesomeCopilotBundleResolver({ repoSlug: 'test/repo', branch: 'develop', githubApi });

    const result = await resolver.resolve({ bundleId: 'test', bundleVersion: 'latest' });
    expect(result).not.toBeNull();
  });

  it('uses custom collections path', async () => {
    const githubApi = new FakeGitHubApi()
      .seedText('https://raw.githubusercontent.com/test/repo/main/custom-collections/test.collection.yml', 'id: test\nname: Test\nitems:\n  - path: prompts/test.md\n    kind: prompt')
      .seedText(PROMPT_URL, '# Test Prompt');
    const resolver = new AwesomeCopilotBundleResolver({ repoSlug: 'test/repo', collectionsPath: 'custom-collections', githubApi });

    const result = await resolver.resolve({ bundleId: 'test', bundleVersion: 'latest' });
    expect(result).not.toBeNull();
  });

  it('quotes manifest name with special characters', async () => {
    const githubApi = new FakeGitHubApi()
      .seedText(COLLECTION_URL, 'id: test\nname: Test\'s Collection\nitems:\n  - path: prompts/test.md\n    kind: prompt')
      .seedText(PROMPT_URL, '# Test Prompt');
    const resolver = new AwesomeCopilotBundleResolver({ repoSlug: 'test/repo', githubApi });

    const result = await resolver.resolve({ bundleId: 'test', bundleVersion: 'latest' });
    expect(result).not.toBeNull();
  });

  it('uses collection id when present', async () => {
    const githubApi = new FakeGitHubApi()
      .seedText(COLLECTION_URL, 'id: custom-id\nname: Test\nitems:\n  - path: prompts/test.md\n    kind: prompt')
      .seedText(PROMPT_URL, '# Test Prompt');
    const resolver = new AwesomeCopilotBundleResolver({ repoSlug: 'test/repo', githubApi });

    const result = await resolver.resolve({ bundleId: 'test', bundleVersion: 'latest' });
    expect(result).not.toBeNull();
    expect(result?.ref.bundleId).toBe('test'); // bundleId from spec
  });

  it('throws on HTTP errors other than 404', async () => {
    const githubApi = {
      getText: async (): Promise<never> => {
        throw new Error('GitHub API error: 500 (url)');
      }
    };
    const resolver = new AwesomeCopilotBundleResolver({ repoSlug: 'test/repo', githubApi: githubApi as never });

    await expect(resolver.resolve({ bundleId: 'test', bundleVersion: 'latest' }))
      .rejects.toThrow('GitHub API error: 500');
  });
});
