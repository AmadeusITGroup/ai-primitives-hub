/**
 * Scaffolding infrastructure exports.
 */

import * as path from 'node:path';

export { TemplateEngine } from './template-engine';

/**
 * Template root directory for scaffolding.
 * This is the base path for all template directories.
 * After compilation, __dirname points to dist/scaffolding/, and templates are in dist/scaffolding/templates/.
 */
export const TEMPLATE_ROOT = path.join(__dirname, './templates');

/**
 * Template paths for each primitive type.
 * These paths are relative to the infra package and can be used by consumers
 * to locate template directories without knowing the internal package structure.
 */
export const TEMPLATE_PATHS = {
  collection: path.join(TEMPLATE_ROOT, 'collection'),
  prompt: path.join(TEMPLATE_ROOT, 'prompt'),
  instruction: path.join(TEMPLATE_ROOT, 'instruction'),
  agent: path.join(TEMPLATE_ROOT, 'agent'),
  skill: path.join(TEMPLATE_ROOT, 'skill'),
  plugin: path.join(TEMPLATE_ROOT, 'plugin'),
  hook: path.join(TEMPLATE_ROOT, 'hook')
} as const;
