/**
 * The `@ai-primitives-hub/cli` package barrel.
 *
 * Thin delivery adapter over `@ai-primitives-hub/app`: argument parsing and
 * output formatting only, never business logic. See `bin/ai-primitives-hub.js`
 * for the actual executable entry point, which calls `run` (aliased `main`).
 * @module cli
 */
export {
  main as run,
} from './main';
