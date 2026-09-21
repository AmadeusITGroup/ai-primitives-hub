/* eslint-disable @stylistic/max-len, @stylistic/max-statements-per-line, @typescript-eslint/no-base-to-string, jsdoc/require-description -- orchestration adapter */
import {
  createHash,
} from 'node:crypto';
import type {
  HubConfig,
  ReplicationCandidate,
  ReplicationPublisherPort,
  ReplicationResult,
  ReplicationSourcePort,
} from '@ai-primitives-hub/core';
import {
  makeReplicatedEntry,
  requestsFromHubConfig,
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
  const groups: ReplicationCandidate[][] = []; const workers = Math.max(1, Math.floor(options.workers ?? 4));
  for (let offset = 0; offset < enabled.length; offset += workers) {
    const batch = enabled.slice(offset, offset + workers); groups.push(...await Promise.all(batch.map(async (item) => {
      const repo = repoFromUrl(sourceUrl(item)); return source.listReleaseCandidates(repo.owner, repo.repo, String(item.id));
    })));
  }
  const candidates = groups.flat(); const selection = selectReplications(candidates, requestsFromHubConfig(raw), options.mode); const warnings = selection.unresolved.map((item) => `Unresolved profile bundle: ${item}`);
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
      await publisher.publish(manifestPath, candidate.manifestBytes, 'application/yaml'); await publisher.publish(archivePath, archive, 'application/zip');
      entries.push(makeReplicatedEntry(candidate, manifestPath, archivePath, archive, sha256)); verified.add(`${candidate.sourceId}\0${candidate.bundleId}\0${candidate.version}`);
    } else {
      const placeholder = new Uint8Array(candidate.archiveSize); entries.push(makeReplicatedEntry(candidate, manifestPath, archivePath, placeholder, () => '0'.repeat(64)));
    }
  }
  const updatedAt = new Date().toISOString(); const index = { formatVersion: 1 as const, source: { id: 'replicated', name: 'Replicated GitHub hub', description: 'Bundles replicated from GitHub releases', updatedAt }, bundles: entries };
  if (options.publish && publisher) {
    await publisher.publish('index-v1.json', new TextEncoder().encode(JSON.stringify(index, null, 2) + '\n'), 'application/json');
    const profiles = (Array.isArray(raw.profiles) ? raw.profiles : []).filter((profile): profile is Record<string, unknown> => !!profile && typeof profile === 'object').map((profile) => ({ ...profile, bundles: (Array.isArray(profile.bundles) ? profile.bundles : []).filter((bundle): bundle is Record<string, unknown> => {
      const b = bundle as Record<string, unknown>; return verified.has(`${String(b.source)}\0${String(b.id)}\0${String(b.version)}`) || (String(b.version) === 'latest' && [...verified].some((key) => key.startsWith(`${String(b.source)}\0${String(b.id)}\0`)));
    }).map((bundle) => ({ ...bundle, source: 'replicated' })) }));
    const targetAuth = options.targetAuth ?? 'bearer';
    const config: HubConfig = {
      version: typeof raw.version === 'string' ? raw.version : '1',
      metadata: { name: 'Replicated GitHub hub', description: 'Bundles replicated from GitHub releases', maintainer: 'ai-primitives-hub', updatedAt },
      sources: [{
        id: 'replicated', name: 'Replicated GitHub hub', type: 'artifactory',
        url: `${options.targetRoot.replace(/\/$/, '')}/sources/replicated`, enabled: true, priority: 0,
        private: targetAuth === 'bearer',
        config: {
          indexFile: 'index-v1.json', authMode: targetAuth,
          ...(targetAuth === 'bearer' && options.targetCredentialRef ? { credentialRef: options.targetCredentialRef } : {})
        }
      }],
      profiles: profiles as HubConfig['profiles']
    };
    await publisher.publish('hub-config.yml', new TextEncoder().encode(JSON.stringify(config, null, 2) + '\n'), 'application/yaml');
    return { index, hubConfig: config, warnings, selected: selection.selected };
  }
  return { index, hubConfig: { version: '1', metadata: { name: 'Replicated GitHub hub', description: '', maintainer: '', updatedAt }, sources: [], profiles: [] }, warnings, selected: selection.selected };
}
