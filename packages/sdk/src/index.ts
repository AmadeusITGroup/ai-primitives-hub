/**
 * SDK package barrel export.
 * @module sdk
 *
 * NOTE: SDK exports from core and infra only. App package contains CLI-dependent
 * modules that are not suitable for general SDK usage.
 */

// Re-export from core
export * from '@prompt-registry/core';

// Re-export from infra
export * from '@prompt-registry/infra';
