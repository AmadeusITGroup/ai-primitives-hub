import type {
  GitHubApi,
  ReplicationCandidate,
  ReplicationSourcePort,
} from '@ai-primitives-hub/core';
import {
  normalizedReleaseVersion,
  stableReplicatedBundleId,
} from '@ai-primitives-hub/core';
/* eslint-disable @stylistic/max-len, @stylistic/max-statements-per-line, @typescript-eslint/naming-convention, @typescript-eslint/member-ordering -- focused GitHub adapter */
import * as yaml from 'js-yaml';

interface ReleaseAsset { name?: string; url?: string; size?: number }
interface Release { tag_name?: string; name?: string; published_at?: string; draft?: boolean; assets?: ReleaseAsset[] }
export interface ReplicationCache { get(key: string): Promise<Uint8Array | undefined>; set(key: string, value: Uint8Array): Promise<void> }
export class GitHubReleaseSource implements ReplicationSourcePort {
  public constructor(private readonly api: GitHubApi, private readonly cache?: ReplicationCache, private readonly budget = 600) {}
  private used = 0;
  private async get<T>(key: string, load: () => Promise<T>, encode: (value: T) => Uint8Array, decode: (value: Uint8Array) => T): Promise<T> {
    const cached = await this.cache?.get(key); if (cached) {
      return decode(cached);
    } if (++this.used > this.budget) {
      throw new Error(`GitHub request budget (${this.budget}) exhausted; rerun with the same cache directory.`);
    } const value = await load(); await this.cache?.set(key, encode(value)); return value;
  }

  public get requestCount(): number {
    return this.used;
  }

  public async getHubConfig(ownerRepo: string, ref: string): Promise<Record<string, unknown>> {
    const data = await this.get(`hub:${ownerRepo}:${ref}`, () => this.api.getJson<{ content: string }>(`/repos/${ownerRepo}/contents/hub-config.yml?ref=${encodeURIComponent(ref)}`), (value) => new TextEncoder().encode(value.content), (bytes) => ({ content: new TextDecoder().decode(bytes) })); const text = Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8'); const parsed = yaml.load(text); if (!parsed || typeof parsed !== 'object') {
      throw new Error('source hub-config.yml must be a mapping');
    } return parsed as Record<string, unknown>;
  }

  public async listReleaseCandidates(owner: string, repo: string, sourceId: string): Promise<ReplicationCandidate[]> {
    const releases = await this.get(`releases:${owner}/${repo}`, () => this.api.getJson<Release[]>(`/repos/${owner}/${repo}/releases?per_page=100`), (value) => new TextEncoder().encode(JSON.stringify(value)), (bytes) => JSON.parse(new TextDecoder().decode(bytes)) as Release[]); const result: ReplicationCandidate[] = []; for (const release of releases) {
      if (release.draft) {
        continue;
      } const assets = release.assets ?? []; const manifest = assets.find((asset) => ['deployment-manifest.yml', 'deployment-manifest.yaml', 'deployment-manifest.json'].includes(asset.name ?? '')); const archive = assets.find((asset) => asset.name?.endsWith('.zip')); if (!manifest?.url || !archive?.url || !manifest.name) {
        continue;
      } const manifestBytes = await this.get(`manifest:${manifest.url}`, () => this.api.download(manifest.url!), (value) => value, (value) => value); let parsed: unknown; try {
        parsed = manifest.name.endsWith('.json') ? JSON.parse(new TextDecoder().decode(manifestBytes)) : yaml.load(new TextDecoder().decode(manifestBytes));
      } catch {
        continue;
      } if (!parsed || typeof parsed !== 'object') {
        continue;
      } const version = normalizedReleaseVersion(parsed as Record<string, unknown>, release.tag_name ?? ''); if (!version) {
        continue;
      } const bundleId = stableReplicatedBundleId(`${owner}/${repo}`, parsed as Record<string, unknown>); result.push({ sourceId, repo: `${owner}/${repo}`, tag: release.tag_name ?? '', publishedAt: release.published_at ?? '', releaseName: release.name ?? '', manifest: parsed as Record<string, unknown>, manifestBytes, manifestName: manifest.name, archiveUrl: archive.url, archiveSize: archive.size ?? 0, version, bundleId });
    } return result;
  }

  public downloadArchive(candidate: ReplicationCandidate): Promise<Uint8Array> {
    return this.get(`archive:${candidate.archiveUrl}`, () => this.api.download(candidate.archiveUrl), (value) => value, (value) => value);
  }
}
