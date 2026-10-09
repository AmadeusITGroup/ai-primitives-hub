/**
 * Default Hub Configurations — single source of truth for both delivery
 * layers (the VS Code extension and the CLI).
 *
 * This file contains the default hub configurations offered to users
 * during first-time installation. Each hub configuration is verified
 * for accessibility before being activated.
 *
 * The JSON configuration is statically imported so all delivery formats use
 * the same primary source, with a hardcoded fallback for an empty config.
 */
import type {
  HubReference,
  OnLogEvent,
} from '@ai-primitives-hub/core';
import rawDefaultHubs from '../config/default-hubs.json';

export interface DefaultHubConfig {
  /** Display name for the hub. */
  name: string;

  /** Description shown in the selector. */
  description: string;

  /** Icon identifier for plain-text hosts (CLI): emoji or text. */
  icon: string;

  /** VS Code codicon name (without `$()`), used by the extension's selector. */
  codicon?: string;

  /** Hub reference configuration. */
  reference: HubReference;

  /** Whether this is the recommended default. */
  recommended?: boolean;

  /** Whether to show this hub in first-run selector. */
  enabled?: boolean;
}

/**
 * Default hubs offered during installation (hardcoded fallback).
 *
 * These hubs will be:
 * 1. Verified for accessibility (URL reachable).
 * 2. Shown in the first-run hub selector.
 * 3. Imported with proper authentication if selected.
 *
 * Exactly one entry carries `recommended: true` — `getRecommendedHub()`
 * returns the first match, so more than one would make it order-dependent.
 */
const HARDCODED_DEFAULT_HUBS: DefaultHubConfig[] = [
  {
    name: 'Amadeus',
    description: 'Profiles curated by Amadeus',
    icon: '☁️',
    codicon: 'cloud',
    reference: {
      type: 'github',
      location: 'Amadeus-xDLC/genai.prompt-registry-config',
      ref: 'main'
    },
    recommended: true,
    enabled: true
  },
  {
    name: 'Prompt Registry Community Hub',
    description: 'Profiles curated by the Prompt Registry Community',
    icon: '🌐',
    codicon: 'cloud',
    reference: {
      type: 'github',
      location: 'AmadeusITGroup/prompt-registry-config',
      ref: 'main'
    },
    enabled: true
  }
];

function loadDefaultHubs(onLog?: OnLogEvent): DefaultHubConfig[] {
  const configuredHubs = rawDefaultHubs.defaultHubs as DefaultHubConfig[];
  const hubs = configuredHubs.length > 0 ? configuredHubs : HARDCODED_DEFAULT_HUBS;

  onLog?.({
    level: configuredHubs.length > 0 ? 'debug' : 'warn',
    message: configuredHubs.length > 0
      ? `Loaded ${String(hubs.length)} default hub(s) from bundled default-hubs.json.`
      : `Bundled default-hubs.json is empty; loaded ${String(hubs.length)} hardcoded default hub(s).`
  });

  return hubs;
}

let cachedHubs: DefaultHubConfig[] | null = null;

/**
 * Get all default hubs and optionally report which source populated the cache.
 * @param onLog - Receives the source-selection log event on cache initialization.
 */
export function getDefaultHubs(onLog?: OnLogEvent): DefaultHubConfig[] {
  cachedHubs ??= loadDefaultHubs(onLog);
  return cachedHubs;
}

/**
 * Get all enabled default hubs.
 * @param onLog - Receives the source-selection log event on cache initialization.
 */
export function getEnabledDefaultHubs(onLog?: OnLogEvent): DefaultHubConfig[] {
  return getDefaultHubs(onLog).filter((hub) => hub.enabled !== false);
}

/**
 * Get the recommended default hub.
 */
export function getRecommendedHub(): DefaultHubConfig | undefined {
  return getDefaultHubs().find((hub) => hub.recommended && hub.enabled !== false);
}

/**
 * Compare two hub references by identity — type plus location, ignoring
 * `ref`/`autoSync`. A default hub pinned to another branch is still the
 * same hub. GitHub owner/repo names are case-insensitive.
 * @param a - First reference.
 * @param b - Second reference.
 */
function isSameHubReference(a: HubReference, b: HubReference): boolean {
  return a.type === b.type && a.location.toLowerCase() === b.location.toLowerCase();
}

/**
 * Whether a hub reference is one of the shipped default hubs (enabled or
 * not). Used to tell "this account cannot see our own default hub", an
 * expected condition, apart from a genuine failure.
 * @param reference - Hub reference to test.
 */
export function isDefaultHub(reference: HubReference): boolean {
  return getDefaultHubs().some((hub) => isSameHubReference(hub.reference, reference));
}

/**
 * Whether a hub reference is the recommended default hub.
 * @param reference - Hub reference to test.
 */
export function isRecommendedDefaultHub(reference: HubReference): boolean {
  const recommended = getRecommendedHub();
  return recommended !== undefined && isSameHubReference(recommended.reference, reference);
}

/**
 * Find a default hub by name.
 * @param name - Hub name.
 */
export function findDefaultHub(name: string): DefaultHubConfig | undefined {
  return getDefaultHubs().find((hub) => hub.name === name);
}

/**
 * Clear the cached hubs.
 */
export function clearCache(): void {
  cachedHubs = null;
}
