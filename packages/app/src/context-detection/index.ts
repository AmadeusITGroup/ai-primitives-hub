/**
 * Context detection module.
 *
 * Analyzes project structure and environment to detect tech stack,
 * domain, and activity information for context-aware resource discovery.
 * @module app/context-detection
 */

export type {
  ContextDetectionOptions,
  DetectedContext,
  Domain,
  TechStack,
  Activity,
} from './types';

export {
  ContextDetector,
} from './detector';
