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
