/* eslint-disable @stylistic/max-len, @stylistic/max-statements-per-line, @typescript-eslint/unbound-method -- focused use-case fixture */
import type {
  ReplicationCandidate,
  ReplicationPublisherPort,
  ReplicationSourcePort,
} from '@ai-primitives-hub/core';
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
  listReleaseCandidates: vi.fn(() => Promise.resolve(candidates)),
  downloadArchive: vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3])))
});

describe('replicateHub', () => {
  it('does not download archives during dry-run and reports unresolved profiles', async () => {
    const source: ReplicationSourcePort = { getHubConfig: vi.fn(async () => ({ sources: [{ id: 's', type: 'github', url: 'https://github.com/owner/repo' }], profiles: [{ id: 'p', bundles: [{ source: 's', id: 'missing', version: 'latest' }] }] })), listReleaseCandidates: vi.fn(async () => [c]), downloadArchive: vi.fn() }; const result = await replicateHub({ sourceHub: 'owner/hub', sourceRef: 'main', targetRoot: 'https://artifactory.invalid/root', mode: 'latest' }, source); expect(source.downloadArchive).not.toHaveBeenCalled(); expect(result.warnings).toContain('Unresolved profile bundle: s:missing');
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
      listReleaseCandidates: vi.fn(() => Promise.resolve([c])),
      downloadArchive: vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3])))
    };

    const result = await replicateHub({ sourceHub: 'owner/hub', sourceRef: 'main', targetRoot: 'https://artifactory.invalid/root/', mode: 'latest', publish: true }, source, publisher);

    expect(published).toEqual([
      'sources/replicated/bundles/owner-repo-bundle/1.0.0/deployment-manifest.yml',
      'sources/replicated/bundles/owner-repo-bundle/1.0.0/owner-repo-bundle-1.0.0.zip',
      'sources/replicated/index-v1.json',
      'hub-config.yml'
    ]);
    expect(result.hubConfig.sources[0].url).toBe('https://artifactory.invalid/root/sources/replicated');
    expect(result.index.bundles[0].manifest.path).toBe('bundles/owner-repo-bundle/1.0.0/deployment-manifest.yml');
  });

  it.each(['deployment-manifest.yml', '.zip'])('omits an unverified %s bundle from emitted metadata and keeps other verified bundles', async (suffix) => {
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
    expect(result.hubConfig.profiles[0].bundles).toEqual([
      { source: 'replicated', id: other.bundleId, version: '2.0.0', required: true },
      { source: 'replicated', id: other.bundleId, version: 'latest', required: true }
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(`${c.bundleId}@${c.version}`);
    expect(result.warnings[0]).toMatch(/unverified/i);
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
