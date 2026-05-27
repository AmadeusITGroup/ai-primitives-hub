/**
 * Plugin-manifest parser for the awesome-copilot plugin format (PR #245).
 *
 * This module mirrors — on the read-only side — the structure produced
 * by `src/adapters/plugin-adapter-shared.ts` in the main repo. The hub
 * harvester never installs or archives plugins; it only needs to turn
 * `plugins/<id>/.github/plugin/plugin.json` into a list of "here's where
 * to fetch the primitive files" directives, so all the filesystem /
 * archive helpers the adapter carries are intentionally left out.
 *
 * Everything here is pure (no I/O, no network) so it can be unit-tested
 * in isolation and reused unchanged by any caller that already has the
 * manifest bytes in hand (tree enumerator, local fixtures, etc.).
 */

// These types were promoted into `lib/src/domain/hub/`.
// The local definitions were removed (they were duplicates left
// over from before the promotion because eslint --fix reverted the
// removal). The canonical home is `domain/hub/types.ts`; this file
// owns only the parser and helpers below.
import type {
  PluginItem,
  PluginItemKind,
  PluginManifest,
} from '@prompt-registry/core';

const KNOWN_KINDS: readonly PluginItemKind[] = [
  'prompt', 'instruction', 'chat-mode', 'agent', 'skill'
];

/**
 * Parse a `plugin.json` string into the manifest superset.
 * @param raw - UTF-8 string of the plugin.json file.
 * @returns the parsed manifest (permissive — missing fields are fine).
 * @throws {Error} if the input is not valid JSON.
 */
export function parsePluginManifest(raw: string): PluginManifest {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new Error(`plugin manifest parse error: ${(err as Error).message}`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('plugin manifest parse error: root is not an object');
  }
  return obj as PluginManifest;
}

/**
 * Derive the canonical `PluginItem[]` list from a manifest.
 *
 * Precedence:
 *   1. If `items[]` is present and non-empty, use it (our format).
 *   2. Otherwise, fold `agents[]` + `skills[]` into `items[]` in that
 *      deterministic order (agents first, then skills — matches the
 *      adapter's helper for snapshot stability).
 *
 * Drops entries with an unknown `kind` or a non-string `path`.
 * @param manifest - A parsed plugin manifest.
 */
export function derivePluginItems(manifest: PluginManifest): PluginItem[] {
  if (Array.isArray(manifest.items) && manifest.items.length > 0) {
    return filterAndMapItems(manifest.items);
  }
  return deriveItemsFromLegacyFields(manifest);
}

function filterAndMapItems(items: unknown[]): PluginItem[] {
  const objectItems = filterObjectItems(items);
  const extractedItems = extractKindAndPath(objectItems);
  return filterValidPluginItems(extractedItems);
}

function filterObjectItems(items: unknown[]): { kind: unknown; path: unknown }[] {
  return items.filter((e): e is { kind: unknown; path: unknown } => typeof e === 'object' && e !== null);
}

function extractKindAndPath(items: { kind: unknown; path: unknown }[]): { kind: unknown; path: unknown }[] {
  return items.map((e) => ({ kind: e.kind, path: e.path }));
}

function filterValidPluginItems(items: { kind: unknown; path: unknown }[]): PluginItem[] {
  return items.filter((e): e is PluginItem =>
    typeof e.kind === 'string'
    && typeof e.path === 'string'
    && (KNOWN_KINDS as readonly string[]).includes(e.kind)
  );
}

function deriveItemsFromLegacyFields(manifest: PluginManifest): PluginItem[] {
  const items: PluginItem[] = [];
  for (const p of manifest.agents ?? []) {
    if (typeof p === 'string') {
      items.push({ kind: 'agent', path: p });
    }
  }
  for (const p of manifest.skills ?? []) {
    if (typeof p === 'string') {
      items.push({ kind: 'skill', path: p });
    }
  }
  return items;
}

/**
 * Resolve an item's canonical "entry file" path relative to the repo root.
 *
 * - For folder-based kinds (`skill`, `agent`) the entry file is the
 *   well-known `SKILL.md` / `AGENT.md` inside the referenced directory.
 * - For single-file kinds (`prompt`, `instruction`, `chat-mode`) the
 *   path already points at the file, so we return it verbatim (modulo
 *   `./` stripping and joining onto the plugin root).
 * @param pluginRoot - e.g. "plugins/my-plugin" (no trailing slash).
 * @param item - The item to resolve.
 */
export function resolvePluginItemEntryPath(pluginRoot: string, item: PluginItem): string {
  const rel = stripLeadingDotSlash(item.path);
  const base = `${pluginRoot.replace(/\/+$/u, '')}/${rel}`;
  switch (item.kind) {
    case 'skill': {
      return `${base}/SKILL.md`;
    }
    case 'agent': {
      return `${base}/AGENT.md`;
    }
    default: {
      return base;
    }
  }
}

/**
 * Strip a leading `./` from a path, if present. Idempotent.
 * @param p
 */
export function stripLeadingDotSlash(p: string): string {
  return p.startsWith('./') ? p.slice(2) : p;
}

function mergeMcpServers(
  target: Record<string, unknown>,
  source: Record<string, unknown> | undefined
): void {
  if (!source || typeof source !== 'object') {
    return;
  }
  for (const [name, cfg] of Object.entries(source)) {
    if (cfg && typeof cfg === 'object') {
      target[name] = cfg;
    }
  }
}

/**
 * Merge the two MCP-declaration shapes a plugin manifest may use into a
 * single `{ name → config }` map.
 *
 * - `mcp.items` is the "our" format (aligned with the mcp.schema used by
 *   collection.yml).
 * - `mcpServers` is the alternative top-level layout accepted by the
 *   plugin schema.
 *
 * When both are present we merge, preferring `mcp.items` on name
 * conflicts (it's the documented canonical form in the plugin schema).
 * @param manifest - A parsed plugin manifest.
 */
export function extractPluginMcpServers(manifest: PluginManifest): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  mergeMcpServers(merged, manifest.mcpServers);
  mergeMcpServers(merged, manifest.mcp?.items);
  return merged;
}
