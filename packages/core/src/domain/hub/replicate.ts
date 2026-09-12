/* eslint-disable @stylistic/max-len, @stylistic/max-statements-per-line, unicorn/no-array-sort, @typescript-eslint/no-base-to-string -- compact domain contract helpers */
import * as semver from 'semver';
import type {
  ArtifactoryBundleIndexEntry,
  ArtifactorySourceIndex,
} from '../source/artifactory-source-index';
import type {
  HubConfig,
} from './types';

export interface ReplicationCandidate {
  sourceId: string; repo: string; tag: string; publishedAt: string; releaseName: string;
  manifest: Record<string, unknown>; manifestBytes: Uint8Array; manifestName: string;
  archiveUrl: string; archiveSize: number; version: string; bundleId: string;
}
export interface ReplicationRequest { sourceId: string; bundleId: string; versions: Set<string> }
export interface ReplicationSelection { selected: ReplicationCandidate[]; unresolved: string[] }
export interface ReplicationResult { index: ArtifactorySourceIndex; hubConfig: HubConfig; warnings: string[]; selected: ReplicationCandidate[] }
export interface ReplicationSourcePort {
  getHubConfig(ownerRepo: string, ref: string): Promise<Record<string, unknown>>;
  listReleaseCandidates(owner: string, repo: string, sourceId: string): Promise<ReplicationCandidate[]>;
  downloadArchive(candidate: ReplicationCandidate): Promise<Uint8Array>;
}
export interface ReplicationPublisherPort {
  publish(path: string, data: Uint8Array, mediaType: string): Promise<'uploaded' | 'skipped-existing' | 'skipped-unverified'>;
}

export const stableReplicatedBundleId = (repo: string, manifest: Record<string, unknown>): string => {
  const [owner, name] = repo.split('/', 2);
  const id = typeof manifest.id === 'string' && manifest.id.length > 0 ? `-${manifest.id}` : '';
  return `${owner}-${name}${id}`;
};
export const normalizedReleaseVersion = (manifest: Record<string, unknown>, tag: string): string | undefined => {
  const values = [manifest.version, tag.replace(/^v/, '')];
  for (const value of values) {
    if (typeof value === 'string' && semver.valid(value)) {
      return semver.clean(value) ?? undefined;
    }
  }
  return undefined;
};
export const selectReplications = (candidates: ReplicationCandidate[], requests: ReplicationRequest[], mode: 'latest' | 'all'): ReplicationSelection => {
  if (mode === 'all') {
    const available = new Set(candidates.map((candidate) => `${candidate.sourceId}\0${candidate.bundleId}`));
    return { selected: deduplicate(candidates), unresolved: requests.filter((request) => !available.has(`${request.sourceId}\0${request.bundleId}`)).map((request) => `${request.sourceId}:${request.bundleId}`) };
  }
  const byKey = new Map<string, ReplicationCandidate[]>();
  for (const candidate of candidates) {
    byKey.set(`${candidate.sourceId}\0${candidate.bundleId}`, [...(byKey.get(`${candidate.sourceId}\0${candidate.bundleId}`) ?? []), candidate]);
  }
  const selected: ReplicationCandidate[] = []; const unresolved: string[] = [];
  for (const request of requests) {
    const options = byKey.get(`${request.sourceId}\0${request.bundleId}`) ?? [];
    const explicit = [...request.versions].filter((version) => version !== 'latest');
    const matches = explicit.length > 0 ? options.filter((candidate) => explicit.includes(candidate.version)) : options;
    if (matches.length === 0) {
      unresolved.push(`${request.sourceId}:${request.bundleId}`); continue;
    }
    if (explicit.length > 0) {
      selected.push(...matches);
    } else {
      selected.push([...matches].sort((a, b) => semver.rcompare(a.version, b.version))[0]);
    }
  }
  return { selected: deduplicate(selected), unresolved };
};
const deduplicate = (items: ReplicationCandidate[]): ReplicationCandidate[] => [...new Map(items.map((item) => [`${item.bundleId}\0${item.version}`, item])).values()].sort((a, b) => a.bundleId.localeCompare(b.bundleId) || semver.compare(a.version, b.version));

export const requestsFromHubConfig = (hub: Record<string, unknown>): ReplicationRequest[] => {
  const sources = new Set((Array.isArray(hub.sources) ? hub.sources : []).filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && s.enabled !== false && s.type === 'github' && typeof s.id === 'string').map((s) => s.id as string));
  const requests = new Map<string, ReplicationRequest>();
  for (const profile of Array.isArray(hub.profiles) ? hub.profiles : []) {
    if (!profile || typeof profile !== 'object') {
      continue;
    }
    const bundles = (profile as Record<string, unknown>).bundles;
    for (const bundle of (Array.isArray(bundles) ? bundles : []) as unknown[]) {
      if (!bundle || typeof bundle !== 'object') {
        continue;
      }
      const item = bundle as Record<string, unknown>; const sourceId = String(item.source ?? ''); const bundleId = String(item.id ?? '');
      if (!sources.has(sourceId) || !bundleId) {
        continue;
      }
      const key = `${sourceId}\0${bundleId}`; const request = requests.get(key) ?? { sourceId, bundleId, versions: new Set<string>() };
      request.versions.add(String(item.version ?? 'latest')); requests.set(key, request);
    }
  }
  return [...requests.values()];
};

export const makeReplicatedEntry = (candidate: ReplicationCandidate, manifestPath: string, archivePath: string, archive: Uint8Array, sha256: (data: Uint8Array) => string): ArtifactoryBundleIndexEntry => {
  const m = candidate.manifest; const text = (key: string, fallback: string) => typeof m[key] === 'string' ? m[key] : fallback;
  return { id: candidate.bundleId, version: candidate.version, name: text('name', candidate.releaseName || candidate.bundleId), description: text('description', candidate.releaseName), author: text('author', 'GitHub release publisher'), environments: Array.isArray(m.environments) ? m.environments as string[] : ['vscode'], tags: Array.isArray(m.tags) ? m.tags as string[] : [], lastUpdated: candidate.publishedAt || '1970-01-01T00:00:00Z', dependencies: Array.isArray(m.dependencies) ? m.dependencies as never[] : [], license: text('license', 'UNLICENSED'), manifest: { path: manifestPath, size: candidate.manifestBytes.byteLength, sha256: sha256(candidate.manifestBytes), mediaType: 'application/yaml' }, archive: { path: archivePath, size: archive.byteLength, sha256: sha256(archive), mediaType: 'application/zip' }, canonicalSource: `https://github.com/${candidate.repo}`, revision: candidate.tag };
};
