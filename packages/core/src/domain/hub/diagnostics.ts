/**
 * Domain layer — Structured hub configuration diagnostics, source ranges,
 * inline decorations, and quick-fix descriptors.
 *
 * Used across `@ai-primitives-hub/infra`, `@ai-primitives-hub/app`, and the
 * VS Code extension's visual editor and live YAML intelligence.
 * @module domain/hub/diagnostics
 */

/**
 * Machine-readable diagnostic codes for hub configuration validation.
 */
export type HubDiagnosticCode =
  | 'HUB_YAML_SYNTAX_ERROR'
  | 'HUB_SCHEMA_VIOLATION'
  | 'HUB_MISSING_REQUIRED_FIELD'
  | 'HUB_INVALID_SEMVER'
  | 'HUB_INVALID_CHECKSUM'
  | 'HUB_DUPLICATE_SOURCE_ID'
  | 'HUB_DUPLICATE_PROFILE_ID'
  | 'HUB_PATH_TRAVERSAL'
  | 'HUB_SOURCE_FORBIDDEN_CONFIG'
  | 'HUB_SOURCE_REQUIRED_CONFIG'
  | 'HUB_UNKNOWN_SOURCE_REFERENCE'
  | 'HUB_INVALID_BUNDLE_PREFIX'
  | 'HUB_SOURCE_UNREACHABLE'
  | 'HUB_BUNDLE_NOT_FOUND'
  | 'HUB_BUNDLE_VERSION_NOT_FOUND'
  | 'HUB_STALE_UPDATED_AT';

/**
 * 0-based line/column range within a YAML text document.
 */
export interface SourceRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/**
 * Actionable quick fix attached to a validation diagnostic.
 */
export interface HubValidationQuickFix {
  /** Human-readable title displayed in VS Code Quick Fix menu or Visual Editor. */
  title: string;
  /** Quick fix kind identifier. */
  kind:
    | 'update-timestamp'
    | 'fix-bundle-prefix'
    | 'add-source-config'
    | 'remove-source-config'
    | 'create-missing-source';
  /** Target JSON path within `hub-config.yml`. */
  jsonPath: (string | number)[];
  /** Replacement value or payload used by the document mutator. */
  replacementValue?: unknown;
}

/**
 * Structured validation diagnostic with JSON path, YAML source range, and
 * optional quick-fix metadata.
 */
export interface HubValidationDiagnostic {
  code: HubDiagnosticCode;
  severity: 'error' | 'warning' | 'info';
  message: string;
  jsonPath: (string | number)[];
  range?: SourceRange;
  quickFix?: HubValidationQuickFix;
}

/**
 * Inline hint decoration model for a YAML line in `hub-config.yml`.
 */
export interface HubInlineDecoration {
  line: number;
  text: string;
  status: 'ok' | 'warning' | 'error' | 'info';
  jsonPath: (string | number)[];
}

/**
 * Semantic entity enclosing a cursor line in `hub-config.yml`.
 */
export type HubCursorNodeContext =
  | { section: 'root' }
  | { section: 'metadata' }
  | { section: 'sources-header' }
  | { section: 'source'; index: number; id?: string }
  | { section: 'profiles-header' }
  | { section: 'profile'; index: number; id?: string; bundleIndex?: number };

/**
 * Summary of structural changes between a base `hub-config.yml` and an edited
 * `hub-config.yml`, used to generate commit messages and pull request bodies.
 */
export interface HubChangeSummary {
  sourcesAdded: string[];
  sourcesModified: string[];
  sourcesRemoved: string[];
  profilesAdded: string[];
  profilesModified: string[];
  profilesRemoved: string[];
  suggestedCommitMessage: string;
  suggestedPrTitle: string;
  suggestedPrBody: string;
}
