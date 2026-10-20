/**
 * Domain layer — Bundle types.
 *
 * `Bundle` is the catalog/runtime entry as fetched from a source adapter and
 * shown to users (Marketplace, `cli index search`, etc.). It is distinct
 * from `Collection` (`../collection/types.ts`), which is the pre-build,
 * author-facing shape of a `deployment-manifest.yml`.
 *
 * Mirrors the shape already in production at
 * `src/types/registry.ts` (`Bundle`, `BundleDependency`, `BundleUpdate`) so
 * that the extension's `RegistryManager`/`BundleInstaller` can eventually
 * delegate to this type with zero field-mapping (see migration plan §7.5).
 * @module domain/bundle/types
 */

import type {
  SourceType,
} from '../source/types';
import {
  extractBundleIdentity,
} from './version';

/**
 * Bundle metadata as surfaced by a source adapter.
 */
export interface Bundle {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  sourceId: string;
  environments: string[];
  tags: string[];
  downloads?: number;
  rating?: number;
  lastUpdated: string;
  size: string;
  dependencies: BundleDependency[];
  homepage?: string;
  repository?: string;
  license: string;
  manifestUrl: string;
  downloadUrl: string;
  /** True if the bundle was surfaced via a curated hub rather than a raw source. */
  isCurated?: boolean;
  /** Name of the curated hub, when `isCurated` is true. */
  hubName?: string;
  checksum?: {
    algorithm: string;
    hash: string;
  };
  /** URL to the README asset (if available). */
  readmeUrl?: string;
  /** Cached README text content. */
  readme?: string;
  /** Source revision the cached readme corresponds to (e.g. release tag, commit sha). */
  readmeRevision?: string;
}

/**
 * A dependency a bundle declares on another bundle.
 */
export interface BundleDependency {
  bundleId: string;
  versionRange: string;
  optional: boolean;
}

/**
 * Result of comparing an installed bundle's version against its source.
 */
export interface BundleUpdate {
  bundleId: string;
  currentVersion: string;
  latestVersion: string;
  changelog?: string;
}

/**
 * Identifies one specific bundle version from one specific source, for the
 * harvest/search subsystem (`infra/harvest`, `infra/search`). Distinct
 * from `Bundle` above: `Bundle` is the rich, source-adapter-shaped catalog
 * entry (name/description/downloads/checksum/... for the Marketplace UI);
 * `BundleRef` is the minimal, stable coordinate a `Primitive` (below) is
 * harvested from and a `BundleProvider` enumerates — no adapter needs to
 * exist yet for a `BundleRef` to make sense (e.g. a local folder scan).
 */
export interface BundleRef {
  sourceId: string;
  sourceType: string;
  bundleId: string;
  bundleVersion: string;
  installed: boolean;
}

/**
 * Stable identity for one source-qualified bundle version.
 *
 * The separator is intentionally not user-facing; callers should treat the
 * result as an opaque key shared by index records and installation snapshots.
 * @param ref
 */
export function getBundleRefKey(ref: Pick<BundleRef, 'sourceId' | 'bundleId' | 'bundleVersion'>): string {
  return `${ref.sourceId}\u0000${ref.bundleId}\u0000${ref.bundleVersion}`;
}

/**
 * Version-agnostic identity for a source-qualified bundle.
 *
 * Used by the query-time installation overlay when an index record carries a
 * Git commit SHA (`GitHubSingleBundleProvider`, `AwesomeCopilotBundleProvider`)
 * or a consolidated latest semver version that differs from the user's
 * currently installed version.
 * @param ref
 */
export function getBundleIdentityKey(ref: Pick<BundleRef, 'sourceId' | 'bundleId'>): string {
  return `${ref.sourceId}\u0000${ref.bundleId}`;
}

const NORMALIZED_INSTALLED_KEYS_MARKER = '\u0000__normalized__';

/**
 * Extract the canonical bundle identity, falling back to the raw `bundleId`
 * when `extractBundleIdentity` throws (for example, when `bundleId` exceeds
 * `MAX_BUNDLE_ID_LENGTH`).
 * @param bundleId
 * @param sourceType
 */
export function safeExtractBundleIdentity(bundleId: string, sourceType: SourceType): string {
  try {
    return extractBundleIdentity(bundleId, sourceType);
  } catch {
    return bundleId;
  }
}

/**
 * Build lookup keys for an installed bundle so query-time installation overlays
 * match exact `(sourceId, bundleId, bundleVersion)` refs, version-agnostic
 * `(sourceId, bundleId)` refs, and source-level GitHub bundle refs.
 * @param entry
 * @param entry.sourceId
 * @param entry.bundleId
 * @param entry.bundleVersion
 * @param entry.sourceType
 */
export function buildInstalledBundleLookupKeys(entry: {
  sourceId: string;
  bundleId: string;
  bundleVersion?: string;
  sourceType?: string;
}): string[] {
  const keys = new Set<string>([
    getBundleIdentityKey({ sourceId: entry.sourceId, bundleId: entry.bundleId }),
    getBundleIdentityKey({ sourceId: entry.sourceId, bundleId: entry.sourceId })
  ]);
  if (entry.bundleVersion !== undefined && entry.bundleVersion.length > 0) {
    keys.add(getBundleRefKey({
      sourceId: entry.sourceId,
      bundleId: entry.bundleId,
      bundleVersion: entry.bundleVersion
    }));
  }
  const baseId = safeExtractBundleIdentity(entry.bundleId, (entry.sourceType ?? 'github') as SourceType);
  if (baseId !== entry.bundleId) {
    keys.add(getBundleIdentityKey({ sourceId: entry.sourceId, bundleId: baseId }));
    if (entry.bundleVersion !== undefined && entry.bundleVersion.length > 0) {
      keys.add(getBundleRefKey({
        sourceId: entry.sourceId,
        bundleId: baseId,
        bundleVersion: entry.bundleVersion
      }));
    }
  }
  return [...keys];
}

/**
 * Expand a list or set of raw installed-bundle keys (3-part `getBundleRefKey`
 * or 2-part `getBundleIdentityKey`) into a normalized lookup set.
 * @param installedBundleKeys
 */
export function normalizeInstalledBundleKeys(installedBundleKeys: Iterable<string>): Set<string> {
  if (installedBundleKeys instanceof Set && installedBundleKeys.has(NORMALIZED_INSTALLED_KEYS_MARKER)) {
    return installedBundleKeys as Set<string>;
  }
  const expanded = new Set<string>([NORMALIZED_INSTALLED_KEYS_MARKER]);
  for (const rawKey of installedBundleKeys) {
    expanded.add(rawKey);
    const parts = rawKey.split('\u0000');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      const [sourceId, bundleId, bundleVersion] = parts;
      for (const key of buildInstalledBundleLookupKeys({ sourceId, bundleId, bundleVersion })) {
        expanded.add(key);
      }
    }
  }
  return expanded;
}

/**
 * Check whether an indexed `BundleRef` matches the current installed-bundle
 * snapshot.
 * @param ref
 * @param installedBundleKeys
 */
export function isBundleRefInstalled(
  ref: Pick<BundleRef, 'sourceId' | 'bundleId' | 'bundleVersion'> & { sourceType?: string },
  installedBundleKeys: Iterable<string> | ReadonlySet<string>
): boolean {
  const lookup = installedBundleKeys instanceof Set && installedBundleKeys.has(NORMALIZED_INSTALLED_KEYS_MARKER)
    ? installedBundleKeys
    : normalizeInstalledBundleKeys(installedBundleKeys);
  if (lookup.has(getBundleRefKey(ref)) || lookup.has(getBundleIdentityKey(ref))) {
    return true;
  }
  const baseId = safeExtractBundleIdentity(ref.bundleId, (ref.sourceType ?? 'github') as SourceType);
  if (baseId !== ref.bundleId && lookup.has(getBundleIdentityKey({ sourceId: ref.sourceId, bundleId: baseId }))) {
    return true;
  }
  return false;
}

/**
 * The subset of a `deployment-manifest.yml` (or legacy `collection.yml`)
 * the harvester's primitive extractor reads: per-item kind/title/tags
 * hints, plus top-level tags/author as fallbacks. Permissive — unknown
 * keys pass through via the index signature so forward-compat manifest
 * fields don't need a schema bump here.
 */
export interface BundleManifest {
  id: string;
  version: string;
  name?: string;
  description?: string;
  tags?: string[];
  author?: string;
  items?: {
    path: string;
    kind: string;
    title?: string;
    description?: string;
    tags?: string[];
  }[];
  mcp?: {
    items?: Record<string, {
      type?: string;
      command?: string;
      args?: string[];
      url?: string;
      description?: string;
    }>;
  };
  [key: string]: unknown;
}

/**
 * A single file read from a bundle during harvest, relative-path + raw
 * UTF-8 content — the unit `extractFromFile` (`infra/harvest/extractor.ts`)
 * turns into zero or one `Primitive`.
 */
export interface HarvestedFile {
  path: string;
  content: string;
}

/**
 * Adapter-agnostic bundle enumeration + read surface for the harvester.
 * Anything that can list bundles and read their files can feed the
 * harvester: a GitHub tree walk, a local folder scan, an awesome-copilot
 * collection listing, etc. Concrete implementations live in
 * `infra/harvest/bundle-providers/*`.
 */
export interface BundleProvider {
  listBundles(): AsyncIterable<BundleRef>;
  readManifest(ref: BundleRef): Promise<BundleManifest>;
  readFile(ref: BundleRef, relPath: string): Promise<string>;
}
