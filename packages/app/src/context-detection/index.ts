/**
 * Context detection module.
 *
 * Analyzes project structure and environment to detect tech stack,
 * domain, and activity information for context-aware resource
 * discovery.
 * @module context-detection
 */

export type {
  Activity,
  ContextDetectionOptions,
  DetectedContext,
  Domain,
  TechStack,
} from './types';

export {
  ContextDetector,
} from './detector';
