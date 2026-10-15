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
  tag_name: `bundle-v${version}`,
  name: `bundle-v${version}`,
  assets: [
    { name: 'deployment-manifest.yml', url: `https://raw.githubusercontent.com/owner/repo/${version}/deployment-manifest.yml` },
    { name: 'bundle.bundle.zip', url: `https://github.com/owner/repo/releases/download/bundle-v${version}/bundle.bundle.zip`, size: 3 },
    { name: 'release-notes.zip', url: `https://github.com/owner/repo/releases/download/bundle-v${version}/release-notes.zip`, size: 1 }
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
      .addRoute({ url: originalRelease.assets[0].url, status: 200, body: 'id: bundle\nversion: 1.0.0\n' })
      .addRoute({ url: originalRelease.assets[1].url, status: 200, body: archive });
    const initial = new GitHubReleaseSource(new GitHubApiClient(initialHttp), cache);
    const original = (await initial.listReleaseCandidates('owner', 'repo', 'source')).candidates;
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
      .addRoute({ url: newRelease.assets[0].url, status: 200, body: 'id: bundle\nversion: 2.0.0\n' })
      .addRoute({ url: newRelease.assets[1].url, status: 200, body: archive });
    const updated = new GitHubReleaseSource(new GitHubApiClient(updatedHttp), cache, 4);
    const candidates = (await updated.listReleaseCandidates('owner', 'repo', 'source')).candidates;

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

  it('accepts prerelease coordinates and preserves latest fallback and pinned selection', async () => {
    const prerelease = release('1.0.0-alpha.1');
    const http = new FakeHttpClient()
      .addRoute({ url: firstPageUrl, status: 200, body: JSON.stringify([prerelease]) })
      .addRoute({ url: prerelease.assets[0].url, status: 200, body: 'id: bundle\nversion: 1.0.0-alpha.1\n' });
    const source = new GitHubReleaseSource(new GitHubApiClient(http));
    const candidates = (await source.listReleaseCandidates('owner', 'repo', 'source')).candidates;
    const request = { sourceId: 'source', bundleId: 'owner-repo-bundle', versions: new Set(['latest']) };

    expect(candidates.map((candidate) => candidate.version)).toEqual(['1.0.0-alpha.1']);
    expect(selectReplications(candidates, [request], 'latest').selected[0].version).toBe('1.0.0-alpha.1');
    expect(selectReplications(candidates, [{ ...request, versions: new Set(['1.0.0-alpha.1']) }], 'latest').unresolved)
      .toEqual([]);
  });

  it('ignores releases that do not meet the release-name, asset, and manifest coordinate convention', async () => {
    const legacyManifestUrl = 'https://raw.githubusercontent.com/owner/repo/legacy/deployment-manifest.yml';
    const legacyArchiveUrl = 'https://github.com/owner/repo/releases/download/1.0.3/workflow-nevio-1.0.3.zip';
    const wrongArchiveManifestUrl = 'https://raw.githubusercontent.com/owner/repo/wrong-archive/deployment-manifest.yml';
    const wrongArchiveUrl = 'https://github.com/owner/repo/releases/download/workflow-nevio-v1.0.3/workflow-nevio-1.0.3.zip';
    const alternateManifestUrl = 'https://raw.githubusercontent.com/owner/repo/yaml-only/deployment-manifest.yaml';
    const versionMismatchManifestUrl = 'https://raw.githubusercontent.com/owner/repo/version-mismatch/deployment-manifest.yml';
    const mismatchedManifestUrl = 'https://raw.githubusercontent.com/owner/repo/task-driven/deployment-manifest.yml';
    const mismatchedArchiveUrl = 'https://github.com/owner/repo/releases/download/task-driven-agents-v1.0.3/task-driven-agents.bundle.zip';
    const http = new FakeHttpClient()
      .addRoute({
        url: firstPageUrl,
        status: 200,
        body: JSON.stringify([
          { tag_name: '1.0.3', name: '1.0.3', assets: [
            { name: 'deployment-manifest.yml', url: legacyManifestUrl },
            { name: 'workflow-nevio-1.0.3.zip', url: legacyArchiveUrl, size: 5 }
          ] },
          { tag_name: 'workflow-nevio-v1.0.3', name: 'workflow-nevio-v1.0.3', assets: [
            { name: 'deployment-manifest.yml', url: wrongArchiveManifestUrl },
            { name: 'workflow-nevio-1.0.3.zip', url: wrongArchiveUrl, size: 5 }
          ] },
          { tag_name: 'yaml-only-v1.0.3', name: 'yaml-only-v1.0.3', assets: [
            { name: 'deployment-manifest.yaml', url: alternateManifestUrl },
            { name: 'yaml-only.bundle.zip', url: 'https://github.com/owner/repo/releases/download/yaml-only-v1.0.3/yaml-only.bundle.zip', size: 8 }
          ] },
          { tag_name: 'task-driven-agents-v1.0.3', name: 'task-driven-agents-v1.0.3', assets: [
            { name: 'deployment-manifest.yml', url: mismatchedManifestUrl },
            { name: 'task-driven-agents.bundle.zip', url: mismatchedArchiveUrl, size: 10 }
          ] },
          { tag_name: 'version-mismatch-v1.0.3', name: 'version-mismatch-v1.0.3', assets: [
            { name: 'deployment-manifest.yml', url: versionMismatchManifestUrl },
            { name: 'version-mismatch.bundle.zip', url: 'https://github.com/owner/repo/releases/download/version-mismatch-v1.0.3/version-mismatch.bundle.zip', size: 10 }
          ] }
        ])
      })
      .addRoute({ url: legacyManifestUrl, status: 200, body: `id: workflow-nevio
version: 1.0.3
` })
      .addRoute({ url: wrongArchiveManifestUrl, status: 200, body: `id: workflow-nevio
version: 1.0.3
` })
      .addRoute({ url: mismatchedManifestUrl, status: 200, body: `id: workflow-nevio
version: 1.0.3
` })
      .addRoute({ url: versionMismatchManifestUrl, status: 200, body: `id: version-mismatch
version: 1.0.2
` });

    const discovery = await new GitHubReleaseSource(new GitHubApiClient(http)).listReleaseCandidates('owner', 'repo', 'source');
    expect(discovery.candidates).toEqual([]);
    expect(discovery.warnings).toHaveLength(5);
    expect(discovery.warnings.join('\n')).toContain('release name must match <collectionid>-vX.Y.Z');
    expect(discovery.warnings.join('\n')).toContain('expected one workflow-nevio.bundle.zip');
    expect(discovery.warnings.join('\n')).toContain('expected one deployment-manifest.yml');
    expect(discovery.warnings.join('\n')).toContain('manifest id/version "workflow-nevio"@"1.0.3" must match task-driven-agents@1.0.3');
    expect(discovery.warnings.join('\n')).toContain('manifest id/version "version-mismatch"@"1.0.2" must match version-mismatch@1.0.3');
    expect(http.calls.map((call) => call.url)).toEqual([firstPageUrl, mismatchedManifestUrl, versionMismatchManifestUrl]);
  });

  it.each([404, 410])('warns and excludes a release when its manifest asset returns HTTP %i', async (status) => {
    const validRelease = release('1.0.0');
    const http = new FakeHttpClient()
      .addRoute({ url: firstPageUrl, status: 200, body: JSON.stringify([validRelease]) })
      .addRoute({ url: validRelease.assets[0].url, status, body: 'not found' });

    const discovery = await new GitHubReleaseSource(new GitHubApiClient(http)).listReleaseCandidates('owner', 'repo', 'source');

    expect(discovery.candidates).toEqual([]);
    expect(discovery.warnings[0]).toContain('deployment-manifest.yml download failed');
    expect(discovery.warnings[0]).toContain(`GitHub API error: ${String(status)}`);
  });

  it('stops release discovery when a manifest asset fails for a reason other than a missing asset', async () => {
    const validRelease = release('1.0.0');
    const http = new FakeHttpClient()
      .addRoute({ url: firstPageUrl, status: 200, body: JSON.stringify([validRelease]) })
      .addRoute({ url: validRelease.assets[0].url, status: 403, body: 'forbidden' });

    await expect(new GitHubReleaseSource(new GitHubApiClient(http)).listReleaseCandidates('owner', 'repo', 'source'))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it('keeps manifest request-budget exhaustion fatal', async () => {
    const validRelease = release('1.0.0');
    const http = new FakeHttpClient().addRoute({ url: firstPageUrl, status: 200, body: JSON.stringify([validRelease]) });
    const source = new GitHubReleaseSource(new GitHubApiClient(http), undefined, 1);

    await expect(source.listReleaseCandidates('owner', 'repo', 'source'))
      .rejects.toMatchObject({
        name: 'GitHubRequestBudgetError',
        budget: 1,
        message: 'GitHub request budget (1) exhausted; rerun with the same cache directory.'
      });
  });

  it('follows every Link page and keeps all/latest selection over collected releases', async () => {
    const newerRelease = release('2.0.0');
    const olderRelease = release('1.0.0');
    const http = new FakeHttpClient()
      .addRoute({
        url: firstPageUrl,
        status: 200,
        body: JSON.stringify([newerRelease]),
        headers: { link: `<${secondPageUrl}>; rel="next", <${thirdPageUrl}>; rel="last"` }
      })
      .addRoute({
        url: secondPageUrl,
        status: 200,
        body: JSON.stringify([]),
        headers: { link: `<${firstPageUrl}>; rel="prev", <${thirdPageUrl}>; rel="next", <${thirdPageUrl}>; rel="last"` }
      })
      .addRoute({ url: thirdPageUrl, status: 200, body: JSON.stringify([olderRelease]) })
      .addRoute({
        url: newerRelease.assets[0].url,
        status: 200,
        body: 'id: bundle\nversion: 2.0.0\n'
      })
      .addRoute({
        url: release('1.0.0').assets[0].url,
        status: 200,
        body: 'id: bundle\nversion: 1.0.0\n'
      });
    const source = new GitHubReleaseSource(new GitHubApiClient(http));

    const candidates = (await source.listReleaseCandidates('owner', 'repo', 'source')).candidates;
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
      newerRelease.assets[0].url,
      olderRelease.assets[0].url
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
      .rejects.toMatchObject({
        name: 'GitHubRequestBudgetError',
        budget: 1,
        message: 'GitHub request budget (1) exhausted; rerun with the same cache directory.'
      });

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

    await expect(resumed.listReleaseCandidates('owner', 'repo', 'source')).resolves.toEqual({ candidates: [], warnings: [] });
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
        url: release('1.0.0').assets[0].url,
        status: 200,
        body: 'id: bundle\nversion: 1.0.0\n'
      });

    const candidates = (await new GitHubReleaseSource(new GitHubApiClient(http)).listReleaseCandidates('owner', 'repo', 'source')).candidates;

    expect(candidates.map((candidate) => candidate.version)).toEqual(['1.0.0']);
    expect(http.calls.map((call) => call.url)).not.toContain(thirdPageUrl);
  });
});
