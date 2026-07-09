/**
 * Collection validation utilities.
 * @module validate
 *
 * Shared validation logic for collection files.
 * Used by validate-collections, build-collection-bundle, and publish-collections
 * to ensure consistent validation across all components.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type {
  AllCollectionsResult,
  Collection,
  FileValidationResult,
  ObjectValidationResult,
  ValidationResult,
  ValidationRules,
} from './types';

/**
 * Load valid item kinds from the JSON schema (single source of truth).
 * Falls back to a default list if schema cannot be loaded.
 * @param schemaDir - Directory containing the schema file
 * @returns Array of valid item kinds
 */
export function loadItemKindsFromSchema(schemaDir?: string): string[] {
  try {
    const schemaPath = schemaDir
      ? path.join(schemaDir, 'collection.schema.json')
      : path.join(__dirname, '..', '..', 'schemas', 'collection.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const kinds = schema?.properties?.items?.items?.properties?.kind?.enum;
    if (Array.isArray(kinds) && kinds.length > 0) {
      return kinds;
    }
  } catch {
    // Schema unavailable or malformed, use fallback
  }
  return ['prompt', 'instruction', 'agent', 'skill'];
}

/**
 * Validation rules for collections.
 * These rules are shared across all validation components for consistency.
 * Item kinds are loaded from the JSON schema for single source of truth.
 */
export const VALIDATION_RULES: ValidationRules = {
  collectionId: {
    maxLength: 100,
    pattern: /^[a-z0-9-]+$/,
    description: 'lowercase letters, numbers, and hyphens only'
  },
  version: {
    pattern: /^\d+\.\d+\.\d+$/,
    default: '1.0.0',
    description: 'semantic versioning format (X.Y.Z)'
  },
  itemKinds: loadItemKindsFromSchema(),
  deprecatedKinds: {
    chatmode: 'agent',
    'chat-mode': 'agent'
  }
};

/**
 * Validate a collection ID.
 * @param id - Collection ID to validate
 * @returns Validation result
 */
export function validateCollectionId(id: string): ValidationResult {
  if (!id || typeof id !== 'string') {
    return { valid: false, error: 'Collection ID is required and must be a string' };
  }

  if (id.length > VALIDATION_RULES.collectionId.maxLength) {
    return {
      valid: false,
      error: `Collection ID must be at most ${VALIDATION_RULES.collectionId.maxLength} characters (got ${id.length})`
    };
  }

  if (!VALIDATION_RULES.collectionId.pattern.test(id)) {
    return {
      valid: false,
      error: `Collection ID must contain only ${VALIDATION_RULES.collectionId.description}`
    };
  }

  return { valid: true };
}

/**
 * Validate a version string.
 * @param version - Version string to validate
 * @returns Validation result with normalized version
 */
export function validateVersion(version?: string | null): ValidationResult {
  // If no version provided, use default
  if (version === undefined || version === null) {
    return { valid: true, normalized: VALIDATION_RULES.version.default };
  }

  if (typeof version !== 'string') {
    return { valid: false, error: 'Version must be a string' };
  }

  if (!VALIDATION_RULES.version.pattern.test(version)) {
    return {
      valid: false,
      error: `Version must follow ${VALIDATION_RULES.version.description} (got "${version}")`
    };
  }

  return { valid: true, normalized: version };
}

/**
 * Validate an item kind.
 * @param kind - Item kind to validate
 * @returns Validation result
 */
export function validateItemKind(kind: string): ValidationResult {
  if (!kind || typeof kind !== 'string') {
    return { valid: false, error: 'Item kind is required and must be a string' };
  }

  const normalizedKind = kind.toLowerCase();

  // Check for deprecated kinds (chatmode)
  if (VALIDATION_RULES.deprecatedKinds[normalizedKind]) {
    const replacement = VALIDATION_RULES.deprecatedKinds[normalizedKind];
    return {
      valid: false,
      error: `Item kind '${kind}' is deprecated. Use '${replacement}' instead`,
      deprecated: true,
      replacement
    };
  }

  // Check for valid kinds
  if (!VALIDATION_RULES.itemKinds.includes(normalizedKind)) {
    return {
      valid: false,
      error: `Invalid item kind '${kind}'. Must be one of: ${VALIDATION_RULES.itemKinds.join(', ')}`
    };
  }

  return { valid: true };
}

/**
 * Normalize a path to be repo-root relative.
 * Uses POSIX normalization since collection paths are repo-root relative
 * and should work consistently across platforms.
 * @param p - Path to normalize
 * @returns Normalized repo-relative path
 * @throws {Error} if path is empty, traverses outside repo, or is absolute
 */
export function normalizeRepoRelativePath(p: string): string {
  if (!p || typeof p !== 'string') {
    throw new Error('path must be a non-empty string');
  }

  const s = String(p).trim().replace(/\\/g, '/').replace(/^\//, '');
  if (!s) {
    throw new Error('path must be a non-empty string');
  }

  // Use posix normalization since collection paths are repo-root relative.
  const normalized = path.posix.normalize(s);
  if (normalized.startsWith('../') || normalized === '..') {
    throw new Error('path must not traverse outside repo');
  }
  if (normalized.startsWith('/')) {
    throw new Error('path must be repo-root relative');
  }
  return normalized;
}

/**
 * Check if a path is a safe repo-relative path.
 * @param p - Path to check
 * @returns True if path is valid and safe
 */
export function isSafeRepoRelativePath(p: string): boolean {
  try {
    normalizeRepoRelativePath(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a collection object structure.
 * @param collection - Parsed collection object
 * @param sourceLabel - Label for error messages
 * @returns Validation result
 */
export function validateCollectionObject(
  collection: unknown,
  sourceLabel: string
): ObjectValidationResult {
  const errors: string[] = [];

  if (!collection || typeof collection !== 'object') {
    return { ok: false, errors: [`${sourceLabel}: YAML did not parse to an object`] };
  }

  const col = collection as Record<string, unknown>;

  // Validate collection ID
  if (!col.id || typeof col.id !== 'string') {
    errors.push(`${sourceLabel}: Missing required field: id`);
  } else {
    const idResult = validateCollectionId(col.id);
    if (!idResult.valid) {
      errors.push(`${sourceLabel}: ${idResult.error}`);
    }
  }

  if (!col.name || typeof col.name !== 'string') {
    errors.push(`${sourceLabel}: Missing required field: name`);
  }

  // Validate version if present
  if (col.version !== undefined) {
    const versionResult = validateVersion(col.version as string);
    if (!versionResult.valid) {
      errors.push(`${sourceLabel}: ${versionResult.error}`);
    }
  }

  // Validate readme if present (optional field)
  if (col.readme !== undefined) {
    if (!col.readme || typeof col.readme !== 'object') {
      errors.push(`${sourceLabel}: readme must be an object with a "path" property`);
    } else {
      const readme = col.readme as Record<string, unknown>;
      if (!readme.path || typeof readme.path !== 'string' || readme.path.trim() === '') {
        errors.push(`${sourceLabel}: readme.path must be a non-empty string`);
      } else {
        try {
          normalizeRepoRelativePath(readme.path);
        } catch {
          errors.push(`${sourceLabel}: readme.path has an invalid path (must be repo-root relative): ${readme.path}`);
        }
      }
    }
  }

  if (!Array.isArray(col.items)) {
    errors.push(`${sourceLabel}: Missing required field: items (array)`);
  }

  if (Array.isArray(col.items)) {
    col.items.forEach((item: unknown, idx: number) => {
      const prefix = `${sourceLabel}: items[${idx}]`;
      if (!item || typeof item !== 'object') {
        errors.push(`${prefix}: must be an object`);
        return;
      }
      const it = item as Record<string, unknown>;
      if (!it.path || typeof it.path !== 'string') {
        errors.push(`${prefix}: Missing required field: path`);
      } else {
        try {
          normalizeRepoRelativePath(it.path);
        } catch {
          errors.push(`${prefix}: Invalid path (must be repo-root relative): ${it.path}`);
        }
      }
      if (!it.kind || typeof it.kind !== 'string') {
        errors.push(`${prefix}: Missing required field: kind`);
      } else {
        // Validate item kind (including chatmode rejection)
        const kindResult = validateItemKind(it.kind);
        if (!kindResult.valid) {
          errors.push(`${prefix}: ${kindResult.error}`);
        }
      }
    });
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate a collection file from disk.
 * Checks YAML syntax, required fields, and referenced file existence.
 * @param repoRoot - Repository root path
 * @param collectionFile - Collection file path (absolute or repo-relative)
 * @returns Validation result with parsed collection
 */
export function validateCollectionFile(
  repoRoot: string,
  collectionFile: string
): FileValidationResult {
  const rel = collectionFile.replace(/\\/g, '/');
  const abs = path.isAbsolute(collectionFile)
    ? collectionFile
    : path.join(repoRoot, collectionFile);

  const errors: string[] = [];
  const warnings: string[] = [];

  if (!fs.existsSync(abs)) {
    return { ok: false, errors: [`${rel}: Collection file not found`] };
  }

  let collection: Collection;
  try {
    collection = yaml.load(fs.readFileSync(abs, 'utf8')) as Collection;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, errors: [`${rel}: YAML parse error: ${message}`] };
  }

  const schema = validateCollectionObject(collection, rel);
  errors.push(...schema.errors);

  if (Array.isArray(collection?.items)) {
    collection.items.forEach((item, idx) => {
      if (!item?.path || typeof item.path !== 'string') {
        return;
      }
      let relPath: string;
      try {
        relPath = normalizeRepoRelativePath(item.path);
      } catch {
        return;
      }

      const itemAbs = path.join(repoRoot, relPath);
      if (!fs.existsSync(itemAbs)) {
        errors.push(`${rel}: items[${idx}] referenced file not found: ${relPath}`);
      }
    });
  }

  if (collection?.readme?.path) {
    let relPath: string;
    try {
      relPath = normalizeRepoRelativePath(collection.readme.path);
    } catch {
      return { ok: false, errors: [...errors, `${rel}: readme path is invalid: ${collection.readme.path}`] };
    }
    const readmeAbs = path.join(repoRoot, relPath);
    if (!fs.existsSync(readmeAbs)) {
      errors.push(`${rel}: readme referenced file not found: ${relPath}`);
    }
  } else {
    warnings.push(`${rel}: Collection has no readme. Consider adding a readme to help users understand this collection.`);
  }

  return { ok: errors.length === 0, errors, warnings, collection };
}

/**
 * Validate all collections in a repository, including duplicate detection.
 * @param repoRoot - Repository root path
 * @param collectionFiles - Array of collection file paths (repo-relative)
 * @returns Validation result
 */
export function validateAllCollections(
  repoRoot: string,
  collectionFiles: string[]
): AllCollectionsResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fileResults: ({ file: string } & FileValidationResult)[] = [];
  const seenIds = new Map<string, string>(); // id -> file path
  const seenNames = new Map<string, string>(); // name -> file path

  for (const file of collectionFiles) {
    const result = validateCollectionFile(repoRoot, file);
    fileResults.push({ file, ...result });
    errors.push(...result.errors);
    if (result.warnings) {
      warnings.push(...result.warnings);
    }

    // Check for duplicate IDs and names
    if (result.collection) {
      const { id, name } = result.collection;

      if (id && seenIds.has(id)) {
        errors.push(`${file}: Duplicate collection ID '${id}' (also in ${seenIds.get(id)})`);
      } else if (id) {
        seenIds.set(id, file);
      }

      if (name && seenNames.has(name)) {
        errors.push(`${file}: Duplicate collection name '${name}' (also in ${seenNames.get(name)})`);
      } else if (name) {
        seenNames.set(name, file);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, fileResults };
}

/**
 * Generate markdown content for PR comment from validation result.
 * @param result - Result from validateAllCollections
 * @param totalFiles - Total number of collection files
 * @returns Markdown content
 */
export function generateMarkdown(result: AllCollectionsResult, totalFiles: number): string {
  let md = '## 📋 Collection Validation Results\n\n';

  if (result.ok) {
    md += `✅ **All ${totalFiles} collection(s) validated successfully!**\n`;
  } else {
    md += `❌ **Validation failed with ${result.errors.length} error(s)**\n\n`;
    md += '### Errors\n\n';
    result.errors.forEach((err) => {
      md += `- ${err}\n`;
    });
  }

  if (result.warnings && result.warnings.length > 0) {
    md += '\n### Warnings\n\n';
    result.warnings.forEach((warn) => {
      md += `- ⚠️ ${warn}\n`;
    });
  }

  return md;
}
