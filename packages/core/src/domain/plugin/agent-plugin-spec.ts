/**
 * Agent Plugins 1.0.0 manifest validation (pure functions).
 * @module domain/plugin/agent-plugin-spec
 *
 * Validates a plugin's root `plugin.json` against the Agent Plugins 1.0.0
 * specification and applies the AI Primitives Hub plugin-root packaging rule.
 * The caller supplies the manifest text; this module never touches the
 * filesystem, so the same checks run on an authoring checkout
 * (`collection validate`), a release plan, or an extracted archive.
 *
 * Severity follows the spec:
 * - fatal: a missing or unsupported `$schema` (§5.2), a missing or
 *   malformed `name` (§5.5), a wrongly typed standard field such as a
 *   non-object `author`, or an unreadable / non-JSON / non-object manifest.
 * - non-fatal: unknown top-level fields and a non-object `extensions`
 *   field, which clients ignore (§5.2, §11.3). A non-object *member* of
 *   `extensions` is also non-fatal: clients ignore namespaces they don't
 *   implement without validating their values (§8.1), and APH implements none.
 *
 * APH packaging rule (stricter than the spec, which only recommends it):
 * the plugin root is the directory that contains `plugin.json`, and the
 * manifest `name` must equal that directory's name. Bundling archives
 * `dirname(item.path)` and installs it under that name, so without this rule
 * a manifest that is not at the plugin root would pass the spec checks and
 * be silently packaged without the rest of the plugin.
 *
 * `validateAgentPluginName` exposes the name rule on its own, so callers
 * that create a plugin (scaffolding) can reject a name before writing.
 *
 * The rule constants mirror the vendored schema at
 * `public/schemas/agent-plugins/1.0.0/plugin.schema.json`; a parity test
 * guards against drift.
 * @see https://agent-plugins.org/specification
 * @see https://github.com/agentplugins/agent-plugins-spec/blob/d92e6f443b8edcea42c039727a82afdc565779e2/schemas/1.0.0/plugin.schema.json
 */
import * as path from 'node:path';
import {
  normalizeRepoRelativePath,
} from '../collection/validate';

/** Agent Plugins specification version this module validates against. */
export const AGENT_PLUGINS_SPEC_VERSION = '1.0.0';
/** File name of the plugin manifest at the plugin root. */
export const AGENT_PLUGIN_MANIFEST_FILENAME = 'plugin.json';
/** The only `$schema` value accepted for Agent Plugins 1.0.0 manifests. */
export const AGENT_PLUGIN_MANIFEST_SCHEMA_URI = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
/** Maximum length of the manifest `name`. */
export const AGENT_PLUGIN_NAME_MAX_LENGTH = 64;
/** Pattern the manifest `name` must match. */
export const AGENT_PLUGIN_NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
/** Top-level fields defined by Agent Plugins 1.0.0. */
export const AGENT_PLUGIN_MANIFEST_FIELDS = [
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions'
] as const;
/** Fields allowed inside the manifest `author` object. */
export const AGENT_PLUGIN_AUTHOR_FIELDS = ['name', 'email', 'url'] as const;

export type AgentPluginIssueSeverity = 'fatal' | 'non-fatal';

export type AgentPluginIssueCode =
  | 'manifest-path'
  | 'manifest-root'
  | 'manifest-unreadable'
  | 'manifest-json'
  | 'manifest-not-object'
  | 'schema-missing'
  | 'schema-unsupported'
  | 'name-missing'
  | 'name-invalid'
  | 'field-type'
  | 'author-invalid'
  | 'name-directory-mismatch'
  | 'unknown-field'
  | 'extensions-not-object'
  | 'extension-not-object';

export interface AgentPluginIssue {
  severity: AgentPluginIssueSeverity;
  code: AgentPluginIssueCode;
  /** Offending field, e.g. `name`, `author.email`, `extensions.com.example.client`. */
  field?: string;
  /** Actionable message. Never contains the item path; callers add context. */
  message: string;
}

/** Typed view of a spec-compliant Agent Plugins 1.0.0 manifest. */
export interface AgentPluginManifest {
  $schema: string;
  name: string;
  version?: string;
  description?: string;
  author?: { name?: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  extensions?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export interface AgentPluginValidationResult {
  /** True when no fatal issue was found. */
  valid: boolean;
  /** Repo-relative plugin root (`dirname(itemPath)`), or null when the path rule failed. */
  pluginRoot: string | null;
  /** Parsed top-level manifest object, when parsing succeeded. */
  manifest?: Record<string, unknown>;
  /** Fatal and non-fatal issues, in check order. */
  issues: AgentPluginIssue[];
}

export interface AgentPluginItemInput {
  /** Collection item path; must point to the plugin's root `plugin.json`. */
  itemPath: string;
  /** Manifest file content, or null when it is not a readable regular file. */
  manifestText: string | null;
}

const STRING_FIELDS = ['version', 'description', 'homepage', 'repository', 'license'] as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const describeType = (value: unknown): string => {
  if (value === null) {
    return 'null';
  }
  return Array.isArray(value) ? 'array' : typeof value;
};

const fatal = (code: AgentPluginIssueCode, message: string, field?: string): AgentPluginIssue =>
  ({ severity: 'fatal', code, message, ...(field === undefined ? {} : { field }) });

const nonFatal = (code: AgentPluginIssueCode, message: string, field?: string): AgentPluginIssue =>
  ({ severity: 'non-fatal', code, message, ...(field === undefined ? {} : { field }) });

const quoteList = (values: readonly string[]): string => values.map((v) => `"${v}"`).join(', ');

const checkSchema = (manifest: Record<string, unknown>): AgentPluginIssue[] => {
  if (!('$schema' in manifest)) {
    return [fatal('schema-missing', `missing required field "$schema"; set it to "${AGENT_PLUGIN_MANIFEST_SCHEMA_URI}"`, '$schema')];
  }
  if (manifest.$schema !== AGENT_PLUGIN_MANIFEST_SCHEMA_URI) {
    return [fatal(
      'schema-unsupported',
      `unsupported "$schema" ${JSON.stringify(manifest.$schema)}; Agent Plugins ${AGENT_PLUGINS_SPEC_VERSION} requires "${AGENT_PLUGIN_MANIFEST_SCHEMA_URI}"`,
      '$schema'
    )];
  }
  return [];
};

/**
 * Check a plugin name against the Agent Plugins 1.0.0 name grammar (§5.5).
 * This is the rule `validateAgentPluginManifest` applies to `name`; use it
 * to vet a name before anything is written (e.g. when scaffolding).
 * @param name - Candidate plugin name
 * @returns A fatal `name-invalid` issue, or null when the name is valid
 */
export function validateAgentPluginName(name: unknown): AgentPluginIssue | null {
  if (
    typeof name !== 'string'
    || name.length === 0
    || name.length > AGENT_PLUGIN_NAME_MAX_LENGTH
    || !AGENT_PLUGIN_NAME_PATTERN.test(name)
  ) {
    return fatal(
      'name-invalid',
      `"name" must be 1-${AGENT_PLUGIN_NAME_MAX_LENGTH} characters of lowercase letters, digits, "." or "-", `
      + `start and end with a letter or digit, and contain no "--" or ".." (got ${JSON.stringify(name)})`,
      'name'
    );
  }
  return null;
}

const checkName = (manifest: Record<string, unknown>): AgentPluginIssue[] => {
  if (!('name' in manifest)) {
    return [fatal('name-missing', 'missing required field "name"', 'name')];
  }
  const issue = validateAgentPluginName(manifest.name);
  return issue === null ? [] : [issue];
};

const checkFieldTypes = (manifest: Record<string, unknown>): AgentPluginIssue[] => {
  const issues: AgentPluginIssue[] = [];
  for (const field of STRING_FIELDS) {
    if (field in manifest && typeof manifest[field] !== 'string') {
      issues.push(fatal('field-type', `"${field}" must be a string`, field));
    }
  }
  if ('keywords' in manifest) {
    const { keywords } = manifest;
    if (!Array.isArray(keywords) || keywords.some((k) => typeof k !== 'string')) {
      issues.push(fatal('field-type', '"keywords" must be an array of strings', 'keywords'));
    }
  }
  return issues;
};

const checkAuthor = (manifest: Record<string, unknown>): AgentPluginIssue[] => {
  if (!('author' in manifest)) {
    return [];
  }
  const { author } = manifest;
  if (!isPlainObject(author)) {
    return [fatal(
      'author-invalid',
      `"author" must be an object with optional string fields ${quoteList(AGENT_PLUGIN_AUTHOR_FIELDS)} (got a ${describeType(author)})`,
      'author'
    )];
  }
  const allowed: readonly string[] = AGENT_PLUGIN_AUTHOR_FIELDS;
  const issues: AgentPluginIssue[] = [];
  for (const [key, value] of Object.entries(author)) {
    if (!allowed.includes(key)) {
      issues.push(fatal(
        'author-invalid',
        `"author" has unknown field "${key}"; only ${quoteList(AGENT_PLUGIN_AUTHOR_FIELDS)} are allowed`,
        `author.${key}`
      ));
    } else if (typeof value !== 'string') {
      issues.push(fatal('author-invalid', `"author.${key}" must be a string`, `author.${key}`));
    }
  }
  return issues;
};

const checkUnknownFields = (manifest: Record<string, unknown>): AgentPluginIssue[] => {
  const allowed: readonly string[] = AGENT_PLUGIN_MANIFEST_FIELDS;
  return Object.keys(manifest)
    .filter((key) => !allowed.includes(key))
    .map((key) => nonFatal(
      'unknown-field',
      `unknown top-level field "${key}" is ignored; Agent Plugins ${AGENT_PLUGINS_SPEC_VERSION} allows only ${quoteList(AGENT_PLUGIN_MANIFEST_FIELDS)}. Put client-specific data under "extensions"`,
      key
    ));
};

const checkExtensions = (manifest: Record<string, unknown>): AgentPluginIssue[] => {
  if (!('extensions' in manifest)) {
    return [];
  }
  const { extensions } = manifest;
  if (!isPlainObject(extensions)) {
    return [nonFatal(
      'extensions-not-object',
      '"extensions" must be an object keyed by reverse-domain namespace; the field is ignored',
      'extensions'
    )];
  }
  return Object.entries(extensions)
    .filter(([, value]) => !isPlainObject(value))
    .map(([namespace]) => nonFatal(
      'extension-not-object',
      `"extensions.${namespace}" must be an object; the entry is ignored`,
      `extensions.${namespace}`
    ));
};

/**
 * Validate a parsed `plugin.json` against Agent Plugins 1.0.0 (spec checks only).
 * Does not apply the APH name/directory packaging rule.
 * @param manifest - Parsed manifest value
 * @returns Fatal and non-fatal issues, in check order (empty when compliant)
 */
export function validateAgentPluginManifest(manifest: unknown): AgentPluginIssue[] {
  if (!isPlainObject(manifest)) {
    return [fatal('manifest-not-object', `${AGENT_PLUGIN_MANIFEST_FILENAME} must contain a top-level JSON object`)];
  }
  return [
    ...checkSchema(manifest),
    ...checkName(manifest),
    ...checkFieldTypes(manifest),
    ...checkAuthor(manifest),
    ...checkUnknownFields(manifest),
    ...checkExtensions(manifest)
  ];
}

const resolvePluginRoot = (itemPath: string): { pluginRoot: string } | { issue: AgentPluginIssue } => {
  let normalized: string | null = null;
  try {
    normalized = normalizeRepoRelativePath(itemPath);
  } catch {
    // Reported below as a manifest-path issue.
  }
  if (normalized === null || path.posix.basename(normalized) !== AGENT_PLUGIN_MANIFEST_FILENAME) {
    return {
      issue: fatal(
        'manifest-path',
        `plugin item path must point to the plugin's root ${AGENT_PLUGIN_MANIFEST_FILENAME} (got ${JSON.stringify(itemPath)}); `
        + `the plugin root is the directory that contains ${AGENT_PLUGIN_MANIFEST_FILENAME}`
      )
    };
  }
  const pluginRoot = path.posix.dirname(normalized);
  if (pluginRoot === '.') {
    return {
      issue: fatal(
        'manifest-root',
        `${AGENT_PLUGIN_MANIFEST_FILENAME} must sit in its own plugin directory (for example plugins/<name>/${AGENT_PLUGIN_MANIFEST_FILENAME}), not at the repository root`
      )
    };
  }
  return { pluginRoot };
};

/**
 * Validate a collection `kind: plugin` item from in-memory input: the item
 * path must point to a root `plugin.json` inside its own directory, the
 * manifest must satisfy Agent Plugins 1.0.0, and its `name` must equal the
 * plugin directory name (APH packaging rule).
 * @param input - Item path and manifest text (null when not a readable file)
 * @returns Structured result; `valid` is false when any fatal issue exists
 */
export function validateAgentPluginItem(input: AgentPluginItemInput): AgentPluginValidationResult {
  const resolved = resolvePluginRoot(input.itemPath);
  if ('issue' in resolved) {
    return { valid: false, pluginRoot: null, issues: [resolved.issue] };
  }
  const { pluginRoot } = resolved;
  const stop = (issue: AgentPluginIssue): AgentPluginValidationResult =>
    ({ valid: false, pluginRoot, issues: [issue] });

  if (input.manifestText === null) {
    return stop(fatal('manifest-unreadable', `${AGENT_PLUGIN_MANIFEST_FILENAME} is not a readable file`));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.manifestText);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return stop(fatal('manifest-json', `${AGENT_PLUGIN_MANIFEST_FILENAME} is not valid JSON: ${reason}`));
  }
  if (!isPlainObject(parsed)) {
    return stop(fatal('manifest-not-object', `${AGENT_PLUGIN_MANIFEST_FILENAME} must contain a top-level JSON object`));
  }

  const issues = validateAgentPluginManifest(parsed);
  const directory = path.posix.basename(pluginRoot);
  if (typeof parsed.name === 'string' && parsed.name.length > 0 && parsed.name !== directory) {
    issues.push(fatal(
      'name-directory-mismatch',
      `plugin name "${parsed.name}" must match its directory "${directory}" `
      + `(AI Primitives Hub packaging rule: the plugin root is the directory that contains ${AGENT_PLUGIN_MANIFEST_FILENAME}, `
      + 'and it is bundled and installed under that directory name). '
      + `Rename the directory or the "name" field, and keep ${AGENT_PLUGIN_MANIFEST_FILENAME} at the plugin root`,
      'name'
    ));
  }
  return {
    valid: !issues.some((i) => i.severity === 'fatal'),
    pluginRoot,
    manifest: parsed,
    issues
  };
}
