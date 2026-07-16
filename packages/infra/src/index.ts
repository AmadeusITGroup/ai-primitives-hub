/**
 * The `@ai-primitives-hub/infra` package.
 *
 * Adapters, harvest, search, and per-target writers, per the migration
 * plan (.tmp/ai-primitives-hub-next-migration-plan.md §7.4). Planned
 * module boundaries: adapters/, harvest/, search/, writers/, stores/,
 * scaffolding/, fs/, http/. Landing incrementally, starting with
 * adapters/ (Phase 3a).
 */
export * from './adapters';
export * from './auth';
export * from './clock';
export * from './downloaders';
export * from './extractors';
export * from './fs';
export * from './harvest';
export * from './http';
export * from './hub';
export * from './process';
export * from './resolvers';
export * from './scaffolding';
export * from './search';
export * from './storage';
export * from './stores';
export * from './telemetry';
export * from './writers';

/**
 * Phase 1 scaffolding marker, kept until `app`/`cli` each have real code
 * of their own to depend on instead of this placeholder re-export chain
 * (see those packages' `src/index.ts`) — removed once Phase 3 fills in
 * every planned infra module.
 */
export {
  CORE_PACKAGE_READY as INFRA_PACKAGE_READY,
} from '@ai-primitives-hub/core';
