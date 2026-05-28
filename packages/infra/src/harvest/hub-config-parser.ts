/**
 * Hub config parser.
 *
 * Reads a hub-config.yml (as produced by the VS Code extension / hub schema)
 * and emits a minimal, normalised list of sources the primitive-index
 * harvester understands. Only `github` and `awesome-copilot` source types
 * are supported today; everything else is silently skipped (forward-compat).
 *
 * Unknown `config.*` keys are preserved under `rawConfig` so downstream
 * experiments can consume new fields without forcing a schema bump here.
 */

import type {
  HubSourceSpec,
} from '@prompt-registry/core';
import * as yaml from 'js-yaml';

// HubSourceSpec was promoted into `lib/src/domain/hub/`.
// The back-compat re-export from this module was removed after
// every in-tree consumer (and both public package barrels) was
// migrated to import from `domain` directly. This file's job is the
// `parseHubConfig` and `normalizeRepoFromUrl` helpers below; the
// type lives in `domain/hub/types.ts`.

/**
 * Check if the entry type is supported.
 * @param type - Entry type string.
 * @returns True if type is supported.
 */
function isSupportedType(type: string | undefined): boolean {
  return type === 'github' || type === 'awesome-copilot' || type === 'awesome-copilot-plugin';
}

/**
 * Extract the URL from an entry.
 * @param entry - Raw config entry object.
 * @returns URL string or undefined.
 */
function extractUrl(entry: Record<string, unknown>): string | undefined {
  return typeof entry.url === 'string' ? entry.url : undefined;
}

/**
 * Generate the ID string for an entry.
 * @param entry - Raw config entry object.
 * @param ownerRepo - Normalized owner/repo.
 * @param ownerRepo.owner
 * @param ownerRepo.repo
 * @returns ID string.
 */
function generateId(entry: Record<string, unknown>, ownerRepo: { owner: string; repo: string }): string {
  return typeof entry.id === 'string' ? entry.id : `${ownerRepo.owner}-${ownerRepo.repo}`;
}

/**
 * Generate the name string for an entry.
 * @param entry - Raw config entry object.
 * @param ownerRepo - Normalized owner/repo.
 * @param ownerRepo.owner
 * @param ownerRepo.repo
 * @returns Name string.
 */
function generateName(entry: Record<string, unknown>, ownerRepo: { owner: string; repo: string }): string {
  if (typeof entry.name === 'string') {
    return entry.name;
  }
  if (typeof entry.id === 'string') {
    return entry.id;
  }
  return ownerRepo.repo;
}

/**
 * Extract the plugins path from config for awesome-copilot-plugin type.
 * @param config - Config object.
 * @param type - Entry type.
 * @returns Plugins path or undefined.
 */
function extractPluginsPath(config: Record<string, unknown>, type: string | undefined): string | undefined {
  if (type === 'awesome-copilot-plugin') {
    return typeof config.pluginsPath === 'string' ? config.pluginsPath : 'plugins';
  }
  return undefined;
}

/**
 * Parse a single hub-config entry into a HubSourceSpec.
 * Returns undefined if the entry should be filtered out.
 * @param entry - Raw config entry object.
 */
function parseHubConfigEntry(entry: Record<string, unknown>): HubSourceSpec | undefined {
  if (entry.enabled === false) {
    return undefined;
  }
  const type = entry.type as string | undefined;
  if (!isSupportedType(type)) {
    return undefined;
  }
  const url = extractUrl(entry);
  if (!url) {
    return undefined;
  }
  const ownerRepo = normalizeRepoFromUrl(url);
  if (!ownerRepo) {
    return undefined;
  }
  const config = (entry.config ?? {}) as Record<string, unknown>;
  const idStr = generateId(entry, ownerRepo);
  const nameStr = generateName(entry, ownerRepo);
  const pluginsPath = extractPluginsPath(config, type);
  return {
    id: idStr,
    name: nameStr,
    type: type as 'github' | 'awesome-copilot' | 'awesome-copilot-plugin',
    url,
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
    branch: typeof config.branch === 'string' ? config.branch : 'main',
    collectionsPath: typeof config.collectionsPath === 'string' ? config.collectionsPath : undefined,
    pluginsPath,
    rawConfig: config
  };
}

/**
 * Parse a hub-config.yml string (or already-parsed object) into normalised
 * source specs. Disabled sources and non-github hosts are filtered out.
 * @param input - Raw YAML string or already-parsed object.
 */
export function parseHubConfig(input: string | Record<string, unknown>): HubSourceSpec[] {
  const data = typeof input === 'string' ? (yaml.load(input) as Record<string, unknown>) : input;
  const raw = Array.isArray(data?.sources) ? (data.sources as Record<string, unknown>[]) : [];
  return raw.flatMap((entry) => {
    const spec = parseHubConfigEntry(entry);
    return spec ? [spec] : [];
  });
}

/**
 * Extract {owner, repo} from a GitHub clone/html URL. Handles trailing
 * slashes and a trailing `.git`. Returns undefined for non-github hosts.
 * @param url - URL to parse.
 */
export function normalizeRepoFromUrl(url: string): { owner: string; repo: string } | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') {
    return undefined;
  }
  const segments = u.pathname.split('/').filter((s) => s.length > 0);
  if (segments.length < 2) {
    return undefined;
  }
  const [owner, repoRaw] = segments;
  const repo = repoRaw.endsWith('.git') ? repoRaw.slice(0, -4) : repoRaw;
  return { owner, repo };
}
