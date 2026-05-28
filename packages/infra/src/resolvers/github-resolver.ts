/**
 * GitHubBundleResolver.
 *
 * Resolves a `BundleSpec` against a GitHub repository's releases,
 * mirroring `GitHubAdapter.fetchBundles + getDownloadUrl` from the
 * VS Code extension. Produces an `Installable` whose `downloadUrl`
 * points at the release asset that `BundleDownloader` will fetch.
 *
 * Uses a `TokenProvider` rather than reading env directly.
 */
import {
  type BundleResolver,
  type BundleSpec,
  generateSourceId,
  type HttpClient,
  type Installable,
  type TokenProvider,
} from '@prompt-registry/core';

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
  /** API base URL; override for GHES. Defaults to `https://api.github.com`. */
  apiBase?: string;
  /** Required HttpClient for the network calls. */
  http: HttpClient;
  /** Required TokenProvider for auth headers. */
  tokens: TokenProvider;
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
      console.error(`[GitHubBundleResolver] No releases found for ${this.opts.repoSlug}`);
      return null;
    }
    const { collection: bundleName } = decomposeBundleId(spec.bundleId, this.opts.repoSlug);
    console.error(`[GitHubBundleResolver] bundleId=${spec.bundleId}, bundleName=${bundleName}, repoSlug=${this.opts.repoSlug}`);
    console.error(`[GitHubBundleResolver] Available releases: ${releases.map((r) => r.tag_name).join(', ')}`);
    const wantVersion = spec.bundleVersion;
    const release: GitHubRelease | undefined = wantVersion === undefined || wantVersion === 'latest'
      ? this.findLatestRelease(releases, bundleName)
      : this.findSpecificRelease(releases, bundleName, wantVersion);
    if (release === undefined) {
      console.error(`[GitHubBundleResolver] No release found for bundleName=${bundleName}, version=${wantVersion}`);
      return null;
    }
    const asset = this.findAsset(release, spec.bundleId);
    if (asset === undefined) {
      console.error(`[GitHubBundleResolver] No asset found for bundleId=${spec.bundleId} in release ${release.tag_name}`);
      console.error(`[GitHubBundleResolver] Available assets: ${release.assets.map((a) => a.name).join(', ')}`);
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
   * GET /repos/{owner}/{repo}/releases. Cached per resolver instance.
   * Handles GitHub repository redirects (e.g., renames) by following
   * the redirect and updating the repoSlug to the final resolved name.
   * @returns Releases array (newest first per GitHub default ordering).
   */
  private async listReleases(): Promise<GitHubRelease[]> {
    if (this.cachedReleases !== null) {
      return this.cachedReleases;
    }
    const url = `${this.apiBase()}/repos/${this.opts.repoSlug}/releases`;
    const headers = await this.authHeaders();
    headers.Accept = 'application/vnd.github+json';
    headers['X-GitHub-Api-Version'] = '2022-11-28';
    const res = await this.opts.http.fetch({ url, headers });
    if (res.statusCode === 404) {
      this.cachedReleases = [];
      return [];
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(
        `GitHub API ${String(res.statusCode)} for ${url}; body: ${truncate(decode(res.body), 200)}`
      );
    }
    // If the request was redirected, update the repoSlug to match the final repository name
    // This handles repository renames (e.g., "collect" -> "collection")
    if (res.finalUrl && res.finalUrl !== url) {
      const match = /\/repos\/([^/]+\/[^/]+)\/releases/.exec(res.finalUrl);
      const finalRepoSlug = match?.[1];
      if (finalRepoSlug && finalRepoSlug !== this.opts.repoSlug) {
        // Update the repoSlug to the final resolved name
        (this.opts as any).repoSlug = finalRepoSlug;
      }
    }
    const text = decode(res.body);
    const parsed = JSON.parse(text) as GitHubRelease[];
    this.cachedReleases = parsed;
    return parsed;
  }

  /** Build the Authorization header set, deferring to the token provider. */
  private async authHeaders(): Promise<Record<string, string>> {
    const host = new URL(this.apiBase()).hostname;
    const token = await this.opts.tokens.getToken(host);
    return token === null ? {} : { Authorization: `Bearer ${token}` };
  }

  /** Resolve the API base for this resolver. */
  private apiBase(): string {
    return this.opts.apiBase ?? 'https://api.github.com';
  }
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n)}…` : s;

/**
 * Extract the semver portion from a release tag, handling all four
 * conventions documented in I-004. Returns `null` when no semver
 * pattern is found (caller decides whether to fall back).
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
 * @param repoSlug Repository slug (e.g., "Amadeus-xDLC/genai.clean-code-in-the-cloud-skills-collection").
 * @returns Object with source, collection, and version components.
 */
const decomposeBundleId = (bundleId: string, repoSlug: string): { source: string | null; collection: string | null; version: string | null } => {
  // Amadeus convention: the bundle ID format is {owner}-{repo}-{collection}-{version}
  // The repo may contain dots (e.g., "genai.clean-code-in-the-cloud-skills-collection")
  // We need to extract the collection name by removing the repo prefix from the bundle ID
  // Examples:
  //   "Amadeus-xDLC-genai.clean-code-in-the-cloud-skills-collection-amadeus-microservice-coding-guidebook-v1.0.1" -> collection: "amadeus-microservice-coding-guidebook", version: "v1.0.1"
  //   "Amadeus-xDLC-genai.clean-code-in-the-cloud-skills-collection-amadeus-microservice-coding-guidebook" -> collection: "amadeus-microservice-coding-guidebook", version: null
  //   "Amadeus-xDLC-genai.clean-code-in-the-cloud-skills-collection-skubedocs" -> collection: "skubedocs", version: null
  //   "offer-agent-skills" -> collection: "offer-agent-skills", version: null (fallback for primitive index bundle IDs)

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
