/**
 * MCP config format translation — the single source of truth for converting
 * between an IDE's on-disk `mcp.json` shape and the extension's internal
 * `McpConfiguration` shape.
 *
 * IDEs disagree on the JSON root key holding the server map: VS Code Copilot
 * uses `servers`, while Kiro / Windsurf / Claude Code / Copilot CLI use
 * `mcpServers`. Internally the extension always uses `servers`.
 *
 * Both `McpConfigService` (user + workspace scope) and `McpServerManager`
 * (repository scope) delegate here so the two paths cannot diverge.
 * Longer term this belongs in the `app` package per ADR-0001; keeping it in
 * `utils` for now avoids leaking IDE-file concerns across the package boundary
 * in the same change.
 * @module utils/mcp-config-format
 */
import * as jsonc from 'jsonc-parser';
import type {
  McpConfiguration,
  McpRawConfig,
  McpServersKey,
} from '../types/mcp';

/**
 * Every known on-disk server-map key. Both are stripped during normalization
 * and serialization so a file can never end up carrying two server maps.
 */
const SERVER_MAP_KEYS: readonly string[] = ['servers', 'mcpServers'];

/**
 * Copy every key except the server-map keys, preserving unrelated IDE state
 * (Claude's API key, editor preferences, …) through a read → write cycle.
 * @param source - Raw or internal config object.
 */
function withoutServerMapKeys(source: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...source };
  for (const key of SERVER_MAP_KEYS) {
    delete rest[key];
  }
  return rest;
}

/**
 * Normalize an on-disk config into the internal shape, collapsing whichever
 * server-map key the file uses into the canonical `servers` key.
 *
 * The host's own key wins when a file contains both (which happens after a
 * manual edit or an IDE migration); the other key is dropped rather than
 * carried along, so a later write cannot emit two competing server maps.
 * @param raw - Parsed on-disk config, or null/undefined for a missing file.
 * @param serversKey - The root key the host IDE actually reads.
 * @returns Internal config with exactly one server map under `servers`.
 */
export function normalizeMcpConfig(
  raw: McpRawConfig | null | undefined,
  serversKey: McpServersKey
): McpConfiguration {
  if (!raw || typeof raw !== 'object') {
    return { servers: {} };
  }
  const hostServers = serversKey === 'mcpServers' ? raw.mcpServers : raw.servers;
  const otherServers = serversKey === 'mcpServers' ? raw.servers : raw.mcpServers;
  const rest = withoutServerMapKeys(raw);
  return {
    ...rest,
    servers: hostServers ?? otherServers ?? {}
  };
}

/**
 * Serialize an internal config to the host IDE's on-disk shape.
 *
 * `tasks` and `inputs` are re-attached additively — never via early return —
 * because a config may legitimately carry both, and `inputs` holds the prompts
 * for secrets such as API keys. Dropping either silently breaks server startup.
 * @param config - Internal config.
 * @param serversKey - The root key the host IDE expects for the server map.
 * @returns On-disk config carrying exactly one server map.
 */
export function serializeMcpConfig(
  config: McpConfiguration,
  serversKey: McpServersKey
): McpRawConfig {
  // `withoutServerMapKeys` copies every key except the two server-map keys, so
  // `tasks` and `inputs` are carried across by the copy itself. There is deliberately
  // no conditional re-attachment here: an earlier version destructured them out and
  // re-added them behind `if` guards, which is what allowed `inputs` to be dropped
  // when `tasks` was also present.
  const result = withoutServerMapKeys(config);
  result[serversKey] = config.servers ?? {};
  return result;
}

/** Result of parsing an `mcp.json` file: the config plus any recoverable parse warnings. */
export interface ParsedMcpConfig {
  /** Normalized internal config. Empty when the file is blank or unparseable. */
  readonly config: McpConfiguration;
  /** Human-readable summaries of recoverable parse errors; empty when the file parsed cleanly. */
  readonly warnings: readonly string[];
}

/**
 * Parse and normalize `mcp.json` file contents.
 *
 * Uses the JSONC parser because comments and trailing commas are valid in a
 * VS Code `mcp.json`; a strict `JSON.parse` throws on those files. Warnings are
 * returned rather than logged so this stays pure and testable — callers decide
 * how to surface them.
 * @param content - Raw file contents.
 * @param serversKey - The root key the host IDE actually reads.
 * @returns The normalized config and any recoverable parse warnings.
 */
export function parseMcpConfig(
  content: string,
  serversKey: McpServersKey
): ParsedMcpConfig {
  const errors: jsonc.ParseError[] = [];
  const raw = jsonc.parse(content, errors, { allowTrailingComma: true }) as McpRawConfig | undefined;
  const warnings = errors.map(
    (e) => `${jsonc.printParseErrorCode(e.error)} at offset ${e.offset}`
  );
  return {
    config: normalizeMcpConfig(raw, serversKey),
    warnings
  };
}
