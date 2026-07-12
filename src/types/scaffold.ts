/**
 * Domain types for scaffolding collections and primitives.
 *
 * Author: Waldek Herka
 */

/**
 * Sanitize an ID by converting to lowercase and replacing non-alphanumeric chars with hyphens.
 * @param name
 */
export function generateSanitizedId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Supported scaffold types for CLI commands.
 */
export enum ScaffoldType {
  collection = 'collection',
  prompt = 'prompt',
  instruction = 'instruction',
  agent = 'agent',
  skill = 'skill',
  plugin = 'plugin',
  hook = 'hook',
  chatMode = 'chat-mode'
}

/**
 * Common options for scaffold commands.
 */
export interface ScaffoldOptions {
  name?: string;
  description?: string;
  author?: string;
  tags?: string[];
  collectionId?: string;
  path?: string;
  interactive?: boolean;
  version?: string;
  hookType?: string;
}

/**
 * Context variables for template rendering.
 */
export interface TemplateContext {
  projectName: string;
  collectionId: string;
  name?: string;
  description?: string;
  author?: string;
  tags?: string[];
  version?: string;
  [key: string]: string | string[] | undefined;
}

/**
 * Result of a scaffold operation.
 */
export interface ScaffoldResult {
  success: boolean;
  createdFiles: string[];
  error?: string;
}
