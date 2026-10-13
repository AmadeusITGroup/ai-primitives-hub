/* eslint-disable @stylistic/max-len, @stylistic/max-statements-per-line, @typescript-eslint/no-base-to-string, jsdoc/require-description -- orchestration adapter */
import {
  createHash,
} from 'node:crypto';
import type {
  HubConfig,
  ReplicationCandidateDiscovery,
  ReplicationPublisherPort,
  ReplicationResult,
  ReplicationSourcePort,
} from '@ai-primitives-hub/core';
import {
  makeReplicatedEntry,
  requestsFromHubConfig,
  resolveReplicatedProfiles,
  selectReplications,
} from '@ai-primitives-hub/core';

export interface ReplicateOptions {
  sourceHub: string;
  sourceRef: string;
  targetRoot: string;
  mode: 'latest' | 'all';
  publish?: boolean;
  allowUnverifiedExisting?: boolean;
  workers?: number;
  targetAuth?: 'anonymous' | 'bearer';
  targetCredentialRef?: string;
}
const REPLICATED_SOURCE_PATH = 'sources/replicated';
const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const sourceUrl = (source: Record<string, unknown>): string => String(source.url ?? '');
const repoFromUrl = (url: string): { owner: string; repo: string } => {
  const value = url.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/^\/+|\/+$/g, ''); const [owner, repo] = value.split('/'); if (!owner || !repo || value.includes('?') || value.includes('#')) {
    throw new Error(`Invalid GitHub source URL: ${url}`);
  } return { owner, repo };
};
/**
 *
 * @param options
 * @param source
 * @param publisher
 */
export async function replicateHub(options: ReplicateOptions, source: ReplicationSourcePort, publisher?: ReplicationPublisherPort): Promise<ReplicationResult> {
  const raw = await source.getHubConfig(options.sourceHub, options.sourceRef);
  const enabled = (Array.isArray(raw.sources) ? raw.sources : []).filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && item.enabled !== false && item.type === 'github' && typeof item.id === 'string');
  const groups: ReplicationCandidateDiscovery[] = []; const workers = Math.max(1, Math.floor(options.workers ?? 4));
  for (let offset = 0; offset < enabled.length; offset += workers) {
    const batch = enabled.slice(offset, offset + workers); groups.push(...await Promise.all(batch.map(async (item) => {
      const repo = repoFromUrl(sourceUrl(item)); return source.listReleaseCandidates(repo.owner, repo.repo, String(item.id));
    })));
  }
  const candidates = groups.flatMap((group) => group.candidates); const selection = selectReplications(candidates, requestsFromHubConfig(raw), options.mode); const warnings = groups.flatMap((group) => group.warnings);
  const entries = []; const verified = new Set<string>();
  for (const candidate of selection.selected) {
    const manifestPath = `bundles/${candidate.bundleId}/${candidate.version}/deployment-manifest.yml`; const archivePath = `bundles/${candidate.bundleId}/${candidate.version}/${candidate.bundleId}-${candidate.version}.zip`;
    if (options.publish) {
      if (!publisher) {
        throw new Error('Publisher is required when --publish is enabled');
      }
      const archive = await source.downloadArchive(candidate); if (archive.byteLength === 0) {
        throw new Error(`Empty release archive for ${candidate.bundleId}@${candidate.version}`);
      }
      const manifestStatus = await publisher.publish(`${REPLICATED_SOURCE_PATH}/${manifestPath}`, candidate.manifestBytes, 'application/yaml');
      const bundleStatus = manifestStatus === 'skipped-unverified'
        ? manifestStatus
        : await publisher.publish(`${REPLICATED_SOURCE_PATH}/${archivePath}`, archive, 'application/zip');
      if (bundleStatus === 'skipped-unverified') {
        warnings.push(`Skipped unverified existing bundle ${candidate.bundleId}@${candidate.version}. Check the target objects before retrying.`);
        continue;
      }
      entries.push(makeReplicatedEntry(candidate, manifestPath, archivePath, archive, sha256));
      for (const sourceId of candidate.sourceIds ?? [candidate.sourceId]) {
        verified.add(`${sourceId}\0${candidate.bundleId}\0${candidate.version}`);
      }
    } else {
      const placeholder = new Uint8Array(candidate.archiveSize); entries.push(makeReplicatedEntry(candidate, manifestPath, archivePath, placeholder, () => '0'.repeat(64)));
    }
  }
  const updatedAt = new Date().toISOString(); const index = { formatVersion: 1 as const, source: { id: 'replicated', name: 'Replicated GitHub hub', description: 'Bundles replicated from GitHub releases', updatedAt }, bundles: entries };
  if (options.publish && publisher) {
    const verifiedCandidates = selection.selected.filter((candidate) => (candidate.sourceIds ?? [candidate.sourceId]).some((sourceId) => verified.has(`${sourceId}\0${candidate.bundleId}\0${candidate.version}`)));
    const publicationProfiles = resolveReplicatedProfiles(raw, verifiedCandidates, selection.selected);
    warnings.push(...publicationProfiles.warnings);
    const profiles = publicationProfiles.profiles.map((profile) => ({
      ...profile,
      bundles: (profile.bundles as Record<string, unknown>[]).map((bundle) => ({ ...bundle, source: 'replicated' }))
    }));
    const indexBytes = new TextEncoder().encode(JSON.stringify(index, null, 2) + '\n');
    const indexFile = `indexes/${sha256(indexBytes)}/index-v1.json`;
    const generationStatus = await publisher.publish(`${REPLICATED_SOURCE_PATH}/${indexFile}`, indexBytes, 'application/json');
    if (generationStatus === 'skipped-unverified') {
      throw new Error('Unverified existing catalog generation. Check the target objects before retrying.');
    }
    const indexStatus = await publisher.publish(`${REPLICATED_SOURCE_PATH}/index-v1.json`, indexBytes, 'application/json', { replaceExisting: true });
    if (indexStatus === 'skipped-unverified') {
      throw new Error('Unverified existing metadata at sources/replicated/index-v1.json. Check the target objects before retrying.');
    }
    const targetAuth = options.targetAuth ?? 'bearer';
    const config: HubConfig = {
      version: typeof raw.version === 'string' ? raw.version : '1',
      metadata: { name: 'Replicated GitHub hub', description: 'Bundles replicated from GitHub releases', maintainer: 'ai-primitives-hub', updatedAt },
      sources: [{
        id: 'replicated', name: 'Replicated GitHub hub', type: 'artifactory',
        url: `${options.targetRoot.replace(/\/$/, '')}/${REPLICATED_SOURCE_PATH}`, enabled: true, priority: 0,
        private: targetAuth === 'bearer',
        config: {
          indexFile, authMode: targetAuth,
          ...(targetAuth === 'bearer' && options.targetCredentialRef ? { credentialRef: options.targetCredentialRef } : {})
        }
      }],
      profiles: profiles as HubConfig['profiles']
    };
    const hubStatus = await publisher.publish('hub-config.yml', new TextEncoder().encode(JSON.stringify(config, null, 2) + '\n'), 'application/yaml', { replaceExisting: true });
    if (hubStatus === 'skipped-unverified') {
      throw new Error('Unverified existing metadata at hub-config.yml. Check the target objects before retrying.');
    }
    return { index, hubConfig: config, warnings, selected: selection.selected };
  }
  const dryRunProfiles = resolveReplicatedProfiles(raw, selection.selected);
  warnings.push(...dryRunProfiles.warnings);
  return { index, hubConfig: { version: '1', metadata: { name: 'Replicated GitHub hub', description: '', maintainer: '', updatedAt }, sources: [], profiles: [] }, warnings, selected: selection.selected };
}
