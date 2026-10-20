/**
 * Primitive rules for skills, agents, prompts, instructions and MCP servers.
 * Pure `(path, content)` checks: they run on local files and on content fetched from a source.
 * New rules ship as warnings and are promoted to errors in a later release.
 * @module domain/governance/rules/primitive
 */
import {
  collectInputReferences,
  type McpServerInputView,
} from '../../mcp/inputs';
import {
  parseFrontmatter,
  validateSkillContent,
} from '../../skill/validate';
import type {
  GovernanceFinding,
  GovernanceRule,
} from '../types';

export const GOVERNED_PRIMITIVE_KINDS = ['skill', 'agent', 'prompt', 'instruction', 'mcp-server'] as const;
export type GovernedPrimitiveKind = typeof GOVERNED_PRIMITIVE_KINDS[number];

const PRIMITIVE_SUBJECTS = ['primitive'] as const;
const rule = (id: string, description: string, defaultSeverity: 'error' | 'warning'): GovernanceRule => ({
  id, subjects: PRIMITIVE_SUBJECTS, description, defaultSeverity, disableable: true, configurable: true, needsNetwork: false
});

export const PRIMITIVE_RULES: readonly GovernanceRule[] = [
  { ...rule('SKL001', 'Agent Skills specification and folder validation', 'error'), disableable: false },
  rule('SKL002', 'Skill validation advisories', 'warning'),
  rule('AGT001', 'Agent file is *.agent.md with frontmatter: description, and tools as a list of strings', 'warning'),
  rule('PRM001', 'Prompt file is *.prompt.md with frontmatter: description, and a valid agent or mode', 'warning'),
  rule('INS001', 'Instruction file is *.instructions.md with frontmatter applyTo glob(s)', 'warning'),
  rule('MCP001', 'MCP server definition has command or url, and every ${input:id} is declared', 'warning'),
  rule('MCP002', 'MCP server env and headers contain no literal secrets', 'warning')
];

const baseName = (file: string): string => file.replaceAll('\\', '/').split('/').pop() ?? file;
const folderOf = (file: string): string => {
  const parts = file.replaceAll('\\', '/').split('/');
  return parts.length > 1 ? parts.at(-2) ?? '' : '';
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim() !== '');
const hasText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/**
 * Infer the kind from the file name; undefined when the file is not a governed primitive.
 * @param file Repository-relative or absolute path.
 */
export function detectPrimitiveKind(file: string): GovernedPrimitiveKind | undefined {
  const name = baseName(file).toLowerCase();
  if (name === 'skill.md') {
    return 'skill';
  }
  if (name.endsWith('.agent.md')) {
    return 'agent';
  }
  if (name.endsWith('.prompt.md')) {
    return 'prompt';
  }
  if (name.endsWith('.instructions.md')) {
    return 'instruction';
  }
  if (name === 'mcp.json' || name.endsWith('.mcp.json')) {
    return 'mcp-server';
  }
  return undefined;
}

/**
 * Frontmatter is required for the markdown kinds; `null` marks missing or unparseable YAML.
 * @param content
 */
function frontmatter(content: string): Record<string, unknown> | null {
  const parsed: unknown = parseFrontmatter(content);
  return isRecord(parsed) ? parsed : null;
}

function agentErrors(file: string, content: string): string[] {
  const errors = baseName(file).toLowerCase().endsWith('.agent.md') ? [] : ['Agent file name must end with .agent.md.'];
  const meta = frontmatter(content);
  if (!meta) {
    return [...errors, 'Agent frontmatter is missing or is not valid YAML.'];
  }
  if (!hasText(meta.description)) {
    errors.push('Agent frontmatter must declare a non-empty description.');
  }
  if (meta.tools !== undefined && !isStringList(meta.tools)) {
    errors.push('Agent frontmatter tools must be a list of non-empty strings.');
  }
  return errors;
}

const PROMPT_MODES = new Set(['ask', 'edit', 'agent']);

function promptErrors(file: string, content: string): string[] {
  const errors = baseName(file).toLowerCase().endsWith('.prompt.md') ? [] : ['Prompt file name must end with .prompt.md.'];
  const meta = frontmatter(content);
  if (!meta) {
    return [...errors, 'Prompt frontmatter is missing or is not valid YAML.'];
  }
  if (!hasText(meta.description)) {
    errors.push('Prompt frontmatter must declare a non-empty description.');
  }
  if (meta.agent !== undefined && !hasText(meta.agent)) {
    errors.push('Prompt frontmatter agent must be a non-empty string.');
  }
  if (meta.mode !== undefined && !(typeof meta.mode === 'string' && PROMPT_MODES.has(meta.mode))) {
    errors.push(`Prompt frontmatter mode must be one of: ${[...PROMPT_MODES].join(', ')}.`);
  }
  return errors;
}

function instructionErrors(file: string, content: string): string[] {
  const errors = baseName(file).toLowerCase().endsWith('.instructions.md') ? [] : ['Instruction file name must end with .instructions.md.'];
  const meta = frontmatter(content);
  if (!meta) {
    return [...errors, 'Instruction frontmatter is missing or is not valid YAML.'];
  }
  const applyTo = meta.applyTo;
  const globs = typeof applyTo === 'string' ? applyTo.split(',').map((glob) => glob.trim()) : applyTo;
  if (!isStringList(globs) || globs.length === 0) {
    errors.push('Instruction frontmatter applyTo must be a glob or a list of globs.');
  } else if (globs.some((glob) => glob.startsWith('/') || glob.split('/').includes('..'))) {
    errors.push('Instruction applyTo globs must be relative and must not contain "..".');
  }
  return errors;
}

const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|credential|private[-_]?key)/i;
const SECRET_VALUE = /(ghp_|gho_|ghs_|github_pat_|xox[abpr]-|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY)/;
const isPlaceholder = (value: string): boolean => /\$\{[^}]+\}/.test(value);

function mcpFindings(file: string, content: string): GovernanceFinding[] {
  const finding = (ruleId: string, message: string): GovernanceFinding => ({ ruleId, severity: 'warning', message, file });
  let document: unknown;
  try {
    document = JSON.parse(content);
  } catch {
    return [finding('MCP001', 'MCP configuration is not valid JSON.')];
  }
  if (!isRecord(document)) {
    return [finding('MCP001', 'MCP configuration root must be an object.')];
  }
  const servers = document.servers ?? document.mcpServers;
  if (!isRecord(servers) || Object.keys(servers).length === 0) {
    return [finding('MCP001', 'MCP configuration must declare at least one server under "servers" or "mcpServers".')];
  }
  const findings: GovernanceFinding[] = [];
  const views: Record<string, McpServerInputView> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (!isRecord(server)) {
      findings.push(finding('MCP001', `MCP server '${name}' must be an object.`));
      continue;
    }
    if (!hasText(server.command) && !hasText(server.url)) {
      findings.push(finding('MCP001', `MCP server '${name}' must declare a command or a url.`));
    }
    for (const key of ['env', 'headers'] as const) {
      const map = server[key];
      if (map === undefined) {
        continue;
      }
      if (!isRecord(map) || !Object.values(map).every((value) => typeof value === 'string')) {
        findings.push(finding('MCP001', `MCP server '${name}' ${key} must map names to strings.`));
        continue;
      }
      for (const [entry, value] of Object.entries(map as Record<string, string>)) {
        if (value.trim() !== '' && !isPlaceholder(value) && (SECRET_KEY.test(entry) || SECRET_VALUE.test(value))) {
          findings.push(finding('MCP002', `MCP server '${name}' ${key} '${entry}' looks like a literal secret; use \${input:...} or \${env:...}.`));
        }
      }
    }
    if (Array.isArray(server.args) && server.args.some((arg) => typeof arg === 'string' && SECRET_VALUE.test(arg) && !isPlaceholder(arg))) {
      findings.push(finding('MCP002', `MCP server '${name}' args contain what looks like a literal secret.`));
    }
    views[name] = server;
  }
  const declared = new Set((Array.isArray(document.inputs) ? document.inputs : [])
    .filter((input): input is { id: string } => isRecord(input) && typeof input.id === 'string').map((input) => input.id));
  for (const id of [...collectInputReferences(views)].toSorted()) {
    if (!declared.has(id)) {
      findings.push(finding('MCP001', `Input '\${input:${id}}' is referenced but not declared in "inputs".`));
    }
  }
  return findings;
}

/**
 * Run the primitive rules for one file.
 * @param file Display path (repository-relative where possible).
 * @param content File content.
 * @param kind Override the kind inferred from the file name.
 */
export function primitiveFindings(file: string, content: string, kind = detectPrimitiveKind(file)): GovernanceFinding[] {
  const warn = (ruleId: string, messages: string[]): GovernanceFinding[] =>
    messages.map((message) => ({ ruleId, severity: 'warning', message, file }));
  switch (kind) {
    case 'skill': {
      return validateSkillContent(folderOf(file), content).map((message) => ({ ruleId: 'SKL001', severity: 'error', message, file }));
    }
    case 'agent': {
      return warn('AGT001', agentErrors(file, content));
    }
    case 'prompt': {
      return warn('PRM001', promptErrors(file, content));
    }
    case 'instruction': {
      return warn('INS001', instructionErrors(file, content));
    }
    case 'mcp-server': {
      return mcpFindings(file, content);
    }
    default: {
      return [];
    }
  }
}
