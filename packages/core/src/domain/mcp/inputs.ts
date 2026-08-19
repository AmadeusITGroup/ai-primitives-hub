/**
 * MCP input reference scanning — pure domain logic.
 *
 * `${input:id}` is a host-specific feature (currently VS Code Copilot): an
 * `inputs` array at the root of an MCP config file declares the values the
 * IDE should prompt for, and each server config can reference them via
 * `${input:id}` placeholders.
 *
 * This module provides only the generic scanner and minimal types needed by
 * use-case orchestration in `@ai-primitives-hub/app`. The full
 * IDE-specific input definition interface (`McpInputDefinition`) lives in
 * the delivery layer (`apps/vscode-extension/src/types/mcp.ts`).
 *
 * Pure: no IO, no side effects, no framework imports.
 * @module domain/mcp/inputs
 */

/**
 * Minimal shape for an input declaration — just enough for merge/derive
 * logic to identify and deduplicate entries by `id`.
 *
 * The full schema (password, options, default, etc.) is delivery-layer
 * specific and defined in the extension's type file.
 */
export interface McpInputDeclaration {
  /** Unique identifier referenced by `${input:<id>}` placeholders. */
  id: string;
  /** Discriminator for the prompt type. */
  type: string;
  /** Human-readable label shown in the IDE prompt. */
  description?: string;
}

/**
 * A minimal server config shape sufficient for input-reference scanning.
 * The full per-IDE server shapes live in the extension layer; this interface
 * only captures the fields that may carry `${input:id}` tokens.
 */
export interface McpServerInputView {
  /** stdio server command string */
  command?: string;
  /** stdio server arguments */
  args?: string[];
  /** stdio server environment variables */
  env?: Record<string, string>;
  /** remote server URL */
  url?: string;
  /** remote server request headers (common source of `${input:id}` tokens) */
  headers?: Record<string, string>;
}

/**
 * Collect all `${input:id}` references from a map of server configurations.
 *
 * Scans command, args, env values, URL, and header values for every server.
 * Pure: no IO.
 * @param servers - Server config map (prefixed server name → config).
 * @returns Set of referenced input ids (without the `${input:…}` delimiters).
 */
export function collectInputReferences(
  servers: Record<string, McpServerInputView>
): Set<string> {
  const inputPattern = /\$\{input:([^}]+)\}/g;
  const referenced = new Set<string>();

  const scan = (value: string | undefined): void => {
    if (!value) {
      return;
    }
    let match: RegExpExecArray | null;
    while ((match = inputPattern.exec(value)) !== null) {
      referenced.add(match[1]);
    }
  };

  for (const config of Object.values(servers)) {
    scan(config.url);
    scan(config.command);
    config.args?.forEach((v) => {
      scan(v);
    });
    if (config.env) {
      Object.values(config.env).forEach((v) => {
        scan(v);
      });
    }
    if (config.headers) {
      Object.values(config.headers).forEach((v) => {
        scan(v);
      });
    }
  }

  return referenced;
}
