/**
 * Domain layer — Structured collection manifest diagnostics, quick-fix
 * descriptors, inline decorations, cursor context, change summaries, and
 * full author-facing collection manifest types.
 *
 * Used across `@ai-primitives-hub/infra`, `@ai-primitives-hub/app`, and the
 * VS Code extension's Visual Collection Editor, Collections Tree View, and
 * live YAML intelligence.
 * @module domain/collection/diagnostics
 */
import type {
  SourceRange,
} from '../hub/diagnostics';

/**
 * Machine-readable diagnostic codes for collection manifest validation.
 */
export type CollectionDiagnosticCode =
  | 'COLLECTION_YAML_SYNTAX_ERROR'
  | 'COLLECTION_SCHEMA_VIOLATION'
  | 'COLLECTION_MISSING_REQUIRED_FIELD'
  | 'COLLECTION_INVALID_ID'
  | 'COLLECTION_INVALID_VERSION'
  | 'COLLECTION_INVALID_ITEM_KIND'
  | 'COLLECTION_DEPRECATED_ITEM_KIND'
  | 'COLLECTION_INVALID_PATH'
  | 'COLLECTION_ITEM_FILE_NOT_FOUND'
  | 'COLLECTION_README_MISSING'
  | 'COLLECTION_README_FILE_NOT_FOUND'
  | 'COLLECTION_KIND_ROUTE_MISMATCH'
  | 'COLLECTION_PLUGIN_MANIFEST_ERROR'
  | 'COLLECTION_PLUGIN_MANIFEST_WARNING'
  | 'COLLECTION_DUPLICATE_ID'
  | 'COLLECTION_DUPLICATE_NAME'
  | 'COLLECTION_DUPLICATE_ITEM_PATH'
  | 'COLLECTION_TAG_WARNING'
  | 'COLLECTION_MCP_INVALID';

/**
 * Actionable quick fix attached to a collection validation diagnostic.
 */
export interface CollectionValidationQuickFix {
  /** Human-readable title displayed in VS Code Quick Fix menu or Visual Editor. */
  title: string;
  /** Quick fix kind identifier. */
  kind:
    | 'fix-deprecated-kind'
    | 'fix-kind-route'
    | 'sanitize-collection-id'
    | 'fix-version'
    | 'scaffold-missing-item'
    | 'scaffold-missing-readme';
  /** Target JSON path within `.collection.yml`. */
  jsonPath: (string | number)[];
  /** Replacement value or payload used by the document mutator. */
  replacementValue?: unknown;
  /** Optional repo-relative file path to scaffold on disk. */
  filePath?: string;
  /** Optional item kind when scaffolding a missing item file. */
  itemKind?: string;
}

/**
 * Structured validation diagnostic with JSON path, YAML source range, and
 * optional quick-fix metadata.
 */
export interface CollectionValidationDiagnostic {
  code: CollectionDiagnosticCode;
  severity: 'error' | 'warning' | 'info';
  message: string;
  jsonPath: (string | number)[];
  range?: SourceRange;
  quickFix?: CollectionValidationQuickFix;
}

/**
 * Inline hint decoration model for a YAML line in `.collection.yml`.
 */
export interface CollectionInlineDecoration {
  line: number;
  text: string;
  status: 'ok' | 'warning' | 'error' | 'info';
  jsonPath: (string | number)[];
}

/**
 * Semantic entity enclosing a cursor line in `.collection.yml`.
 */
export type CollectionCursorNodeContext =
  | { section: 'root' }
  | { section: 'metadata' }
  | { section: 'readme' }
  | { section: 'display' }
  | { section: 'items-header' }
  | { section: 'item'; index: number; path?: string; kind?: string }
  | { section: 'mcp-header' }
  | { section: 'mcp-input'; index: number; id?: string }
  | { section: 'mcp-server'; key: string };

/**
 * MCP input definition inside `.collection.yml` (`mcp.inputs[]`).
 */
export interface CollectionMcpInput {
  id: string;
  type: 'promptString' | 'pickString' | 'command';
  description?: string;
  password?: boolean;
  default?: string;
  options?: string[];
}

/**
 * MCP server definition inside `.collection.yml` (`mcp.items.<serverKey>`).
 */
export interface CollectionMcpServerConfig {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  envFile?: string;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  description?: string;
}

/**
 * Display preferences inside `.collection.yml` (`display`).
 */
export interface CollectionDisplayConfig {
  color?: string;
  icon?: string;
  ordering?: 'manual' | 'alphabetical';
  // eslint-disable-next-line @typescript-eslint/naming-convention -- matches collection.schema.json
  show_badge?: boolean;
}

/**
 * Author-facing item definition inside `.collection.yml` (`items[]`).
 */
export interface CollectionItemDefinition {
  path: string;
  kind: string;
  title?: string;
  name?: string;
  description?: string;
  tags?: string[];
}

/**
 * Full author-facing collection manifest matching `collection.schema.json`.
 */
export interface CollectionManifest {
  id: string;
  name: string;
  description: string;
  version?: string;
  author?: string;
  tags?: string[];
  readme?: {
    path: string;
  };
  items: CollectionItemDefinition[];
  mcp?: {
    inputs?: CollectionMcpInput[];
    items?: Record<string, CollectionMcpServerConfig>;
  };
  display?: CollectionDisplayConfig;
}

/**
 * Summary of structural changes between a base `.collection.yml` and an edited
 * `.collection.yml`, used to generate commit messages and pull request bodies.
 */
export interface CollectionChangeSummary {
  collectionId: string;
  metadataChanged: boolean;
  itemsAdded: string[];
  itemsModified: string[];
  itemsRemoved: string[];
  mcpServersAdded: string[];
  mcpServersModified: string[];
  mcpServersRemoved: string[];
  mcpInputsAdded: string[];
  mcpInputsRemoved: string[];
  suggestedCommitMessage: string;
  suggestedPrTitle: string;
  suggestedPrBody: string;
}
