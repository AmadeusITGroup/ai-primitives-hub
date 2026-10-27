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

/** A layout route whose kind differs from an item's declared kind. */
export interface KindRouteMismatch {
  /** Kind the matched route installs. */
  routeKind: PrimitiveKind;
  /** Matched `kindRoutes` key (`chat-modes/` for a `chatmodes/…` path). */
  routePrefix: string;
}

/**
 * Compare an item's declared kind with the kind of the layout route its
 * path matches. Path-routed targets install the file as the route's kind,
 * so a difference means the item lands somewhere its author did not ask
 * for.
 * @param itemPath - Bundle-relative item path.
 * @param declaredKind - Canonical declared kind (no alias normalisation).
 * @param kindRoutes - Routes to match against.
 * @returns The mismatch, or `null` when no route matches, the route's key
 *   names no kind, or the kinds agree.
 */
export const findKindRouteMismatch = (
  itemPath: string,
  declaredKind: PrimitiveKind,
  kindRoutes: KindRoutes
): KindRouteMismatch | null => {
  const match = matchKindRoute(itemPath, kindRoutes);
  if (match === null) {
    return null;
  }
  const routeKind = routeKindOf(match.prefix);
  if (routeKind === null || routeKind === declaredKind) {
    return null;
  }
  return { routeKind, routePrefix: match.prefix };
};

/** Fragment that identifies a {@link formatKindRouteMismatch} message. */
const KIND_ROUTE_MISMATCH_MARKER = 'of the install route "';

/**
 * Warning text for a kind/route mismatch of one collection item.
 * @param collectionRel - Repository-relative collection file.
 * @param index - Item index in `items[]`.
 * @param itemPath - Item path as declared.
 * @param declaredKind - Item kind as the author wrote it.
 * @param mismatch - The mismatch found by {@link findKindRouteMismatch}.
 * @returns The warning message.
 */
export const formatKindRouteMismatch = (
  collectionRel: string,
  index: number,
  itemPath: string,
  declaredKind: string,
  mismatch: KindRouteMismatch
): string =>
  `${collectionRel}: items[${String(index)}] ${itemPath}: kind "${declaredKind}" differs from the kind `
  + `"${mismatch.routeKind}" ${KIND_ROUTE_MISMATCH_MARKER}${mismatch.routePrefix}" that this path matches`;

/**
 * Whether a validation warning was built by {@link formatKindRouteMismatch}.
 * @param message - Warning message.
 * @returns True for a kind/route mismatch warning.
 */
export const isKindRouteMismatchWarning = (message: string): boolean =>
  message.includes(KIND_ROUTE_MISMATCH_MARKER);
