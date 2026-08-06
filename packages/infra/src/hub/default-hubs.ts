/**
 * Default Hub Configurations — single source of truth for both delivery
 * layers (the VS Code extension and the CLI).
 *
 * This file contains the default hub configurations offered to users
 * during first-time installation. Each hub configuration is verified
 * for accessibility before being activated.
 *
 * Configurations can be:
 * 1. Defined in code (HARDCODED_DEFAULT_HUBS constant)
 * 2. Loaded from default-hubs.json (if available in packages/infra/config/)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  HubReference,
} from '@ai-primitives-hub/core';

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

let cachedHubs: DefaultHubConfig[] | null = null;

/**
 * Load default hubs from JSON configuration file (if available).
 * Falls back to hardcoded configuration.
 */
function loadDefaultHubs(): DefaultHubConfig[] | null {
  if (cachedHubs) {
    return cachedHubs;
  }

  try {
    // Try to load from JSON file in packages/infra/config/. `__dirname` is
    // available at runtime because this package compiles to CommonJS.
    const configPath = path.join(__dirname, '..', '..', 'config', 'default-hubs.json');
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(content) as { defaultHubs?: DefaultHubConfig[] };
      if (config.defaultHubs && Array.isArray(config.defaultHubs)) {
        cachedHubs = config.defaultHubs;
        return cachedHubs;
      }
    }
  } catch {
    // Silently fall back to hardcoded defaults.
  }

  // Fallback to hardcoded defaults.
  cachedHubs = HARDCODED_DEFAULT_HUBS;
  return cachedHubs;
}

/**
 * Get all default hubs (loaded from JSON or hardcoded).
 */
export function getDefaultHubs(): DefaultHubConfig[] {
  const hubs = loadDefaultHubs();
  return hubs || HARDCODED_DEFAULT_HUBS;
}

/**
 * Get all enabled default hubs.
 */
export function getEnabledDefaultHubs(): DefaultHubConfig[] {
  return getDefaultHubs().filter((hub) => hub.enabled !== false);
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
 * Clear the cached hubs (for testing purposes).
 */
export function clearCache(): void {
  cachedHubs = null;
}
