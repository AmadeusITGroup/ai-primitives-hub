import nock from 'nock';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  AwesomeCopilotBundleResolver,
} from '../../src/resolvers/awesome-copilot-resolver';

const mockHttpClient = {
  fetch: async ({ url, headers }: { url: string; headers?: Record<string, string> }) => {
    const response = await fetch(url, { headers });
    const body = await response.arrayBuffer();
    return {
      statusCode: response.status,
      body: new Uint8Array(body)
    };
  }
};

const mockTokenProvider = {
  getToken: async () => null
};

describe('AwesomeCopilotBundleResolver', () => {
  it('returns null when collection file not found', async () => {
    const resolver = new AwesomeCopilotBundleResolver({
      repoSlug: 'test/repo',
      http: mockHttpClient as any,
      tokens: mockTokenProvider
    });

    nock('https://raw.githubusercontent.com')
      .get('/test/repo/main/collections/test.collection.yml')
      .reply(404);

    const result = await resolver.resolve({ bundleId: 'test', bundleVersion: 'latest' });
    expect(result).toBeNull();
  });

  it('returns null when collection has no items', async () => {
    const resolver = new AwesomeCopilotBundleResolver({
      repoSlug: 'test/repo',
      http: mockHttpClient as any,
      tokens: mockTokenProvider
    });

    nock('https://raw.githubusercontent.com')
      .get('/test/repo/main/collections/test.collection.yml')
      .reply(200, 'id: test\nname: Test\nitems: []');

    const result = await resolver.resolve({ bundleId: 'test', bundleVersion: 'latest' });
    expect(result).toBeNull();
  });

  it('returns null when collection YAML is invalid', async () => {
    const resolver = new AwesomeCopilotBundleResolver({
      repoSlug: 'test/repo',
      http: mockHttpClient as any,
      tokens: mockTokenProvider
    });

    nock('https://raw.githubusercontent.com')
      .get('/test/repo/main/collections/test.collection.yml')
      .reply(200, 'invalid: yaml: [unclosed');

    const result = await resolver.resolve({ bundleId: 'test', bundleVersion: 'latest' });
    expect(result).toBeNull();
  });

  it('builds zip bundle with collection items', async () => {
    const resolver = new AwesomeCopilotBundleResolver({
      repoSlug: 'test/repo',
      http: mockHttpClient as any,
      tokens: mockTokenProvider
    });

    nock('https://raw.githubusercontent.com')
      .get('/test/repo/main/collections/test.collection.yml')
      .reply(200, 'id: test\nname: Test\nitems:\n  - path: prompts/test.md\n    kind: prompt')
      .get('/test/repo/main/prompts/test.md')
      .reply(200, '# Test Prompt');

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
    const resolver = new AwesomeCopilotBundleResolver({
      repoSlug: 'test/repo',
      http: mockHttpClient as any,
      tokens: mockTokenProvider
    });

    nock('https://raw.githubusercontent.com')
      .get('/test/repo/main/collections/test.collection.yml')
      .reply(200, 'id: test\nname: Test\nitems:\n  - path: prompts/test.md\n    kind: prompt\n  - path: prompts/missing.md\n    kind: prompt')
      .get('/test/repo/main/prompts/test.md')
      .reply(200, '# Test Prompt')
      .get('/test/repo/main/prompts/missing.md')
      .reply(404);

    const result = await resolver.resolve({ bundleId: 'test', bundleVersion: 'latest' });
    expect(result).not.toBeNull();
    expect(result?.inlineBytes).toBeDefined();
    if (result?.inlineBytes) {
      expect(result.inlineBytes.length).toBeGreaterThan(0);
    }
  });

  it('uses custom branch', async () => {
    const resolver = new AwesomeCopilotBundleResolver({
      repoSlug: 'test/repo',
      branch: 'develop',
      http: mockHttpClient as any,
      tokens: mockTokenProvider
    });

    nock('https://raw.githubusercontent.com')
      .get('/test/repo/develop/collections/test.collection.yml')
      .reply(200, 'id: test\nname: Test\nitems:\n  - path: prompts/test.md\n    kind: prompt')
      .get('/test/repo/develop/prompts/test.md')
      .reply(200, '# Test Prompt');

    const result = await resolver.resolve({ bundleId: 'test', bundleVersion: 'latest' });
    expect(result).not.toBeNull();
  });

  it('uses custom collections path', async () => {
    const resolver = new AwesomeCopilotBundleResolver({
      repoSlug: 'test/repo',
      collectionsPath: 'custom-collections',
      http: mockHttpClient as any,
      tokens: mockTokenProvider
    });

    nock('https://raw.githubusercontent.com')
      .get('/test/repo/main/custom-collections/test.collection.yml')
      .reply(200, 'id: test\nname: Test\nitems:\n  - path: prompts/test.md\n    kind: prompt')
      .get('/test/repo/main/prompts/test.md')
      .reply(200, '# Test Prompt');

    const result = await resolver.resolve({ bundleId: 'test', bundleVersion: 'latest' });
    expect(result).not.toBeNull();
  });

  it('quotes manifest name with special characters', async () => {
    const resolver = new AwesomeCopilotBundleResolver({
      repoSlug: 'test/repo',
      http: mockHttpClient as any,
      tokens: mockTokenProvider
    });

    nock('https://raw.githubusercontent.com')
      .get('/test/repo/main/collections/test.collection.yml')
      .reply(200, 'id: test\nname: Test\'s Collection\nitems:\n  - path: prompts/test.md\n    kind: prompt')
      .get('/test/repo/main/prompts/test.md')
      .reply(200, '# Test Prompt');

    const result = await resolver.resolve({ bundleId: 'test', bundleVersion: 'latest' });
    expect(result).not.toBeNull();
  });

  it('uses collection id when present', async () => {
    const resolver = new AwesomeCopilotBundleResolver({
      repoSlug: 'test/repo',
      http: mockHttpClient as any,
      tokens: mockTokenProvider
    });

    nock('https://raw.githubusercontent.com')
      .get('/test/repo/main/collections/test.collection.yml')
      .reply(200, 'id: custom-id\nname: Test\nitems:\n  - path: prompts/test.md\n    kind: prompt')
      .get('/test/repo/main/prompts/test.md')
      .reply(200, '# Test Prompt');

    const result = await resolver.resolve({ bundleId: 'test', bundleVersion: 'latest' });
    expect(result).not.toBeNull();
    expect(result?.ref.bundleId).toBe('test'); // bundleId from spec
  });

  it('throws on HTTP errors other than 404', async () => {
    const resolver = new AwesomeCopilotBundleResolver({
      repoSlug: 'test/repo',
      http: mockHttpClient as any,
      tokens: mockTokenProvider
    });

    nock('https://raw.githubusercontent.com')
      .get('/test/repo/main/collections/test.collection.yml')
      .reply(500);

    await expect(resolver.resolve({ bundleId: 'test', bundleVersion: 'latest' }))
      .rejects.toThrow('raw fetch 500');
  });

  it('uses token from token provider', async () => {
    const tokenProvider = {
      getToken: async () => 'test-token'
    };

    const resolver = new AwesomeCopilotBundleResolver({
      repoSlug: 'test/repo',
      http: mockHttpClient as any,
      tokens: tokenProvider
    });

    nock('https://raw.githubusercontent.com')
      .get('/test/repo/main/collections/test.collection.yml')
      .matchHeader('authorization', 'Bearer test-token')
      .reply(200, 'id: test\nname: Test\nitems:\n  - path: prompts/test.md\n    kind: prompt')
      .get('/test/repo/main/prompts/test.md')
      .matchHeader('authorization', 'Bearer test-token')
      .reply(200, '# Test Prompt');

    const result = await resolver.resolve({ bundleId: 'test', bundleVersion: 'latest' });
    expect(result).not.toBeNull();
  });
});
