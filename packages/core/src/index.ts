// Core package exports - domain types and ports

import * as path from 'node:path';

// Force runtime imports to ensure file emission
import './domain';
import './ports';
import './public/schemas/collection.schema.json';

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
