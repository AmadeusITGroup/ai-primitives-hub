/**
 * Type definitions for collection scripts.
 * @module types
 */

export interface ValidationResult {
  valid: boolean;
  error?: string;
  normalized?: string;
  deprecated?: boolean;
  replacement?: string;
}

export interface ObjectValidationResult {
  ok: boolean;
  errors: string[];
}

export interface FileValidationResult extends ObjectValidationResult {
  collection?: Collection;
}

export interface AllCollectionsResult extends ObjectValidationResult {
  fileResults: ({ file: string } & FileValidationResult)[];
}

export interface CollectionItem {
  path: string;
  kind: string;
  name?: string;
  description?: string;
}

export interface Collection {
  id: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  tags?: string[];
  items: CollectionItem[];
}

export interface ValidationRules {
  collectionId: {
    maxLength: number;
    pattern: RegExp;
    description: string;
  };
  version: {
    pattern: RegExp;
    default: string;
    description: string;
  };
  itemKinds: string[];
  deprecatedKinds: Record<string, string>;
}

export interface VersionInfo {
  collectionId: string;
  collectionFile: string;
  lastVersion: string | null;
  manualVersion: string;
  nextVersion: string;
  tag: string;
}

export interface BundleInfo {
  collectionId: string;
  version: string;
  outDir: string;
  manifestAsset: string;
  zipAsset: string;
  bundleId: string;
}
