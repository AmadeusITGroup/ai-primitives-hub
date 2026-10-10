import {
  selectReplications,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  GitHubApiClient,
} from '../src/http/github-api-client';
import type {
  ReplicationCache,
} from '../src/replicate/github-release-source';
import {
  GitHubReleaseSource,
} from '../src/replicate/github-release-source';
import {
  FakeHttpClient,
} from './helpers/fake-http-client';

class MemoryCache implements ReplicationCache {
  private readonly values = new Map<string, Uint8Array>();

  public get(key: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.values.get(key));
  }

  public set(key: string, value: Uint8Array): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

const firstPageUrl = 'https://api.github.com/repos/owner/repo/releases?per_page=100';
const secondPageUrl = `${firstPageUrl}&page=2`;
const thirdPageUrl = `${firstPageUrl}&page=3`;

const release = (version: string) => ({
  tag_name: `v${version}`,
  name: `Release ${version}`,
  assets: [
    { name: 'deployment-manifest.json', url: `https://raw.githubusercontent.com/owner/repo/${version}/deployment-manifest.json` },
    { name: `bundle-${version}.zip`, url: `https://github.com/owner/repo/releases/download/v${version}/bundle.zip`, size: 3 }
  ]
});

describe('GitHubReleaseSource', () => {
  it('refreshes a branch hub config across runs sharing a cache and counts it against the budget', async () => {
    const url = 'https://api.github.com/repos/owner/hub/contents/hub-config.yml?ref=main';
    const initialConfig = { sources: [] };
    const updatedConfig = { sources: [{ id: 'new-source' }] };
    const cache = new MemoryCache();
    const initialHttp = new FakeHttpClient().addRoute({
      url,
      status: 200,
      body: JSON.stringify({ content: btoa(JSON.stringify(initialConfig)) })
    });
    const updatedHttp = new FakeHttpClient().addRoute({
      url,
      status: 200,
      body: JSON.stringify({ content: btoa(JSON.stringify(updatedConfig)) })
    });

    await expect(new GitHubReleaseSource(new GitHubApiClient(initialHttp), cache).getHubConfig('owner/hub', 'main'))
      .resolves.toEqual(initialConfig);
    const updated = new GitHubReleaseSource(new GitHubApiClient(updatedHttp), cache, 1);

    await expect(updated.getHubConfig('owner/hub', 'main')).resolves.toEqual(updatedConfig);
    expect(updated.requestCount).toBe(1);
    expect(updatedHttp.calls.map((call) => call.url)).toEqual([url]);
    await expect(new GitHubReleaseSource(new GitHubApiClient(updatedHttp), cache, 0).getHubConfig('owner/hub', 'main'))
      .rejects.toThrow('GitHub request budget (0) exhausted');
    expect(updatedHttp.calls).toHaveLength(1);
  });

  it('discovers new releases and pagination across runs while reusing cached manifests and archives', async () => {
    const originalRelease = release('1.0.0');
    const newRelease = release('2.0.0');
    const archive = new Uint8Array([1, 2, 3]);
    const cache = new MemoryCache();
    const initialHttp = new FakeHttpClient()
      .addRoute({ url: firstPageUrl, status: 200, body: JSON.stringify([originalRelease]) })
      .addRoute({ url: originalRelease.assets[0].url, status: 200, body: JSON.stringify({ id: 'bundle', version: '1.0.0' }) })
      .addRoute({ url: originalRelease.assets[1].url, status: 200, body: archive });
    const initial = new GitHubReleaseSource(new GitHubApiClient(initialHttp), cache);
    const original = await initial.listReleaseCandidates('owner', 'repo', 'source');
    await expect(initial.downloadArchive(original[0])).resolves.toEqual(archive);
    expect(initial.requestCount).toBe(3);

    const updatedHttp = new FakeHttpClient()
      .addRoute({
        url: firstPageUrl,
        status: 200,
        body: JSON.stringify([newRelease]),
        headers: { link: `<${secondPageUrl}>; rel="next"` }
      })
      .addRoute({ url: secondPageUrl, status: 200, body: JSON.stringify([originalRelease]) })
      .addRoute({ url: newRelease.assets[0].url, status: 200, body: JSON.stringify({ id: 'bundle', version: '2.0.0' }) })
      .addRoute({ url: newRelease.assets[1].url, status: 200, body: archive });
    const updated = new GitHubReleaseSource(new GitHubApiClient(updatedHttp), cache, 4);
    const candidates = await updated.listReleaseCandidates('owner', 'repo', 'source');

    expect(candidates.map((candidate) => candidate.version)).toEqual(['2.0.0', '1.0.0']);
    await expect(updated.downloadArchive(candidates[1])).resolves.toEqual(archive);
    await expect(updated.downloadArchive(candidates[0])).resolves.toEqual(archive);
    expect(updated.requestCount).toBe(4);
    expect(updatedHttp.calls.map((call) => call.url)).toEqual([
      firstPageUrl,
      secondPageUrl,
      newRelease.assets[0].url,
      newRelease.assets[1].url
    ]);
  });

  it('follows every Link page and keeps all/latest selection over collected releases', async () => {
    const http = new FakeHttpClient()
      .addRoute({
        url: firstPageUrl,
        status: 200,
        body: JSON.stringify([release('2.0.0')]),
        headers: { link: `<${secondPageUrl}>; rel="next", <${thirdPageUrl}>; rel="last"` }
      })
      .addRoute({
        url: secondPageUrl,
        status: 200,
        body: JSON.stringify([]),
        headers: { link: `<${firstPageUrl}>; rel="prev", <${thirdPageUrl}>; rel="next", <${thirdPageUrl}>; rel="last"` }
      })
      .addRoute({ url: thirdPageUrl, status: 200, body: JSON.stringify([release('1.0.0')]) })
      .addRoute({
        url: 'https://raw.githubusercontent.com/owner/repo/2.0.0/deployment-manifest.json',
        status: 200,
        body: JSON.stringify({ id: 'bundle', version: '2.0.0' })
      })
      .addRoute({
        url: 'https://raw.githubusercontent.com/owner/repo/1.0.0/deployment-manifest.json',
        status: 200,
        body: JSON.stringify({ id: 'bundle', version: '1.0.0' })
      });
    const source = new GitHubReleaseSource(new GitHubApiClient(http));

    const candidates = await source.listReleaseCandidates('owner', 'repo', 'source');
    const request = { sourceId: 'source', bundleId: 'owner-repo-bundle', versions: new Set(['latest']) };

    expect(candidates.map((candidate) => candidate.version)).toEqual(['2.0.0', '1.0.0']);
    expect(selectReplications(candidates, [request], 'all').selected.map((candidate) => candidate.version))
      .toEqual(['1.0.0', '2.0.0']);
    expect(selectReplications(candidates, [request], 'latest').selected.map((candidate) => candidate.version))
      .toEqual(['2.0.0']);
    const pinned = selectReplications(candidates, [{ ...request, versions: new Set(['1.0.0']) }], 'latest');
    expect(pinned.selected.map((candidate) => candidate.version)).toEqual(['1.0.0']);
    expect(pinned.unresolved).toEqual([]);
    expect(source.requestCount).toBe(5);
    expect(http.calls.map((call) => call.url)).toEqual([
      firstPageUrl,
      secondPageUrl,
      thirdPageUrl,
      'https://raw.githubusercontent.com/owner/repo/2.0.0/deployment-manifest.json',
      'https://raw.githubusercontent.com/owner/repo/1.0.0/deployment-manifest.json'
    ]);
  });

  it('counts each page against the request budget and stops before an over-budget request', async () => {
    const http = new FakeHttpClient().addRoute({
      url: firstPageUrl,
      status: 200,
      body: JSON.stringify([]),
      headers: { link: `<${secondPageUrl}>; rel="next"` }
    });
    const source = new GitHubReleaseSource(new GitHubApiClient(http), undefined, 1);

    await expect(source.listReleaseCandidates('owner', 'repo', 'source'))
      .rejects.toThrow('GitHub request budget (1) exhausted');

    expect(source.requestCount).toBe(1);
    expect(http.calls.map((call) => call.url)).toEqual([firstPageUrl]);
  });

  it('refetches every page after a previous run exhausted its budget mid-pagination', async () => {
    const http = new FakeHttpClient()
      .addRoute({ url: firstPageUrl, status: 200, body: JSON.stringify([]), headers: { link: `<${secondPageUrl}>; rel="next"` } })
      .addRoute({ url: secondPageUrl, status: 200, body: JSON.stringify([]) });
    const cache = new MemoryCache();

    await expect(new GitHubReleaseSource(new GitHubApiClient(http), cache, 1).listReleaseCandidates('owner', 'repo', 'source'))
      .rejects.toThrow('GitHub request budget (1) exhausted');
    const resumed = new GitHubReleaseSource(new GitHubApiClient(http), cache, 2);

    await expect(resumed.listReleaseCandidates('owner', 'repo', 'source')).resolves.toEqual([]);
    expect(resumed.requestCount).toBe(2);
    expect(http.calls.map((call) => call.url)).toEqual([firstPageUrl, firstPageUrl, secondPageUrl]);
  });

  it('stops when the Link chain repeats a page instead of looping', async () => {
    const http = new FakeHttpClient()
      .addRoute({ url: firstPageUrl, status: 200, body: JSON.stringify([]), headers: { link: `<${secondPageUrl}>; rel="next"` } })
      .addRoute({ url: secondPageUrl, status: 200, body: JSON.stringify([]), headers: { link: `<${secondPageUrl}>; rel="next"` } });

    await expect(new GitHubReleaseSource(new GitHubApiClient(http)).listReleaseCandidates('owner', 'repo', 'source'))
      .rejects.toThrow('pagination repeated');
    expect(http.calls.map((call) => call.url)).toEqual([firstPageUrl, secondPageUrl]);
  });

  it('treats the next relation case-insensitively and ignores other relations', async () => {
    const http = new FakeHttpClient()
      .addRoute({ url: firstPageUrl, status: 200, body: JSON.stringify([]), headers: { link: `<${thirdPageUrl}>; rel="last", <${secondPageUrl}>; rel=Next` } })
      .addRoute({ url: secondPageUrl, status: 200, body: JSON.stringify([release('1.0.0')]) })
      .addRoute({
        url: 'https://raw.githubusercontent.com/owner/repo/1.0.0/deployment-manifest.json',
        status: 200,
        body: JSON.stringify({ id: 'bundle', version: '1.0.0' })
      });

    const candidates = await new GitHubReleaseSource(new GitHubApiClient(http)).listReleaseCandidates('owner', 'repo', 'source');

    expect(candidates.map((candidate) => candidate.version)).toEqual(['1.0.0']);
    expect(http.calls.map((call) => call.url)).not.toContain(thirdPageUrl);
  });
});
