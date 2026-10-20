/**
 * Published collection release lookup. Drafts and prereleases do not qualify.
 * Every release page is read, including pages after a match. Missing is only
 * definitive when all release metadata and candidate manifests are accessible.
 * @module governance/github-release-lookup
 */
import type {
  GitHubApi,
  GitHubRepositoryTarget,
  GovernanceCollection,
  HubCollectionInventory,
  ReleaseLookup,
  ReleaseLookupResult,
} from '@ai-primitives-hub/core';
import {
  generateBundleId,
  generateGitHubReleaseBundleId,
} from '@ai-primitives-hub/core';
import * as yaml from 'js-yaml';
import {
  isGitHubHost,
} from '../http/github-host';
import {
  parseGitHubRepositoryTarget,
} from '../http/github-repository-target';
import {
  combineFailures,
  describeFailure,
  type FailureReason,
} from './failure-reasons';

const PAGE_SIZE = 100;
const UNVERIFIED: FailureReason = {
  reason: 'Published releases could not be read.',
  hint: 'Check the repository URL, release assets, token access and rate limits, then retry.'
};

/** A data problem with an explained reason; the reason is built here, never copied from a response. */
class ReleaseDataError extends Error {
  public constructor(public readonly failure: FailureReason) {
    super(failure.reason);
  }
}

interface ReleaseAsset {
  name: string;
  url: string;
}

interface PublishedRelease {
  tagName: string;
  assets: ReleaseAsset[];
}

interface ManifestIdentity {
  id: string;
  version: string;
}

interface ReleaseIdentity extends ManifestIdentity {
  tagName: string;
}

interface RepositoryReleases {
  identities: ReleaseIdentity[];
  hasUnknownData: boolean;
  /** Why data is unknown, for the report. */
  problems: FailureReason[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isManifestAsset(name: string): boolean {
  return name === 'deployment-manifest.yml' || name === 'deployment-manifest.yaml' || name === 'deployment-manifest.json';
}

function isArchiveAsset(name: string): boolean {
  return name.endsWith('.zip') || name.endsWith('.tar.gz');
}

/**
 * Reject malformed asset URLs before a repository-scoped client sees them.
 * @param value
 * @param target
 */
function isAssetUrl(value: unknown, target: GitHubRepositoryTarget): value is string {
  if (!isNonEmptyString(value) || value.trim() !== value) {
    return false;
  }
  try {
    const url = new URL(value);
    const prefix = `/repos/${target.owner}/${target.repository}/releases/assets/`.toLowerCase();
    return url.protocol === 'https:'
      && isGitHubHost(url.hostname)
      && url.username === '' && url.password === '' && url.port === ''
      && !value.includes('?') && !value.includes('#')
      && url.pathname.toLowerCase().startsWith(prefix)
      && /^\d+$/u.test(url.pathname.slice(prefix.length));
  } catch {
    return false;
  }
}

/**
 * `owner/repo` of a GitHub release-asset API URL, or undefined when it is not one.
 * @param value
 */
function assetRepository(value: unknown): string | undefined {
  if (!isNonEmptyString(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    const match = /^\/repos\/([\w.-]+)\/([\w.-]+)\/releases\/assets\/\d+$/u.exec(url.pathname);
    return url.protocol === 'https:' && isGitHubHost(url.hostname) && match ? `${match[1]}/${match[2]}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decode only the API fields needed to establish publication and assets.
 * @param value
 * @param target
 */
function publishedRelease(value: unknown, target: GitHubRepositoryTarget): PublishedRelease | undefined {
  if (!isRecord(value)
    || typeof value.draft !== 'boolean'
    || typeof value.prerelease !== 'boolean'
    || !isNonEmptyString(value.tag_name)
    || !Array.isArray(value.assets)) {
    throw new ReleaseDataError({ reason: 'GitHub returned a release without the expected fields (draft, prerelease, tag_name, assets).', hint: 'Retry the check.' });
  }
  const publishedAt = value.published_at;
  const hasPublicationDate = isNonEmptyString(publishedAt) && Number.isFinite(Date.parse(publishedAt));
  if (!hasPublicationDate && !(value.draft && publishedAt === null)) {
    throw new ReleaseDataError({ reason: `Release '${String(value.tag_name)}' has no valid publication date.`, hint: 'Publish the release (not draft) and retry.' });
  }
  const tag = value.tag_name;
  const assets = value.assets.map((asset: unknown): ReleaseAsset => {
    if (!isRecord(asset) || !isNonEmptyString(asset.name)) {
      throw new ReleaseDataError({ reason: `Release '${tag}' has an asset without a name.`, hint: 'Re-publish the release with named assets.' });
    }
    if (!isAssetUrl(asset.url, target)) {
      const actual = assetRepository(asset.url);
      const configured = `${target.owner}/${target.repository}`;
      if (actual !== undefined && actual.toLowerCase() !== configured.toLowerCase()) {
        throw new ReleaseDataError({
          reason: `Release assets belong to repository '${actual}', not '${configured}' as configured; the repository was probably renamed or moved.`,
          hint: `Update this source's url in hub-config.yml to https://${target.host}/${actual}.`
        });
      }
      throw new ReleaseDataError({ reason: `Release '${tag}' has an asset '${asset.name}' with an unexpected download address.`, hint: 'Re-publish the release from this repository.' });
    }
    return { name: asset.name, url: asset.url };
  });
  if (value.draft || value.prerelease) {
    return undefined;
  }
  return { tagName: value.tag_name, assets };
}

async function readManifest(api: GitHubApi, asset: ReleaseAsset): Promise<ManifestIdentity> {
  const content = await api.getText(asset.url, { Accept: 'application/octet-stream' });
  const manifest: unknown = asset.name.endsWith('.json') ? JSON.parse(content) : yaml.load(content);
  if (!isRecord(manifest) || !isNonEmptyString(manifest.id) || !isNonEmptyString(manifest.version)) {
    throw new ReleaseDataError({ reason: `'${asset.name}' does not declare a non-empty id and version.`, hint: 'Publish a deployment manifest with id and version fields.' });
  }
  return { id: manifest.id, version: manifest.version };
}

/**
 * Repository-scoped snapshot shared by concurrent and later collection queries.
 * Failed reads are retained as unknown data, never as proof of a missing release.
 * Create a new lookup instance to refresh the snapshot after correcting access.
 */
export class GitHubReleaseLookup implements ReleaseLookup {
  private readonly repositories = new Map<string, Promise<RepositoryReleases>>();
  private readonly idSnapshots = new Map<string, Promise<RepositoryReleases>>();

  public constructor(private readonly apiForRepository: (url: string) => GitHubApi) {}

  private snapshot(target: GitHubRepositoryTarget, idsOnly = false): Promise<RepositoryReleases> {
    const key = `${target.host}/${target.owner}/${target.repository}`.toLowerCase();
    // A full snapshot also answers ids-only queries; never the reverse.
    const full = this.repositories.get(key);
    if (full || !idsOnly) {
      let snapshot = full;
      if (!snapshot) {
        snapshot = Promise.resolve().then(() => this.readRepository(target, false));
        this.repositories.set(key, snapshot);
      }
      return snapshot;
    }
    let pending = this.idSnapshots.get(key);
    if (!pending) {
      pending = Promise.resolve().then(() => this.readRepository(target, true));
      this.idSnapshots.set(key, pending);
    }
    return pending;
  }

  /**
   * Read release metadata and manifests. In ids-only mode, only the newest release of each
   * tag family (tag minus its trailing version) is opened: versions of one collection share an id.
   * @param target
   * @param idsOnly
   */
  private async readRepository(target: GitHubRepositoryTarget, idsOnly: boolean): Promise<RepositoryReleases> {
    const seenFamilies = new Set<string>();
    const result: RepositoryReleases = { identities: [], hasUnknownData: false, problems: [] };
    const unknown = (failure: FailureReason): void => {
      result.hasUnknownData = true;
      result.problems.push(failure);
    };
    const explain = (error: unknown): FailureReason => error instanceof ReleaseDataError ? error.failure : describeFailure(error);
    const manifests = new Map<string, Promise<ManifestIdentity>>();
    try {
      const api = this.apiForRepository(`https://${target.host}/${target.owner}/${target.repository}`);
      for (let page = 1; ; page++) {
        const releases = await api.getJson<unknown>(`/repos/${target.owner}/${target.repository}/releases?per_page=${PAGE_SIZE}&page=${page}`);
        if (!Array.isArray(releases)) {
          unknown({ reason: 'GitHub returned an unexpected response for the releases list.', hint: 'Retry the check.' });
          break;
        }
        for (let offset = 0; offset < releases.length; offset += 10) {
          const batch = await Promise.all(releases.slice(offset, offset + 10).map(async (value) => {
            const identities: ReleaseIdentity[] = [];
            try {
              const release = publishedRelease(value, target);
              if (!release || !release.assets.some((asset) => isArchiveAsset(asset.name))) {
                return identities;
              }
              if (idsOnly) {
                const family = tagFamily(release.tagName);
                if (seenFamilies.has(family)) {
                  return identities;
                }
                seenFamilies.add(family);
              }
              for (const asset of release.assets.filter((candidate) => isManifestAsset(candidate.name))) {
                try {
                  const key = `${asset.name}:${asset.url}`;
                  let manifest = manifests.get(key);
                  if (!manifest) {
                    manifest = readManifest(api, asset);
                    manifests.set(key, manifest);
                  }
                  identities.push({ ...await manifest, tagName: release.tagName });
                } catch (error) {
                  const failure = explain(error);
                  unknown({ reason: `Release '${release.tagName}': ${failure.reason}`, hint: failure.hint });
                }
              }
            } catch (error) {
              unknown(explain(error));
            }
            return identities;
          }));
          result.identities.push(...batch.flat());
        }
        if (releases.length < PAGE_SIZE) {
          break;
        }
      }
    } catch (error) {
      unknown(explain(error));
    }
    return result;
  }

  /**
   * Canonical manifest IDs, not generated runtime bundle IDs, for Hub comparisons.
   * @param repository
   * @param sourceId
   * @param options `idsOnly` opens one release per tag family; use it for context sources.
   * @param options.idsOnly
   */
  public async listCollections(repository: string, sourceId: string, options: { idsOnly?: boolean } = {}): Promise<HubCollectionInventory> {
    try {
      const target = parseGitHubRepositoryTarget(repository);
      const snapshot = await this.snapshot(target, options.idsOnly === true);
      const collections = new Map<string, GovernanceCollection>();
      for (const manifest of snapshot.identities) {
        const id = canonicalManifestId(manifest, target);
        collections.set(id, { id, sourceId, repository });
      }
      return {
        collections: [...collections.values()],
        unverifiedSources: snapshot.hasUnknownData ? [{ sourceId, ...unverified(snapshot) }] : []
      };
    } catch {
      return { collections: [], unverifiedSources: [{ sourceId, message: 'The source url is not a GitHub repository address.', hint: 'Use https://github.com/<owner>/<repo> as the source url.' }] };
    }
  }

  public async lookup(collection: GovernanceCollection): Promise<ReleaseLookupResult> {
    try {
      if (!isNonEmptyString(collection.repository) || !isNonEmptyString(collection.id)) {
        return { status: 'unverified', message: 'No repository is known for this collection.', hint: 'Supply --repository <owner/repo>.' };
      }
      const target = parseGitHubRepositoryTarget(collection.repository);
      const releases = await this.snapshot(target);
      const matched = releases.identities.some((manifest) => collection.id === canonicalManifestId(manifest, target)
        || collection.id === manifest.id
        || collection.id === generateBundleId(`${target.owner}/${target.repository}`, manifest.id, manifest.version)
        || collection.id === generateGitHubReleaseBundleId(target.owner, target.repository, manifest.tagName, manifest.id, manifest.version));
      if (matched) {
        return { status: 'published' };
      }
      return releases.hasUnknownData
        ? { status: 'unverified', ...unverified(releases) }
        : { status: 'missing' };
    } catch {
      // Never propagate HTTP bodies, raw URLs, credentials or parser errors.
      return { status: 'unverified', message: UNVERIFIED.reason, hint: UNVERIFIED.hint };
    }
  }
}

/**
 * Tag without its trailing semantic version: `my-collection-v1.2.0` → `my-collection`.
 * Tags with no version form their own family, so they are always opened.
 * @param tagName
 */
function tagFamily(tagName: string): string {
  const family = tagName.replace(/[-_@]?v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u, '');
  return family === tagName || family === '' ? `\u0000${tagName}` : family;
}

/**
 * Message and hint for unknown release data, from the recorded problems.
 * @param snapshot
 */
function unverified(snapshot: RepositoryReleases): { message: string; hint: string } {
  const failure = snapshot.problems.length > 0 ? combineFailures(snapshot.problems.slice(0, 5)) : UNVERIFIED;
  return { message: failure.reason, hint: failure.hint };
}

function canonicalManifestId(manifest: ManifestIdentity, target: GitHubRepositoryTarget): string {
  const prefix = `${target.owner}-${target.repository}-`;
  for (const suffix of [`-v${manifest.version}`, `-${manifest.version}`]) {
    if (manifest.id.startsWith(prefix) && manifest.id.endsWith(suffix)) {
      return manifest.id.slice(prefix.length, -suffix.length);
    }
  }
  return manifest.id;
}
