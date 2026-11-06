/**
 * Configured source → recorded source (BR3.2, NFR4.5, NFR4.11).
 *
 * One normalisation for every writer of a record source: the CLI install,
 * the extension install, the CLI profile and the trust gate's configured
 * match. Only the fields that apply to the source type are kept:
 * - every type: `type` and `url`, and `collectionsPath` when it is a non-empty string;
 * - Artifactory: `indexFile` and `credentialRef` when they are strings, and
 *   `authMode` always, `bearer` when configured so and `anonymous` otherwise
 *   (the default the Artifactory adapter applies when it is absent);
 * - any other type: `branch` when it is a string.
 * Tokens and other config never reach the result. The URL is cleaned later,
 * when `recordInstall` sanitizes the source.
 * @module records/to-record-source
 */
import type {
  RegistrySource,
  SourceRecord,
} from '@ai-primitives-hub/core';
import {
  copySourceFields,
} from './source-fields';

/**
 * The record-shaped, prototype-free copy of a configured source.
 * @param configured - Source as configured in the hub or detached sources.
 * @returns The source to record.
 */
export function toRecordSource(configured: RegistrySource): SourceRecord;
/**
 * The record-shaped, prototype-free copy of a configured source, keyed by its record id.
 * @param configured - Source as configured in the hub or detached sources.
 * @param sourceId - Record key of the source.
 * @returns The source to record, with `sourceId`.
 */
export function toRecordSource(configured: RegistrySource, sourceId: string): SourceRecord & { sourceId: string };
/**
 * Implementation of both overloads.
 * @param configured - Source as configured.
 * @param sourceId - Record key of the source, when the caller wants it set.
 * @returns The source to record.
 */
export function toRecordSource(configured: RegistrySource, sourceId?: string): SourceRecord & { sourceId?: string } {
  const config: Readonly<Record<string, unknown>> | undefined = configured.config;
  const isArtifactory = configured.type === 'artifactory';
  const source: SourceRecord & { sourceId?: string } = copySourceFields(
    config, configured.type, configured.url, isArtifactory ? ['indexFile', 'credentialRef'] : ['branch']
  );
  if (typeof config?.collectionsPath === 'string' && config.collectionsPath !== '') {
    source.collectionsPath = config.collectionsPath;
  }
  if (isArtifactory) {
    source.authMode = config?.authMode === 'bearer' ? 'bearer' : 'anonymous';
  }
  if (sourceId !== undefined) {
    source.sourceId = sourceId;
  }
  return source;
}
