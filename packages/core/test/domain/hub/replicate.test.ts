/* eslint-disable @stylistic/max-len, @stylistic/max-statements-per-line -- focused fixtures */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  type ReplicationCandidate,
  selectReplications,
  stableReplicatedBundleId,
} from '../../../src';

const candidate = (version: string): ReplicationCandidate => ({ sourceId: 'source', repo: 'owner/repo', tag: `v${version}`, publishedAt: '', releaseName: '', manifest: {}, manifestBytes: new Uint8Array([1]), manifestName: 'deployment-manifest.yml', archiveUrl: 'https://example.invalid/a.zip', archiveSize: 3, version, bundleId: 'owner-repo' });
describe('replication domain', () => {
  it('matches stable IDs and selects latest stable over prerelease', () => {
    expect(stableReplicatedBundleId('owner/repo', { id: 'bundle' })).toBe('owner-repo-bundle'); const result = selectReplications([candidate('1.0.0-alpha.1'), candidate('1.0.0'), candidate('2.0.0'), candidate('3.0.0-alpha.1')], [{ sourceId: 'source', bundleId: 'owner-repo', versions: new Set(['latest']) }], 'latest'); expect(result.selected.map((item) => item.version)).toEqual(['2.0.0']);
  });
  it('falls back to the highest prerelease when no stable release exists', () => {
    const result = selectReplications([candidate('2.0.0-rc.1'), candidate('3.0.0-alpha.1')], [{ sourceId: 'source', bundleId: 'owner-repo', versions: new Set(['latest']) }], 'latest'); expect(result.selected.map((item) => item.version)).toEqual(['3.0.0-alpha.1']);
  });
  it('honors an explicit prerelease pin even when stable releases exist', () => {
    const result = selectReplications([candidate('2.0.0'), candidate('3.0.0-alpha.1')], [{ sourceId: 'source', bundleId: 'owner-repo', versions: new Set(['3.0.0-alpha.1']) }], 'latest'); expect(result.selected.map((item) => item.version)).toEqual(['3.0.0-alpha.1']);
  });
  it('selects every release in all mode and reports unresolved requests', () => {
    const result = selectReplications([candidate('1.0.0')], [{ sourceId: 'source', bundleId: 'missing', versions: new Set(['latest']) }], 'latest'); expect(result.unresolved).toEqual(['source:missing']); expect(selectReplications([candidate('1.0.0'), candidate('1.1.0'), candidate('2.0.0-rc.1')], [], 'all').selected).toHaveLength(3);
  });
});
