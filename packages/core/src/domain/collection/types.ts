/**
 * Domain layer — Collection types.
 *
 * `Collection` is the pre-build, author-facing shape of a directory that
 * validates and builds into a `Bundle` (`../bundle/types.ts`) — mirrors
 * `lib/src/types.ts` (`Collection`, `CollectionItem`) and the
 * `deployment-manifest.yml` schema described in
 * `docs/author-guide/collection-schema.md`.
 *
 * `DeploymentManifest` mirrors the production shape at
 * `src/types/registry.ts` verbatim (field names/casing match the on-disk
 * YAML schema and must not be reformatted to camelCase).
 * @module domain/collection/types
 */
import type {
  PrimitiveKind,
} from '../primitive/types';

/**
 * Compression formats supported when packaging a bundle.
 */
export type CompressionFormat = 'zip' | 'tar.gz' | 'tar.bz2' | 'tar.xz' | 'none';

/**
 * A single item (prompt, instruction, chat mode, agent, skill, ...) declared
 * by a collection.
 */
export interface CollectionItem {
  path: string;
  kind: string;
  name?: string;
  description?: string;
  tags?: string[];
}

/**
 * Author-facing collection definition, prior to being built into a
 * distributable `Bundle`.
 */
export interface Collection {
  id: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  tags?: string[];
  readme?: {
    path: string;
  };
  items: CollectionItem[];
}

/**
 * Result of validating a single field (collection id, version, item kind).
 *
 * Named `CollectionFieldValidationResult` (not the reference branch's bare
 * `ValidationResult`) to avoid colliding with the differently-shaped
 * `ValidationResult` already exported by `domain/source/types.ts`
 * (`{ valid, errors: string[], warnings? }`, used by `app/registry/hub-manager.ts`)
 * — both are wildcard re-exported from the same `domain/index.ts` barrel.
 */
export interface CollectionFieldValidationResult {
  valid: boolean;
  error?: string;
  normalized?: string;
  deprecated?: boolean;
  replacement?: string;
}

/**
 * Result of validating a parsed collection object's structure.
 */
export interface ObjectValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Result of validating a collection file on disk (parse + structure).
 */
export interface FileValidationResult extends ObjectValidationResult {
  warnings?: string[];
  collection?: Collection;
}

/**
 * Aggregate result of validating every collection file in a repository.
 */
export interface AllCollectionsResult extends ObjectValidationResult {
  warnings: string[];
  fileResults: ({ file: string } & FileValidationResult)[];
}

/**
 * Configurable rules used by the collection validators.
 */
export interface ValidationRules {
  collectionId: {
    maxLength: number;
    pattern: RegExp;
    description: string;
  };
  version: {
    pattern: RegExp;
    default: string;
    description: string;
  };
  itemKinds: string[];
  deprecatedKinds: Record<string, string>;
}

/**
 * Result of `version compute` — the next semver version + git tag for a collection.
 */
export interface VersionInfo {
  collectionId: string;
  collectionFile: string;
  lastVersion: string | null;
  manualVersion: string;
  nextVersion: string;
  tag: string;
}

/**
 * Result of `bundle build` — the on-disk artifacts produced for a collection.
 */
export interface BundleInfo {
  collectionId: string;
  version: string;
  outDir: string;
  manifestAsset: string;
  zipAsset: string;
  bundleId: string;
}

/**
 * Parsed `deployment-manifest.yml` — the build spec a `Collection` compiles
 * to. Field names intentionally match the on-disk YAML schema
 * (`snake_case` for schema-defined keys).
 */
export interface DeploymentManifest {
  common: {
    directories: string[];
    files: string[];
    // eslint-disable-next-line @typescript-eslint/naming-convention -- matches external API property name
    include_patterns: string[];
    // eslint-disable-next-line @typescript-eslint/naming-convention -- matches external API property name
    exclude_patterns: string[];
  };
  environments?: {
    [key: string]: {
      name: string;
      description: string;
      directories: string[];
      files: string[];
      // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
      include_patterns: string[];
      // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
      exclude_patterns: string[];
      // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
      bundle_structure?: {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
        preserve_paths: boolean;
        // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
        root_folder: string;
      };
      metadata?: Record<string, unknown>;
    };
  };
  // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
  bundle_settings: {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
    include_common_in_environment_bundles: boolean;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
    create_common_bundle: boolean;
    compression: CompressionFormat;
    naming: {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
      common_bundle?: string;
      // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
      environment_bundle: string;
      // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
      full_bundle?: string;
    };
    isCurated?: boolean;
    hubName?: string;
    checksum?: {
      enabled: boolean;
      algorithms: string[];
    };
    // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
    output_directory?: string;
  };
  metadata: {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
    manifest_version: string;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
    prompt_library_version?: string;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
    last_updated?: string;
    description: string;
    author?: string;
    homepage?: string;
    repository?: {
      type: string;
      url: string;
      directory?: string;
    };
    license?: string;
    keywords?: string[];
    compatibility?: {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
      min_manifest_version?: string;
      platforms?: string[];
    };
  };
  hooks?: {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
    pre_bundle?: string[];
    // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
    post_bundle?: string[];
    // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
    pre_install?: string[];
    // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
    post_install?: string[];
  };
  prompts?: {
    id: string;
    name: string;
    description: string;
    file: string;
    tags?: string[];
    type?: 'prompt' | 'instructions' | 'chatmode' | 'agent' | 'skill';
  }[];
  /**
   * MCP server declarations. Loosely typed pending a dedicated
   * `domain/mcp` module — not required by any Phase 2 consumer yet.
   */
  mcpServers?: Record<string, unknown>;
}

/**
 * Version of the self-contained release deployment-manifest contract.
 *
 * This is deliberately separate from the legacy {@link DeploymentManifest}
 * build-spec shape above. The legacy format remains readable for existing
 * releases; a release opts into the governed archive contract by declaring
 * this format version.
 */
export const RELEASE_DEPLOYMENT_MANIFEST_FORMAT_VERSION = 1 as const;

/**
 * How a file carried by a release archive participates in installation.
 *
 * `installable` files are passed to a target writer. `metadata` files retain
 * provenance, licensing, and documentation evidence inside the archive but
 * are never routed into an IDE target. `ignored` records make intentionally
 * retained non-runtime content visible to policy without installing it.
 */
export type ReleaseManifestFileRole = 'installable' | 'metadata' | 'ignored';

/** A canonical primitive item in a versioned release manifest. */
export interface ReleaseManifestItem {
  /** Stable identifier within the release. */
  id: string;
  /** Canonical bundle-relative path to the primitive entry point. */
  path: string;
  /** Canonical runtime primitive vocabulary. */
  kind: PrimitiveKind;
  name?: string;
  description?: string;
  tags?: string[];
}

/** A file inventory record for a self-contained release archive. */
export interface ReleaseManifestFile {
  /** Canonical bundle-relative path, excluding deployment-manifest.yml itself. */
  path: string;
  role: ReleaseManifestFileRole;
  /** Exact uncompressed byte length. */
  size: number;
  /** Lowercase SHA-256 digest in canonical sha256:<hex> form. */
  sha256: string;
}

/** Source facts resolved before packaging a self-contained release. */
export interface ReleaseManifestProvenance {
  /** Immutable source location, such as a repository URL. */
  source: string;
  /** Immutable source revision used for both discovery and packaging. */
  revision: string;
  /** Path of the collection in the source tree at {@link revision}. */
  collectionPath: string;
  /** Archive-relative snapshot of the source collection definition. */
  sourceSnapshotPath: string;
  /** License identifier or source declaration. */
  license: string;
  /** Archive-relative path containing the applicable license text. */
  licensePath: string;
}

/**
 * Legacy item representation retained for older bundle consumers.
 * New producers must treat {@link ReleaseDeploymentManifest.items} as
 * canonical and may emit this representation as a compatibility projection.
 */
export interface LegacyReleaseManifestItem {
  id: string;
  file: string;
  type: string;
  name?: string;
  description?: string;
  tags?: string[];
}

/**
 * Self-contained, versioned deployment manifest published inside a release
 * archive. The manifest intentionally does not contain the ZIP's own digest:
 * that digest must remain a detached release asset or attestation to avoid a
 * circular archive hash.
 */
export interface ReleaseDeploymentManifest {
  formatVersion: typeof RELEASE_DEPLOYMENT_MANIFEST_FORMAT_VERSION;
  id: string;
  version: string;
  name: string;
  description?: string;
  author?: string;
  tags?: string[];
  environments?: string[];
  /** Archive-relative README when the source declares one. */
  readme?: string;
  /** Legacy/package-level license declaration. */
  license?: string;
  repository?: string;
  /** Canonical release primitive representation. */
  items: ReleaseManifestItem[];
  /** Complete inventory of every archive file except this manifest. */
  files: ReleaseManifestFile[];
  provenance: ReleaseManifestProvenance;
  /** Compatibility projection for legacy consumers. */
  prompts?: LegacyReleaseManifestItem[];
  dependencies?: unknown[];
  mcpServers?: Record<string, unknown>;
  mcpInputs?: unknown[];
}
