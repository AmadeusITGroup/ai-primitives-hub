/* eslint-disable @stylistic/max-len, @stylistic/max-statements-per-line, @typescript-eslint/no-base-to-string, jsdoc/require-description -- orchestration adapter */
import {
  createHash,
} from 'node:crypto';
import type {
  HubConfig,
  PreparedReplicationArchive,
  ReplicationArchivePreparer,
  ReplicationCandidateDiscovery,
  ReplicationPublisherPort,
  ReplicationResult,
  ReplicationSourcePort,
} from '@ai-primitives-hub/core';
import {
  isRegistryError,
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
  apmTransition?: boolean;
}
const REPLICATED_SOURCE_PATH = 'sources/replicated';
const APM_CONFIG_PATH = '__CONFIG__';
const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
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
 * @param archivePreparer
 */
export async function replicateHub(options: ReplicateOptions, source: ReplicationSourcePort, publisher?: ReplicationPublisherPort, archivePreparer?: ReplicationArchivePreparer): Promise<ReplicationResult> {
  if (options.apmTransition && (!options.publish || !publisher || !archivePreparer)) {
    throw new Error('--apm-transition requires publication, a publisher, and an APM archive preparer; the CLI also requires --review.');
  }
  const raw = await source.getHubConfig(options.sourceHub, options.sourceRef);
  const configuredSources: unknown[] = Array.isArray(raw.sources) ? raw.sources as unknown[] : [];
  const enabled = configuredSources.filter((item): item is Record<string, unknown> => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return false;
    }
    const sourceRecord = item as Record<string, unknown>;
    return sourceRecord.enabled !== false && sourceRecord.type === 'github' && typeof sourceRecord.id === 'string';
  });
  const groups: ReplicationCandidateDiscovery[] = []; const workers = Math.max(1, Math.floor(options.workers ?? 4));
  for (let offset = 0; offset < enabled.length; offset += workers) {
    const batch = enabled.slice(offset, offset + workers); groups.push(...await Promise.all(batch.map(async (item) => {
      const repo = repoFromUrl(sourceUrl(item)); return source.listReleaseCandidates(repo.owner, repo.repo, String(item.id));
    })));
  }
  const candidates = groups.flatMap((group) => group.candidates); const selection = selectReplications(candidates, requestsFromHubConfig(raw), options.mode); const warnings = groups.flatMap((group) => group.warnings);
  const preparedArchives = new Map<string, { owner: string; prepared: PreparedReplicationArchive }>();
  const unsupportedTransitionCandidates = new Set<string>();
  if (options.apmTransition) {
    const coordinates = new Map<string, { candidate: typeof selection.selected[number]; prepared: PreparedReplicationArchive }>();
    for (const candidate of selection.selected) {
      const owner = candidate.repo.split('/')[0]?.toLowerCase();
      const packageName = candidate.manifest.id;
      if (!owner || !/^[a-z0-9][a-z0-9-]*$/.test(owner) || typeof packageName !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(packageName)) {
        throw new Error(`Cannot map ${candidate.bundleId}@${candidate.version} to a valid Agent Packages coordinate.`);
      }
      const archive = await source.downloadArchive(candidate);
      if (archive.byteLength === 0) {
        throw new Error(`Empty release archive for ${candidate.bundleId}@${candidate.version}`);
      }
      let prepared: PreparedReplicationArchive;
      try {
        if (!archivePreparer) {
          throw new Error('An APM archive preparer is required.');
        }
        prepared = await archivePreparer.prepare(candidate, archive);
      } catch (error) {
        if (isRegistryError(error) && error.code === 'BUNDLE.APM_UNSUPPORTED_CONTENT') {
          const key = `${candidate.bundleId}\0${candidate.version}`;
          unsupportedTransitionCandidates.add(key);
          warnings.push(`Skipped ${candidate.bundleId}@${candidate.version}: ${error.message}`);
          continue;
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot prepare ${candidate.bundleId}@${candidate.version}: ${detail}`);
      }
      if (prepared.packageName !== packageName) {
        throw new Error(`APM package name "${prepared.packageName}" does not match the release collection id for ${candidate.bundleId}@${candidate.version}.`);
      }
      const coordinate = `${owner}/${packageName}@${candidate.version}`;
      const existing = coordinates.get(coordinate);
      if (existing) {
        if (!sameBytes(existing.prepared.bytes, prepared.bytes)
          || !sameBytes(existing.candidate.manifestBytes, candidate.manifestBytes)) {
          throw new Error(`Agent Packages coordinate collision for ${coordinate}: ${existing.candidate.repo} (${existing.candidate.bundleId}) and ${candidate.repo} (${candidate.bundleId}) have different release content; no artifacts were published.`);
        }
        warnings.push(`Shared identical Agent Packages artifact ${coordinate} for ${existing.candidate.bundleId} and ${candidate.bundleId}; both Hub IDs reference the same ZIP.`);
      } else {
        coordinates.set(coordinate, { candidate, prepared });
      }
      preparedArchives.set(`${candidate.bundleId}\0${candidate.version}`, { owner, prepared });
      warnings.push(...prepared.warnings);
      if (prepared.translated) {
        warnings.push(`Temporarily translated ${candidate.bundleId}@${candidate.version} to the dual-manifest APM layout; the uploaded ZIP differs from the immutable GitHub release asset.`);
      }
    }
  }
  const entries = []; const verified = new Set<string>();
  const publishedPackages = new Map<string, 'uploaded' | 'skipped-existing' | 'skipped-unverified'>();
  for (const candidate of selection.selected) {
    if (unsupportedTransitionCandidates.has(`${candidate.bundleId}\0${candidate.version}`)) {
      continue;
    }
    let manifestPath = `bundles/${candidate.bundleId}/${candidate.version}/deployment-manifest.yml`;
    let archivePath = `bundles/${candidate.bundleId}/${candidate.version}/${candidate.bundleId}-${candidate.version}.zip`;
    if (options.publish) {
      if (!publisher) {
        throw new Error('Publisher is required when --publish is enabled');
      }
      let preparedArchive: Uint8Array;
      let sourcePath = `${REPLICATED_SOURCE_PATH}/`;
      if (options.apmTransition) {
        const { owner, prepared } = preparedArchives.get(`${candidate.bundleId}\0${candidate.version}`)!;
        sourcePath = '';
        manifestPath = `${APM_CONFIG_PATH}/manifests/${candidate.bundleId}/${candidate.version}/deployment-manifest.yml`;
        archivePath = `${owner}/${prepared.packageName}/${prepared.packageName}-${candidate.version}.zip`;
        preparedArchive = prepared.bytes;
      } else {
        preparedArchive = await source.downloadArchive(candidate);
        if (preparedArchive.byteLength === 0) {
          throw new Error(`Empty release archive for ${candidate.bundleId}@${candidate.version}`);
        }
      }
      const manifestStatus = await publisher.publish(`${sourcePath}${manifestPath}`, candidate.manifestBytes, 'application/yaml');
      const bundleStatus = manifestStatus === 'skipped-unverified'
        ? manifestStatus
        : publishedPackages.get(archivePath) ?? await publisher.publish(`${sourcePath}${archivePath}`, preparedArchive, 'application/zip');
      if (manifestStatus !== 'skipped-unverified' && !publishedPackages.has(archivePath)) {
        publishedPackages.set(archivePath, bundleStatus);
      }
      if (bundleStatus === 'skipped-unverified') {
        warnings.push(`Skipped unverified existing bundle ${candidate.bundleId}@${candidate.version}. Check the target objects before retrying.`);
        continue;
      }
      entries.push(makeReplicatedEntry(candidate, manifestPath, archivePath, preparedArchive, sha256));
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
    const apmTransition = options.apmTransition === true;
    const indexFile = apmTransition
      ? `${APM_CONFIG_PATH}/indexes/${sha256(indexBytes)}-index-v1.json`
      : `indexes/${sha256(indexBytes)}/index-v1.json`;
    const indexPrefix = apmTransition ? '' : `${REPLICATED_SOURCE_PATH}/`;
    const generationStatus = await publisher.publish(`${indexPrefix}${indexFile}`, indexBytes, 'application/json');
    if (generationStatus === 'skipped-unverified') {
      throw new Error('Unverified existing catalog generation. Check the target objects before retrying.');
    }
    const latestIndexPath = apmTransition ? `${APM_CONFIG_PATH}/index-v1.json` : `${REPLICATED_SOURCE_PATH}/index-v1.json`;
    const indexStatus = await publisher.publish(latestIndexPath, indexBytes, 'application/json', { replaceExisting: true });
    if (indexStatus === 'skipped-unverified') {
      throw new Error(`Unverified existing metadata at ${latestIndexPath}. Check the target objects before retrying.`);
    }
    const targetAuth = options.targetAuth ?? 'bearer';
    const config: HubConfig = {
      version: typeof raw.version === 'string' ? raw.version : '1',
      metadata: { name: 'Replicated GitHub hub', description: 'Bundles replicated from GitHub releases', maintainer: 'ai-primitives-hub', updatedAt },
      sources: [{
        id: 'replicated', name: 'Replicated GitHub hub', type: 'artifactory',
        url: apmTransition
          ? options.targetRoot.replace(/\/$/, '')
          : `${options.targetRoot.replace(/\/$/, '')}/${REPLICATED_SOURCE_PATH}`, enabled: true, priority: 0,
        private: targetAuth === 'bearer',
        config: {
          indexFile, authMode: targetAuth,
          ...(targetAuth === 'bearer' && options.targetCredentialRef ? { credentialRef: options.targetCredentialRef } : {})
        }
      }],
      profiles: profiles as HubConfig['profiles']
    };
    const hubBytes = new TextEncoder().encode(JSON.stringify(config, null, 2) + '\n');
    const hubConfigPath = apmTransition ? `${APM_CONFIG_PATH}/hub-config.yml` : 'hub-config.yml';
    if (apmTransition) {
      const hubSnapshotPath = `${APM_CONFIG_PATH}/hub-config/${sha256(hubBytes)}-hub-config.yml`;
      const snapshotStatus = await publisher.publish(hubSnapshotPath, hubBytes, 'application/yaml');
      if (snapshotStatus === 'skipped-unverified') {
        throw new Error('Unverified existing immutable hub snapshot. Check the target before retrying.');
      }
    }
    const hubStatus = await publisher.publish(hubConfigPath, hubBytes, 'application/yaml', { replaceExisting: true });
    if (hubStatus === 'skipped-unverified') {
      throw new Error(`Unverified existing metadata at ${hubConfigPath}. Check the target objects before retrying.`);
    }
    return { index, hubConfig: config, warnings, selected: selection.selected };
  }
  const dryRunProfiles = resolveReplicatedProfiles(raw, selection.selected);
  warnings.push(...dryRunProfiles.warnings);
  return { index, hubConfig: { version: '1', metadata: { name: 'Replicated GitHub hub', description: '', maintainer: '', updatedAt }, sources: [], profiles: [] }, warnings, selected: selection.selected };
}
