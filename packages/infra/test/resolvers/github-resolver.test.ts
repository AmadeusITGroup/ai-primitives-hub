/**
 * Coverage tests for infra/resolvers/github-resolver.ts.
 *
 * No equivalent test existed in the reference branch this module was
 * ported from (a pre-existing gap there, not something dropped during
 * this port) — written fresh against `GitHubBundleResolver`'s actual
 * behavior. Rewritten to seed `FakeGitHubApi` (the shared `GitHubApi`
 * test double) instead of `FakeHttpClient` when the resolver moved off
 * raw `HttpClient`+`TokenProvider` onto the `GitHubApi` port — see
 * `github-resolver.ts`'s module doc.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  extractSemver,
  GitHubBundleResolver,
} from '../../src/resolvers/github-resolver';
import {
  FakeGitHubApi,
} from '../helpers/fake-github-api';
import {
  RecordingGitHubApi,
} from '../helpers/recording-github-api';

const RELEASES_PATH = '/repos/owner/repo/releases';

const release = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  tag_name: 'owner-repo-mybundle-v1.0.0',
  assets: [
    { name: 'bundle.zip', browser_download_url: 'https://github.com/owner/repo/releases/download/v1.0.0/bundle.zip', url: 'https://api.github.com/assets/1' }
  ],
  draft: false,
  prerelease: false,
  ...overrides
});

describe('extractSemver', () => {
  it('extracts bare semver', () => {
    expect(extractSemver('1.2.3')).toBe('1.2.3');
  });

  it('extracts v-prefixed semver', () => {
    expect(extractSemver('v1.2.3')).toBe('1.2.3');
  });

  it('extracts semver from a suffixed tag', () => {
    expect(extractSemver('my-bundle-1.0.0')).toBe('1.0.0');
  });

  it('extracts prerelease semver', () => {
    expect(extractSemver('v1.2.3-rc.1')).toBe('1.2.3-rc.1');
  });

  it('returns null when no semver pattern is present', () => {
    expect(extractSemver('release')).toBeNull();
  });
});

describe('GitHubBundleResolver', () => {
  it('returns null when the repo has no releases', async () => {
    const githubApi = new FakeGitHubApi().seedJson(RELEASES_PATH, []);
    const resolver = new GitHubBundleResolver({ repoSlug: 'owner/repo', githubApi });

    const result = await resolver.resolve({ bundleId: 'owner-repo-mybundle', bundleVersion: 'latest' });
    expect(result).toBeNull();
  });

  it('resolves the latest matching release', async () => {
    const githubApi = new FakeGitHubApi().seedJson(RELEASES_PATH, [release()]);
    const resolver = new GitHubBundleResolver({ repoSlug: 'owner/repo', githubApi });

    const result = await resolver.resolve({ bundleId: 'owner-repo-mybundle', bundleVersion: 'latest' });
    expect(result).not.toBeNull();
    expect(result?.ref.bundleVersion).toBe('1.0.0');
    expect(result?.ref.sourceType).toBe('github');
    expect(result?.downloadUrl).toBe('https://api.github.com/assets/1');
  });

  it('resolves a specific version', async () => {
    const githubApi = new FakeGitHubApi().seedJson(RELEASES_PATH, [
      release({ tag_name: 'owner-repo-mybundle-v1.0.0' }),
      release({ tag_name: 'owner-repo-mybundle-v2.0.0' })
    ]);
    const resolver = new GitHubBundleResolver({ repoSlug: 'owner/repo', githubApi });

    const result = await resolver.resolve({ bundleId: 'owner-repo-mybundle', bundleVersion: '1.0.0' });
    expect(result?.ref.bundleVersion).toBe('1.0.0');
  });

  it('ignores draft and prerelease releases when picking latest', async () => {
    const githubApi = new FakeGitHubApi().seedJson(RELEASES_PATH, [
      release({ tag_name: 'owner-repo-mybundle-v2.0.0', draft: true }),
      release({ tag_name: 'owner-repo-mybundle-v1.0.0' })
    ]);
    const resolver = new GitHubBundleResolver({ repoSlug: 'owner/repo', githubApi });

    const result = await resolver.resolve({ bundleId: 'owner-repo-mybundle', bundleVersion: 'latest' });
    expect(result?.ref.bundleVersion).toBe('1.0.0');
  });

  it('returns null when no asset matches the expected name', async () => {
    const githubApi = new FakeGitHubApi().seedJson(RELEASES_PATH, [
      release({ assets: [{ name: 'unrelated.txt', browser_download_url: 'https://x', url: 'https://x' }] })
    ]);
    const resolver = new GitHubBundleResolver({ repoSlug: 'owner/repo', githubApi });

    const result = await resolver.resolve({ bundleId: 'owner-repo-mybundle', bundleVersion: 'latest' });
    expect(result).toBeNull();
  });

  it('matches a bundle-id-specific asset name', async () => {
    const githubApi = new FakeGitHubApi().seedJson(RELEASES_PATH, [release({
      assets: [{ name: 'owner-repo-mybundle.bundle.zip', browser_download_url: 'https://x', url: 'https://api.github.com/assets/9' }]
    })]);
    const resolver = new GitHubBundleResolver({ repoSlug: 'owner/repo', githubApi });

    const result = await resolver.resolve({ bundleId: 'owner-repo-mybundle', bundleVersion: 'latest' });
    expect(result?.downloadUrl).toBe('https://api.github.com/assets/9');
  });

  it('uses a custom asset name when configured', async () => {
    const githubApi = new FakeGitHubApi().seedJson(RELEASES_PATH, [release({
      assets: [{ name: 'custom.zip', browser_download_url: 'https://x', url: 'https://api.github.com/assets/custom' }]
    })]);
    const resolver = new GitHubBundleResolver({ repoSlug: 'owner/repo', assetName: 'custom.zip', githubApi });

    const result = await resolver.resolve({ bundleId: 'owner-repo-mybundle', bundleVersion: 'latest' });
    expect(result?.downloadUrl).toBe('https://api.github.com/assets/custom');
  });

  it('calls the releases endpoint through the shared GitHubApi', async () => {
    const inner = new FakeGitHubApi().seedJson(RELEASES_PATH, [release()]);
    const githubApi = new RecordingGitHubApi(inner);
    const resolver = new GitHubBundleResolver({ repoSlug: 'owner/repo', githubApi });

    await resolver.resolve({ bundleId: 'owner-repo-mybundle', bundleVersion: 'latest' });
    expect(githubApi.calls).toEqual([{ method: 'getJson', pathOrUrl: RELEASES_PATH }]);
  });

  it('treats a 404 releases response as an empty release list', async () => {
    // Nothing seeded -> FakeGitHubApi.getJson throws a 404-shaped error,
    // mirroring a real "repo not found or not accessible" response.
    const resolver = new GitHubBundleResolver({ repoSlug: 'owner/repo', githubApi: new FakeGitHubApi() });

    const result = await resolver.resolve({ bundleId: 'owner-repo-mybundle', bundleVersion: 'latest' });
    expect(result).toBeNull();
  });

  it('throws on non-2xx, non-404 API errors', async () => {
    const githubApi = {
      getJson: async (): Promise<never> => {
        throw new Error('GitHub API error: 500 (url)');
      }
    };
    const resolver = new GitHubBundleResolver({ repoSlug: 'owner/repo', githubApi: githubApi as never });

    await expect(resolver.resolve({ bundleId: 'owner-repo-mybundle', bundleVersion: 'latest' }))
      .rejects.toThrow('GitHub API error: 500');
  });

  it('caches the release list across multiple resolve calls', async () => {
    const inner = new FakeGitHubApi().seedJson(RELEASES_PATH, [release()]);
    const githubApi = new RecordingGitHubApi(inner);
    const resolver = new GitHubBundleResolver({ repoSlug: 'owner/repo', githubApi });

    await resolver.resolve({ bundleId: 'owner-repo-mybundle', bundleVersion: 'latest' });
    await resolver.resolve({ bundleId: 'owner-repo-mybundle', bundleVersion: 'latest' });
    expect(githubApi.countOf('getJson')).toBe(1);
  });
});
