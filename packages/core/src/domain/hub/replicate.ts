/* eslint-disable @stylistic/max-len, @stylistic/max-statements-per-line, unicorn/no-array-sort, @typescript-eslint/no-base-to-string -- compact domain contract helpers */
import * as semver from 'semver';
import {
  RegistryError,
} from '../registry-error';
import type {
  ArtifactoryBundleIndexEntry,
  ArtifactorySourceIndex,
} from '../source/artifactory-source-index';
import type {
  HubConfig,
} from './types';

export interface ReplicationCandidate {
  sourceId: string; sourceIds?: string[]; repo: string; tag: string; publishedAt: string; releaseName: string;
  manifest: Record<string, unknown>; manifestBytes: Uint8Array; manifestName: string;
  archiveUrl: string; archiveSize: number; version: string; bundleId: string;
}
export interface ReplicationRequest { sourceId: string; bundleId: string; versions: Set<string> }
export interface ReplicationSelection { selected: ReplicationCandidate[]; unresolved: string[] }
export interface ReplicationCandidateDiscovery { candidates: ReplicationCandidate[]; warnings: string[] }
export interface ReplicationResult { index: ArtifactorySourceIndex; hubConfig: HubConfig; warnings: string[]; selected: ReplicationCandidate[] }
export interface ReplicationSourcePort {
  getHubConfig(ownerRepo: string, ref: string): Promise<Record<string, unknown>>;
  listReleaseCandidates(owner: string, repo: string, sourceId: string): Promise<ReplicationCandidateDiscovery>;
  downloadArchive(candidate: ReplicationCandidate): Promise<Uint8Array>;
}
export interface ReplicationPublishOptions { replaceExisting?: boolean }
export interface ReplicationPublisherPort {
  publish(path: string, data: Uint8Array, mediaType: string, options?: ReplicationPublishOptions): Promise<'uploaded' | 'skipped-existing' | 'skipped-unverified'>;
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
    const allModeUnresolved = requests.filter((request) => {
      const options = candidates.filter((candidate) => candidate.sourceId === request.sourceId && candidate.bundleId === request.bundleId);
      const explicit = [...request.versions].filter((version) => version !== 'latest');
      return (request.versions.has('latest') && options.length === 0) || explicit.some((version) => !options.some((candidate) => candidate.version === version));
    }).map((request) => `${request.sourceId}:${request.bundleId}`);
    return { selected: deduplicate(candidates), unresolved: allModeUnresolved };
  }
  const byKey = new Map<string, ReplicationCandidate[]>();
  for (const candidate of candidates) {
    byKey.set(`${candidate.sourceId}\0${candidate.bundleId}`, [...(byKey.get(`${candidate.sourceId}\0${candidate.bundleId}`) ?? []), candidate]);
  }
  const selected: ReplicationCandidate[] = []; const unresolved: string[] = [];
  for (const request of requests) {
    const options = byKey.get(`${request.sourceId}\0${request.bundleId}`) ?? [];
    const explicit = [...request.versions].filter((version) => version !== 'latest');
    const explicitMatches = options.filter((candidate) => explicit.includes(candidate.version));
    const missingExplicit = explicit.some((version) => !options.some((candidate) => candidate.version === version));
    selected.push(...explicitMatches);
    let latest: ReplicationCandidate | undefined;
    if (request.versions.has('latest')) {
      const stable = options.filter((candidate) => semver.prerelease(candidate.version) === null);
      const pool = stable.length > 0 ? stable : options;
      latest = [...pool].sort((a, b) => semver.rcompare(a.version, b.version))[0];
      if (latest) {
        selected.push(latest);
      }
    }
    if (missingExplicit || (explicit.length === 0 && !latest)) {
      unresolved.push(`${request.sourceId}:${request.bundleId}`);
    }
  }
  return { selected: deduplicate(selected), unresolved };
};
const deduplicate = (items: ReplicationCandidate[]): ReplicationCandidate[] => {
  const unique = new Map<string, ReplicationCandidate>();
  for (const item of items) {
    const key = `${item.bundleId}\0${item.version}`;
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, { ...item, sourceIds: [item.sourceId] });
      continue;
    }
    if (existing.repo !== item.repo || existing.tag !== item.tag || existing.archiveUrl !== item.archiveUrl
      || existing.archiveSize !== item.archiveSize || existing.manifestName !== item.manifestName
      || existing.manifestBytes.length !== item.manifestBytes.length
      || !existing.manifestBytes.every((byte, index) => byte === item.manifestBytes[index])) {
      throw new RegistryError({ code: 'HUB.REPLICATION_CONFLICT', message: `Conflicting replication candidates for ${item.bundleId}@${item.version}. Check the source releases before retrying.` });
    }
    existing.sourceIds = [...new Set([...(existing.sourceIds ?? [existing.sourceId]), item.sourceId])];
  }
  return [...unique.values()].sort((a, b) => a.bundleId.localeCompare(b.bundleId) || semver.compare(a.version, b.version));
};

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

export interface ReplicationProfileResolution { profiles: Record<string, unknown>[]; warnings: string[] }
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const resolveReplicatedProfiles = (hub: Record<string, unknown>, candidates: ReplicationCandidate[], selectedCandidates: ReplicationCandidate[] = candidates): ReplicationProfileResolution => {
  const warnings: string[] = []; const profiles: Record<string, unknown>[] = [];
  if (hub.profiles === undefined) {
    return { profiles, warnings };
  }
  if (!Array.isArray(hub.profiles)) {
    return { profiles, warnings: ['Excluded all profiles: hub-config profiles must be a list.'] };
  }
  const profileValues = hub.profiles as unknown[];
  const sourceValues = Array.isArray(hub.sources) ? hub.sources as unknown[] : [];
  const sources = new Map<string, Record<string, unknown>>();
  for (const source of sourceValues) {
    if (isRecord(source) && typeof source.id === 'string') {
      sources.set(source.id, source);
    }
  }
  for (const [profileIndex, value] of profileValues.entries()) {
    if (!isRecord(value)) {
      warnings.push(`Excluded profile #${profileIndex + 1}: profile entry must be a mapping.`);
      continue;
    }
    if (typeof value.id !== 'string' || value.id.length === 0) {
      warnings.push(`Excluded profile #${profileIndex + 1}: profile id must be a nonempty string.`);
      continue;
    }
    const profileLabel = JSON.stringify(value.id);
    if (!Array.isArray(value.bundles)) {
      warnings.push(`Excluded profile ${profileLabel}: bundles must be a list.`);
      continue;
    }
    const issues: string[] = [];
    const bundleValues = value.bundles as unknown[];
    for (const [bundleIndex, bundle] of bundleValues.entries()) {
      if (!isRecord(bundle) || typeof bundle.source !== 'string' || typeof bundle.id !== 'string' || bundle.id.length === 0) {
        issues.push(`bundle reference #${bundleIndex + 1} must contain string source and id fields`);
        continue;
      }
      const version = bundle.version === undefined ? 'latest' : (typeof bundle.version === 'string' ? bundle.version : '');
      if (!version) {
        issues.push(`${bundle.source}:${bundle.id} has an invalid version`);
        continue;
      }
      const source = sources.get(bundle.source);
      if (!source) {
        issues.push(`${bundle.source}:${bundle.id}@${version} references an unconfigured source`);
        continue;
      }
      if (source.enabled === false) {
        issues.push(`${bundle.source}:${bundle.id}@${version} references a disabled source`);
        continue;
      }
      if (source.type !== 'github') {
        issues.push(`${bundle.source}:${bundle.id}@${version} references source type ${JSON.stringify(source.type ?? '<missing>')}; only GitHub sources can be replicated`);
        continue;
      }
      const matches = (candidate: ReplicationCandidate): boolean =>
        (candidate.sourceIds ?? [candidate.sourceId]).includes(bundle.source as string)
        && candidate.bundleId === bundle.id;
      const options = selectedCandidates.filter((candidate) => matches(candidate));
      const requestedCandidate = version === 'latest'
        ? (() => {
          const stable = options.filter((candidate) => semver.prerelease(candidate.version) === null);
          const pool = stable.length > 0 ? stable : options;
          return [...pool].sort((a, b) => semver.rcompare(a.version, b.version))[0];
        })()
        : options.find((candidate) => candidate.version === version);
      if (!requestedCandidate) {
        issues.push(`${bundle.source}:${bundle.id}@${version} has no compliant release candidate`);
      } else if (!candidates.some((candidate) => matches(candidate) && candidate.version === requestedCandidate.version)) {
        issues.push(`${bundle.source}:${bundle.id}@${version} selected ${requestedCandidate.version} but that candidate was not verified in the target`);
      }
    }
    if (issues.length > 0) {
      warnings.push(`Excluded profile ${profileLabel}: ${issues.join('; ')}.`);
    } else {
      profiles.push(value);
    }
  }
  return { profiles, warnings };
};

export const makeReplicatedEntry = (candidate: ReplicationCandidate, manifestPath: string, archivePath: string, archive: Uint8Array, sha256: (data: Uint8Array) => string): ArtifactoryBundleIndexEntry => {
  const m = candidate.manifest; const text = (key: string, fallback: string) => typeof m[key] === 'string' ? m[key] : fallback;
  return { id: candidate.bundleId, version: candidate.version, name: text('name', candidate.releaseName || candidate.bundleId), description: text('description', candidate.releaseName), author: text('author', 'GitHub release publisher'), environments: Array.isArray(m.environments) ? m.environments as string[] : ['vscode'], tags: Array.isArray(m.tags) ? m.tags as string[] : [], lastUpdated: candidate.publishedAt || '1970-01-01T00:00:00Z', dependencies: Array.isArray(m.dependencies) ? m.dependencies as never[] : [], license: text('license', 'UNLICENSED'), manifest: { path: manifestPath, size: candidate.manifestBytes.byteLength, sha256: sha256(candidate.manifestBytes), mediaType: 'application/yaml' }, archive: { path: archivePath, size: archive.byteLength, sha256: sha256(archive), mediaType: 'application/zip' }, canonicalSource: `https://github.com/${candidate.repo}`, revision: candidate.tag };
};
