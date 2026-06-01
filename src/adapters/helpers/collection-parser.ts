import * as yaml from 'js-yaml';
import type {
  Bundle,
} from '../../types/registry';

export interface CollectionManifest {
  id: string;
  name: string;
  description: string;
  version?: string;
  author?: string;
  tags?: string[];
  items: CollectionItem[];
  // eslint-disable-next-line @typescript-eslint/naming-convention -- mirrors deployment manifest YAML field names
  display?: { ordering?: string; show_badge?: boolean };
  mcp?: { items?: Record<string, any> };
  mcpServers?: Record<string, any>;
}

export interface CollectionItem {
  path: string;
  kind: 'prompt' | 'instruction' | 'chat-mode' | 'agent' | 'skill';
}

export interface CollectionBreakdown {
  prompts: number;
  instructions: number;
  agents: number;
  skills: number;
  mcpServers: number;
}

/**
 * Parses a YAML collection manifest string into a typed object.
 * @param content - Raw YAML string
 */
export function parseCollectionYaml(content: string): CollectionManifest {
  return yaml.load(content) as CollectionManifest;
}

/**
 * Returns tags as environments, defaulting to ['vscode'] when empty.
 * @param tags - Collection tags from manifest
 */
export function inferEnvironments(tags: string[]): string[] {
  return tags.length > 0 ? [...tags] : ['vscode'];
}

/**
 * Counts collection items by kind and MCP servers.
 * @param items - Collection items to count
 * @param mcpServers - Optional MCP server definitions
 */
export function calculateBreakdown(items: CollectionItem[], mcpServers?: Record<string, any>): CollectionBreakdown {
  const breakdown: CollectionBreakdown = {
    prompts: 0, instructions: 0, agents: 0, skills: 0,
    mcpServers: mcpServers ? Object.keys(mcpServers).length : 0
  };
  for (const item of items) {
    switch (item.kind) {
      case 'prompt': {
        breakdown.prompts++;
        break;
      }
      case 'instruction': {
        breakdown.instructions++;
        break;
      }
      case 'chat-mode':
      case 'agent': {
        breakdown.agents++;
        break;
      }
      case 'skill': {
        breakdown.skills++;
        break;
      }
    }
  }
  return breakdown;
}

/**
 * Maps a CollectionManifest to a Bundle for registry display.
 * @param collection - Parsed collection manifest
 * @param sourceId - Registry source identifier
 * @param repoUrl - GitHub repository URL
 */
export function mapCollectionToBundle(collection: CollectionManifest, sourceId: string, repoUrl: string): Bundle {
  return {
    id: collection.id,
    name: collection.name,
    version: collection.version || '1.0.0',
    description: collection.description,
    author: collection.author || extractOwnerFromUrl(repoUrl),
    repository: repoUrl,
    tags: collection.tags || [],
    environments: inferEnvironments(collection.tags || []),
    sourceId,
    manifestUrl: '',
    downloadUrl: '',
    lastUpdated: new Date().toISOString(),
    size: `${collection.items.length} items`,
    dependencies: [],
    license: 'MIT'
  };
}

function extractOwnerFromUrl(url: string): string {
  const match = url.match(/github\.com[/:]([^/]+)/);
  return match ? match[1] : 'unknown';
}

const KIND_MAP: Record<string, 'prompt' | 'instructions' | 'chatmode' | 'agent' | 'skill'> = {
  prompt: 'prompt',
  instruction: 'instructions',
  'chat-mode': 'chatmode',
  agent: 'agent',
  skill: 'skill'
};

/**
 * Maps a collection item kind to its prompt type string.
 * @param kind - Item kind from collection manifest
 */
export function mapKindToType(kind: string): 'prompt' | 'instructions' | 'chatmode' | 'agent' | 'skill' {
  return KIND_MAP[kind] || 'prompt';
}

/**
 * Converts a string to title case.
 * @param str - Input string
 */
export function titleCase(str: string): string {
  return str
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
