/**
 * Application layer barrel — use-case orchestrators that depend only
 * on domain types and port interfaces. No concrete adapters here.
 * @module app
 */

// Context detection
export * from './context-detection';

// Install
export * from './install';

// Registry
export * from './registry';

// Writers (moved from infra due to CLI dependencies)
export * from './writers/file-tree-writer';

// Stores (moved from infra due to CLI dependencies)
export * from './stores/json-lockfile-store';
export * from './stores/active-hub-store';
export * from './stores/yaml-hub-store';

// Resolvers (moved from infra due to CLI dependencies)
export * from './resolvers/resolver-registry';
