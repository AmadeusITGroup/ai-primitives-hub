/**
 * Stores subsystem barrel export (app-layer, pure functions
 * parametrized by a minimal fs-like interface — not core-port
 * implementations, hence not living in `infra`).
 * @module stores
 */
export * from './json-lockfile-store';
