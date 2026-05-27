/**
 * Parse CLI `--extra-source` flags into HubSourceSpec objects.
 *
 * Format: `key1=value1,key2=value2,...`
 *
 * Required keys: `id`, `type`, `url`.
 * Optional keys: `name` (defaults to id), `branch` (defaults to "main"),
 *   `pluginsPath` (awesome-copilot-plugin only; defaults to "plugins"),
 *   `collectionsPath` (awesome-copilot only; defaults to undefined).
 *
 * Intentionally narrower than parseHubConfig: only one source per
 * invocation, no YAML, no `enabled` flag — the CLI caller decides when
 * to append / when to drop the flag. This keeps the CLI surface simple
 * and the parser trivial to unit-test.
 */

import type {
  HubSourceSpec,
} from '@prompt-registry/core';
import {
  normalizeRepoFromUrl,
} from './hub-config-parser';

const ALLOWED_TYPES = new Set(['github', 'awesome-copilot', 'awesome-copilot-plugin']);

/**
 * Parse one `--extra-source=...` argument into a HubSourceSpec.
 * @param arg - The raw key=value,... string.
 * @throws {Error} on missing required fields or invalid values.
 */
export function parseExtraSource(arg: string): HubSourceSpec {
  const pairs = new Map<string, string>();
  for (const chunk of arg.split(',')) {
    const eq = chunk.indexOf('=');
    if (eq === -1) {
      continue; // silently skip malformed chunks
    }
    const k = chunk.slice(0, eq).trim();
    const v = chunk.slice(eq + 1).trim();
    if (k) {
      pairs.set(k, v);
    }
  }
  const id = pairs.get('id');
  const type = pairs.get('type');
  const url = pairs.get('url');
  if (!id) {
    throw new Error('--extra-source: missing field "id"');
  }
  if (!type) {
    throw new Error('--extra-source: missing field "type"');
  }
  if (!url) {
    throw new Error('--extra-source: missing field "url"');
  }
  if (!ALLOWED_TYPES.has(type)) {
    throw new Error(`--extra-source: unsupported source type "${type}" (allowed: github, awesome-copilot, awesome-copilot-plugin)`);
  }
  const ownerRepo = normalizeRepoFromUrl(url);
  if (!ownerRepo) {
    throw new Error(`--extra-source: not a github URL: ${url}`);
  }
  const pluginsPathDefault = type === 'awesome-copilot-plugin' ? 'plugins' : undefined;
  return {
    id,
    name: pairs.get('name') ?? id,
    type: type as HubSourceSpec['type'],
    url,
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
    branch: pairs.get('branch') ?? 'main',
    collectionsPath: type === 'awesome-copilot' ? pairs.get('collectionsPath') : undefined,
    pluginsPath: pairs.get('pluginsPath') ?? pluginsPathDefault,
    rawConfig: {}
  };
}
