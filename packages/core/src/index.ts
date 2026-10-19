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
 * Versioned self-contained release deployment-manifest schema.
 * Legacy manifests without `formatVersion` remain runtime-compatible but do
 * not satisfy this governed release contract.
 */
export { default as DEPLOYMENT_MANIFEST_SCHEMA } from './public/schemas/deployment-manifest.schema.json';

/**
 * Hub configuration schema used by the CLI and other non-extension callers.
 */
export { default as HUB_CONFIG_SCHEMA } from './public/schemas/hub-config.schema.json';

/** Artifactory source index JSON schema. */
export { default as ARTIFACTORY_SOURCE_INDEX_SCHEMA } from './public/schemas/artifactory-source-index.schema.json';

/**
 * Agent Plugins 1.0.0 `plugin.json` schema, vendored unmodified from
 * https://github.com/agentplugins/agent-plugins-spec/blob/d92e6f443b8edcea42c039727a82afdc565779e2/schemas/1.0.0/plugin.schema.json
 * (Copyright the Agent Plugins authors, Apache-2.0). Per the spec (§5.2),
 * clients must not fetch the schema at load time, so it ships embedded.
 * The validation rules live in `domain/plugin/agent-plugin-spec.ts`.
 */
export { default as AGENT_PLUGIN_MANIFEST_SCHEMA } from './public/schemas/agent-plugins/1.0.0/plugin.schema.json';

/**
 * Phase 1 scaffolding marker, kept until `infra`/`app`/`cli` each have real
 * code of their own to depend on instead of this placeholder re-export
 * chain (see those packages' `src/index.ts`) — removed in Phase 5 once
 * `cli` no longer needs it.
 */
export const CORE_PACKAGE_READY = true;
