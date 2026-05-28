/**
 * Default Hub Configurations
 *
 * This file contains the default hub configurations offered to users
 * during first-time installation. Each hub configuration is verified
 * for accessibility before being activated.
 *
 * Configurations can be:
 * 1. Defined in code (DEFAULT_HUBS constant)
 * 2. Loaded from defaultHubs.json (if available)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  HubReference,
} from '../types/hub';
import {
  Logger,
} from '../utils/logger';

const logger = Logger.getInstance();

export interface DefaultHubConfig {
  /** Display name for the hub */
  name: string;

  /** Description shown in the selector */
  description: string;

  /** Icon to display (VS Code codicon name without $()) */
  icon: string;

  /** Hub reference configuration */
  reference: HubReference;

  /** Whether this is the recommended default */
  recommended?: boolean;

  /** Whether to show this hub in first-run selector */
  enabled?: boolean;
}

/**
 * Default hubs offered during installation (hardcoded fallback)
 *
 * These hubs will be:
 * 1. Verified for accessibility (URL reachable)
 * 2. Shown in the first-run hub selector
 * 3. Imported with proper authentication if selected
 */
const HARDCODED_DEFAULT_HUBS: DefaultHubConfig[] = [
  {
    name: 'Awesome Copilot Hub',
    description: 'Official curated collection',
    icon: 'cloud',
    reference: {
      type: 'github',
      location: 'github/awesome-copilot',
      ref: 'main'
    },
    recommended: true,
    enabled: true
  },
  {
    name: 'Community Hub',
    description: 'Community-contributed prompts',
    icon: 'organization',
    reference: {
      type: 'github',
      location: 'promptregistry/community-hub',
      ref: 'main'
    },
    enabled: false // Disabled by default
  }
];

let cachedHubs: DefaultHubConfig[] | null = null;

/**
 * Load default hubs from JSON configuration file (if available)
 * Falls back to hardcoded configuration
 */
function loadDefaultHubs(): DefaultHubConfig[] | null {
  if (cachedHubs) {
    return cachedHubs;
  }

  try {
    // Try to load from JSON file
    const configPath = path.join(__dirname, '..', 'config', 'defaultHubs.json');
    logger.debug(`Loading default hubs from: ${configPath}`);
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(content);
      if (config.defaultHubs && Array.isArray(config.defaultHubs)) {
        cachedHubs = config.defaultHubs;
        return cachedHubs;
      }
    }
  } catch (error) {
    console.warn('Failed to load defaultHubs.json, using hardcoded defaults:', error);
  }

  // Fallback to hardcoded defaults
  cachedHubs = HARDCODED_DEFAULT_HUBS;
  return cachedHubs;
}

/**
 * Get all default hubs (loaded from JSON or hardcoded)
 */
export function getDefaultHubs(): DefaultHubConfig[] {
  const hubs = loadDefaultHubs();
  return hubs || HARDCODED_DEFAULT_HUBS;
}

/**
 * Get all enabled default hubs
 */
export function getEnabledDefaultHubs(): DefaultHubConfig[] {
  return getDefaultHubs().filter((hub) => hub.enabled !== false);
}

/**
 * Get the recommended default hub
 */
export function getRecommendedHub(): DefaultHubConfig | undefined {
  return getDefaultHubs().find((hub) => hub.recommended && hub.enabled !== false);
}

/**
 * Find a default hub by name
 * @param name
 */
export function findDefaultHub(name: string): DefaultHubConfig | undefined {
  return getDefaultHubs().find((hub) => hub.name === name);
}

/**
 * Clear the cached hubs (for testing purposes)
 */
export function clearCache(): void {
  cachedHubs = null;
}
