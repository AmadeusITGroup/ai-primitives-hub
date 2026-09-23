/**
 * `@prompt-registry/collection-scripts`
 *
 * Shared scripts for building, validating, and publishing Copilot prompt collections.
 * @module @prompt-registry/collection-scripts
 */

// Type exports
export type {
  ValidationResult,
  ObjectValidationResult,
  FileValidationResult,
  AllCollectionsResult,
  CollectionItem,
  Collection,
  ValidationRules,
  VersionInfo,
  BundleInfo,
} from './types';

// Validation exports
export {
  VALIDATION_RULES,
  loadItemKindsFromSchema,
  validateCollectionId,
  validateVersion,
  validateItemKind,
  normalizeRepoRelativePath,
  isSafeRepoRelativePath,
  validateCollectionObject,
  validateCollectionFile,
  validateAllCollections,
  generateMarkdown,
} from './validate';

// Collection utilities exports
export {
  listCollectionFiles,
  readCollection,
  resolveCollectionItemPaths,
  resolveCollectionReadmePath,
} from './collections';

export {
  createReleaseManifestPlan,
  createLegacyReleaseManifestPlan,
  isMissingSourceLicenseError,
  LEGACY_RELEASE_WARNING,
  NO_SOURCE_LICENSE_MESSAGE,
  resolveGitRevision,
  resolveSourceRepository,
  serializeReleaseManifest,
} from './release-manifest';
export type {
  CreateReleaseManifestPlanOptions,
  ReleaseArchiveEntry,
  ReleaseManifestFileRole,
  ReleaseManifestPlan,
} from './release-manifest';

// Bundle ID exports
export { generateBundleId } from './bundle-id';

// CLI utilities exports
export {
  parseSingleArg,
  parseMultiArg,
  hasFlag,
  getPositionalArg,
} from './cli';

// Skills exports
export type {
  SkillMetadata,
  SkillValidationResult,
  AllSkillsValidationResult,
} from './skills';

export {
  SKILL_NAME_MAX_LENGTH,
  SKILL_DESCRIPTION_MIN_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
  MAX_ASSET_SIZE,
  parseFrontmatter,
  validateSkillName,
  validateSkillDescription,
  validateSkillFolder,
  validateAllSkills,
  generateSkillContent,
  createSkill,
} from './skills';
