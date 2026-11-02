/**
 * Drift guard between the published collection schema and the
 * hand-written collection validation.
 *
 * `validateCollectionObject` enforces `collection.schema.json` without a
 * schema validator, so every property, enum, limit and closed object of
 * the schema is mirrored by a constant in `collection-schema-rules.ts`.
 * These tests fail as soon as the schema changes without that file.
 *
 * Validation is more lenient than the schema on one point: an unknown key
 * of a closed object (`additionalProperties: false`) is a warning, not an
 * error. The pattern-keyed `mcp.items` is the exception: its keys are
 * server names, and an invalid one is an error.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  COLLECTION_CLOSED_OBJECTS,
  COLLECTION_DESCRIPTION_MAX_LENGTH,
  COLLECTION_DISPLAY_PROPERTIES,
  COLLECTION_ITEM_PROPERTIES,
  COLLECTION_ITEM_REQUIRED_PROPERTIES,
  COLLECTION_MCP_PROPERTIES,
  COLLECTION_NAME_MAX_LENGTH,
  COLLECTION_REQUIRED_PROPERTIES,
  COLLECTION_ROOT_PROPERTIES,
  COLLECTION_SCHEMA,
  DEFAULT_VALIDATION_RULES,
  DISPLAY_ORDERINGS,
  MCP_INPUT_ID_PATTERN,
  MCP_INPUT_PROPERTIES,
  MCP_INPUT_REQUIRED_PROPERTIES,
  MCP_INPUT_TYPES,
  MCP_SERVER_NAME_PATTERN,
  MCP_SERVER_PROPERTIES,
  MCP_SERVER_TYPES,
  PRIMITIVE_KINDS,
  validateCollectionObject,
} from '../../../src/index';

interface SchemaNode {
  type?: string;
  required?: string[];
  enum?: string[];
  pattern?: string;
  maxLength?: number;
  maxItems?: number;
  properties?: Record<string, SchemaNode>;
  patternProperties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  additionalProperties?: boolean | SchemaNode;
}

const schema = COLLECTION_SCHEMA as unknown as SchemaNode;
const props = (node: SchemaNode | undefined): Record<string, SchemaNode> => node?.properties ?? {};
const root = props(schema);
const item = root.items.items!;
const mcp = root.mcp;
const mcpItems = props(mcp).items;
const [serverPattern, server] = Object.entries(mcpItems.patternProperties ?? {})[0] ?? [];
const input = props(mcp).inputs.items!;
const display = root.display;

const sorted = (values: readonly string[] | undefined): string[] => [...(values ?? [])].toSorted();

/** A closed object of the schema and whether its keys must match `patternProperties`. */
interface ClosedObject {
  path: string;
  patternKeyed: boolean;
}

/**
 * Collect every object the schema closes with `additionalProperties: false`.
 * @param node - Schema node to walk
 * @param dataPath - Data path of the value the node describes
 * @param out - Accumulated closed objects
 * @returns The accumulated closed objects
 */
function closedObjects(node: SchemaNode, dataPath: string, out: ClosedObject[] = []): ClosedObject[] {
  if (node.additionalProperties === false) {
    out.push({ path: dataPath, patternKeyed: node.patternProperties !== undefined });
  }
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    closedObjects(child, `${dataPath}.${key}`, out);
  }
  for (const child of Object.values(node.patternProperties ?? {})) {
    closedObjects(child, `${dataPath}.<server>`, out);
  }
  if (node.items) {
    closedObjects(node.items, `${dataPath}[]`, out);
  }
  if (typeof node.additionalProperties === 'object') {
    closedObjects(node.additionalProperties, `${dataPath}.<key>`, out);
  }
  return out;
}

const L = 'collections/x.collection.yml';
const valid = (): Record<string, unknown> => ({
  id: 'x',
  name: 'X',
  description: 'A collection',
  items: [{ path: 'prompts/hello.prompt.md', kind: 'prompt' }]
});

/**
 * The warning for an unknown property in a free-form closed object.
 * @param prefix - Location of the object
 * @param allowed - Properties the schema allows there
 * @param noun - `property`, or `root property` at the root
 * @returns The expected warning
 */
const unknownWarning = (prefix: string, allowed: readonly string[], noun = 'property'): string =>
  `${prefix}: unknown ${noun} 'extra' is not in the collection schema; remove it or rename it to one of: ${allowed.join(', ')}`;

/**
 * A collection carrying an unknown key at each closed object, and how it is
 * reported: a warning for a free-form object, an error for the
 * pattern-keyed `mcp.items` (its keys are server names).
 */
const UNKNOWN_PROPERTY_PROBES: Record<string, { collection: Record<string, unknown>; severity: 'warning' | 'error'; message: string }> = {
  $: {
    collection: { ...valid(), extra: 1 },
    severity: 'warning',
    message: unknownWarning(L, COLLECTION_ROOT_PROPERTIES, 'root property')
  },
  '$.items[]': {
    collection: { ...valid(), items: [{ path: 'prompts/hello.prompt.md', kind: 'prompt', extra: 1 }] },
    severity: 'warning',
    message: unknownWarning(`${L}: items[0]`, COLLECTION_ITEM_PROPERTIES)
  },
  '$.mcp': {
    collection: { ...valid(), mcp: { extra: 1 } },
    severity: 'warning',
    message: unknownWarning(`${L}: mcp`, COLLECTION_MCP_PROPERTIES)
  },
  '$.mcp.items': {
    collection: { ...valid(), mcp: { items: { 'bad name': { command: 'node' } } } },
    severity: 'error',
    message: `${L}: mcp.items: invalid server name 'bad name' (letters, digits, '_' and '-' only)`
  },
  '$.mcp.items.<server>': {
    collection: { ...valid(), mcp: { items: { srv: { command: 'node', extra: 1 } } } },
    severity: 'warning',
    message: unknownWarning(`${L}: mcp.items.srv`, MCP_SERVER_PROPERTIES)
  },
  '$.mcp.inputs[]': {
    collection: { ...valid(), mcp: { inputs: [{ id: 'tok', type: 'promptString', extra: 1 }] } },
    severity: 'warning',
    message: unknownWarning(`${L}: mcp.inputs[0]`, MCP_INPUT_PROPERTIES)
  },
  '$.display': {
    collection: { ...valid(), display: { extra: 1 } },
    severity: 'warning',
    message: unknownWarning(`${L}: display`, COLLECTION_DISPLAY_PROPERTIES)
  }
};

describe('collection schema drift guard', () => {
  it('knows every property and required list of the schema', () => {
    expect(sorted(Object.keys(root))).toEqual(sorted(COLLECTION_ROOT_PROPERTIES));
    expect(sorted(schema.required)).toEqual(sorted(COLLECTION_REQUIRED_PROPERTIES));
    expect(sorted(Object.keys(props(item)))).toEqual(sorted(COLLECTION_ITEM_PROPERTIES));
    expect(sorted(item.required)).toEqual(sorted(COLLECTION_ITEM_REQUIRED_PROPERTIES));
    expect(sorted(Object.keys(props(mcp)))).toEqual(sorted(COLLECTION_MCP_PROPERTIES));
    expect(Object.keys(mcpItems.patternProperties ?? {})).toEqual([MCP_SERVER_NAME_PATTERN.source]);
    expect(sorted(Object.keys(props(server)))).toEqual(sorted(MCP_SERVER_PROPERTIES));
    expect(sorted(Object.keys(props(input)))).toEqual(sorted(MCP_INPUT_PROPERTIES));
    expect(sorted(input.required)).toEqual(sorted(MCP_INPUT_REQUIRED_PROPERTIES));
    expect(sorted(Object.keys(props(display)))).toEqual(sorted(COLLECTION_DISPLAY_PROPERTIES));
    expect(serverPattern).toBe(MCP_SERVER_NAME_PATTERN.source);
  });

  it('knows every enum of the schema', () => {
    expect(sorted(props(item).kind.enum)).toEqual(sorted(PRIMITIVE_KINDS));
    expect(sorted(props(server).type.enum)).toEqual(sorted(MCP_SERVER_TYPES));
    expect(sorted(props(input).type.enum)).toEqual(sorted(MCP_INPUT_TYPES));
    expect(sorted(props(display).ordering.enum)).toEqual(sorted(DISPLAY_ORDERINGS));
  });

  it('knows every limit and pattern of the schema', () => {
    expect(root.name.maxLength).toBe(COLLECTION_NAME_MAX_LENGTH);
    expect(root.description.maxLength).toBe(COLLECTION_DESCRIPTION_MAX_LENGTH);
    expect(root.items).not.toHaveProperty('maxItems');
    expect(root.id.maxLength).toBe(DEFAULT_VALIDATION_RULES.collectionId.maxLength);
    expect(root.id.pattern).toBe(DEFAULT_VALIDATION_RULES.collectionId.pattern.source);
    expect(root.version.pattern).toBe(DEFAULT_VALIDATION_RULES.version.pattern.source);
    expect(props(input).id.pattern).toBe(MCP_INPUT_ID_PATTERN.source);
  });

  it('covers every closed object of the schema', () => {
    expect(sorted(closedObjects(schema, '$').map((closed) => closed.path))).toEqual(sorted(COLLECTION_CLOSED_OBJECTS));
    expect(sorted(Object.keys(UNKNOWN_PROPERTY_PROBES))).toEqual(sorted(COLLECTION_CLOSED_OBJECTS));
  });

  it('reports unknown keys of free-form closed objects as warnings and invalid keys of pattern-keyed ones as errors', () => {
    for (const closed of closedObjects(schema, '$')) {
      expect(UNKNOWN_PROPERTY_PROBES[closed.path]?.severity, closed.path).toBe(closed.patternKeyed ? 'error' : 'warning');
    }
  });

  it.each(Object.entries(UNKNOWN_PROPERTY_PROBES))('reports an unknown property at %s', (_path, probe) => {
    const result = validateCollectionObject(probe.collection, L);
    if (probe.severity === 'warning') {
      expect(result).toEqual({ ok: true, errors: [], warnings: [probe.message] });
    } else {
      expect(result).toEqual({ ok: false, errors: [probe.message], warnings: [] });
    }
  });
});
