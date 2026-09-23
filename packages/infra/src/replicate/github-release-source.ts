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

  public async listReleaseCandidates(owner: string, repo: string, sourceId: string): Promise<ReplicationCandidate[]> {
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
    const result: ReplicationCandidate[] = []; for (const release of releases) {
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
