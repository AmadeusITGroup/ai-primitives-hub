/**
 * Collection validation utilities (pure functions).
 * @module domain/collection/validate
 *
 * Pure validation logic for collection files.
 * File-IO dependent functions are in `app/collection/read-collection.ts`.
 *
 * Ported unchanged from the reference branch's
 * `core/src/domain/collection/validate.ts`, save for dropping its trailing
 * `export { type ValidationResult, type ObjectValidationResult } from
 * './types'` — this barrel already re-exports every `./collection/types`
 * name via `domain/index.ts`'s own `export * from './collection/types'`,
 * so repeating it here would create an ambiguous star-export binding.
 */
import * as path from 'node:path';
import {
  PRIMITIVE_KINDS,
} from '../primitive/types';
import {
  COLLECTION_DESCRIPTION_MAX_LENGTH,
  COLLECTION_NAME_MAX_LENGTH,
  COLLECTION_ROOT_PROPERTIES,
  optionalTypeErrors,
  unknownPropertyWarnings,
  validateCollectionDisplay,
  validateCollectionItemFields,
  validateCollectionMcp,
  validateCollectionTags,
} from './collection-schema-rules';
import type {
  CollectionFieldValidationResult,
  CollectionObjectValidationResult,
  ValidationRules,
} from './types';

/**
 * Default validation rules for collections.
 * Item kinds are sourced from the canonical PRIMITIVE_KINDS list.
 */
export const DEFAULT_VALIDATION_RULES: ValidationRules = {
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
  itemKinds: [...PRIMITIVE_KINDS],
  deprecatedKinds: {
    chatmode: 'agent'
  }
};

/**
 * Validate a collection ID.
 * @param id - Collection ID to validate
 * @param rules - Validation rules (uses DEFAULT_VALIDATION_RULES if not provided)
 * @returns Validation result
 */
export function validateCollectionId(id: string, rules: ValidationRules = DEFAULT_VALIDATION_RULES): CollectionFieldValidationResult {
  if (!id || typeof id !== 'string') {
    return { valid: false, error: 'Collection ID is required and must be a string' };
  }

  if (id.length > rules.collectionId.maxLength) {
    return {
      valid: false,
      error: `Collection ID must be at most ${rules.collectionId.maxLength} characters (got ${id.length})`
    };
  }

  if (!rules.collectionId.pattern.test(id)) {
    return {
      valid: false,
      error: `Collection ID must contain only ${rules.collectionId.description}`
    };
  }

  return { valid: true };
}

/**
 * Validate a version string.
 * @param version - Version string to validate
 * @param rules - Validation rules (uses DEFAULT_VALIDATION_RULES if not provided)
 * @returns Validation result with normalized version
 */
export function validateVersion(version?: string | null, rules: ValidationRules = DEFAULT_VALIDATION_RULES): CollectionFieldValidationResult {
  // If no version provided, use default
  if (version === undefined || version === null) {
    return { valid: true, normalized: rules.version.default };
  }

  if (typeof version !== 'string') {
    return { valid: false, error: 'Version must be a string' };
  }

  if (!rules.version.pattern.test(version)) {
    return {
      valid: false,
      error: `Version must follow ${rules.version.description} (got "${version}")`
    };
  }

  return { valid: true, normalized: version };
}

/**
 * Validate an item kind.
 * @param kind - Item kind to validate
 * @param rules - Validation rules (uses DEFAULT_VALIDATION_RULES if not provided)
 * @returns Validation result
 */
export function validateItemKind(kind: string, rules: ValidationRules = DEFAULT_VALIDATION_RULES): CollectionFieldValidationResult {
  if (!kind || typeof kind !== 'string') {
    return { valid: false, error: 'Item kind is required and must be a string' };
  }

  const normalizedKind = kind.toLowerCase();

  // Check for deprecated kinds (chatmode)
  if (rules.deprecatedKinds[normalizedKind]) {
    const replacement = rules.deprecatedKinds[normalizedKind];
    return {
      valid: false,
      error: `Item kind '${kind}' is deprecated. Use '${replacement}' instead`,
      deprecated: true,
      replacement
    };
  }

  // Check for valid kinds
  if (!rules.itemKinds.includes(normalizedKind)) {
    return {
      valid: false,
      error: `Invalid item kind '${kind}'. Must be one of: ${rules.itemKinds.join(', ')}`
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

  const s = String(p).trim().replaceAll('\\', '/').replace(/^\//, '');
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
 * Validate a collection object against the published collection schema
 * (`public/schemas/collection.schema.json`), whose rules are mirrored in
 * `collection-schema-rules.ts`. Item kinds are matched case-insensitively
 * (the schema enum is case-sensitive). Properties the schema does not
 * define (at the root, in items, `mcp`, MCP servers, `mcp.inputs` and
 * `display`) and the tag count and length produce warnings, which never
 * fail validation.
 * @param collection - Parsed collection object
 * @param sourceLabel - Label for error messages
 * @param rules - Validation rules (uses DEFAULT_VALIDATION_RULES if not provided)
 * @returns Validation result; `ok` means no errors
 */
export function validateCollectionObject(
  collection: unknown,
  sourceLabel: string,
  rules: ValidationRules = DEFAULT_VALIDATION_RULES
): CollectionObjectValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!collection || typeof collection !== 'object') {
    return { ok: false, errors: [`${sourceLabel}: YAML did not parse to an object`], warnings };
  }

  const col = collection as Record<string, unknown>;
  warnings.push(...unknownPropertyWarnings(col, COLLECTION_ROOT_PROPERTIES, sourceLabel, 'root property'));

  // Validate collection ID
  if (!col.id || typeof col.id !== 'string') {
    errors.push(`${sourceLabel}: Missing required field: id`);
  } else {
    const idResult = validateCollectionId(col.id, rules);
    if (!idResult.valid) {
      errors.push(`${sourceLabel}: ${idResult.error}`);
    }
  }

  // Lengths are counted in code points, as JSON Schema `maxLength` does.
  if (!col.name || typeof col.name !== 'string') {
    errors.push(`${sourceLabel}: Missing required field: name`);
  } else {
    const nameLength = [...col.name].length;
    if (nameLength > COLLECTION_NAME_MAX_LENGTH) {
      errors.push(`${sourceLabel}: name must be at most ${COLLECTION_NAME_MAX_LENGTH} characters (got ${nameLength})`);
    }
  }

  if (!col.description || typeof col.description !== 'string') {
    errors.push(`${sourceLabel}: Missing required field: description`);
  } else {
    const descriptionLength = [...col.description].length;
    if (descriptionLength > COLLECTION_DESCRIPTION_MAX_LENGTH) {
      errors.push(
        `${sourceLabel}: description must be at most ${COLLECTION_DESCRIPTION_MAX_LENGTH} characters (got ${descriptionLength})`
      );
    }
  }

  // Validate version if present. The schema requires a string, so an empty
  // `version:` key (null) is a type error, not an omitted version.
  if (col.version === null) {
    errors.push(`${sourceLabel}: Version must be a string`);
  } else if (col.version !== undefined) {
    const versionResult = validateVersion(col.version as string, rules);
    if (!versionResult.valid) {
      errors.push(`${sourceLabel}: ${versionResult.error}`);
    }
  }

  errors.push(...optionalTypeErrors(col, ['author'], 'string', sourceLabel));
  const tags = validateCollectionTags(col.tags, sourceLabel);
  errors.push(...tags.errors);
  warnings.push(...tags.warnings);

  if (col.readme !== undefined) {
    if (!col.readme || typeof col.readme !== 'object') {
      errors.push(`${sourceLabel}: readme must be an object with a "path" property`);
    } else {
      const readme = col.readme as Record<string, unknown>;
      if (!readme.path || typeof readme.path !== 'string' || readme.path.trim() === '') {
        errors.push(`${sourceLabel}: readme.path must be a non-empty string`);
      } else if (!isSafeRepoRelativePath(readme.path)) {
        errors.push(`${sourceLabel}: readme.path has an invalid path (must be repo-root relative): ${readme.path}`);
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
        const kindResult = validateItemKind(it.kind, rules);
        if (!kindResult.valid) {
          errors.push(`${prefix}: ${kindResult.error}`);
        }
      }
      const fields = validateCollectionItemFields(it, prefix);
      errors.push(...fields.errors);
      warnings.push(...fields.warnings);
    });
  }

  for (const section of [validateCollectionMcp(col.mcp, sourceLabel), validateCollectionDisplay(col.display, sourceLabel)]) {
    errors.push(...section.errors);
    warnings.push(...section.warnings);
  }

  return { ok: errors.length === 0, errors, warnings };
}
