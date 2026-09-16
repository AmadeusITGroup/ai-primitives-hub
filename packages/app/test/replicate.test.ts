/* eslint-disable @stylistic/max-len, @stylistic/max-statements-per-line, @typescript-eslint/unbound-method -- focused use-case fixture */
import type {
  ReplicationCandidate,
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
describe('replicateHub', () => {
  it('does not download archives during dry-run and reports unresolved profiles', async () => {
    const source: ReplicationSourcePort = { getHubConfig: vi.fn(async () => ({ sources: [{ id: 's', type: 'github', url: 'https://github.com/owner/repo' }], profiles: [{ id: 'p', bundles: [{ source: 's', id: 'missing', version: 'latest' }] }] })), listReleaseCandidates: vi.fn(async () => [c]), downloadArchive: vi.fn() }; const result = await replicateHub({ sourceHub: 'owner/hub', sourceRef: 'main', targetRoot: 'https://artifactory.invalid/root', mode: 'latest' }, source); expect(source.downloadArchive).not.toHaveBeenCalled(); expect(result.warnings).toContain('Unresolved profile bundle: s:missing');
  });
});
