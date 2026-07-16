/**
 * The `@ai-primitives-hub/core` package.
 *
 * Domain types and port interfaces, per the migration plan
 * (.tmp/ai-primitives-hub-next-migration-plan.md §7.3): bundle/collection,
 * source, install/target (full TargetType union), hub/profile/registry,
 * primitive/index, and port interfaces for filesystem, HTTP, GitHub API,
 * clock. Landing incrementally, one bounded context per commit.
 */
import * as path from 'node:path';

export * from './domain';
export * from './ports';

/**
 * Public schema directory path.
 * This directory contains JSON schemas for validation.
 */
export const SCHEMA_DIR = path.join(__dirname, './public/schemas');

/**
 * Collection schema JSON embedded directly in the bundle.
 * Use this instead of loading from disk to ensure schema is always available
 * in single-executable applications.
 */
export { default as COLLECTION_SCHEMA } from './public/schemas/collection.schema.json';

/**
 * Phase 1 scaffolding marker, kept until `infra`/`app`/`cli` each have real
 * code of their own to depend on instead of this placeholder re-export
 * chain (see those packages' `src/index.ts`) — removed in Phase 5 once
 * `cli` no longer needs it.
 */
export const CORE_PACKAGE_READY = true;
