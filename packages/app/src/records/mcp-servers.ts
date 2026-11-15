/**
 * MCP servers an install record entry owns. A server's definition lives in the
 * tool's own MCP file (`.vscode/mcp.json`, `.kiro/settings/mcp.json`, …), next
 * to servers the user added; the entry records each server's file, name and the
 * checksum of the definition it wrote. Only servers an entry recorded are
 * changed or removed, and a server whose definition changed since is kept.
 * Files are read and written as plain JSON; a file with comments is refused.
 * @module records/mcp-servers
 */
import {
  createHash,
} from 'node:crypto';
import * as path from 'node:path';
import {
  isJsonObject,
  type McpEnvPlaceholderStyle,
  type McpServersKey,
  RECORD_MAX_BYTES,
  type RecordedMcpServer,
  recordError,
  type RecordFs,
  resolveMcpServerKey,
  rewriteEnvPlaceholders,
} from '@ai-primitives-hub/core';
import {
  writeFileAtomically,
} from './atomic-write';

/** A tool's MCP file. */
export interface McpConfigFile {
  /** Absolute path. */
  path: string;
  /** Root key of the server map. */
  serversKey: McpServersKey;
}

/** One server to write, under its final name. */
export interface McpServerToWrite {
  name: string;
  /** Server name in the bundle. */
  item: string;
  definition: Record<string, unknown>;
}

/** What {@link prepareMcpServers} needs. */
export interface PrepareMcpServersInput {
  /** The deployment manifest's `mcpServers`. */
  servers: Readonly<Record<string, unknown>> | undefined;
  bundleId: string;
  version: string;
  /** Manifest (collection) id. */
  manifestId?: string;
  /** The deployment manifest's `repository`. */
  manifestRepository?: string;
  /** Repository of the source the bundle came from. */
  sourceRepository?: string;
  /** Value of `${bundlePath}`. */
  bundlePath: string;
  envPlaceholderStyle?: McpEnvPlaceholderStyle;
}

/** Fields that do not count as a change of the definition: tools set them, as duplicate detection sets both. */
const VOLATILE_FIELDS = new Set(['disabled', 'description']);

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => canonical(item));
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(Object.keys(value).toSorted().map((key) => [key, canonical(value[key])]));
  }
  return value;
};

/**
 * `sha256:` of a server definition, keys sorted, without fields the tools change themselves (`disabled`, `description`).
 * @param definition - Server definition as in the MCP file.
 */
export const mcpServerChecksumOf = (definition: unknown): string => {
  const fields = isJsonObject(definition)
    ? Object.fromEntries(Object.entries(definition).filter(([key]) => !VOLATILE_FIELDS.has(key)))
    : definition;
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(fields))).digest('hex')}`;
};

const substitute = (value: unknown, replace: (text: string) => string): unknown => {
  if (typeof value === 'string') {
    return replace(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => substitute(item, replace));
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, replace)]));
  }
  return value;
};

/**
 * The bundle's MCP servers as they are written: named like the extension names
 * them, `${bundlePath}`, `${bundleId}` and `${bundleVersion}` filled in, and
 * `${env:VAR}` kept unresolved in the tool's syntax.
 * @param input - Manifest servers and the bundle they come from.
 */
export const prepareMcpServers = (input: PrepareMcpServersInput): McpServerToWrite[] => {
  const style = input.envPlaceholderStyle ?? 'prefixed';
  const replace = (text: string): string => rewriteEnvPlaceholders(text
    .replaceAll('${bundlePath}', input.bundlePath)
    .replaceAll('${bundleId}', input.bundleId)
    .replaceAll('${bundleVersion}', input.version), style);
  return Object.entries(input.servers ?? {})
    .filter((entry): entry is [string, Record<string, unknown>] => isJsonObject(entry[1]))
    .map(([item, definition]) => ({
      name: resolveMcpServerKey({
        bundleId: input.bundleId,
        serverName: item,
        ...(input.manifestId === undefined ? {} : { manifestId: input.manifestId }),
        ...(input.manifestRepository === undefined ? {} : { manifestRepository: input.manifestRepository }),
        ...(input.sourceRepository === undefined ? {} : { sourceRepository: input.sourceRepository })
      }),
      item,
      definition: substitute(definition, replace) as Record<string, unknown>
    }));
};

/**
 * Read an MCP file; a missing file is empty.
 * @param fs - Filesystem port.
 * @param file - The MCP file.
 * @param label - File named in errors.
 * @throws {RegistryError} `RECORD.MCP_CONFIG_UNREADABLE` for a file that is not a plain JSON object.
 */
export const readMcpConfig = async (fs: RecordFs, file: McpConfigFile, label: string): Promise<Record<string, unknown>> => {
  if (!(await fs.exists(file.path))) {
    return {};
  }
  try {
    const bytes = await fs.readCapped(file.path, RECORD_MAX_BYTES + 1);
    if (bytes.byteLength > RECORD_MAX_BYTES) {
      throw new Error('larger than 10 MB');
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed: unknown = text.trim() === '' ? {} : JSON.parse(text);
    if (!isJsonObject(parsed)) {
      throw new Error('not a JSON object');
    }
    return parsed;
  } catch (error) {
    throw recordError('RECORD.MCP_CONFIG_UNREADABLE', { file: label, detail: error instanceof Error ? error.message : String(error), cause: error });
  }
};

const serversIn = (config: Record<string, unknown>, serversKey: McpServersKey): Record<string, unknown> => {
  const servers = config[serversKey];
  return isJsonObject(servers) ? servers : {};
};

const writeMcpConfig = async (fs: RecordFs, file: McpConfigFile, config: Record<string, unknown>): Promise<void> => {
  await fs.mkdir(path.dirname(file.path), { recursive: true });
  await writeFileAtomically(fs, file.path, `${JSON.stringify(config, null, 2)}\n`);
};

/**
 * Write servers into an MCP file, keeping every other key and server. A name the
 * file has that `isRecorded` does not claim was added by someone else and is refused.
 * @param fs - Filesystem port.
 * @param file - The MCP file.
 * @param servers - Servers to write.
 * @param options - Which existing names an install recorded, and the file name for errors.
 * @param options.isRecorded - Whether an install record lists this server name for this file.
 * @param options.label - File named in errors, relative to the level root.
 * @returns Each server as recorded, without `config`.
 * @throws {RegistryError} `RECORD.MCP_CONFLICT` or `RECORD.MCP_CONFIG_UNREADABLE`; the file is then unchanged.
 */
export const writeMcpServers = async (
  fs: RecordFs,
  file: McpConfigFile,
  servers: readonly McpServerToWrite[],
  options: { isRecorded: (name: string) => boolean; label: string }
): Promise<{ name: string; item: string; checksum: string }[]> => {
  if (servers.length === 0) {
    return [];
  }
  const config = await readMcpConfig(fs, file, options.label);
  const existing = serversIn(config, file.serversKey);
  const taken = servers.filter((server) => Object.hasOwn(existing, server.name) && !options.isRecorded(server.name));
  if (taken.length > 0) {
    throw recordError('RECORD.MCP_CONFLICT', {
      file: options.label,
      detail: `server ${taken.map((server) => JSON.stringify(server.name)).join(', ')} is already in the file`,
      context: { servers: taken.map((server) => server.name) }
    });
  }
  const next = { ...existing };
  for (const server of servers) {
    // A tool's own `disabled` setting survives a rewrite.
    const current = existing[server.name];
    const kept = isJsonObject(current) && current.disabled !== undefined ? { disabled: current.disabled } : {};
    next[server.name] = { ...server.definition, ...kept };
  }
  await writeMcpConfig(fs, file, { ...config, [file.serversKey]: next });
  return servers.map((server) => ({ name: server.name, item: server.item, checksum: mcpServerChecksumOf(server.definition) }));
};

/** Outcome of {@link removeMcpServers}. */
export interface RemoveMcpServersResult {
  /** Names removed. */
  removed: string[];
  /** Names kept because their definition changed since the install. */
  modified: string[];
}

/**
 * Remove recorded servers from an MCP file. A server whose definition no longer
 * matches its recorded checksum is kept; a missing one is skipped. The file is
 * deleted only when nothing but an empty server map is left.
 * @param fs - Filesystem port.
 * @param file - The MCP file.
 * @param servers - Recorded servers of this file.
 * @param label - File named in errors.
 * @throws {RegistryError} `RECORD.MCP_CONFIG_UNREADABLE`; the file is then unchanged.
 */
export const removeMcpServers = async (
  fs: RecordFs,
  file: McpConfigFile,
  servers: readonly RecordedMcpServer[],
  label: string
): Promise<RemoveMcpServersResult> => {
  const result: RemoveMcpServersResult = { removed: [], modified: [] };
  if (servers.length === 0 || !(await fs.exists(file.path))) {
    return result;
  }
  const config = await readMcpConfig(fs, file, label);
  const next = { ...serversIn(config, file.serversKey) };
  for (const server of servers) {
    if (!Object.hasOwn(next, server.name)) {
      continue;
    }
    if (server.checksum !== undefined && mcpServerChecksumOf(next[server.name]) !== server.checksum) {
      result.modified.push(server.name);
      continue;
    }
    delete next[server.name];
    result.removed.push(server.name);
  }
  if (result.removed.length === 0) {
    return result;
  }
  // A file left with nothing but an empty server map is the one an install created: it goes too.
  await (Object.keys(next).length === 0 && Object.keys(config).every((key) => key === file.serversKey)
    ? fs.unlink(file.path)
    : writeMcpConfig(fs, file, { ...config, [file.serversKey]: next }));
  return result;
};

/**
 * The key a server is known by across entries: its file and name.
 * @param server - Recorded server.
 */
export const mcpServerKeyOf = (server: Pick<RecordedMcpServer, 'config' | 'name'>): string => `${server.config}\u0000${server.name}`;
