/* eslint-disable @stylistic/max-len, @stylistic/max-statements-per-line, @typescript-eslint/unbound-method -- focused use-case fixture */
import {
  createHash,
} from 'node:crypto';
import type {
  HttpClient,
  HttpRequest,
  ReplicationCandidate,
  ReplicationPublisherPort,
  ReplicationSourcePort,
} from '@ai-primitives-hub/core';
import {
  validateArtifactorySourceIndex,
} from '@ai-primitives-hub/core';
import {
  AnonymousCredentialProvider,
  ArtifactoryReplicationPublisher,
} from '@ai-primitives-hub/infra';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  replicateHub,
} from '../src';

const c: ReplicationCandidate = { sourceId: 's', repo: 'owner/repo', tag: 'v1.0.0', publishedAt: '', releaseName: 'One', manifest: { id: 'bundle', version: '1.0.0' }, manifestBytes: new Uint8Array([1]), manifestName: 'deployment-manifest.yml', archiveUrl: 'https://example.invalid/a.zip', archiveSize: 10, version: '1.0.0', bundleId: 'owner-repo-bundle' };
const sourceFor = (candidates: ReplicationCandidate[]): ReplicationSourcePort => ({
  getHubConfig: vi.fn(() => Promise.resolve({
    version: '1.0.0',
    sources: [{ id: 's', type: 'github', url: 'https://github.com/owner/repo' }],
    profiles: [{
      id: 'p',
      bundles: candidates.flatMap((item) => [
        { source: item.sourceId, id: item.bundleId, version: item.version, required: true },
        { source: item.sourceId, id: item.bundleId, version: 'latest', required: true }
      ])
    }]
  })),
  listReleaseCandidates: vi.fn(() => Promise.resolve({ candidates, warnings: [] })),
  downloadArchive: vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3])))
});

describe('replicateHub', () => {
  it('stops before publishing pointers when an immutable catalog generation is unverified', async () => {
    const publisher: ReplicationPublisherPort = { publish: vi.fn((path: string) => Promise.resolve(path.includes('/indexes/') ? 'skipped-unverified' as const : 'uploaded' as const)) };
    await expect(replicateHub({ sourceHub: 'owner/hub', sourceRef: 'main', targetRoot: 'https://artifactory.invalid/root', mode: 'latest', publish: true }, sourceFor([c]), publisher)).rejects.toThrow(/Unverified existing catalog generation/);
    expect(publisher.publish).not.toHaveBeenCalledWith('hub-config.yml', expect.anything(), expect.anything(), expect.anything());
  });

  it('binds the published hub to its own immutable catalog generation across interleaved runs', async () => {
    const published = new Map<string, Uint8Array>();
    const options = { sourceHub: 'owner/hub', sourceRef: 'main', targetRoot: 'https://artifactory.invalid/root', mode: 'latest' as const, publish: true };
    const other = { ...c, version: '2.0.0', tag: 'v2.0.0', manifest: { id: 'bundle', version: '2.0.0' } };
    let interleaved = false;
    const publisher: ReplicationPublisherPort = {
      publish: async (path, data) => {
        published.set(path, data);
        if (path === 'sources/replicated/index-v1.json' && !interleaved) {
          interleaved = true;
          await replicateHub(options, sourceFor([other]), publisher);
        }
        return 'uploaded';
      }
    };
    await replicateHub(options, sourceFor([c]), publisher);
    const hub = JSON.parse(new TextDecoder().decode(published.get('hub-config.yml')));
    const catalog = JSON.parse(new TextDecoder().decode(published.get(`sources/replicated/${hub.sources[0].config.indexFile}`)));
    expect(catalog.bundles.map((bundle: { version: string }) => bundle.version)).toEqual([c.version]);
    expect(hub.profiles[0].bundles[0].version).toBe(c.version);
    expect(hub.sources[0].config.indexFile).toMatch(/^indexes\/[a-f0-9]{64}\/index-v1.json$/);
  });

  it('refreshes a stateful target for new releases and timestamps while retaining immutable objects and write ordering', async () => {
    const objects = new Map<string, Uint8Array>();
    const requests: HttpRequest[] = [];
    const hash = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
    let rejectIndex = false;
    const http: HttpClient = {
      fetch: (request) => {
        requests.push(request);
        const existing = objects.get(request.url);
        const etag = existing ? `"${hash(existing)}"` : undefined;
        if (request.method === 'HEAD') {
          const headers: Record<string, string> = existing ? { etag: etag!, 'x-checksum-sha256': hash(existing) } : {};
          return Promise.resolve({ statusCode: existing ? 200 : 404, headers, body: new Uint8Array(), finalUrl: request.url });
        }
        const rejected = (request.headers?.['If-None-Match'] === '*' && existing !== undefined)
          || (request.headers?.['If-Match'] !== undefined && request.headers['If-Match'] !== etag)
          || (rejectIndex && request.url.endsWith('/index-v1.json'));
        if (!rejected) {
          objects.set(request.url, request.body as Uint8Array);
        }
        return Promise.resolve({ statusCode: rejected ? 412 : 201, headers: {}, body: new Uint8Array(), finalUrl: request.url });
      }
    };
    const targetRoot = 'https://artifactory.invalid/root';
    const publisher = new ArtifactoryReplicationPublisher(http, new AnonymousCredentialProvider(), targetRoot);
    const options = { sourceHub: 'owner/hub', sourceRef: 'main', targetRoot, mode: 'latest' as const, publish: true };
    await replicateHub(options, sourceFor([c]), publisher);
    const originalArchive = objects.get(`${targetRoot}/sources/replicated/bundles/${c.bundleId}/${c.version}/${c.bundleId}-${c.version}.zip`);
    const next = { ...c, version: '2.0.0', tag: 'v2.0.0', manifest: { id: 'bundle', version: '2.0.0' }, manifestBytes: new TextEncoder().encode('id: bundle\nversion: 2.0.0\n') };
    requests.length = 0;
    const refreshed = await replicateHub(options, sourceFor([next]), publisher);
    expect(JSON.parse(new TextDecoder().decode(objects.get(`${targetRoot}/sources/replicated/index-v1.json`)))).toEqual(refreshed.index);
    expect(JSON.parse(new TextDecoder().decode(objects.get(`${targetRoot}/hub-config.yml`)))).toEqual(refreshed.hubConfig);
    expect(objects.get(`${targetRoot}/sources/replicated/bundles/${c.bundleId}/${c.version}/${c.bundleId}-${c.version}.zip`)).toBe(originalArchive);
    expect(requests.filter((request) => request.method === 'PUT').map((request) => request.url)).toEqual([
      `${targetRoot}/sources/replicated/bundles/${c.bundleId}/2.0.0/deployment-manifest.yml`,
      `${targetRoot}/sources/replicated/bundles/${c.bundleId}/2.0.0/${c.bundleId}-2.0.0.zip`,
      expect.stringMatching(/^https:\/\/artifactory.invalid\/root\/sources\/replicated\/indexes\/[a-f0-9]{64}\/index-v1.json$/),
      `${targetRoot}/sources/replicated/index-v1.json`, `${targetRoot}/hub-config.yml`
    ]);
    await new Promise((resolve) => setTimeout(resolve, 2));
    requests.length = 0;
    await replicateHub(options, sourceFor([next]), publisher);
    expect(requests.filter((request) => request.method === 'PUT').every((request) => request.url.endsWith('/index-v1.json') || request.url.endsWith('/hub-config.yml'))).toBe(true);
    expect(requests.filter((request) => request.method === 'PUT')).toHaveLength(3);
    rejectIndex = true;
    requests.length = 0;
    const oldHub = objects.get(`${targetRoot}/hub-config.yml`);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await expect(replicateHub(options, sourceFor([next]), publisher)).rejects.toThrow(/412/);
    expect(objects.get(`${targetRoot}/hub-config.yml`)).toBe(oldHub);
    expect(requests.some((request) => request.method === 'PUT' && request.url.endsWith('/hub-config.yml'))).toBe(false);
  });

  it.each(['latest', 'all'] as const)('preserves every pinned/latest source alias with one verified publication in %s mode', async (mode) => {
    const aliases = ['a', 'b'];
    const source: ReplicationSourcePort = {
      getHubConfig: vi.fn(() => Promise.resolve({ version: '1.0.0', sources: aliases.map((id) => ({ id, type: 'github', url: 'https://github.com/owner/repo' })), profiles: aliases.map((id) => ({ id, bundles: [c.version, 'latest'].map((version) => ({ source: id, id: c.bundleId, version, required: true })) })) })),
      listReleaseCandidates: vi.fn((_owner, _repo, sourceId) => Promise.resolve({ candidates: [{ ...c, sourceId }], warnings: [] })),
      downloadArchive: vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3])))
    };
    const publisher: ReplicationPublisherPort = { publish: vi.fn(() => Promise.resolve('uploaded' as const)) };
    const result = await replicateHub({ sourceHub: 'owner/hub', sourceRef: 'main', targetRoot: 'https://artifactory.invalid/root', mode, publish: true }, source, publisher);
    expect(result.index.bundles).toHaveLength(1);
    expect(validateArtifactorySourceIndex(result.index).valid).toBe(true);
    expect(result.hubConfig.profiles.map((profile) => profile.bundles)).toEqual(aliases.map(() => [c.version, 'latest'].map((version) => ({ source: 'replicated', id: c.bundleId, version, required: true }))));
    expect(result.warnings).toEqual([]);
    expect(source.downloadArchive).toHaveBeenCalledTimes(1);
    expect(publisher.publish).toHaveBeenCalledTimes(5);

    const unverifiedPublisher: ReplicationPublisherPort = { publish: vi.fn((path: string) => Promise.resolve(path.endsWith('.zip') ? 'skipped-unverified' as const : 'uploaded' as const)) };
    const unverified = await replicateHub({ sourceHub: 'owner/hub', sourceRef: 'main', targetRoot: 'https://artifactory.invalid/root', mode, publish: true }, source, unverifiedPublisher);
    expect(unverified.index.bundles).toEqual([]);
    expect(unverified.hubConfig.profiles).toEqual([]);
    expect(unverified.warnings).toHaveLength(3);
    expect(unverified.warnings[0]).toContain(`${c.bundleId}@${c.version}`);
    expect(unverified.warnings[0]).toMatch(/unverified/i);
    expect(unverified.warnings.slice(1).every((warning) => warning.includes('Excluded profile'))).toBe(true);
  });

  it('does not download archives during dry-run and reports unresolved profiles', async () => {
    const source: ReplicationSourcePort = { getHubConfig: vi.fn(async () => ({ sources: [{ id: 's', type: 'github', url: 'https://github.com/owner/repo' }], profiles: [{ id: 'p', bundles: [{ source: 's', id: 'missing', version: 'latest' }] }] })), listReleaseCandidates: vi.fn(async () => ({ candidates: [c], warnings: [] })), downloadArchive: vi.fn() }; const result = await replicateHub({ sourceHub: 'owner/hub', sourceRef: 'main', targetRoot: 'https://artifactory.invalid/root', mode: 'latest' }, source); expect(source.downloadArchive).not.toHaveBeenCalled(); expect(result.warnings).toContain('Excluded profile "p": s:missing@latest has no compliant release candidate.');
  });

  it('reports excluded releases and excludes an entire profile with unresolved bundle references', async () => {
    const releaseWarning = 'Excluded GitHub release owner/repo#tag="1.0.3" name="1.0.3": release name must match <collectionid>-vX.Y.Z.';
    const source: ReplicationSourcePort = {
      getHubConfig: vi.fn(() => Promise.resolve({
        version: '1.0.0',
        sources: [{ id: 's', type: 'github', url: 'https://github.com/owner/repo' }],
        profiles: [
          { id: 'ready', bundles: [{ source: 's', id: c.bundleId, version: 'latest', required: true }] },
          { id: 'broken', bundles: [
            { source: 's', id: c.bundleId, version: 'latest', required: true },
            { source: 's', id: 'missing-bundle', version: '1.0.0', required: true }
          ] }
        ]
      })),
      listReleaseCandidates: vi.fn(() => Promise.resolve({ candidates: [c], warnings: [releaseWarning] })),
      downloadArchive: vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3])))
    };
    const publisher: ReplicationPublisherPort = { publish: vi.fn(() => Promise.resolve('uploaded' as const)) };

    const result = await replicateHub({ sourceHub: 'owner/hub', sourceRef: 'main', targetRoot: 'https://artifactory.invalid/root', mode: 'latest', publish: true }, source, publisher);

    expect(result.warnings).toEqual([
      releaseWarning,
      'Excluded profile "broken": s:missing-bundle@1.0.0 has no compliant release candidate.'
    ]);
    expect(result.hubConfig.profiles.map((profile) => profile.id)).toEqual(['ready']);
    expect(result.hubConfig.profiles[0].bundles).toEqual([{ source: 'replicated', id: c.bundleId, version: 'latest', required: true }]);
  });

  it('publishes the objects and index under the replicated source path and the hub config at the publisher root', async () => {
    const published: string[] = [];
    const publisher: ReplicationPublisherPort = {
      publish: vi.fn((path: string) => {
        published.push(path);
        return Promise.resolve('uploaded' as const);
      })
    };
    const source: ReplicationSourcePort = {
      getHubConfig: vi.fn(() => Promise.resolve({ sources: [{ id: 's', type: 'github', url: 'https://github.com/owner/repo' }], profiles: [{ id: 'p', bundles: [{ source: 's', id: 'owner-repo-bundle', version: 'latest' }] }] })),
      listReleaseCandidates: vi.fn(() => Promise.resolve({ candidates: [c], warnings: [] })),
      downloadArchive: vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3])))
    };

    const result = await replicateHub({ sourceHub: 'owner/hub', sourceRef: 'main', targetRoot: 'https://artifactory.invalid/root/', mode: 'latest', publish: true }, source, publisher);

    expect(published).toEqual([
      'sources/replicated/bundles/owner-repo-bundle/1.0.0/deployment-manifest.yml',
      'sources/replicated/bundles/owner-repo-bundle/1.0.0/owner-repo-bundle-1.0.0.zip',
      expect.stringMatching(/^sources\/replicated\/indexes\/[a-f0-9]{64}\/index-v1.json$/),
      'sources/replicated/index-v1.json',
      'hub-config.yml'
    ]);
    expect(result.hubConfig.sources[0].url).toBe('https://artifactory.invalid/root/sources/replicated');
    expect(result.index.bundles[0].manifest.path).toBe('bundles/owner-repo-bundle/1.0.0/deployment-manifest.yml');
  });

  it.each(['deployment-manifest.yml', '.zip'])('omits an unverified %s bundle and excludes profiles that reference it', async (suffix) => {
    const other: ReplicationCandidate = {
      ...c,
      bundleId: 'owner-repo-other',
      version: '2.0.0',
      manifest: { id: 'other', version: '2.0.0' }
    };
    const uploads = new Map<string, Uint8Array>();
    const publisher: ReplicationPublisherPort = {
      publish: vi.fn((path: string, data: Uint8Array) => {
        const unverified = path.includes(`/${c.bundleId}/`) && path.endsWith(suffix);
        if (!unverified) {
          uploads.set(path, data);
        }
        return Promise.resolve(unverified ? 'skipped-unverified' as const : 'uploaded' as const);
      })
    };

    const result = await replicateHub({
      sourceHub: 'owner/hub', sourceRef: 'main', targetRoot: 'https://artifactory.invalid/root', mode: 'all', publish: true
    }, sourceFor([c, other]), publisher);

    expect(result.index.bundles.map((bundle) => bundle.id)).toEqual([other.bundleId]);
    expect(result.hubConfig.profiles).toEqual([]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain(`${c.bundleId}@${c.version}`);
    expect(result.warnings[0]).toMatch(/unverified/i);
    expect(result.warnings[1]).toContain('Excluded profile "p"');
    expect(result.warnings[1]).toContain(`${c.bundleId}@${c.version}`);
    if (suffix === 'deployment-manifest.yml') {
      expect(publisher.publish).not.toHaveBeenCalledWith(
        `sources/replicated/bundles/${c.bundleId}/${c.version}/${c.bundleId}-${c.version}.zip`, expect.anything(), 'application/zip'
      );
    }
    expect(JSON.parse(new TextDecoder().decode(uploads.get('sources/replicated/index-v1.json')))).toEqual(result.index);
    expect(JSON.parse(new TextDecoder().decode(uploads.get('hub-config.yml')))).toEqual(result.hubConfig);
  });

  it.each(['uploaded', 'skipped-existing'] as const)('keeps %s bundles in the index and both pinned and latest profile references', async (status) => {
    const publisher: ReplicationPublisherPort = {
      publish: vi.fn(() => Promise.resolve(status))
    };

    const result = await replicateHub({
      sourceHub: 'owner/hub', sourceRef: 'main', targetRoot: 'https://artifactory.invalid/root', mode: 'latest', publish: true
    }, sourceFor([c]), publisher);

    expect(result.index.bundles.map((bundle) => bundle.id)).toEqual([c.bundleId]);
    expect(result.hubConfig.profiles[0].bundles).toEqual([
      { source: 'replicated', id: c.bundleId, version: c.version, required: true },
      { source: 'replicated', id: c.bundleId, version: 'latest', required: true }
    ]);
    expect(result.warnings).toEqual([]);
  });

  it.each(['sources/replicated/index-v1.json', 'hub-config.yml'])('fails closed if metadata at %s is skipped unverified', async (unverifiedPath) => {
    const uploads = new Map<string, Uint8Array>();
    const publisher: ReplicationPublisherPort = {
      publish: vi.fn((path: string, data: Uint8Array) => {
        if (path === unverifiedPath) {
          return Promise.resolve('skipped-unverified' as const);
        }
        uploads.set(path, data);
        return Promise.resolve('uploaded' as const);
      })
    };

    await expect(replicateHub({
      sourceHub: 'owner/hub', sourceRef: 'main', targetRoot: 'https://artifactory.invalid/root', mode: 'latest', publish: true
    }, sourceFor([c]), publisher)).rejects.toThrow(`Unverified existing metadata at ${unverifiedPath}`);
    expect(uploads.has('hub-config.yml')).toBe(false);
  });
});
