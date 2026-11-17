/**
 * Configured source to recorded source: one normalisation for every writer of
 * a record source. Only the fields that apply to the source type are kept, and
 * tokens never reach the result.
 * @module records/to-record-source
 */
import {
  DEFAULT_LOCAL_HUB_ID,
  type RegistrySource,
  type SourceRecord,
} from '@ai-primitives-hub/core';
import {
  type RecordHubInput,
  toRecordHub,
} from './record-hub';
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
 * @param hub - The source's hub when it is shareable; its id is then recorded as `hubId`.
 */
export function toRecordSource(configured: RegistrySource, sourceId: string, hub?: RecordHubInput): SourceRecord & { sourceId: string };
/**
 * Implementation of both overloads.
 * @param configured - Configured source.
 * @param sourceId - Record key of the source.
 * @param hub - The source's shareable hub.
 */
export function toRecordSource(configured: RegistrySource, sourceId?: string, hub?: RecordHubInput): SourceRecord & { sourceId?: string } {
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
  // Never the built-in local hub or a local-path hub.
  if (hub !== undefined && configured.hubId === hub.id && hub.id !== DEFAULT_LOCAL_HUB_ID && toRecordHub(hub.id, hub.name, hub) !== undefined) {
    source.hubId = hub.id;
  }
  if (sourceId !== undefined) {
    source.sourceId = sourceId;
  }
  return source;
}
