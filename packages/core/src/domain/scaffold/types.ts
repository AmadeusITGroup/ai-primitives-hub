/**
 * Domain types for scaffolding collections and primitives.
 *
 * These types define the structure for CLI scaffolding commands,
 * adapted from the VS Code extension's scaffolding implementation
 * but without VS Code-specific dependencies.
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
/* eslint-disable @typescript-eslint/naming-convention -- PascalCase string-enum members are intentional domain vocabulary */
export enum ScaffoldType {
  // Collection scaffolding
  Collection = 'collection',

  // Primitive scaffolding
  Prompt = 'prompt',
  Instruction = 'instruction',
  Agent = 'agent',
  Skill = 'skill',
  Plugin = 'plugin',
  Hook = 'hook',
  ChatMode = 'chat-mode',

  // Project scaffolding
  ProjectGitHub = 'project-github',
  ProjectApm = 'project-apm'
}
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Common options for scaffold commands.
 */
export interface ScaffoldOptions {
  /** Name of the item being scaffolded */
  name?: string;
  /** Description of the item */
  description?: string;
  /** Author name */
  author?: string;
  /** Tags (comma-separated string or array) */
  tags?: string[];
  /** Collection ID (for primitives that belong to collections) */
  collectionId?: string;
  /** Output directory path */
  path?: string;
  /** Whether to use interactive mode */
  interactive?: boolean;

  // Type-specific options
  /** Version (for plugins) */
  version?: string;
  /** Hook type (for hooks) */
  hookType?: string;
  /** GitHub organization (for projects) */
  githubOrg?: string;
  /** GitHub Actions runner (for projects) */
  githubRunner?: string;
  /** Organization name (for InnerSource LICENSE) */
  organizationName?: string;
  /** Internal contact email */
  internalContact?: string;
  /** Legal contact email */
  legalContact?: string;
  /** Organization policy link */
  organizationPolicyLink?: string;
}

/**
 * Context variables for template rendering.
 */
export interface TemplateContext {
  /** Project name */
  projectName: string;
  /** Sanitized collection/project ID */
  collectionId: string;
  /** Display name */
  name?: string;
  /** Description */
  description?: string;
  /** Author */
  author?: string;
  /** Tags (array) */
  tags?: string[];
  /** Version */
  version?: string;
  /** GitHub organization */
  githubOrg?: string;
  /** GitHub Actions runner */
  githubRunner?: string;
  /** Organization name */
  organizationName?: string;
  /** Internal contact */
  internalContact?: string;
  /** Legal contact */
  legalContact?: string;
  /** Organization policy link */
  organizationPolicyLink?: string;
  /** Additional context variables */
  [key: string]: any;
}

/**
 * Template metadata from manifest.json.
 */
export interface TemplateInfo {
  /** Relative path to template file */
  path: string;
  /** Human-readable description */
  description: string;
  /** Whether this template is required */
  required: boolean;
  /** Variable names used in this template */
  variables: string[];
}

/**
 * Template manifest structure.
 */
export interface TemplateManifest {
  /** Manifest version */
  version: string;
  /** Description of the template set */
  description: string;
  /** Template definitions keyed by name */
  templates: {
    [key: string]: TemplateInfo;
  };
}

/**
 * Result of a scaffold operation.
 */
export interface ScaffoldResult {
  /** Whether scaffolding succeeded */
  success: boolean;
  /** Files that were created */
  createdFiles: string[];
  /** Error message if failed */
  error?: string;
}
