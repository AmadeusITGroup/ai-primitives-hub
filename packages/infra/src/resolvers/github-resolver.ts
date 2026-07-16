/**
 * GitHubBundleResolver.
 *
 * Resolves a `BundleSpec` against a GitHub repository's releases,
 * mirroring `GitHubAdapter.fetchBundles + getDownloadUrl` from the
 * VS Code extension. Produces an `Installable` whose `downloadUrl`
 * points at the release asset that `BundleDownloader` will fetch.
 *
 * The `SourceAdapter` (`adapters/github-adapter.ts`) vs `BundleResolver`
 * (this file) split is intentional and stays: `GitHubAdapter` lists every
 * bundle in a source for marketplace browsing, this resolver looks up a
 * single `BundleSpec` for CLI `install <spec>` — different call shapes for
 * different consumers, not the same responsibility twice.
 *
 * What *was* duplicated (now fixed): this resolver used to talk to GitHub
 * via a raw `HttpClient` + `TokenProvider`, reimplementing auth headers and
 * error handling that `core`'s `GitHubApi` port + `infra`'s
 * `GitHubApiClient` already provide — with none of that client's retry/
 * backoff/rate-limit handling. Now takes a `GitHubApi` directly, same as
 * `GitHubAdapter`, so both share one hardened GitHub transport.
 *
 * Dropped in that move: automatic repo-slug update on a GitHub redirect
 * (e.g. a renamed repository) that the old raw-`HttpClient` path derived
 * from the response's `finalUrl`. The redirect itself is still followed
 * (data comes back correctly either way) — only the *display* slug used
 * for bundle-ID decomposition/`sourceId` could stay stale for a renamed
 * repo. This was untested and `GitHubAdapter` never had it either; not
 * worth keeping a resolver-only special case for.
 * @module resolvers/github-resolver
 */
import {
  type BundleResolver,
  type BundleSpec,
  generateSourceId,
  type GitHubApi,
  type Installable,
} from '@ai-primitives-hub/core';

/**
 * Minimal shape of GitHub's `/releases` API response (subset we use).
 */
/* eslint-disable @typescript-eslint/naming-convention -- GitHub REST API field names are fixed external identifiers */
interface GitHubRelease {
  tag_name: string;
  name?: string;
  assets: { name: string; browser_download_url: string; url?: string }[];
  draft?: boolean;
  prerelease?: boolean;
}
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Options for GitHubBundleResolver.
 */
export interface GitHubResolverOptions {
  /** GitHub repo slug, e.g. `owner/repo`. */
  repoSlug: string;
  /** Asset filename within each release; defaults to `bundle.zip`. */
  assetName?: string;
  /**
   * GitHub API client. Configure its own `baseUrl` for GHES — the resolver
   * always calls relative paths (`/repos/...`) so it inherits whatever base
   * the caller configured.
   */
  githubApi: GitHubApi;
}

/**
 * Resolver that lists releases of a GitHub repo and matches them
 * against a `BundleSpec`. Returns a single `Installable` whose
 * `downloadUrl` is the release-asset URL.
 *
 * Caches the release list per instance to avoid repeated API calls
 * when `resolve` is invoked multiple times in one process.
 */
/* eslint-disable @typescript-eslint/member-ordering -- public surface first, private helpers below */
export class GitHubBundleResolver implements BundleResolver {
  private cachedReleases: GitHubRelease[] | null = null;

  /**
   * Create a GitHubBundleResolver.
   * @param opts Options for the resolver.
   */
  constructor(private readonly opts: GitHubResolverOptions) {
    // Intentionally empty
  }

  /**
   * Find the latest release for a specific bundle.
   * @param releases All releases.
   * @param bundleName Bundle name to match.
   * @returns Latest release or undefined.
   */
  private findLatestRelease(releases: GitHubRelease[], bundleName: string | null): GitHubRelease | undefined {
    const matchingReleases = releases.filter((r) =>
      r.draft !== true && r.prerelease !== true && (bundleName === null || r.tag_name.startsWith(bundleName))
    );
    if (matchingReleases.length === 0) {
      const allReleases = releases.filter((r) => r.draft !== true && r.prerelease !== true);
      if (allReleases.length === 0) {
        return undefined;
      }
      return allReleases[0];
    }
    const withVersions = matchingReleases
      .map((r) => ({ release: r, version: extractSemver(r.tag_name) }))
      .filter((item) => item.version !== null) as { release: GitHubRelease; version: string }[];
    if (withVersions.length === 0) {
      return matchingReleases[0];
    }
    withVersions.sort((a, b) => {
      const partsA = a.version.split('.').map(Number);
      const partsB = b.version.split('.').map(Number);
      for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const partA = partsA[i] ?? 0;
        const partB = partsB[i] ?? 0;
        if (partA !== partB) {
          return partB - partA;
        }
      }
      return 0;
    });
    return withVersions[0].release;
  }

  /**
   * Find a release with a specific version.
   * @param releases All releases.
   * @param bundleName Bundle name to match.
   * @param wantVersion Version to find.
   * @returns Release or undefined.
   */
  private findSpecificRelease(releases: GitHubRelease[], bundleName: string | null, wantVersion: string): GitHubRelease | undefined {
    // First try to find a release that matches both bundle name and version
    const match = releases.find((r) => (bundleName === null || r.tag_name.startsWith(bundleName)) && extractSemver(r.tag_name) === wantVersion);
    if (match !== undefined) {
      return match;
    }
    // Fallback: try to find any release with the matching version (ignoring bundle name prefix)
    // This handles cases where the primitive index bundle ID doesn't match the actual release tag name
    const versionMatch = releases.find((r) => extractSemver(r.tag_name) === wantVersion);
    if (versionMatch !== undefined) {
      return versionMatch;
    }
    // Second fallback: try to find a release where the tag starts with the version (handles prereleases like v0.0.0-prerelease.1)
    const prefixMatch = releases.find((r) => (bundleName === null || r.tag_name.startsWith(bundleName)) && r.tag_name.startsWith(`v${wantVersion}`));
    if (prefixMatch !== undefined) {
      return prefixMatch;
    }
    // Third fallback: try to find any release where the tag starts with the version (ignoring bundle name)
    const versionPrefixMatch = releases.find((r) => r.tag_name.startsWith(`v${wantVersion}`));
    return versionPrefixMatch;
  }

  /**
   * Find the matching asset from a release.
   * @param release Release to search.
   * @param bundleId Bundle ID for asset naming.
   * @returns Asset or undefined.
   */
  private findAsset(release: GitHubRelease, bundleId: string): GitHubRelease['assets'][number] | undefined {
    const candidates = this.assetCandidates(bundleId);
    for (const candidate of candidates) {
      const asset = candidate === '*.bundle.zip' ? release.assets.find((a) => a.name.endsWith('.bundle.zip')) : release.assets.find((a) => a.name === candidate);
      if (asset !== undefined) {
        return asset;
      }
    }
    return undefined;
  }

  /**
   * Find an Installable for the given spec.
   * @param spec Parsed BundleSpec.
   * @returns Installable, or `null` when the bundle is not present.
   */
  public async resolve(spec: BundleSpec): Promise<Installable | null> {
    const releases = await this.listReleases();
    if (releases.length === 0) {
      return null;
    }
    const { collection: bundleName } = decomposeBundleId(spec.bundleId, this.opts.repoSlug);
    const wantVersion = spec.bundleVersion;
    const release: GitHubRelease | undefined = wantVersion === undefined || wantVersion === 'latest'
      ? this.findLatestRelease(releases, bundleName)
      : this.findSpecificRelease(releases, bundleName, wantVersion);
    if (release === undefined) {
      return null;
    }
    const asset = this.findAsset(release, spec.bundleId);
    if (asset === undefined) {
      return null;
    }
    const sourceId = generateSourceId('github', `https://github.com/${this.opts.repoSlug}`);
    const tag = extractSemver(release.tag_name) ?? release.tag_name.replace(/^v/, '');
    return {
      ref: {
        sourceId,
        sourceType: 'github',
        bundleId: spec.bundleId,
        bundleVersion: tag,
        installed: false
      },
      downloadUrl: asset.url ?? asset.browser_download_url
    };
  }

  /**
   * Build the asset-name candidate list per I-003.
   * @param bundleId
   */
  private assetCandidates(bundleId: string): string[] {
    if (this.opts.assetName !== undefined) {
      return [this.opts.assetName];
    }
    return ['bundle.zip', `${bundleId}.bundle.zip`, '*.bundle.zip'];
  }

  /**
   * GET /repos/{owner}/{repo}/releases via the injected `GitHubApi`.
   * Cached per resolver instance. A 404 (repo not found/inaccessible) is
   * treated as an empty release list rather than a thrown error, so
   * `resolve()` can return `null` instead of surfacing a raw HTTP error.
   * @returns Releases array (newest first per GitHub default ordering).
   */
  private async listReleases(): Promise<GitHubRelease[]> {
    if (this.cachedReleases !== null) {
      return this.cachedReleases;
    }
    let releases: GitHubRelease[];
    try {
      releases = await this.opts.githubApi.getJson<GitHubRelease[]>(`/repos/${this.opts.repoSlug}/releases`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        this.cachedReleases = [];
        return [];
      }
      throw error;
    }
    this.cachedReleases = releases;
    return releases;
  }
}

/**
 * Extract the semver portion from a release tag, handling all
 * common conventions (bare, v-prefixed, prerelease, suffixed).
 *
 * Examples:
 *   "v1.2.3"                   -> "1.2.3"
 *   "1.2.3"                    -> "1.2.3"
 *   "1.2.3-rc.1"               -> "1.2.3-rc.1"
 *   "dsre-git-skillset-v0.1.0" -> "0.1.0"
 *   "my-bundle-1.0.0"          -> "1.0.0"
 *   "release"                  -> null
 * @param tag Release tag.
 * @returns Bare semver or null.
 */
export const extractSemver = (tag: string): string | null => {
  const m = /(?:^|-)v?(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/.exec(tag);
  return m === null ? null : m[1];
};

/**
 * Decompose a bundle ID into its components: source (owner-repo), collection, and version.
 * This makes the mechanism resilient to repository renames by separating the collection name
 * from the repository name.
 * @param bundleId Bundle ID to decompose.
 * @param repoSlug Repository slug (e.g., "owner/some.repo-name").
 * @returns Object with source, collection, and version components.
 */
const decomposeBundleId = (bundleId: string, repoSlug: string): { source: string | null; collection: string | null; version: string | null } => {
  // Convention: the bundle ID format is {owner}-{repo}-{collection}-{version}
  // The repo may contain dots (e.g., "genai.clean-code-in-the-cloud-skills-collection")
  // We need to extract the collection name by removing the repo prefix from the bundle ID
  // First, extract the version suffix if present
  const versionPattern = /-v?\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-zA-Z0-9._-]{1,50})?$/;
  const versionMatch = versionPattern.exec(bundleId);
  const version = versionMatch ? versionMatch[0] : null;
  const withoutVersion = bundleId.replace(versionPattern, '');

  // Convert repoSlug to bundle ID format (replace '/' with '-')
  const repoPrefix = repoSlug.replace('/', '-');

  // The bundle ID format is {owner}-{repo}-{collection}
  // Remove the repo prefix from the bundle ID to get the collection
  if (withoutVersion.startsWith(repoPrefix + '-')) {
    const collection = withoutVersion.slice(repoPrefix.length + 1);
    const source = withoutVersion.slice(0, repoPrefix.length);
    return { source, collection, version };
  }

  // Fallback: if the bundle ID doesn't start with the repo prefix,
  // assume it's already the collection name (e.g., from primitive index)
  // Use the repoSlug as the source
  return { source: repoSlug, collection: withoutVersion, version };
};
