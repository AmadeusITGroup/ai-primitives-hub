/**
 * Primitive install categories (ADR-0009).
 *
 * Every primitive kind belongs to exactly one install category, which
 * decides how a bundle item of that kind is packaged and placed:
 *
 * - `file`: the item is one file.
 * - `directory`: the item is its whole directory (`dirname(item.path)`),
 *   installed as one unit named after that directory.
 * - `config`: the item is merged into a target's configuration file.
 *
 * The table reflects today's behaviour. It is a `Record` over every kind,
 * so adding a kind does not compile without its category.
 *
 * Pure domain: no IO.
 * @module domain/install/category
 */
import type {
  PrimitiveKind,
} from '../primitive/types';

/** The install categories, in ADR-0009 order. */
export const INSTALL_CATEGORIES = ['file', 'directory', 'config'] as const;

/** How a primitive kind is packaged and installed. */
export type InstallCategory = typeof INSTALL_CATEGORIES[number];

/** Install category of every primitive kind. */
export const KIND_INSTALL_CATEGORIES: Readonly<Record<PrimitiveKind, InstallCategory>> = {
  prompt: 'file',
  instruction: 'file',
  'chat-mode': 'file',
  agent: 'file',
  skill: 'directory',
  plugin: 'directory',
  hook: 'file',
  'mcp-server': 'config',
  steering: 'file',
  spec: 'file',
  command: 'file',
  rule: 'file',
  'output-style': 'file',
  tool: 'file',
  power: 'file',
  knowledge: 'file',
  playbook: 'file'
};

/**
 * Install category of a primitive kind.
 * @param kind - Canonical primitive kind.
 * @returns The kind's install category.
 */
export const categoryOf = (kind: PrimitiveKind): InstallCategory => KIND_INSTALL_CATEGORIES[kind];
