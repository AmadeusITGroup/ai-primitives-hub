/**
 * Search subsystem barrel export.
 * @module search
 */
export * from './bench';
export * from './bm25-engine';
export * from './eval-pattern';
// Named (not wildcard) export: `primitive-index.ts` re-exports
// `SEARCHABLE_FIELDS` from `./tuning` for direct importers of that file;
// wildcarding it here would collide with this barrel's own `./tuning`
// re-export below (same binding, but `import/export` still flags it).
export { PrimitiveIndex } from './primitive-index';
export * from './tokenizer';
export * from './tuning';
export * from './types';
