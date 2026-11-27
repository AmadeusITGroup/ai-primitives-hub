/**
 * Rules of the published collection schema (pure, no IO).
 * @module domain/collection/collection-schema-rules
 *
 * Hand-written mirror of `public/schemas/collection.schema.json`: core
 * enforces the schema without a schema-validator dependency, so every
 * property list, enum, limit and closed object is a constant here.
 * `test/domain/collection/collection-schema-drift.test.ts` compares these
 * constants with the schema and fails when the two diverge.
 *
 * Messages are prefixed with the collection label (`L`) or the label of
 * the nested value (`L: mcp.items.<name>`, `L: display`, ...).
 *
 * Validation is more lenient than the schema in one place: a key that a
 * closed object does not define is a warning, not an error, so collections
 * that still carry legacy fields (such as the root `mcpServers` and
 * `license`) stay valid. Every other rule is an error.
 */

/** Root properties allowed by the schema (`additionalProperties: false`). */
export const COLLECTION_ROOT_PROPERTIES = [
  'id', 'name', 'description', 'items', 'mcp', 'readme', 'version', 'author', 'tags', 'display'
] as const;
/** Root properties the schema requires. */
export const COLLECTION_REQUIRED_PROPERTIES = ['id', 'name', 'description', 'items'] as const;
/** Properties allowed on a collection item. */
export const COLLECTION_ITEM_PROPERTIES = ['path', 'kind', 'title', 'description', 'tags'] as const;
/** Properties every collection item requires. */
export const COLLECTION_ITEM_REQUIRED_PROPERTIES = ['path', 'kind'] as const;
/** Properties allowed in the `mcp` section. */
export const COLLECTION_MCP_PROPERTIES = ['items', 'inputs'] as const;
/** Allowed MCP server names (keys of `mcp.items`). */
export const MCP_SERVER_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
/** Properties allowed on an MCP server. */
export const MCP_SERVER_PROPERTIES = [
  'type', 'command', 'args', 'env', 'envFile', 'url', 'headers', 'disabled'
] as const;
/** MCP server transport types. */
export const MCP_SERVER_TYPES = ['stdio', 'http', 'sse'] as const;
/** Properties allowed on an `mcp.inputs` entry. */
export const MCP_INPUT_PROPERTIES = ['id', 'type', 'description', 'password', 'default', 'options'] as const;
/** Properties every `mcp.inputs` entry requires. */
export const MCP_INPUT_REQUIRED_PROPERTIES = ['id', 'type'] as const;
/** Allowed `mcp.inputs[].id` values. */
export const MCP_INPUT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
/** `mcp.inputs[].type` values. */
export const MCP_INPUT_TYPES = ['promptString', 'pickString', 'command'] as const;
/** Properties allowed in the `display` section. */
export const COLLECTION_DISPLAY_PROPERTIES = ['color', 'icon', 'ordering', 'show_badge'] as const;
/** `display.ordering` values. */
export const DISPLAY_ORDERINGS = ['manual', 'alphabetical'] as const;
/** Maximum length of the collection `name`. */
export const COLLECTION_NAME_MAX_LENGTH = 100;
/** Maximum length of the collection `description`. */
export const COLLECTION_DESCRIPTION_MAX_LENGTH = 500;
/** Tag count above which a warning is reported (not a schema rule). */
export const COLLECTION_TAG_WARNING_COUNT = 10;
/** Tag length above which a warning is reported (not a schema rule). */
export const COLLECTION_TAG_WARNING_LENGTH = 30;
/**
 * Data paths of the objects the schema closes with
 * `additionalProperties: false`. Validation reports an unknown key of each
 * as a warning, except in `$.mcp.items`, whose keys are server names
 * checked against `MCP_SERVER_NAME_PATTERN` (an error).
 */
export const COLLECTION_CLOSED_OBJECTS = [
  '$', '$.items[]', '$.mcp', '$.mcp.items', '$.mcp.items.<server>', '$.mcp.inputs[]', '$.display'
] as const;

/** Errors and warnings found in one section of a collection. */
export interface CollectionSectionIssues {
  errors: string[];
  warnings: string[];
}

/**
 * Whether a value is a plain (non-array, non-null) object.
 * @param value - Value to test
 * @returns True for a JSON object
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether a value is an array of strings.
 * @param value - Value to test
 * @returns True for a string array
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Render a value for a message: strings as-is, anything else as JSON.
 * A value JSON cannot render (a cycle, which a YAML alias can create) is
 * shown as its tag, such as `[object Array]`, so validation never throws.
 * @param value - Value to render
 * @returns Printable form of the value
 */
function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * Report every key of an object that the schema does not define.
 * @param value - Object to check
 * @param allowed - Allowed keys, listed in the message
 * @param prefix - Message prefix (location of the object)
 * @param noun - What the key is called in the message
 * @returns One `unknown <noun>` warning per unknown key
 */
export function unknownPropertyWarnings(
  value: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
  noun = 'property'
): string[] {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) =>
      `${prefix}: unknown ${noun} '${key}' is not in the collection schema; remove it or rename it to one of: ${allowed.join(', ')}`);
}

/**
 * Report optional fields present with the wrong type.
 * @param value - Object holding the fields
 * @param fields - Fields that must be of `type` when present
 * @param type - Expected `typeof`
 * @param prefix - Message prefix
 * @returns One `<field> must be a <type>` error per mistyped field
 */
export function optionalTypeErrors(
  value: Record<string, unknown>,
  fields: readonly string[],
  type: 'string' | 'boolean',
  prefix: string
): string[] {
  return fields
    .filter((field) => value[field] !== undefined && typeof value[field] !== type)
    .map((field) => `${prefix}: ${field} must be a ${type}`);
}

/**
 * Report an optional field present but not an array of strings.
 * @param value - Object holding the field
 * @param field - Field name
 * @param prefix - Message prefix
 * @returns The `<field> must be an array of strings` error, if any
 */
function optionalStringArrayErrors(value: Record<string, unknown>, field: string, prefix: string): string[] {
  return value[field] === undefined || isStringArray(value[field]) ? [] : [`${prefix}: ${field} must be an array of strings`];
}

/**
 * Report optional fields present but not objects of string values.
 * @param value - Object holding the fields
 * @param fields - Field names
 * @param prefix - Message prefix
 * @returns One `<field> must be an object of strings` error per invalid field
 */
function optionalStringRecordErrors(value: Record<string, unknown>, fields: readonly string[], prefix: string): string[] {
  return fields
    .filter((field) => {
      const entry = value[field];
      return entry !== undefined && !(isPlainObject(entry) && Object.values(entry).every((v) => typeof v === 'string'));
    })
    .map((field) => `${prefix}: ${field} must be an object of strings`);
}

/**
 * Validate the collection's root `tags`. A non-array or non-string tag
 * is an error; many or long tags are warnings.
 * @param tags - Root `tags` value (validated only when not undefined)
 * @param label - Collection label
 * @returns Errors and warnings
 */
export function validateCollectionTags(tags: unknown, label: string): CollectionSectionIssues {
  const issues: CollectionSectionIssues = { errors: [], warnings: [] };
  if (tags === undefined) {
    return issues;
  }
  if (!Array.isArray(tags)) {
    issues.errors.push(`${label}: tags must be an array`);
    return issues;
  }
  if (tags.length > COLLECTION_TAG_WARNING_COUNT) {
    issues.warnings.push(`${label}: More than ${COLLECTION_TAG_WARNING_COUNT} tags (recommended max)`);
  }
  tags.forEach((tag: unknown, index) => {
    if (typeof tag !== 'string') {
      issues.errors.push(`${label}: tags[${index}] must be a string`);
    } else if (tag.length > COLLECTION_TAG_WARNING_LENGTH) {
      issues.warnings.push(`${label}: tags[${index}] is longer than ${COLLECTION_TAG_WARNING_LENGTH} characters`);
    }
  });
  return issues;
}

/**
 * Validate the schema rules of one item beyond `path` and `kind`.
 * @param item - Item object
 * @param prefix - Item label (`L: items[<i>]`)
 * @returns Errors, and warnings for unknown properties
 */
export function validateCollectionItemFields(item: Record<string, unknown>, prefix: string): CollectionSectionIssues {
  return {
    errors: [
      ...optionalTypeErrors(item, ['title', 'description'], 'string', prefix),
      ...optionalStringArrayErrors(item, 'tags', prefix)
    ],
    warnings: unknownPropertyWarnings(item, COLLECTION_ITEM_PROPERTIES, prefix)
  };
}

/**
 * Validate one MCP server of `mcp.items`.
 * @param server - Server object
 * @param prefix - Server label (`L: mcp.items.<name>`)
 * @returns Errors, and warnings for unknown properties
 */
function validateMcpServer(server: Record<string, unknown>, prefix: string): CollectionSectionIssues {
  const errors: string[] = [];
  const type = server.type;
  if (type !== undefined && !(MCP_SERVER_TYPES as readonly unknown[]).includes(type)) {
    errors.push(`${prefix}: Invalid type '${describeValue(type)}'. Must be one of: ${MCP_SERVER_TYPES.join(', ')}`);
  }
  if ((type === undefined || type === 'stdio') && server.command === undefined) {
    errors.push(`${prefix}: Missing required field: command`);
  }
  if ((type === 'http' || type === 'sse') && server.url === undefined) {
    errors.push(`${prefix}: Missing required field: url`);
  }
  errors.push(
    ...optionalTypeErrors(server, ['command', 'envFile', 'url'], 'string', prefix),
    ...optionalStringArrayErrors(server, 'args', prefix),
    ...optionalStringRecordErrors(server, ['env', 'headers'], prefix),
    ...optionalTypeErrors(server, ['disabled'], 'boolean', prefix)
  );
  return { errors, warnings: unknownPropertyWarnings(server, MCP_SERVER_PROPERTIES, prefix) };
}

/**
 * Validate one `mcp.inputs` entry.
 * @param input - Input object
 * @param prefix - Input label (`L: mcp.inputs[<j>]`)
 * @returns Errors, and warnings for unknown properties
 */
function validateMcpInput(input: Record<string, unknown>, prefix: string): CollectionSectionIssues {
  const errors: string[] = [];
  if (input.id === undefined) {
    errors.push(`${prefix}: Missing required field: id`);
  } else if (typeof input.id !== 'string' || !MCP_INPUT_ID_PATTERN.test(input.id)) {
    errors.push(`${prefix}: id must contain only letters, digits, '_' and '-'`);
  }
  if (input.type === undefined) {
    errors.push(`${prefix}: Missing required field: type`);
  } else if (!(MCP_INPUT_TYPES as readonly unknown[]).includes(input.type)) {
    errors.push(`${prefix}: Invalid type '${describeValue(input.type)}'. Must be one of: ${MCP_INPUT_TYPES.join(', ')}`);
  }
  errors.push(
    ...optionalTypeErrors(input, ['description', 'default'], 'string', prefix),
    ...optionalTypeErrors(input, ['password'], 'boolean', prefix),
    ...optionalStringArrayErrors(input, 'options', prefix)
  );
  return { errors, warnings: unknownPropertyWarnings(input, MCP_INPUT_PROPERTIES, prefix) };
}

/**
 * Append the errors and warnings of a nested section.
 * @param issues - Issues to extend
 * @param nested - Issues of the nested section
 */
function mergeIssues(issues: CollectionSectionIssues, nested: CollectionSectionIssues): void {
  issues.errors.push(...nested.errors);
  issues.warnings.push(...nested.warnings);
}

/**
 * Validate the collection's `mcp` section.
 * @param mcp - `mcp` value (validated only when not undefined)
 * @param label - Collection label
 * @returns Errors, and warnings for unknown properties
 */
export function validateCollectionMcp(mcp: unknown, label: string): CollectionSectionIssues {
  if (mcp === undefined) {
    return { errors: [], warnings: [] };
  }
  if (!isPlainObject(mcp)) {
    return { errors: [`${label}: mcp must be an object`], warnings: [] };
  }
  const issues: CollectionSectionIssues = {
    errors: [],
    warnings: unknownPropertyWarnings(mcp, COLLECTION_MCP_PROPERTIES, `${label}: mcp`)
  };
  if (mcp.items !== undefined) {
    if (isPlainObject(mcp.items)) {
      for (const [name, server] of Object.entries(mcp.items)) {
        const prefix = `${label}: mcp.items.${name}`;
        if (!MCP_SERVER_NAME_PATTERN.test(name)) {
          issues.errors.push(`${label}: mcp.items: invalid server name '${name}' (letters, digits, '_' and '-' only)`);
        } else if (isPlainObject(server)) {
          mergeIssues(issues, validateMcpServer(server, prefix));
        } else {
          issues.errors.push(`${prefix} must be an object`);
        }
      }
    } else {
      issues.errors.push(`${label}: mcp.items must be an object`);
    }
  }
  if (mcp.inputs !== undefined) {
    if (Array.isArray(mcp.inputs)) {
      mcp.inputs.forEach((input: unknown, index) => {
        const prefix = `${label}: mcp.inputs[${index}]`;
        if (isPlainObject(input)) {
          mergeIssues(issues, validateMcpInput(input, prefix));
        } else {
          issues.errors.push(`${prefix} must be an object`);
        }
      });
    } else {
      issues.errors.push(`${label}: mcp.inputs must be an array`);
    }
  }
  return issues;
}

/**
 * Validate the collection's `display` section.
 * @param display - `display` value (validated only when not undefined)
 * @param label - Collection label
 * @returns Errors, and warnings for unknown properties
 */
export function validateCollectionDisplay(display: unknown, label: string): CollectionSectionIssues {
  if (display === undefined) {
    return { errors: [], warnings: [] };
  }
  if (!isPlainObject(display)) {
    return { errors: [`${label}: display must be an object`], warnings: [] };
  }
  const prefix = `${label}: display`;
  const errors = optionalTypeErrors(display, ['color', 'icon'], 'string', prefix);
  if (display.ordering !== undefined && !(DISPLAY_ORDERINGS as readonly unknown[]).includes(display.ordering)) {
    errors.push(`${prefix}: Invalid ordering '${describeValue(display.ordering)}'. Must be one of: ${DISPLAY_ORDERINGS.join(', ')}`);
  }
  errors.push(...optionalTypeErrors(display, ['show_badge'], 'boolean', prefix));
  return { errors, warnings: unknownPropertyWarnings(display, COLLECTION_DISPLAY_PROPERTIES, prefix) };
}
