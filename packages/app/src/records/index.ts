/**
 * Install-record barrel export: path confinement, git root and `info/exclude`,
 * canonical serialization, the record store and service, record selection,
 * migration, tool-to-target mapping, the source trust gate, the legacy lockfile shapes,
 * locally modified files and the writer group for the shared-folder sync.
 * @module records
 */
export * from './atomic-write';
export * from './confine-path';
export * from './git-root';
export * from './install-record-service';
export * from './install-record-services';
export * from './legacy-shapes';
export * from './map-tool-to-target';
export * from './modified-files';
export * from './plan-record-entries';
export * from './record-identity';
export * from './record-migration';
export * from './record-store';
export * from './resolve-record-source';
export * from './sanitize-source';
export * from './select-record';
export * from './serialize-record';
export * from './to-record-source';
export * from './user-home';
export * from './writer-group';
