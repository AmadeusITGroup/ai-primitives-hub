/**
 * Domain layer — Bundle ID generation.
 *
 * This is the reference implementation. The extension's
 * `src/utils/bundleNameUtils.ts` (`generateBuildScriptBundleId`) must stay
 * in sync with it until that call site is migrated onto this implementation
 * (migration plan §7.5/§7.7). The legacy `lib/src/bundle-id.ts` is frozen and
 * may diverge: it replaces only the first `/` in the repo slug, while this
 * implementation replaces every `/`. Format:
 * `{owner}-{repo}-{collectionId}-v{version}`.
 * @module domain/bundle/id
 */

/**
 * Generate the canonical bundle ID for a collection.
 * @param repoSlug - Repository slug (`owner/repo` or already-hyphenated `owner-repo`).
 * @param collectionId - Collection identifier.
 * @param version - Version string, without a leading `v`.
 * @returns Canonical bundle ID, e.g. `owner-repo-my-collection-v1.0.0`.
 */
export function generateBundleId(repoSlug: string, collectionId: string, version: string): string {
  const normalizedSlug = repoSlug.replaceAll('/', '-');
  return `${normalizedSlug}-${collectionId}-v${version}`;
}

/**
 * Generate the canonical bundle ID for a GitHub release, as fetched at
 * runtime by the GitHub source adapter.
 *
 * IMPORTANT: this is a *distinct* format from {@link generateBundleId}
 * (ported from `src/utils/bundleNameUtils.ts`'s `generateGitHubBundleId`,
 * not `generateBuildScriptBundleId`) — no `v` prefix before the version,
 * and it falls back to the raw release tag when the manifest doesn't
 * declare its own collection id. Do not consolidate these two: they are
 * used by different producers (build-time collection bundler vs. the
 * runtime GitHub adapter reading whatever a release happens to contain)
 * that must keep matching their own historical ID format for
 * already-published bundles.
 * @param owner - Repository owner.
 * @param repo - Repository name.
 * @param tagName - Git tag name of the release (e.g. `v1.0.0`).
 * @param manifestId - Collection id from the release's deployment manifest, if present.
 * @param manifestVersion - Version from the release's deployment manifest, if present.
 * @returns Canonical bundle ID, e.g. `owner-repo-my-collection-1.0.0` or, lacking
 * a manifest id, `owner-repo-v1.0.0`.
 */
export function generateGitHubReleaseBundleId(
  owner: string,
  repo: string,
  tagName: string,
  manifestId?: string,
  manifestVersion?: string
): string {
  const cleanVersion = manifestVersion ?? tagName.replace(/^v/, '');
  return manifestId ? `${owner}-${repo}-${manifestId}-${cleanVersion}` : `${owner}-${repo}-${tagName}`;
}

/**
 * Check whether a manifest's declared id/version match a bundle id.
 *
 * For GitHub-sourced collection bundles, the manifest may declare just
 * the collection id (e.g. `my-collection`) while the bundle id is the
 * full computed id produced by {@link generateGitHubReleaseBundleId}
 * (e.g. `owner-repo-my-collection-1.0.0` or `owner-repo-my-collection-v1.0.0`).
 * This accepts an exact match as well as both suffix forms, with or
 * without the `v` version prefix.
 *
 * This is the single implementation of the manifest-id rules: the CLI and
 * the VS Code extension both reach it through `validateManifest()`.
 * When the source repository is known, prefer
 * {@link isSourceAwareManifestIdMatch}, which also accepts the versionless
 * `{owner}-{repo}-{manifestId}` form through {@link parseBundleId}.
 * @param manifestId - The `id` field from the deployment manifest.
 * @param manifestVersion - The `version` field from the deployment manifest.
 * @param bundleId - The computed bundle id to match against.
 * @returns `true` if `manifestId`/`manifestVersion` identify `bundleId`.
 */
export function isManifestIdMatch(manifestId: string, manifestVersion: string, bundleId: string): boolean {
  return manifestId === bundleId
    || bundleId.endsWith(`-${manifestId}-v${manifestVersion}`)
    || bundleId.endsWith(`-${manifestId}-${manifestVersion}`);
}

/**
 * Components of a bundle id, as returned by {@link parseBundleId}.
 */
export interface ParsedBundleId {
  /** Bundle (collection) name, without the repo prefix and version suffix. */
  name: string;
  /** Bare version (no leading `v`), or `null` when the id carries no version. */
  version: string | null;
}

/** Optional `-x.y.z[-pre]` / `-vx.y.z[-pre]` suffix of a bundle id. */
const BUNDLE_ID_VERSION_SUFFIX = /-v?(\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-zA-Z0-9._-]{1,50})?)$/;

/**
 * Split a bundle id into its bundle name and optional version, using the
 * repository it comes from.
 *
 * GitHub bundle ids have the shape `{owner}-{repo}-{name}[-[v]{version}]`.
 * Owners, repos and names may all contain dashes, so the id alone is
 * ambiguous (`a-b-c-d` could be repo `a/b` + name `c-d` or repo `a/b-c` +
 * name `d`). The repo slug must therefore come from the source the bundle
 * is fetched from; this function never guesses it from the id.
 *
 * The `{owner}-{repo}-` prefix is compared case-insensitively (GitHub
 * owners and repos are case-insensitive, hub ids are usually lowercase).
 * When the id does not start with the prefix, it is treated as a bare
 * bundle name (e.g. an id taken from a primitive index).
 * @param bundleId - Bundle id to parse.
 * @param repoSlug - Source repository slug (`owner/repo`).
 * @returns Parsed bundle name and version.
 */
export function parseBundleId(bundleId: string, repoSlug: string): ParsedBundleId {
  const versionMatch = BUNDLE_ID_VERSION_SUFFIX.exec(bundleId);
  const version = versionMatch === null ? null : versionMatch[1];
  const withoutVersion = versionMatch === null ? bundleId : bundleId.slice(0, versionMatch.index);
  const repoPrefix = `${repoSlug.replaceAll('/', '-')}-`.toLowerCase();
  const name = withoutVersion.toLowerCase().startsWith(repoPrefix) && withoutVersion.length > repoPrefix.length
    ? withoutVersion.slice(repoPrefix.length)
    : withoutVersion;
  return { name, version };
}

/**
 * Check whether a manifest's declared id/version match a bundle id that
 * comes from a known source repository.
 *
 * Accepts everything {@link isManifestIdMatch} accepts, plus ids whose
 * parsed name ({@link parseBundleId}) equals `manifestId` exactly and whose
 * parsed version, when present, equals `manifestVersion`. The addition
 * covers the versionless and versioned `{owner}-{repo}-{manifestId}` ids
 * hub profiles use for the given repo (and a bare `{manifestId}` with an
 * optional version). It does not narrow the legacy rule: for compatibility,
 * an exact id match or a `…-{manifestId}-[v]{manifestVersion}` suffix is
 * still accepted whatever prefix precedes it, including another repo's.
 * @param manifestId - The `id` field from the deployment manifest.
 * @param manifestVersion - The `version` field from the deployment manifest.
 * @param bundleId - The bundle id to match against.
 * @param repoSlug - Source repository slug (`owner/repo`).
 * @returns `true` if `manifestId`/`manifestVersion` identify `bundleId`.
 */
export function isSourceAwareManifestIdMatch(
  manifestId: string,
  manifestVersion: string,
  bundleId: string,
  repoSlug: string
): boolean {
  if (isManifestIdMatch(manifestId, manifestVersion, bundleId)) {
    return true;
  }
  const parsed = parseBundleId(bundleId, repoSlug);
  return parsed.name === manifestId && (parsed.version === null || parsed.version === manifestVersion);
}
