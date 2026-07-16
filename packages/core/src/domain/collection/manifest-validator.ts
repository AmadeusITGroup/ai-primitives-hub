/**
 * Manifest validator.
 *
 * Reads `deployment-manifest.yml` from the extracted file map and
 * validates the same invariants `BundleInstaller.validateBundle()`
 * checks in the VS Code extension:
 *
 *   - manifest exists at the bundle root
 *   - has `id`, `version`, `name`
 *   - `id` matches the expected bundle id (exact or suffix-tolerant,
 *     see {@link isManifestIdMatch})
 *   - `version` matches `bundleSpec.bundleVersion` (unless 'latest')
 *
 * Returns the parsed manifest on success; throws classed Errors on
 * failure (the install command wraps them at the caller boundary).
 * @module domain/collection/manifest-validator
 */
import {
  load as parseYaml,
} from 'js-yaml';
import type {
  ExtractedFiles,
} from '../../ports/bundle-extractor';
import {
  isManifestIdMatch,
} from '../bundle/id';

export const MANIFEST_FILENAME = 'deployment-manifest.yml';

/**
 * Options for manifest validation.
 */
export interface ManifestValidationOptions {
  /**
   * Expected bundle id from the BundleSpec. Optional: when omitted,
   * the manifest's id is accepted as-is. This is used by hub-driven
   * profile activation, where the hub config carries a synthesized
   * id that does not necessarily match the bundle's natural id.
   */
  expectedId?: string;
  /** Expected version (skipped when 'latest' or undefined). */
  expectedVersion?: string;
}

/**
 * Validated manifest with required fields.
 */
export interface ValidatedManifest {
  id: string;
  version: string;
  name: string;
  /** Open-ended remainder. */
  [key: string]: unknown;
}

/**
 * Error thrown when manifest validation fails.
 */
export class ManifestValidationError extends Error {
  /**
   * Create a ManifestValidationError.
   * @param message Error message.
   * @param code Error code for programmatic handling.
   */
  public constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'ManifestValidationError';
  }
}

/**
 * Read + validate the deployment manifest in `files`.
 * @param files - ExtractedFiles map.
 * @param opts - Expected id / version.
 * @returns Parsed + validated manifest.
 * @throws {ManifestValidationError} On any failure.
 */
export const validateManifest = (
  files: ExtractedFiles,
  opts: ManifestValidationOptions
): ValidatedManifest => {
  const bytes = files.get(MANIFEST_FILENAME);
  if (bytes === undefined) {
    throw new ManifestValidationError(
      `bundle is missing ${MANIFEST_FILENAME} at root`,
      'BUNDLE.MANIFEST_MISSING'
    );
  }
  const text = new TextDecoder().decode(bytes);
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    throw new ManifestValidationError(
      `${MANIFEST_FILENAME} is not valid YAML: ${(err as Error).message}`,
      'BUNDLE.MANIFEST_INVALID'
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ManifestValidationError(
      `${MANIFEST_FILENAME} must be a YAML mapping`,
      'BUNDLE.MANIFEST_INVALID'
    );
  }
  const m = parsed as Record<string, unknown>;
  for (const k of ['id', 'version', 'name'] as const) {
    if (typeof m[k] !== 'string' || (m[k]).length === 0) {
      throw new ManifestValidationError(
        `${MANIFEST_FILENAME} missing or empty "${k}" field`,
        'BUNDLE.MANIFEST_INVALID'
      );
    }
  }
  const id = m.id as string;
  const version = m.version as string;
  if (opts.expectedId !== undefined && !isManifestIdMatch(id, version, opts.expectedId)) {
    throw new ManifestValidationError(
      `manifest id "${id}" does not match expected "${opts.expectedId}"`,
      'BUNDLE.ID_MISMATCH'
    );
  }
  if (opts.expectedVersion !== undefined
    && opts.expectedVersion !== 'latest'
    && version !== opts.expectedVersion) {
    throw new ManifestValidationError(
      `manifest version "${version}" does not match expected "${opts.expectedVersion}"`,
      'BUNDLE.VERSION_MISMATCH'
    );
  }
  return m as ValidatedManifest;
};
