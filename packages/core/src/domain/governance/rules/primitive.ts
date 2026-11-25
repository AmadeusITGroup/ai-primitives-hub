/**
 * Primitive rules for skills, agents, prompts, instructions and MCP servers.
 * Pure `(path, content)` checks: they run on local files and on content fetched from a source.
 * Content advisories are warnings; path safety and invalid MCP structures are errors.
 * @module domain/governance/rules/primitive
 */
import {
  type ParseError,
  parse as parseJsonc,
} from 'jsonc-parser';
import {
  collectInputReferences,
  type McpServerInputView,
} from '../../mcp/inputs';
import type {
  PrimitiveKind,
} from '../../primitive/types';
import {
  containsSecret,
} from '../../security/rule-engine';
import {
  parseFrontmatter,
  validateSkillContent,
} from '../../skill/validate';
import type {
  GovernanceFinding,
  GovernanceRule,
} from '../types';
import {
  emptyPrimitiveBody,
  hasText,
  isRecord,
  mcpStructureFindings,
} from './primitive-checks';

export const GOVERNED_PRIMITIVE_KINDS = ['skill', 'agent', 'prompt', 'instruction', 'mcp-server'] as const satisfies readonly PrimitiveKind[];
export type GovernedPrimitiveKind = typeof GOVERNED_PRIMITIVE_KINDS[number];

/**
 * Type guard for kinds that primitive governance validates.
 * @param kind
 */
export const isGovernedPrimitiveKind = (kind: unknown): kind is GovernedPrimitiveKind =>
  (GOVERNED_PRIMITIVE_KINDS as readonly unknown[]).includes(kind);

const PRIMITIVE_SUBJECTS = ['primitive'] as const;
const rule = (id: string, description: string, defaultSeverity: 'error' | 'warning'): GovernanceRule => ({
  id, subjects: PRIMITIVE_SUBJECTS, description, defaultSeverity, disableable: true, configurable: true, needsNetwork: false
});

export const PRIMITIVE_RULES: readonly GovernanceRule[] = [
  { ...rule('SKL001', 'Agent Skills specification and folder validation', 'error'), disableable: false },
  rule('AGT001', 'Agent file is *.agent.md with frontmatter: description, and tools as a list of strings', 'warning'),
  rule('PRM001', 'Prompt file is *.prompt.md with frontmatter: description, and a valid agent or mode', 'warning'),
  rule('INS001', 'Instruction file is *.instructions.md with frontmatter applyTo glob(s)', 'warning'),
  rule('MCP001', 'Every ${input:id} referenced by an MCP server is declared in "inputs"', 'warning'),
  rule('MCP002', 'MCP server env, headers and args contain no literal secrets', 'warning'),
  rule('MCP003', 'MCP transport fields and input definitions have valid structure', 'error'),
  rule('BOD001', 'Markdown primitive has a non-empty instruction body', 'warning'),
  { ...rule('PTH001', 'Primitive paths resolve inside the repository without escaping symlinks', 'error'), disableable: false },
  { ...rule('VAL001', 'Primitive validation completed: inputs, hub sources and their collections could be read', 'error'), disableable: false }
];

const KIND_RULES: Record<GovernedPrimitiveKind, readonly string[]> = {
  skill: ['SKL001', 'BOD001'], agent: ['AGT001', 'BOD001'], prompt: ['PRM001', 'BOD001'],
  instruction: ['INS001', 'BOD001'], 'mcp-server': ['MCP001', 'MCP002', 'MCP003']
};

/**
 * Rules applicable to the kinds actually inspected, rather than inferred from findings.
 * @param kinds
 */
export function primitiveRulesForKinds(kinds: readonly GovernedPrimitiveKind[]): string[] {
  return [...new Set(kinds.flatMap((kind) => KIND_RULES[kind]))].toSorted();
}

/** Larger primitive files are reported, not parsed. */
export const MAX_PRIMITIVE_BYTES = 1024 * 1024;

/**
 * Finding for a primitive too large to inspect. Kinds with mandatory validation (skills, MCP) fail; others warn.
 * @param file Display path.
 * @param kind Inspected kind.
 */
export function oversizePrimitiveFinding(file: string, kind: GovernedPrimitiveKind): GovernanceFinding {
  const ruleId = { skill: 'SKL001', agent: 'AGT001', prompt: 'PRM001', instruction: 'INS001', 'mcp-server': 'MCP003' }[kind];
  return { ruleId, severity: kind === 'skill' || kind === 'mcp-server' ? 'error' : 'warning', verified: false, file,
    message: 'File is larger than 1 MB and could not be validated.' };
}

const baseName = (file: string): string => file.replaceAll('\\', '/').split('/').pop() ?? file;
const folderOf = (file: string): string => {
  const parts = file.replaceAll('\\', '/').split('/');
  return parts.length > 1 ? parts.at(-2) ?? '' : '';
};
const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim() !== '');

/**
 * Infer the kind from the file name; undefined when the file is not a governed primitive.
 * Skills must be named exactly `SKILL.md`, as the Agent Skills specification requires.
 * @param file Repository-relative or absolute path.
 */
export function detectPrimitiveKind(file: string): GovernedPrimitiveKind | undefined {
  if (baseName(file) === 'SKILL.md') {
    return 'skill';
  }
  const name = baseName(file).toLowerCase();
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
 * Whether a file found by directory traversal belongs to a forced kind: any `.json` for MCP servers,
 * otherwise the kind's own file naming.
 * @param file Repository-relative or absolute path.
 * @param kind Forced kind.
 */
export function isPrimitiveFileOfKind(file: string, kind: GovernedPrimitiveKind): boolean {
  return kind === 'mcp-server' ? baseName(file).toLowerCase().endsWith('.json') : detectPrimitiveKind(file) === kind;
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
const PLACEHOLDER = /\$\{[^}]+\}/g;
const isPlaceholder = (value: string): boolean => /\$\{[^}]+\}/.test(value);
/**
 * Credential patterns are shared with the security scanner; placeholders never hide a literal token.
 * @param value
 */
const hasLiteralSecret = (value: string): boolean => containsSecret(value.replaceAll(PLACEHOLDER, ''));
const stringMap = (value: unknown): Record<string, string> | undefined =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string') ? value as Record<string, string> : undefined;

/**
 * MCP002 secrets and MCP001 input references. Structure, including JSON syntax, is MCP003 only.
 * Files are read as JSONC, like VS Code's mcp.json: comments and trailing commas are allowed.
 * @param file
 * @param content
 */
function mcpFindings(file: string, content: string): GovernanceFinding[] {
  const finding = (ruleId: string, message: string): GovernanceFinding => ({ ruleId, severity: 'warning', message, file });
  const errors: ParseError[] = [];
  const document: unknown = parseJsonc(content, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    return [{ ruleId: 'MCP003', severity: 'error', file, message: 'MCP configuration is not valid JSON or JSONC.' }];
  }
  const structure = mcpStructureFindings(file, document);
  const servers = isRecord(document) ? document.servers ?? document.mcpServers : undefined;
  if (!isRecord(document) || !isRecord(servers)) {
    return structure;
  }
  const findings: GovernanceFinding[] = [];
  const views: Record<string, McpServerInputView> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (!isRecord(server)) {
      continue;
    }
    const env = stringMap(server.env);
    const headers = stringMap(server.headers);
    for (const [key, map] of [['env', env], ['headers', headers]] as const) {
      for (const [entry, value] of Object.entries(map ?? {})) {
        if (value.trim() !== '' && ((SECRET_KEY.test(entry) && !isPlaceholder(value)) || hasLiteralSecret(value))) {
          findings.push(finding('MCP002', `MCP server '${name}' ${key} '${entry}' looks like a literal secret; use \${input:...} or \${env:...}.`));
        }
      }
    }
    const args = Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === 'string') : undefined;
    if (args?.some((arg) => hasLiteralSecret(arg))) {
      findings.push(finding('MCP002', `MCP server '${name}' args contain what looks like a literal secret.`));
    }
    views[name] = {
      command: typeof server.command === 'string' ? server.command : undefined,
      url: typeof server.url === 'string' ? server.url : undefined,
      args, env, headers
    };
  }
  const declared = new Set((Array.isArray(document.inputs) ? document.inputs : [])
    .filter((input): input is { id: string } => isRecord(input) && typeof input.id === 'string').map((input) => input.id));
  for (const id of [...collectInputReferences(views)].toSorted()) {
    if (!declared.has(id)) {
      findings.push(finding('MCP001', `Input '\${input:${id}}' is referenced but not declared in "inputs".`));
    }
  }
  return [...findings, ...structure];
}

/**
 * Run the primitive rules for one file.
 * @param file Display path (repository-relative where possible).
 * @param content File content.
 * @param kind Override the kind inferred from the file name.
 * @param folder Skill folder name, when the display path has no parent folder (a root-level SKILL.md).
 */
export function primitiveFindings(
  file: string, content: string, kind = detectPrimitiveKind(file), folder = folderOf(file)
): GovernanceFinding[] {
  const warn = (ruleId: string, messages: string[]): GovernanceFinding[] =>
    messages.map((message) => ({ ruleId, severity: 'warning', message, file }));
  const body: GovernanceFinding[] = kind !== undefined && kind !== 'mcp-server' && emptyPrimitiveBody(content)
    ? [{ ruleId: 'BOD001', severity: 'warning', file, message: 'Primitive body is empty; add instructions after the frontmatter.' }]
    : [];
  switch (kind) {
    case 'skill': {
      return [...validateSkillContent(folder, content).map((message) => ({ ruleId: 'SKL001', severity: 'error' as const, message, file })), ...body];
    }
    case 'agent': {
      return [...warn('AGT001', agentErrors(file, content)), ...body];
    }
    case 'prompt': {
      return [...warn('PRM001', promptErrors(file, content)), ...body];
    }
    case 'instruction': {
      return [...warn('INS001', instructionErrors(file, content)), ...body];
    }
    case 'mcp-server': {
      return mcpFindings(file, content);
    }
    default: {
      return [];
    }
  }
}
