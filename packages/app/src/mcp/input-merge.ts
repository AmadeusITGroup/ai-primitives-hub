/**
 * MCP input merge and auto-derive use-case logic.
 *
 * These functions orchestrate input declaration handling during MCP server
 * installation. They use the generic `McpInputDeclaration` from core and
 * the `collectInputReferences` scanner — no IO, no framework dependency.
 *
 * The full IDE-specific input type (`McpInputDefinition`) lives in the
 * delivery layer; these functions work with any object that has an `id` field.
 *
 * Pure: no IO, no side effects.
 * @module mcp/input-merge
 */

import type {
  McpInputDeclaration,
  McpServerInputView,
} from '@ai-primitives-hub/core';
import {
  collectInputReferences,
} from '@ai-primitives-hub/core';

/**
 * Merge new input declarations into an existing set, deduplicating by id.
 *
 * Existing declarations win: if an id already exists, the incoming entry is
 * ignored so that a bundle author's re-install does not reset a user-edited
 * description or password flag.
 * @param existing - Current inputs array from the host's config file.
 * @param incoming - New declarations from the bundle manifest.
 * @returns Merged array, or `undefined` when the result would be empty.
 */
export function mergeInputDeclarations<T extends McpInputDeclaration>(
  existing: T[] | undefined,
  incoming: T[] | undefined
): T[] | undefined {
  if (!incoming || incoming.length === 0) {
    return existing;
  }
  const merged: T[] = existing ? [...existing] : [];
  const existingIds = new Set(merged.map((i) => i.id));
  for (const input of incoming) {
    if (!existingIds.has(input.id)) {
      merged.push(input);
      existingIds.add(input.id);
    }
  }
  return merged.length > 0 ? merged : undefined;
}

/**
 * Auto-derive synthetic input declarations for `${input:id}` references that
 * have no matching declaration in the bundle's `mcpInputs`.
 *
 * The bundle manifest should always declare every referenced id, but if it
 * doesn't this function synthesises a minimal `promptString` entry so the
 * placeholder is resolvable at runtime and the literal unresolved string is
 * never sent as a header value.
 * @param servers - Newly-installed servers to scan for references.
 * @param existingInputs - Declarations already present (merged manifest + file).
 * @returns Updated inputs array and warnings to surface to the user.
 */
export function autoDeriveMissingInputs<T extends McpInputDeclaration>(
  servers: Record<string, McpServerInputView>,
  existingInputs: T[] | undefined
): { inputs: T[] | undefined; warnings: string[] } {
  const warnings: string[] = [];
  const referenced = collectInputReferences(servers);
  const declaredIds = new Set((existingInputs ?? []).map((i) => i.id));
  const undeclared = [...referenced].filter((id) => !declaredIds.has(id));

  if (undeclared.length === 0) {
    return { inputs: existingInputs, warnings };
  }

  const inputs: T[] = existingInputs ? [...existingInputs] : [];
  for (const id of undeclared) {
    warnings.push(
      `Input "${id}" is referenced by a server config but has no matching declaration in the bundle's mcpInputs. `
      + `A placeholder declaration has been auto-derived; update the bundle manifest to provide a proper description.`
    );
    inputs.push({
      id,
      type: 'promptString',
      description: `Enter value for "${id}"`
    } as T);
  }
  return { inputs, warnings };
}
