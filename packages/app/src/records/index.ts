/**
 * Install-record barrel export: path confinement, git root and `info/exclude`,
 * canonical serialization, the record store and service, record selection,
 * tool-to-target mapping and the source trust gate.
 * @module records
 */
export * from './atomic-write';
export * from './confine-path';
export * from './git-root';
export * from './install-record-service';
export * from './install-record-services';
export * from './map-tool-to-target';
export * from './record-store';
export * from './resolve-record-source';
export * from './sanitize-source';
export * from './select-record';
export * from './serialize-record';
