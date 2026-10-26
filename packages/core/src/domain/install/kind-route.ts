/**
 * Layout routes and the primitive kind they install (ADR-0009).
 *
 * A target layout maps bundle path prefixes (`kindRoutes` keys such as
 * `prompts/` or `.kiro/steering/`) to output directories. The kind a route
 * installs follows from its key alone, so path-routed writers, preflight
 * and author-side validation share one derivation.
 *
 * Pure domain: no IO.
 * @module domain/install/kind-route
 */
import {
  normalizePrimitiveKind,
  type PrimitiveKind,
} from '../primitive/types';
import type {
  KindRoutes,
} from './layout';

/**
 * A layout route matched by a bundle path: the matched `kindRoutes` key,
 * its output prefix and the rest of the path below the key.
 */
export interface KindRouteMatch {
  prefix: string;
  outPrefix: string;
  tail: string;
}

/**
 * Pick the longest layout route whose key prefixes a bundle path.
 * @param bundlePath - Bundle-relative path.
 * @param routes - Layout `kindRoutes`.
 * @returns The matched route, or `null` when no key prefixes the path.
 */
export const matchKindRoute = (bundlePath: string, routes: KindRoutes): KindRouteMatch | null => {
  const normalizedBundlePath = normalizeBundlePath(bundlePath);
  const sorted = Object.entries(routes).toSorted((a, b) => b[0].length - a[0].length);
  for (const [prefix, outPrefix] of sorted) {
    if (normalizedBundlePath.startsWith(prefix)) {
      return { prefix, outPrefix, tail: normalizedBundlePath.slice(prefix.length) };
    }
  }
  return null;
};

/**
 * Normalize legacy bundle directory aliases before route matching.
 *
 * `chatmodes/` was the historical authoring path while the canonical
 * vocabulary uses `chat-modes/`. Keep accepting both on disk without
 * duplicating aliases in every target layout. The original path remains in
 * lockfile/checksum data; only the routing view is normalized.
 * @param bundlePath
 */
const normalizeBundlePath = (bundlePath: string): string =>
  bundlePath.startsWith('chatmodes/')
    ? `chat-modes/${bundlePath.slice('chatmodes/'.length)}`
    : bundlePath;

/**
 * Map a layout prefix back to the primitive kind it represents.
 * Used to honor `target.allowedKinds`.
 * @param prefix - Layout prefix (e.g., "prompts/").
 * @returns Kind name without trailing slash.
 */
export const ROUTE_PREFIX_KINDS: Record<string, PrimitiveKind> = {
  '.kiro/steering/': 'steering',
  '.kiro/specs/': 'spec',
  '.claude/commands/': 'command',
  '.claude/output-styles/': 'output-style',
  '.cursor/rules/': 'rule',
  '.cursor/agents/': 'agent',
  '.cursor/skills/': 'skill',
  '.cursor/commands/': 'command',
  '.opencode/tools/': 'tool',
  '.opencode/commands/': 'command',
  '.opencode/agents/': 'agent',
  '.opencode/skills/': 'skill',
  '.opencode/rules/': 'rule',
  '.opencode/hooks/': 'hook',
  '.opencode/plugins/': 'plugin',
  '.devin/knowledge/': 'knowledge',
  '.devin/playbooks/': 'playbook',
  '.devin/powers/': 'power',
  '.devin/prompts/': 'prompt',
  '.devin/instructions/': 'instruction',
  '.devin/agents/': 'agent',
  '.devin/skills/': 'skill',
  '.devin/hooks/': 'hook',
  '.devin/plugins/': 'plugin'
};

/**
 * The primitive kind a layout route installs: a single-segment key names
 * its kind (`prompts/`, `chat-modes/`, `mcp/` …); a nested key is looked up
 * in {@link ROUTE_PREFIX_KINDS}.
 * @param prefix - Layout `kindRoutes` key, with or without trailing `/`.
 * @returns The route's kind, or `null` for an unknown key.
 */
export const routeKindOf = (prefix: string): PrimitiveKind | null => {
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return normalizePrimitiveKind(prefix.replace(/\/$/, ''))
    ?? ROUTE_PREFIX_KINDS[normalizedPrefix]
    ?? null;
};
