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
  collection?: Collection;
}

/**
 * Aggregate result of validating every collection file in a repository.
 */
export interface AllCollectionsResult extends ObjectValidationResult {
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
