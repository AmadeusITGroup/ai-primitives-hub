/**
 * Domain Layer — Main barrel.
 *
 * The domain layer contains core data shapes (bundle, primitive, hub) that
 * feature layers (indexing, search, validation, publishing, install) depend on.
 * These types have no feature-layer dependencies.
 * @module domain
 */

export type {
  BundleRef,
  BundleManifest,
  HarvestedFile,
  BundleProvider,
} from './bundle';
export { generateBundleId } from './bundle/id';

export { PRIMITIVE_KINDS } from './primitive';
export type { PrimitiveKind, Primitive } from './primitive';

export type {
  HubSourceSpec,
  HubSourceType,
} from './source/types';

export type {
  HubSourceSpec as HubSourceSpecLegacy,
  PluginItem,
  PluginItemKind,
  PluginManifest,
} from './hub';

export type {
  Target,
  TargetType,
  TargetCommon,
  VsCodeTarget,
  CopilotCliTarget,
  KiroTarget,
  WindsurfTarget,
} from './install';
export { TARGET_TYPES, isTarget } from './install';
export type { BundleSpec, Installable } from './install';
export type {
  ScopedLayoutDef,
  TargetLayoutDef,
  TargetLayoutsConfig,
  KindRoutes,
  TargetLayout,
} from './install';
export { validateTargetLayoutsConfig } from './install';

export type {
  Collection,
  CollectionItem,
  ValidationResult,
  ObjectValidationResult,
  FileValidationResult,
  AllCollectionsResult,
  ValidationRules,
  VersionInfo,
  BundleInfo,
} from './collection/types';
export {
  DEFAULT_VALIDATION_RULES,
  validateCollectionId,
  validateVersion,
  validateItemKind,
  normalizeRepoRelativePath,
  isSafeRepoRelativePath,
  validateCollectionObject,
} from './collection/validate';
export { validateManifest } from './collection/manifest-validator';
export type { ValidatedManifest } from './collection/manifest-validator';
export { generateSourceId } from './source-id';
export { parseBundleSpec, type BundleSpecParseError } from './spec-parser';

export type {
  SkillMetadata,
  SkillValidationResult,
  AllSkillsValidationResult,
} from './skill/validate';
export {
  SKILL_NAME_MAX_LENGTH,
  SKILL_DESCRIPTION_MIN_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
  MAX_ASSET_SIZE,
  parseFrontmatter,
  validateSkillName,
  validateSkillDescription,
} from './skill/validate';

// Registry-config domain (hubs, sources, profiles).
export type {
  HubReference,
  HubMetadata,
  RegistryConfiguration,
  HubConfig,
} from './registry';
export { DEFAULT_LOCAL_HUB_ID, sanitizeHubId, isHubReference, isHubConfig } from './registry';
export type {
  RegistrySource,
  RegistrySourceType,
} from './registry';
export { isRegistrySource } from './registry';
export type {
  Profile,
  ProfileBundle,
  ProfileActivationState,
} from './registry';
export { isProfile, isProfileBundle } from './registry';

// Domain error type (moved from cli/framework for layer independence).
export type {
  RegistryErrorJson,
  RegistryErrorNamespace,
  RegistryErrorOptions,
} from './errors';
export {
  isRegistryError,
  RegistryError,
} from './errors';

// Discovery domain types for AI-powered resource discovery.
export type {
  ResourceRecommendation,
  ResourceSelection,
  ProfileDraft,
  DiscoveryOptions,
  ResourceType,
  RecommendationId,
  ProfileDraftId,
} from './discovery/types';
