/**
 * Domain types for scaffolding collections and primitives.
 *
 * Exported for use by infra (TemplateEngine) and CLI (commands).
 * @module domain/scaffold
 */

export {
  generateSanitizedId,
  ScaffoldType,
} from './types';
export type {
  ScaffoldOptions,
  ScaffoldResult,
  TemplateContext,
  TemplateInfo,
  TemplateManifest,
} from './types';
