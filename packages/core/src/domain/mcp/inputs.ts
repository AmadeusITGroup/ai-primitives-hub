/**
 * MCP input declaration types and the reference scanner.
 *
 * `${input:id}` is a VS Code Copilot feature: an `inputs` array at the root
 * of an MCP config file declares the values the IDE should prompt for, and
 * each server config can reference them via `${input:id}` placeholders.
 *
 * This module holds only the domain types and the pure scanner — use-case
 * orchestration (merge, auto-derive) lives in `@ai-primitives-hub/app`.
 *
 * Pure: no IO, no side effects, no framework imports.
 * @module domain/mcp/inputs
 */

/**
 * A single input declaration as written in the `inputs` array of an MCP
 * config file.  Mirrors the VS Code Copilot `inputs` schema.
 */
export interface McpInputDefinition {
  /** Unique identifier referenced by `${input:<id>}` placeholders. */
  id: string;
  /** How the value is collected: `promptString` is the common case. */
  type: 'promptString' | 'pickString' | 'command';
  /** Human-readable label shown in the IDE prompt. */
  description?: string;
  /** Whether the value should be masked in the UI. */
  password?: boolean;
  /** Pre-filled default value. */
  default?: string;
  /** Choices for `pickString` type. */
  options?: string[];
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
    if (!value) return;
    let match: RegExpExecArray | null;
    while ((match = inputPattern.exec(value)) !== null) {
      referenced.add(match[1]);
    }
  };

  for (const config of Object.values(servers)) {
    scan(config.url);
    scan(config.command);
    config.args?.forEach(scan);
    if (config.env) Object.values(config.env).forEach(scan);
    if (config.headers) Object.values(config.headers).forEach(scan);
  }

  return referenced;
}
