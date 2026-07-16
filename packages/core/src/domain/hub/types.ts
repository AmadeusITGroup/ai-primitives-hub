/**
 * Domain layer — Hub types.
 *
 * Mirrors the production shape at `src/types/hub.ts` so the extension's
 * `HubManager` can eventually delegate here with zero field-mapping
 * (migration plan §7.5).
 * @module domain/hub/types
 */
import type {
  Profile,
} from '../registry/types';
import type {
  RegistrySource,
} from '../source/types';

/**
 * Reserved hub id for the synthetic, auto-managed hub that holds
 * "detached" sources/profiles added directly via `source add`/
 * `profile create` rather than imported from a real hub reference.
 * `HubManager.importHub` refuses this id for real imports.
 */
export const DEFAULT_LOCAL_HUB_ID = 'default-local';

/**
 * Reference to a hub's location.
 */
export interface HubReference {
  type: 'github' | 'local' | 'url';
  location: string;
  /** Git ref for GitHub sources (branch, tag, or commit). */
  ref?: string;
  autoSync?: boolean;
}

/**
 * Elastic Search telemetry configuration for a hub. Authentication is
 * handled by the es-telemetry-proxy — no credentials configured here.
 */
export interface ElasticSearchConfig {
  /** Elastic Search proxy URL, e.g. `https://es-proxy.internal:8080`. */
  node: string;
  /** Custom index prefix (default: `ai-primitives-hub-telemetry`). */
  indexPrefix?: string;
}

/**
 * A source, as provisioned by a hub.
 */
export interface HubSource extends RegistrySource {
  enabled: boolean;
  /** Higher priority wins on conflict. */
  priority: number;
}

/**
 * A bundle reference within a hub-provided profile.
 */
export interface HubProfileBundle {
  id: string;
  version: string;
  source: string;
  required: boolean;
}

/**
 * A profile, as provisioned by a hub.
 */
export interface HubProfile extends Profile {
  bundles: HubProfileBundle[];
  /** Path segments for nested profile organization in UI trees. */
  path?: string[];
}

/**
 * A `HubProfile` decorated with the hub it came from — the shape
 * `RegistryManager.listProfiles()` needs to merge hub-provided
 * profiles alongside local ones. Mirrors the production shape at
 * `src/services/hub-manager.ts`'s `HubProfileWithMetadata`.
 */
export interface HubProfileWithMetadata extends HubProfile {
  hubId: string;
  hubName: string;
}

export interface HubMetadata {
  name: string;
  description: string;
  maintainer: string;
  updatedAt: string;
  /** `sha256:<hash>` or `sha512:<hash>`. */
  checksum?: string;
}

export interface RegistryConfiguration {
  autoSync?: boolean;
  syncInterval?: number;
  /** Enforce profile bundles strictly (no ad-hoc extras). */
  strictMode?: boolean;
}

/**
 * Parsed hub configuration.
 */
export interface HubConfig {
  version: string;
  metadata: HubMetadata;
  sources: HubSource[];
  profiles: HubProfile[];
  configuration?: RegistryConfiguration;
  telemetry?: {
    elasticSearch?: ElasticSearchConfig;
  };
}

export interface ProfileActivationState {
  hubId: string;
  profileId: string;
  activatedAt: string;
  /** @deprecated Kept for backward compatibility; prefer `syncedBundleVersions`. */
  syncedBundles: string[];
  syncedBundleVersions?: Record<string, string>;
}

export interface ProfileActivationOptions {
  installBundles: boolean;
}

export interface ProfileActivationResult {
  success: boolean;
  hubId: string;
  profileId: string;
  resolvedBundles: { bundle: HubProfileBundle; url: string }[];
  error?: string;
}

export interface ProfileDeactivationResult {
  success: boolean;
  hubId: string;
  profileId: string;
  removedBundles?: string[];
  error?: string;
}

export interface ProfileChanges {
  bundlesAdded?: HubProfileBundle[];
  bundlesRemoved?: string[];
  bundlesUpdated?: {
    id: string;
    oldVersion: string;
    newVersion: string;
  }[];
  metadataChanged?: {
    name?: boolean;
    description?: boolean;
    icon?: boolean;
  };
}

export interface DialogOption {
  label: string;
  description?: string;
  action: 'sync' | 'review' | 'cancel';
}

export interface ConflictResolutionDialog {
  title: string;
  message?: string;
  options: DialogOption[];
}

/**
 * Plugin item kinds understood by the awesome-copilot plugin format.
 * Closed set; mirrors PR #245 of the upstream repo.
 *
 * Note: this is a **subset** of `domain/primitive/PrimitiveKind` (which
 * also includes `mcp-server`). Plugins describe primitives by file path;
 * `mcp-server` is described separately under the manifest's `mcp` /
 * `mcpServers` keys, not as a `PluginItem`.
 */
export type PluginItemKind = 'prompt' | 'instruction' | 'chat-mode' | 'agent' | 'skill';

/**
 * A resolved plugin item in the harvester's canonical shape. The
 * companion `derivePluginItems(manifest)` helper in
 * `infra/harvest/plugin-manifest.ts` produces these from the various
 * input formats the upstream plugin schema permits.
 */
export interface PluginItem {
  kind: PluginItemKind;
  /** Path relative to the plugin root (may start with `./`). */
  path: string;
  description?: string;
}

/**
 * Superset of the awesome-copilot `plugin.json` on-disk schema.
 *
 * Permissive by design: any unknown keys (`[key: string]: unknown`) are
 * preserved so feature-layer parsers can read forward-compat fields
 * without forcing a schema bump here.
 *
 * Read-only — the harvester never produces these, only consumes them.
 */
export interface PluginManifest {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  tags?: string[];
  keywords?: string[];
  itemCount?: number;
  path?: string;
  /** Our format: explicit items with `kind`/`path`. */
  items?: unknown[];
  /** Upstream format: agent path refs. */
  agents?: unknown[];
  /** Upstream format: skill path refs. */
  skills?: unknown[];
  /** MCP server configs (see `mcp.schema.json`). */
  mcp?: { items?: Record<string, unknown> };
  mcpServers?: Record<string, unknown>;
  featured?: boolean;
  external?: boolean;
  repository?: string;
  homepage?: string;
  license?: string;
  /** Anything else we don't care about on the read path. */
  [key: string]: unknown;
}

/**
 * A parsed-and-normalised hub source, as consumed by the harvest
 * pipeline (`infra/harvest/hub-config-parser.ts`, `extra-source.ts`,
 * `hub-harvester.ts`, and the GitHub/awesome-copilot bundle providers).
 *
 * Distinct from `HubSource` above: `HubSource` is the *installed-hub*
 * shape (extends `RegistrySource`, tracks `enabled`/`priority` for the
 * extension's registry sync). `HubSourceSpec` is the *harvester's* own
 * narrower, GitHub-specific shape — owner/repo already split out, a
 * closed `type` union of only the three source kinds the harvester
 * walks. The two are populated from the same `hub-config.yml`, by two
 * different parsers, for two different consumers.
 */
export interface HubSourceSpec {
  /** Stable identifier; defaults to `${owner}-${repo}` when omitted in config. */
  id: string;
  /** Human-readable name; defaults to the config `id` or the repo segment. */
  name: string;
  /** Source type tag; only the three listed types are wired today. */
  type: 'github' | 'awesome-copilot' | 'awesome-copilot-plugin';
  /** Original config URL string (used for diagnostics / display). */
  url: string;
  /** GitHub owner segment derived from `url`. */
  owner: string;
  /** GitHub repo segment derived from `url`. */
  repo: string;
  /** Branch (defaults to `main`). */
  branch: string;
  /** For `awesome-copilot` sources: subdir containing collection bundles. */
  collectionsPath?: string;
  /**
   * For `awesome-copilot-plugin` sources: subdir containing plugin
   * roots (each plugin is `<pluginsPath>/<id>/.github/plugin/plugin.json`).
   * Defaults to "plugins" per upstream PR #245 convention.
   */
  pluginsPath?: string;
  /**
   * Forward-compat: arbitrary `config.*` keys preserved verbatim so
   * downstream experiments can consume new fields without forcing a
   * schema bump here.
   */
  rawConfig?: Record<string, unknown>;
}
