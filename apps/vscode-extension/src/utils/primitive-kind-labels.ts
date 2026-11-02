/**
 * Display nouns for primitive kinds, shared by the marketplace and the tree.
 *
 * Keyed by core's canonical kinds, so a new kind fails compilation until it
 * gets a label. Presentation only: which kinds a bundle holds is decided by
 * core (`countManifestItemsByKind`).
 */
import {
  normalizePrimitiveKind,
  PRIMITIVE_KINDS,
  type PrimitiveKind,
} from '@ai-primitives-hub/core';

/** Singular and plural display nouns of a primitive kind. */
export interface PrimitiveKindLabel {
  singular: string;
  plural: string;
}

/** Lowercase display nouns for every primitive kind. */
export const PRIMITIVE_KIND_LABELS: Record<PrimitiveKind, PrimitiveKindLabel> = {
  prompt: { singular: 'prompt', plural: 'prompts' },
  instruction: { singular: 'instruction', plural: 'instructions' },
  'chat-mode': { singular: 'chat mode', plural: 'chat modes' },
  agent: { singular: 'agent', plural: 'agents' },
  skill: { singular: 'skill', plural: 'skills' },
  plugin: { singular: 'plugin', plural: 'plugins' },
  hook: { singular: 'hook', plural: 'hooks' },
  'mcp-server': { singular: 'MCP server', plural: 'MCP servers' },
  steering: { singular: 'steering file', plural: 'steering files' },
  spec: { singular: 'spec', plural: 'specs' },
  command: { singular: 'command', plural: 'commands' },
  rule: { singular: 'rule', plural: 'rules' },
  'output-style': { singular: 'output style', plural: 'output styles' },
  tool: { singular: 'tool', plural: 'tools' },
  power: { singular: 'power', plural: 'powers' },
  knowledge: { singular: 'knowledge item', plural: 'knowledge items' },
  playbook: { singular: 'playbook', plural: 'playbooks' }
};

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Label a manifest item's declared type for display.
 * @param type - Declared type: a canonical kind, a legacy alias, or missing.
 * @returns The capitalized singular noun of a known kind, `Prompt` for a
 *   missing or non-string type (legacy entries default to prompts), or the
 *   type unchanged.
 */
export function primitiveKindLabel(type: unknown): string {
  if (typeof type !== 'string' || type === '') {
    return capitalize(PRIMITIVE_KIND_LABELS.prompt.singular);
  }
  const kind = normalizePrimitiveKind(type);
  return kind ? capitalize(PRIMITIVE_KIND_LABELS[kind].singular) : type;
}

/**
 * Describe per-kind item counts, e.g. `2 prompts, 1 plugin`.
 * @param counts - Item counts by primitive kind.
 * @returns Non-zero kinds in canonical kind order; empty when nothing is counted.
 */
export function formatKindCounts(counts: Partial<Record<PrimitiveKind, number>>): string {
  return PRIMITIVE_KINDS
    .filter((kind) => (counts[kind] ?? 0) > 0)
    .map((kind) => {
      const count = counts[kind]!;
      const label = PRIMITIVE_KIND_LABELS[kind];
      return `${count} ${count === 1 ? label.singular : label.plural}`;
    })
    .join(', ');
}
