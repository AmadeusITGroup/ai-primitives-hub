/**
 * Typed accessor for the built-in target layouts.
 *
 * `default-layouts.json` is imported once here and narrowed to
 * `TargetLayoutsConfig` in a single place, so consumers no longer each carry their
 * own `as unknown as TargetLayoutsConfig` cast. Those casts were unchecked: a typo
 * such as `"serversKey": "server"` would compile, pass CI, and produce a config no
 * IDE reads.
 *
 * TypeScript widens JSON string literals to `string`, so a direct
 * `satisfies TargetLayoutsConfig` on the import fails against the `McpServersKey`
 * union. The narrowing therefore still needs an assertion — but it is paired with
 * `validateBuiltInLayouts()`, which runs the same runtime validator used for
 * user-supplied layout files, and is asserted by a unit test. That turns the
 * unchecked cast into a checked one.
 * @module writers/default-layouts
 */
import type {
  TargetLayoutsConfig,
} from '@ai-primitives-hub/core';
import {
  validateTargetLayoutsConfig,
} from '@ai-primitives-hub/core';
import rawDefaultLayouts from './default-layouts.json';

/**
 * Built-in target layout defaults (single source of truth — `app`'s
 * `FileTreeTargetWriter` and the extension's `McpConfigLocator` both consume this
 * instead of keeping their own copy or cast).
 */
export const defaultLayouts = rawDefaultLayouts as unknown as TargetLayoutsConfig;

/**
 * Validate the built-in layouts against the same runtime validator applied to
 * user-supplied layout config files.
 *
 * Exists so the narrowing above is verified rather than assumed. Called by a unit
 * test; safe to call at runtime for diagnostics.
 * @returns The validated built-in layouts.
 * @throws {TypeError} When default-layouts.json does not satisfy the schema.
 */
export function validateBuiltInLayouts(): TargetLayoutsConfig {
  return validateTargetLayoutsConfig(rawDefaultLayouts);
}
