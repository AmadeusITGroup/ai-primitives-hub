/**
 * Writers subsystem barrel export.
 * @module writers
 */
export * from './zip-writer';
export * from './repo-scope-writer';

/**
 * Built-in target layout defaults (single source of truth — `app`'s
 * `FileTreeTargetWriter` consumes this via the package barrel instead
 * of keeping its own copy, avoiding the two-divergent-copies defect
 * found during the reference branch's port).
 *
 * Exported as a typed value so consumers do not each cast the raw JSON import.
 */
export {
  defaultLayouts,
  validateBuiltInLayouts,
} from './default-layouts';
