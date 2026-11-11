/**
 * Configured source to recorded source: one normalisation for every writer of
 * a record source. Only the fields that apply to the source type are kept, and
 * tokens never reach the result.
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
 * @param configured - Configured source.
 */
export function toRecordSource(configured: RegistrySource): SourceRecord;
/**
 * The record-shaped copy of a configured source, with its record id.
 * @param configured - Configured source.
 * @param sourceId - Record key of the source.
 */
export function toRecordSource(configured: RegistrySource, sourceId: string): SourceRecord & { sourceId: string };
/**
 * Implementation of both overloads.
 * @param configured - Configured source.
 * @param sourceId - Record key of the source.
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
    // `anonymous` is the Artifactory adapter's default when `authMode` is absent.
    source.authMode = config?.authMode === 'bearer' ? 'bearer' : 'anonymous';
  }
  if (sourceId !== undefined) {
    source.sourceId = sourceId;
  }
  return source;
}
