/** Additional pure primitive checks; no filesystem or network access. */
import type {
  GovernanceFinding,
  GovernanceRule,
} from '../types';

export const ADDITIONAL_PRIMITIVE_RULES: readonly GovernanceRule[] = [
  { id: 'PTH001', subjects: ['primitive'], description: 'Primitive paths resolve inside the repository without escaping symlinks',
    defaultSeverity: 'error', disableable: false, configurable: true, needsNetwork: false },
  { id: 'BOD001', subjects: ['primitive'], description: 'Markdown primitive has a non-empty instruction body',
    defaultSeverity: 'warning', disableable: true, configurable: true, needsNetwork: false },
  { id: 'MCP003', subjects: ['primitive'], description: 'MCP transport fields and input definitions have valid structure',
    defaultSeverity: 'error', disableable: true, configurable: true, needsNetwork: false }
];

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/**
 * Ignore metadata and HTML comments when deciding whether any instructions exist.
 * @param content
 */
export function emptyPrimitiveBody(content: string): boolean {
  return content.replaceAll('\r\n', '\n').replace(/^---\n(?:[\s\S]*?\n)?---(?:\n|$)/, '').replace(/<!--[\s\S]*?-->/g, '').trim() === '';
}

/**
 * Validate structure, not command execution, endpoint availability or input resolution.
 * @param file
 * @param document
 */
export function mcpStructureFindings(file: string, document: unknown): GovernanceFinding[] {
  const findings: GovernanceFinding[] = [];
  const error = (message: string): void => {
    findings.push({ ruleId: 'MCP003', severity: 'error', file, message });
  };
  if (!record(document)) {
    error('MCP configuration root must be an object.');
    return findings;
  }
  const servers = document.servers ?? document.mcpServers;
  if (!record(servers) || Object.keys(servers).length === 0) {
    error('MCP configuration must declare a non-empty server map.');
    return findings;
  }
  for (const [name, server] of Object.entries(servers)) {
    const invalid = (message: string): void => error(`MCP server '${name}': ${message}`);
    if (!record(server)) {
      invalid('definition must be an object.');
      continue;
    }
    const hasCommand = server.command !== undefined;
    const hasUrl = server.url !== undefined;
    if (hasCommand === hasUrl) {
      invalid('declare exactly one command or url.');
    }
    if (hasCommand && !text(server.command)) {
      invalid('command must be a non-empty string.');
    }
    if (hasUrl && (!text(server.url) || (!/^https?:\/\/[^/\s?#]+(?:[/?#][^\s]*)?$/i.test(server.url)
      && !/^\$\{(?:input|env):[^}]+\}$/.test(server.url)))) {
      invalid('url must be an HTTP or HTTPS URL, or an input/environment placeholder.');
    }
    if (server.args !== undefined && !strings(server.args)) {
      invalid('args must be an array of strings.');
    }
    if (hasUrl && (server.args !== undefined || server.env !== undefined || server.cwd !== undefined)) {
      invalid('args, env and cwd are stdio-only fields.');
    }
    if (hasCommand && server.headers !== undefined) {
      invalid('headers are only supported for HTTP or SSE servers.');
    }
    if (server.cwd !== undefined && !text(server.cwd)) {
      invalid('cwd must be a non-empty string.');
    }
    if (server.type !== undefined && (typeof server.type !== 'string' || !['stdio', 'http', 'sse'].includes(server.type))) {
      invalid('type must be stdio, http or sse.');
    }
    if ((server.type === 'stdio' && !hasCommand) || ((server.type === 'http' || server.type === 'sse') && !hasUrl)) {
      invalid('transport type does not match command/url.');
    }
    for (const key of ['env', 'headers']) {
      const value = server[key];
      if (value !== undefined && (!record(value) || !Object.values(value).every((entry) => typeof entry === 'string'))) {
        invalid(`${key} must map names to strings.`);
      }
    }
  }
  if (document.inputs === undefined) {
    return findings;
  }
  if (!Array.isArray(document.inputs)) {
    error('MCP inputs must be an array.');
    return findings;
  }
  const seen = new Set<string>();
  for (const [index, input] of document.inputs.entries()) {
    const invalid = (message: string): void => error(`MCP input #${index + 1}: ${message}`);
    if (!record(input)) {
      invalid('definition must be an object.');
      continue;
    }
    if (text(input.id)) {
      if (seen.has(input.id)) {
        invalid('duplicate input id.');
      }
      seen.add(input.id);
    } else {
      invalid('id must be a non-empty string.');
    }
    if (typeof input.type !== 'string' || !['promptString', 'pickString', 'command'].includes(input.type)) {
      invalid('unsupported input type.');
    }
    if (input.type === 'promptString' || input.type === 'pickString') {
      if (!text(input.description)) {
        invalid('description must be a non-empty string.');
      }
      if (input.default !== undefined && typeof input.default !== 'string') {
        invalid('default must be a string.');
      }
    }
    if (input.type === 'promptString' && input.password !== undefined && typeof input.password !== 'boolean') {
      invalid('password must be a boolean.');
    }
    if (input.type === 'command' && !text(input.command)) {
      invalid('command must be a non-empty string.');
    }
    if (input.type === 'pickString') {
      if (!Array.isArray(input.options) || input.options.length === 0
        || !input.options.every((option) => text(option) || (record(option) && text(option.label) && text(option.value)))) {
        invalid('options must be a non-empty list of strings or label/value objects.');
      } else if (typeof input.default === 'string' && !input.options.some((option) => (record(option) ? option.value : option) === input.default)) {
        invalid('default must match an option value.');
      }
    }
  }
  return findings;
}
