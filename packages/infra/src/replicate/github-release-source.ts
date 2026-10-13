import type {
  GitHubApi,
  ReplicationCandidate,
  ReplicationCandidateDiscovery,
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
interface ReleasePage { releases: Release[]; next?: string }
export interface ReplicationCache { get(key: string): Promise<Uint8Array | undefined>; set(key: string, value: Uint8Array): Promise<void> }
const nextPageUrl = (link: string | undefined): string | undefined => {
  for (const part of (link ?? '').split(/,(?=\s*<)/)) {
    const match = /^\s*<([^>]+)>(.*)$/.exec(part);
    const relation = /(?:^|;)\s*rel\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(match?.[2] ?? '');
    if (match && (relation?.[1] ?? relation?.[2])?.toLowerCase().split(/\s+/).includes('next')) {
      return match[1];
    }
  }
  return undefined;
};
interface ReleaseCoordinate { collectionId: string; version: string }
const releaseCoordinate = (name: string | undefined): ReleaseCoordinate | undefined => {
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(name ?? '');
  if (!match) {
    return undefined;
  }
  const version = normalizedReleaseVersion({ version: match[2] }, '');
  return version ? { collectionId: match[1], version } : undefined;
};
export class GitHubReleaseSource implements ReplicationSourcePort {
  public constructor(private readonly api: GitHubApi, private readonly cache?: ReplicationCache, private readonly budget = 600) {}
  private used = 0;
  private async request<T>(load: () => Promise<T>): Promise<T> {
    if (this.used >= this.budget) {
      throw new Error(`GitHub request budget (${this.budget}) exhausted; rerun with the same cache directory.`);
    } this.used += 1; return load();
  }

  private async get<T>(key: string, load: () => Promise<T>, encode: (value: T) => Uint8Array, decode: (value: Uint8Array) => T): Promise<T> {
    const cached = await this.cache?.get(key); if (cached) {
      return decode(cached);
    } const value = await this.request(load); await this.cache?.set(key, encode(value)); return value;
  }

  public get requestCount(): number {
    return this.used;
  }

  public async getHubConfig(ownerRepo: string, ref: string): Promise<Record<string, unknown>> {
    const data = await this.request(() => this.api.getJson<{ content: string }>(`/repos/${ownerRepo}/contents/hub-config.yml?ref=${encodeURIComponent(ref)}`)); const text = Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8'); const parsed = yaml.load(text); if (!parsed || typeof parsed !== 'object') {
      throw new Error('source hub-config.yml must be a mapping');
    } return parsed as Record<string, unknown>;
  }

  public async listReleaseCandidates(owner: string, repo: string, sourceId: string): Promise<ReplicationCandidateDiscovery> {
    const releases: Release[] = []; const visited = new Set<string>(); let pageUrl: string | undefined = `/repos/${owner}/${repo}/releases?per_page=100`;
    while (pageUrl) {
      const currentUrl: string = pageUrl; if (visited.has(currentUrl)) {
        throw new Error(`GitHub releases pagination repeated ${currentUrl}.`);
      } visited.add(currentUrl);
      const page: ReleasePage = await this.request(async (): Promise<ReleasePage> => {
        const response = await this.api.getJsonWithHeaders<Release[]>(currentUrl);
        return { releases: response.value, next: nextPageUrl(response.headers.link) };
      });
      releases.push(...page.releases); pageUrl = page.next;
    }
    const candidates: ReplicationCandidate[] = []; const warnings: string[] = [];
    for (const release of releases) {
      if (release.draft) {
        continue;
      }
      const label = `${owner}/${repo} [source=${JSON.stringify(sourceId)}]#tag=${JSON.stringify(release.tag_name ?? '<missing>')} name=${JSON.stringify(release.name ?? '<missing>')}`;
      const assets = release.assets ?? [];
      const assetNames = JSON.stringify(assets.map((asset) => asset.name ?? '<unnamed>'));
      const coordinate = releaseCoordinate(release.name);
      if (!coordinate) {
        warnings.push(`Excluded GitHub release ${label}: release name must match <collectionid>-vX.Y.Z. Assets found: ${assetNames}.`);
        continue;
      }
      if (!release.tag_name) {
        warnings.push(`Excluded GitHub release ${label}: tag_name is missing. Assets found: ${assetNames}.`);
        continue;
      }
      const manifests = assets.filter((asset) => asset.name === 'deployment-manifest.yml');
      const archives = assets.filter((asset) => asset.name === `${coordinate.collectionId}.bundle.zip`);
      if (manifests.length !== 1 || archives.length !== 1) {
        const reasons = [
          ...(manifests.length === 1 ? [] : [`expected one deployment-manifest.yml (found ${manifests.length})`]),
          ...(archives.length === 1 ? [] : [`expected one ${coordinate.collectionId}.bundle.zip (found ${archives.length})`])
        ];
        warnings.push(`Excluded GitHub release ${label}: ${reasons.join('; ')}. Assets found: ${assetNames}.`);
        continue;
      }
      const manifestAsset = manifests[0];
      const archiveAsset = archives[0];
      if (!manifestAsset.url || !archiveAsset.url) {
        warnings.push(`Excluded GitHub release ${label}: a required asset has no download URL.`);
        continue;
      }
      let manifestBytes: Uint8Array;
      try {
        manifestBytes = await this.get(`manifest:${manifestAsset.url}`, () => this.api.download(manifestAsset.url!), (value) => value, (value) => value);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (/GitHub request budget \(\d+\) exhausted/.test(reason)) {
          throw error;
        }
        warnings.push(`Excluded GitHub release ${label}: deployment-manifest.yml download failed (${JSON.stringify(reason)}).`);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = yaml.load(new TextDecoder().decode(manifestBytes));
      } catch {
        warnings.push(`Excluded GitHub release ${label}: deployment-manifest.yml is not valid YAML.`);
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        warnings.push(`Excluded GitHub release ${label}: deployment-manifest.yml must contain a mapping.`);
        continue;
      }
      const manifest = parsed as Record<string, unknown>;
      const version = normalizedReleaseVersion(manifest, '');
      if (manifest.id !== coordinate.collectionId || version !== coordinate.version) {
        warnings.push(`Excluded GitHub release ${label}: manifest id/version ${JSON.stringify(manifest.id ?? '<missing>')}@${JSON.stringify(manifest.version ?? '<missing>')} must match ${coordinate.collectionId}@${coordinate.version}.`);
        continue;
      }
      const bundleId = stableReplicatedBundleId(`${owner}/${repo}`, manifest);
      candidates.push({ sourceId, repo: `${owner}/${repo}`, tag: release.tag_name, publishedAt: release.published_at ?? '', releaseName: release.name ?? '', manifest, manifestBytes, manifestName: manifestAsset.name!, archiveUrl: archiveAsset.url, archiveSize: archiveAsset.size ?? 0, version, bundleId });
    }
    return { candidates, warnings };
  }

  public downloadArchive(candidate: ReplicationCandidate): Promise<Uint8Array> {
    return this.get(`archive:${candidate.archiveUrl}`, () => this.api.download(candidate.archiveUrl), (value) => value, (value) => value);
  }
}
