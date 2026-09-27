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
  createHash,
} from 'node:crypto';
import {
  load as parseYaml,
} from 'js-yaml';
import type {
  ExtractedFiles,
} from '../../ports/bundle-extractor';
import {
  isManifestIdMatch,
} from '../bundle/id';
import {
  determineFileType,
} from '../install/copilot-file-type';
import {
  getKnowledgeRelativePath,
} from '../install/knowledge-path';
import {
  isPrimitiveKind,
  normalizePrimitiveKind,
} from '../primitive/types';
import {
  RELEASE_DEPLOYMENT_MANIFEST_FORMAT_VERSION,
  type ReleaseDeploymentManifest,
  type ReleaseManifestFile,
  type ReleaseManifestFileRole,
} from './types';

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
 * Legacy manifest with the minimum required runtime identity fields.
 */
export interface LegacyValidatedManifest {
  id: string;
  version: string;
  name: string;
  /** Open-ended remainder. */
  [key: string]: unknown;
}

/**
 * Parsed manifest accepted by the runtime.
 *
 * Releases that declare `formatVersion: 1` are validated against the
 * self-contained archive contract. Manifests without a format version retain
 * legacy compatibility validation so already-published bundles remain
 * installable until their publishers migrate.
 */
export type ValidatedManifest = LegacyValidatedManifest | ReleaseDeploymentManifest;

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
  if (m.formatVersion === undefined) {
    return m as LegacyValidatedManifest;
  }
  if (m.formatVersion !== RELEASE_DEPLOYMENT_MANIFEST_FORMAT_VERSION) {
    throw invalidManifest(
      `${MANIFEST_FILENAME} has unsupported formatVersion ${describeFormatVersion(m.formatVersion)}`
    );
  }

  validateReleaseManifest(m, files);
  return m as unknown as ReleaseDeploymentManifest;
};

/**
 * Determine whether a validated manifest opted into the self-contained
 * release contract.
 * @param manifest - Parsed and validated deployment manifest.
 * @returns True only for a governed release manifest.
 */
export const isReleaseDeploymentManifest = (
  manifest: ValidatedManifest
): manifest is ReleaseDeploymentManifest =>
  manifest.formatVersion === RELEASE_DEPLOYMENT_MANIFEST_FORMAT_VERSION;

/**
 * Return the files that may be supplied to a target writer.
 *
 * A governed archive carries its provenance, license, documentation and
 * inventory inside the ZIP, but those files are evidence rather than target
 * content. The root deployment manifest remains available because
 * manifest-driven repository writers need it to determine primitive routing.
 * Legacy manifests return their complete extracted file map to preserve the
 * pre-contract installation behavior.
 * @param files - Full extracted archive contents.
 * @param manifest - Previously validated manifest.
 * @returns A deterministic map containing target-installable files.
 */
export const getInstallableBundleFiles = (
  files: ExtractedFiles,
  manifest: ValidatedManifest
): ExtractedFiles => {
  if (!isReleaseDeploymentManifest(manifest)) {
    return files;
  }

  const allowedPaths = new Set<string>([
    MANIFEST_FILENAME,
    ...manifest.files
      .filter((file) => file.role === 'installable')
      .map((file) => file.path)
  ]);
  const installableFiles = new Map<string, Uint8Array>();
  for (const [filePath, content] of files) {
    if (allowedPaths.has(filePath)) {
      installableFiles.set(filePath, content);
    }
  }
  return installableFiles;
};

export interface SelectedManifestPlacementItem {
  id?: unknown;
  file: unknown;
  type: unknown;
  tags?: string[];
  name?: unknown;
  description?: unknown;
}

export const getSelectedManifestPlacementItems = (
  manifest: Record<string, unknown>
): SelectedManifestPlacementItem[] => {
  const selectEntry = (value: unknown): SelectedManifestPlacementItem | null => {
    if (value === null || typeof value !== 'object') {
      return null;
    }
    const item = value as Record<string, unknown>;
    const file = typeof item.path === 'string' ? item.path : item.file;
    const type = typeof item.kind === 'string' ? item.kind : item.type;
    const tags = Array.isArray(item.tags) && item.tags.every((tag) => typeof tag === 'string')
      ? item.tags
      : undefined;
    const result: SelectedManifestPlacementItem = { file, type };
    if ('id' in item) {
      result.id = item.id;
    }
    if (tags !== undefined) {
      result.tags = tags;
    }
    if ('name' in item) {
      result.name = item.name;
    }
    if ('description' in item) {
      result.description = item.description;
    }
    return result;
  };

  const items = Array.isArray(manifest.items) ? manifest.items : [];
  if (manifest.formatVersion === RELEASE_DEPLOYMENT_MANIFEST_FORMAT_VERSION) {
    return items.flatMap((value) => {
      const entry = selectEntry(value);
      return entry === null ? [] : [entry];
    });
  }

  const selected: SelectedManifestPlacementItem[] = [];
  const seen = new Set<string>();
  const appendEntries = (entries: unknown[]): void => {
    for (const value of entries) {
      const item = selectEntry(value);
      if (item === null) {
        continue;
      }
      const inferredType = typeof item.type === 'string'
        ? item.type
        : (typeof item.file === 'string' ? determineFileType(item.file, item.tags) : null);
      const canonicalKind = typeof inferredType === 'string'
        ? normalizePrimitiveKind(inferredType) ?? inferredType.trim().toLowerCase()
        : null;
      if (typeof item.file === 'string' && canonicalKind !== null) {
        const key = `${item.file.replaceAll('\\', '/')}\u0000${canonicalKind}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
      }
      selected.push(item);
    }
  };

  appendEntries(Array.isArray(manifest.prompts) ? manifest.prompts : []);
  appendEntries(items);
  return selected;
};

export const getTargetInstallableBundleFiles = (
  files: ExtractedFiles,
  manifest: ValidatedManifest
): ExtractedFiles => {
  const installableFiles = getInstallableBundleFiles(files, manifest);
  const manifestRecord = manifest as Record<string, unknown>;
  const declarations: { source: string }[] = [];
  const skillSourceDirs = new Set<string>();
  const registerSkill = (source: unknown): void => {
    if (typeof source !== 'string') {
      return;
    }
    const normalized = source.replaceAll('\\', '/');
    const segments = normalized.split('/');
    if (segments.length === 3 && segments[0] === 'skills' && segments[2]?.toLowerCase() === 'skill.md') {
      skillSourceDirs.add(segments.slice(0, 2).join('/'));
    }
  };
  const addKnowledgeDeclaration = (source: unknown): void => {
    if (typeof source !== 'string') {
      throw new ManifestValidationError(
        'manifest declares a knowledge item without a string source path',
        'BUNDLE.MANIFEST_INVALID'
      );
    }
    declarations.push({ source });
  };

  for (const item of getSelectedManifestPlacementItems(manifestRecord)) {
    const kind = normalizePrimitiveKind(item.type);
    if (kind === 'skill') {
      registerSkill(item.file);
    } else if (kind === 'knowledge') {
      addKnowledgeDeclaration(item.file);
    }
  }

  const seenSources = new Set<string>();
  const sourceKeys = new Set<string>();
  const projected = new Map<string, { source: string; bytes: Uint8Array }>();
  for (const declaration of declarations) {
    if (seenSources.has(declaration.source)) {
      continue;
    }
    seenSources.add(declaration.source);
    const relativePath = getKnowledgeRelativePath(declaration.source);
    if (declaration.source === MANIFEST_FILENAME || relativePath === null) {
      throw new ManifestValidationError(
        `manifest declares an unsafe knowledge path: ${declaration.source}`,
        'BUNDLE.MANIFEST_INVALID'
      );
    }
    const normalizedSource = declaration.source.split(String.fromCharCode(92)).join('/');
    const sourceKey = files.has(declaration.source) ? declaration.source : normalizedSource;
    const bytes = installableFiles.get(sourceKey);
    if (bytes === undefined) {
      throw new ManifestValidationError(
        `manifest declares a missing or non-installable knowledge file: ${declaration.source}`,
        'BUNDLE.MANIFEST_INVALID'
      );
    }
    const targetKey = `knowledge/${relativePath}`;
    const existing = projected.get(targetKey);
    if (existing !== undefined && existing.source !== declaration.source) {
      throw new ManifestValidationError(
        `knowledge paths ${existing.source} and ${declaration.source} resolve to the same target path`,
        'BUNDLE.MANIFEST_INVALID'
      );
    }
    const embeddedSkillKnowledge = [...skillSourceDirs].some((skillDir) =>
      normalizedSource.startsWith(`${skillDir}/knowledge/`));
    if (!embeddedSkillKnowledge) {
      sourceKeys.add(sourceKey);
    }
    projected.set(targetKey, { source: declaration.source, bytes });
  }

  if (projected.size === 0
    && ![...installableFiles.keys()].some((filePath) => /^(knowledge\/|\.[^/]+\/knowledge\/)/.test(filePath))) {
    return installableFiles;
  }

  const targetFiles = new Map<string, Uint8Array>();
  for (const [filePath, bytes] of installableFiles) {
    if (sourceKeys.has(filePath)) {
      continue;
    }
    if (/^(knowledge\/|\.[^/]+\/knowledge\/)/.test(filePath)) {
      const relativePath = getKnowledgeRelativePath(filePath);
      const targetKey = relativePath === null ? null : `knowledge/${relativePath}`;
      const declared = targetKey === null ? undefined : projected.get(targetKey);
      if (declared !== undefined) {
        throw new ManifestValidationError(
          `knowledge path ${declared.source} collides with an existing bundle path ${filePath}`,
          'BUNDLE.MANIFEST_INVALID'
        );
      }
      continue;
    }
    targetFiles.set(filePath, bytes);
  }
  for (const [targetKey, value] of projected) {
    if (targetFiles.has(targetKey)) {
      throw new ManifestValidationError(
        `knowledge path ${value.source} collides with an existing bundle path ${targetKey}`,
        'BUNDLE.MANIFEST_INVALID'
      );
    }
    targetFiles.set(targetKey, value.bytes);
  }
  return targetFiles;
};

export interface ManifestPlacementItem {
  id: string;
  file: string;
  type: string;
  tags?: string[];
  name?: string;
  description?: string;
}

export const getManifestPlacementItems = (
  manifest: Record<string, unknown>
): ManifestPlacementItem[] => getSelectedManifestPlacementItems(manifest).flatMap((item) => {
  const file = item.file;
  if (typeof file !== 'string' || (typeof item.id !== 'string' && typeof item.id !== 'number')) {
    return [];
  }
  const type = typeof item.type === 'string' ? item.type : determineFileType(file, item.tags);
  const placement: ManifestPlacementItem = { id: String(item.id), file, type };
  if (item.tags !== undefined) {
    placement.tags = item.tags;
  }
  if (typeof item.name === 'string') {
    placement.name = item.name;
  }
  if (typeof item.description === 'string') {
    placement.description = item.description;
  }
  return [placement];
});

const RELEASE_FILE_ROLES: ReadonlySet<ReleaseManifestFileRole> = new Set([
  'installable',
  'metadata',
  'ignored'
]);

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

/**
 * Apply semantic rules that JSON Schema alone cannot express: full archive
 * coverage, exact byte sizes and digests, canonical paths, and relationships
 * between primitive/provenance declarations and the file inventory.
 * @param manifest - Parsed YAML mapping with `formatVersion: 1`.
 * @param files - Full extracted archive contents.
 * @throws {ManifestValidationError} When the governed archive is incomplete or inconsistent.
 */
const validateReleaseManifest = (
  manifest: Record<string, unknown>,
  files: ExtractedFiles
): void => {
  const inventory = validateFileInventory(manifest.files, files);
  validateReleaseItems(manifest.items, inventory);
  validateLegacyProjection(manifest.prompts, inventory);
  validateReleaseProvenance(manifest.provenance, inventory);
  validateDeclaredMetadataPath(manifest.readme, 'readme', inventory);
};

/**
 * Validate full archive inventory, including hashes calculated from the exact
 * extracted bytes. The deployment manifest itself is intentionally excluded:
 * storing its own hash in the document would create a circular value.
 * @param value
 * @param files
 */
const validateFileInventory = (
  value: unknown,
  files: ExtractedFiles
): ReadonlyMap<string, ReleaseManifestFile> => {
  if (!Array.isArray(value)) {
    throw invalidManifest('governed release manifest requires a "files" array');
  }

  const inventory = new Map<string, ReleaseManifestFile>();
  for (const [index, rawRecord] of value.entries()) {
    const prefix = `files[${index}]`;
    if (!isRecord(rawRecord)) {
      throw invalidManifest(`${prefix} must be an object`);
    }
    const filePath = readCanonicalBundlePath(rawRecord.path, `${prefix}.path`);
    if (filePath === MANIFEST_FILENAME) {
      throw invalidManifest(`${prefix}.path must not list ${MANIFEST_FILENAME}`);
    }
    if (inventory.has(filePath)) {
      throw invalidManifest(`${prefix}.path duplicates "${filePath}"`);
    }
    if (!isReleaseManifestFileRole(rawRecord.role)) {
      throw invalidManifest(`${prefix}.role must be installable, metadata, or ignored`);
    }
    if (!Number.isSafeInteger(rawRecord.size) || (rawRecord.size as number) < 0) {
      throw invalidManifest(`${prefix}.size must be a non-negative integer`);
    }
    if (typeof rawRecord.sha256 !== 'string' || !SHA256_PATTERN.test(rawRecord.sha256)) {
      throw invalidManifest(`${prefix}.sha256 must be sha256:<64 lowercase hexadecimal characters>`);
    }

    const actual = files.get(filePath);
    if (actual === undefined) {
      throw invalidManifest(`${prefix}.path "${filePath}" is missing from the archive`);
    }
    if (actual.byteLength !== rawRecord.size) {
      throw invalidManifest(`${prefix}.size does not match archive content for "${filePath}"`);
    }
    if (sha256(actual) !== rawRecord.sha256) {
      throw invalidManifest(`${prefix}.sha256 does not match archive content for "${filePath}"`);
    }

    inventory.set(filePath, {
      path: filePath,
      role: rawRecord.role,
      size: rawRecord.size,
      sha256: rawRecord.sha256
    });
  }

  for (const filePath of files.keys()) {
    if (filePath === MANIFEST_FILENAME) {
      continue;
    }
    assertCanonicalBundlePath(filePath, 'archive entry');
    if (!inventory.has(filePath)) {
      throw invalidManifest(`archive entry "${filePath}" is not declared in files`);
    }
  }
  return inventory;
};

/**
 * Validate canonical primitive entries and their installable inventory records.
 * @param value
 * @param inventory
 */
const validateReleaseItems = (
  value: unknown,
  inventory: ReadonlyMap<string, ReleaseManifestFile>
): void => {
  if (!Array.isArray(value)) {
    throw invalidManifest('governed release manifest requires an "items" array');
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const [index, rawItem] of value.entries()) {
    const prefix = `items[${index}]`;
    if (!isRecord(rawItem)) {
      throw invalidManifest(`${prefix} must be an object`);
    }
    if (!isNonEmptyString(rawItem.id)) {
      throw invalidManifest(`${prefix}.id must be a non-empty string`);
    }
    if (ids.has(rawItem.id)) {
      throw invalidManifest(`${prefix}.id duplicates "${rawItem.id}"`);
    }
    ids.add(rawItem.id);
    const filePath = readCanonicalBundlePath(rawItem.path, `${prefix}.path`);
    if (paths.has(filePath)) {
      throw invalidManifest(`${prefix}.path duplicates "${filePath}"`);
    }
    paths.add(filePath);
    if (!isPrimitiveKind(rawItem.kind)) {
      throw invalidManifest(`${prefix}.kind must be a canonical primitive kind`);
    }
    assertInstallableInventoryPath(filePath, prefix, inventory);
    validateOptionalString(rawItem.name, `${prefix}.name`);
    validateOptionalString(rawItem.description, `${prefix}.description`);
    validateOptionalStringArray(rawItem.tags, `${prefix}.tags`);
  }
};

/**
 * Validate the optional legacy `prompts[]` compatibility projection.
 * @param value
 * @param inventory
 */
const validateLegacyProjection = (
  value: unknown,
  inventory: ReadonlyMap<string, ReleaseManifestFile>
): void => {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw invalidManifest('prompts must be an array when present');
  }
  for (const [index, rawItem] of value.entries()) {
    const prefix = `prompts[${index}]`;
    if (!isRecord(rawItem)) {
      throw invalidManifest(`${prefix} must be an object`);
    }
    if (!isNonEmptyString(rawItem.id) || !isNonEmptyString(rawItem.type)) {
      throw invalidManifest(`${prefix}.id and ${prefix}.type must be non-empty strings`);
    }
    const filePath = readCanonicalBundlePath(rawItem.file, `${prefix}.file`);
    assertInstallableInventoryPath(filePath, prefix, inventory);
    validateOptionalString(rawItem.name, `${prefix}.name`);
    validateOptionalString(rawItem.description, `${prefix}.description`);
    validateOptionalStringArray(rawItem.tags, `${prefix}.tags`);
  }
};

/**
 * Validate the provenance snapshot and embedded license relationship.
 * @param value
 * @param inventory
 */
const validateReleaseProvenance = (
  value: unknown,
  inventory: ReadonlyMap<string, ReleaseManifestFile>
): void => {
  if (!isRecord(value)) {
    throw invalidManifest('governed release manifest requires a "provenance" object');
  }
  for (const field of ['source', 'revision', 'license'] as const) {
    if (!isNonEmptyString(value[field])) {
      throw invalidManifest(`provenance.${field} must be a non-empty string`);
    }
  }
  readCanonicalBundlePath(value.collectionPath, 'provenance.collectionPath');
  const sourceSnapshotPath = readCanonicalBundlePath(
    value.sourceSnapshotPath,
    'provenance.sourceSnapshotPath'
  );
  const licensePath = readCanonicalBundlePath(value.licensePath, 'provenance.licensePath');
  assertMetadataInventoryPath(sourceSnapshotPath, 'provenance.sourceSnapshotPath', inventory);
  assertMetadataInventoryPath(licensePath, 'provenance.licensePath', inventory);
};

/**
 * Validate an optional top-level metadata path such as `readme`.
 * @param value
 * @param field
 * @param inventory
 */
const validateDeclaredMetadataPath = (
  value: unknown,
  field: string,
  inventory: ReadonlyMap<string, ReleaseManifestFile>
): void => {
  if (value === undefined) {
    return;
  }
  const filePath = readCanonicalBundlePath(value, field);
  assertMetadataInventoryPath(filePath, field, inventory);
};

const assertInstallableInventoryPath = (
  filePath: string,
  field: string,
  inventory: ReadonlyMap<string, ReleaseManifestFile>
): void => {
  const file = inventory.get(filePath);
  if (file === undefined) {
    throw invalidManifest(`${field} references undeclared archive file "${filePath}"`);
  }
  if (file.role !== 'installable') {
    throw invalidManifest(`${field} must reference an installable archive file`);
  }
};

const assertMetadataInventoryPath = (
  filePath: string,
  field: string,
  inventory: ReadonlyMap<string, ReleaseManifestFile>
): void => {
  const file = inventory.get(filePath);
  if (file === undefined) {
    throw invalidManifest(`${field} references undeclared archive file "${filePath}"`);
  }
  if (file.role !== 'metadata') {
    throw invalidManifest(`${field} must reference a metadata archive file`);
  }
};

/**
 * Strict archive-relative path validation; never normalize an ambiguous path.
 * @param value
 * @param field
 */
const readCanonicalBundlePath = (value: unknown, field: string): string => {
  if (!isNonEmptyString(value)) {
    throw invalidManifest(`${field} must be a non-empty string`);
  }
  assertCanonicalBundlePath(value, field);
  return value;
};

const assertCanonicalBundlePath = (filePath: string, field: string): void => {
  if (filePath.startsWith('/')
    || filePath.includes('\\')
    || filePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw invalidManifest(`${field} must be a canonical bundle-relative path`);
  }
};

const validateOptionalString = (value: unknown, field: string): void => {
  if (value !== undefined && typeof value !== 'string') {
    throw invalidManifest(`${field} must be a string when present`);
  }
};

const validateOptionalStringArray = (value: unknown, field: string): void => {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw invalidManifest(`${field} must be an array of strings when present`);
  }
};

const isReleaseManifestFileRole = (value: unknown): value is ReleaseManifestFileRole =>
  typeof value === 'string' && RELEASE_FILE_ROLES.has(value as ReleaseManifestFileRole);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const describeFormatVersion = (value: unknown): string => {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return `"${String(value)}"`;
  }
  return 'of a non-scalar type';
};

const sha256 = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const invalidManifest = (message: string): ManifestValidationError =>
  new ManifestValidationError(`${MANIFEST_FILENAME} ${message}`, 'BUNDLE.MANIFEST_INVALID');
