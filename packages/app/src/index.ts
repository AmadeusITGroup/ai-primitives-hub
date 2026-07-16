/**
 * The `@ai-primitives-hub/app` package.
 *
 * Use-case orchestration (install/uninstall, registry, discovery/search,
 * multi-target transforms) per Phase 4 of the migration plan (see
 * .tmp/ai-primitives-hub-next-migration-plan.md §7.5). Planned module
 * boundaries: install/, registry/, discovery/, search/, transform/
 * (transform/transformers/ for per-target content transforms). Also serves
 * as the public SDK surface (§8 decision 2) until a standalone
 * `@ai-primitives-hub/sdk` package has a real consumer.
 *
 * Landing incrementally: install/ (+ its writers/ and stores/ support
 * modules) is the first real module family to land.
 */
export * from './collection';
export * from './context-detection';
export * from './discovery';
export * from './install';
export * from './writers';
export * from './stores';
export * from './update';
export * from './registry';
export * from './search';
export * from './transform';

/**
 * Phase 1 scaffolding marker, kept until `cli` has real code of its own
 * to depend on instead of this placeholder re-export chain (see that
 * package's `src/index.ts`) — removed once Phase 5 lands.
 */
export {
  INFRA_PACKAGE_READY as APP_PACKAGE_READY,
} from '@ai-primitives-hub/infra';
