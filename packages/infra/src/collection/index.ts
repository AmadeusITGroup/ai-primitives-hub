/**
 * Collection YAML document engine and range-mapped validator exports.
 * @module collection
 */
export {
  applyCollectionYamlMutation,
  type CollectionYamlMutation,
  indexCollectionYamlRanges,
  locateCollectionYamlCursor,
  summarizeCollectionYamlChanges,
} from './collection-yaml-document';

export {
  type CollectionFileProbeResult,
  type CollectionYamlValidationResult,
  type SiblingCollectionSummary,
  validateCollectionYaml,
  type ValidateCollectionYamlOptions,
} from './validate-collection-yaml';
