/**
 * Diagnostics subsystem barrel export: the `doctor diagnostics --primitives`
 * use case and its I/O helpers. Every rule and expected value lives in
 * `@ai-primitives-hub/core` (`domain/diagnostics/primitives`).
 * @module diagnostics
 */
export * from './find-ancestor-file';
export * from './run-primitive-diagnostics';
export * from './sandbox-snapshot';
