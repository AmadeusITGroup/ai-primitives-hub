/** Provider-neutral published bundle index contract used by Artifactory sources. */
import * as semver from 'semver';
import type {
  ValidationResult,
} from './types';

export interface PublishedObject {
  path: string;
  size: number;
  sha256: string;
  mediaType?: string;
}
export interface ArtifactoryDependency {
  bundleId: string;
  versionRange: string;
  optional: boolean;
}
export interface ArtifactoryBundleIndexEntry {
  id: string;
  version: string;
  name: string;
  description: string;
  author: string;
  environments: string[];
  tags: string[];
  lastUpdated: string;
  dependencies: ArtifactoryDependency[];
  homepage?: string;
  repository?: string;
  license: string;
  manifest: PublishedObject;
  archive: PublishedObject;
  readme?: PublishedObject;
  canonicalSource?: string;
  revision?: string;
}
export interface ArtifactorySourceIndex {
  formatVersion: 1;
  source: { id: string; name: string; description?: string; updatedAt: string };
  bundles: ArtifactoryBundleIndexEntry[];
}

/** Provider-neutral aliases for consumers that do not expose the backend name. */
export type PublishedBundleIndex = ArtifactorySourceIndex;
export type PublishedBundleIndexEntry = ArtifactoryBundleIndexEntry;

export const isValidSemVer = (version: string): boolean => typeof version === 'string' && semver.valid(version) !== null;
export const compareSemVer = (a: string, b: string): number => semver.compare(a, b);

const RELATIVE_PATH = /^(?!\/)(?!.*%)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))(?![a-zA-Z][a-zA-Z0-9+.-]*:).+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const required = (value: Record<string, unknown>, fields: readonly string[], prefix: string, errors: string[]) => {
  for (const field of fields) {
    if (!(field in value)) {
      errors.push(`${prefix}.${field} is required`);
    }
  }
};
const noUnknown = (value: Record<string, unknown>, allowed: readonly string[], prefix: string, errors: string[]) => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push(`${prefix}.${key} is not allowed`);
    }
  }
};
const objectErrors = (value: unknown, prefix: string, errors: string[]): void => {
  if (!isRecord(value)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  noUnknown(value, ['path', 'size', 'sha256', 'mediaType'], prefix, errors);
  required(value, ['path', 'size', 'sha256'], prefix, errors);
  if (typeof value.path !== 'string' || !RELATIVE_PATH.test(value.path)) {
    errors.push(`${prefix}.path must be a safe relative path`);
  }
  if (!Number.isInteger(value.size) || (value.size as number) < 0) {
    errors.push(`${prefix}.size must be a non-negative integer`);
  }
  if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) {
    errors.push(`${prefix}.sha256 must be 64 lowercase hexadecimal characters`);
  }
};

/**
 * Validate an Artifactory source index, including invariants not expressible in JSON Schema.
 * @param input
 * @param expectedSourceId
 */
export const validateArtifactorySourceIndex = (input: unknown, expectedSourceId?: string | { hubSourceId?: string }): ValidationResult => {
  const configuredSourceId = typeof expectedSourceId === 'string' ? expectedSourceId : expectedSourceId?.hubSourceId;
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { valid: false, errors: ['index must be an object'] };
  }
  noUnknown(input, ['formatVersion', 'source', 'bundles'], 'index', errors);
  if (input.formatVersion !== 1) {
    errors.push('formatVersion must be 1');
  }
  const source = input.source;
  if (isRecord(source)) {
    noUnknown(source, ['id', 'name', 'description', 'updatedAt'], 'source', errors);
    required(source, ['id', 'name', 'updatedAt'], 'source', errors);
    if (typeof source.id !== 'string' || !/^[a-zA-Z0-9_-]{1,50}$/.test(source.id)) {
      errors.push('source.id is invalid');
    }
    if (typeof source.name !== 'string' || source.name.length === 0 || source.name.length > 100) {
      errors.push('source.name is invalid');
    }
    if (typeof source.updatedAt !== 'string' || Number.isNaN(Date.parse(source.updatedAt))) {
      errors.push('source.updatedAt is invalid');
    }
    if (configuredSourceId !== undefined && source.id !== configuredSourceId) {
      errors.push('source.id does not match the configured hub source id');
    }
  } else {
    errors.push('source is required and must be an object');
  }
  if (Array.isArray(input.bundles)) {
    const identities = new Set<string>();
    input.bundles.forEach((bundle, index) => {
      const prefix = `bundles[${index}]`;
      if (!isRecord(bundle)) {
        errors.push(`${prefix} must be an object`);
        return;
      }
      noUnknown(
        bundle,
        [
          'id', 'version', 'name', 'description', 'author', 'environments', 'tags',
          'lastUpdated', 'dependencies', 'homepage', 'repository', 'license', 'manifest',
          'archive', 'readme', 'canonicalSource', 'revision'
        ],
        prefix,
        errors
      );
      required(
        bundle,
        ['id', 'version', 'name', 'description', 'author', 'environments', 'tags',
          'lastUpdated', 'dependencies', 'license', 'manifest', 'archive'],
        prefix,
        errors
      );
      if (typeof bundle.id !== 'string' || !/^[\w.-]{1,200}$/.test(bundle.id)) {
        errors.push(`${prefix}.id is invalid`);
      }
      if (typeof bundle.version !== 'string' || !isValidSemVer(bundle.version)) {
        errors.push(`${prefix}.version is not valid SemVer`);
      }
      const identity = `${String(bundle.id)}\0${String(bundle.version)}`;
      if (identities.has(identity)) {
        errors.push(`duplicate bundle id/version: ${bundle.id}@${bundle.version}`);
      }
      identities.add(identity);
      for (const field of ['name', 'description', 'author', 'license']) {
        if (typeof bundle[field] !== 'string') {
          errors.push(`${prefix}.${field} is required`);
        }
      }
      for (const field of ['environments', 'tags', 'dependencies']) {
        if (!Array.isArray(bundle[field])) {
          errors.push(`${prefix}.${field} must be an array`);
        }
      }
      objectErrors(bundle.manifest, `${prefix}.manifest`, errors);
      objectErrors(bundle.archive, `${prefix}.archive`, errors);
      if (isRecord(bundle.archive) && bundle.archive.mediaType !== 'application/zip') {
        errors.push(`${prefix}.archive.mediaType must be application/zip`);
      }
      if (bundle.readme !== undefined) {
        objectErrors(bundle.readme, `${prefix}.readme`, errors);
      }
      const paths = [bundle.manifest, bundle.archive, bundle.readme]
        .filter((object): object is Record<string, unknown> => isRecord(object))
        .map((object) => object.path);
      if (new Set(paths).size !== paths.length) {
        errors.push(`${prefix} object paths must be distinct`);
      }
    });
  } else {
    errors.push('bundles is required and must be an array');
  }
  return {
    valid: errors.length === 0,
    errors,
    bundlesFound: Array.isArray(input.bundles) ? input.bundles.length : 0
  };
};

export const validatePublishedBundleIndex = validateArtifactorySourceIndex;
