import {
  createHash,
} from 'node:crypto';
import type {
  ExtractedFiles,
} from '../../ports/bundle-extractor';
import {
  isReleaseDeploymentManifest,
  type LegacyValidatedManifest,
  ManifestValidationError,
  type ValidatedManifest,
} from '../collection/manifest-validator';
import type {
  ReleaseDeploymentManifest,
} from '../collection/types';
import {
  normalizePrimitiveKind,
  type PrimitiveKind,
} from '../primitive/types';
import {
  determineFileType,
} from './copilot-file-type';

export interface BundleInstallFile {
  sourcePath: string;
  relativePath: string;
  bytes: Uint8Array;
  sourceChecksum: string;
}

export interface BundleInstallItem {
  id: string;
  kind: PrimitiveKind;
  entryPath: string;
  files: readonly BundleInstallFile[];
}

export interface BundleInstallPlan {
  bundleId: string;
  bundleVersion: string;
  manifest: ValidatedManifest;
  items: readonly BundleInstallItem[];
  /** Paths placed via deprecated identity-only prefix inference. */
  legacyInferredPaths: readonly string[];
}

const MANIFEST_FILENAME = 'deployment-manifest.yml';

/**
 * Convert a validated archive into target-neutral semantic install items.
 * Target layouts and filesystem destinations deliberately do not participate.
 * @param files
 * @param manifest
 */
export function createBundleInstallPlan(
  files: ExtractedFiles,
  manifest: ValidatedManifest
): BundleInstallPlan {
  if (isReleaseDeploymentManifest(manifest)) {
    return createPlanFromGovernedManifest(files, manifest);
  }

  const legacyItems = getLegacyItems(manifest);
  if (legacyItems.length > 0) {
    return createPlanFromItems(files, manifest, legacyItems);
  }

  return createPlanFromLegacyPaths(files, manifest);
}

interface ManifestItemInput {
  id: unknown;
  path: unknown;
  type: unknown;
  tags?: unknown;
}

function createPlanFromGovernedManifest(
  files: ExtractedFiles,
  manifest: ReleaseDeploymentManifest
): BundleInstallPlan {
  const inventory = new Map(manifest.files.map((file) => [file.path, file.role]));
  const items = manifest.items.map((item) => createItem(
    files,
    inventory,
    {
      id: item.id,
      path: item.path,
      type: item.kind,
      tags: item.tags
    },
    false
  ));

  assertNoDuplicateOwnership(items);
  assertGovernedCoverage(files, inventory, items);
  return {
    bundleId: manifest.id,
    bundleVersion: manifest.version,
    manifest,
    items,
    legacyInferredPaths: []
  };
}

function createPlanFromItems(
  files: ExtractedFiles,
  manifest: LegacyValidatedManifest,
  inputs: readonly ManifestItemInput[]
): BundleInstallPlan {
  const items = inputs.map((input) => createItem(files, undefined, input, true));
  assertNoDuplicateOwnership(items);
  return {
    bundleId: manifest.id,
    bundleVersion: manifest.version,
    manifest,
    items,
    legacyInferredPaths: []
  };
}

function createItem(
  files: ExtractedFiles,
  inventory: ReadonlyMap<string, string> | undefined,
  input: ManifestItemInput,
  allowDetection: boolean
): BundleInstallItem {
  const entryPath = readBundlePath(input.path, 'item path');
  const id = input.id === undefined && allowDetection
    ? legacyItemId(entryPath, input.type)
    : readNonEmptyString(input.id, 'BUNDLE.MANIFEST_ITEM_INVALID', 'item id');
  const bytes = files.get(entryPath);
  if (bytes === undefined) {
    throw bundleError(
      `item "${id}" entry file "${entryPath}" is missing from the archive`,
      'BUNDLE.MANIFEST_ENTRY_MISSING'
    );
  }
  if (inventory !== undefined && inventory.get(entryPath) !== 'installable') {
    throw bundleError(
      `item "${id}" entry file "${entryPath}" is not installable`,
      'BUNDLE.MANIFEST_ENTRY_INVALID'
    );
  }

  const kind = input.type === undefined && allowDetection
    ? normalizePrimitiveKind(determineFileType(
      entryPath,
      Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === 'string') : undefined
    ))
    : normalizePrimitiveKind(input.type);
  if (kind === null) {
    throw bundleError(
      `item "${id}" has invalid primitive kind "${String(input.type)}"`,
      'BUNDLE.MANIFEST_INVALID_KIND'
    );
  }

  const ownedPaths = kind === 'skill'
    ? skillOwnedPaths(files, inventory, entryPath)
    : [entryPath];
  return {
    id,
    kind,
    entryPath,
    files: ownedPaths.map((sourcePath) => createFileRecord(sourcePath, files.get(sourcePath)!, entryPath, kind))
  };
}

function skillOwnedPaths(
  files: ExtractedFiles,
  inventory: ReadonlyMap<string, string> | undefined,
  entryPath: string
): string[] {
  const separator = entryPath.lastIndexOf('/');
  const root = separator === -1 ? '' : entryPath.slice(0, separator);
  const prefix = root.length === 0 ? '' : `${root}/`;
  const paths = [...files.keys()].filter((filePath) => {
    if (filePath === MANIFEST_FILENAME || (inventory !== undefined && inventory.get(filePath) !== 'installable')) {
      return false;
    }
    return filePath === entryPath || filePath.startsWith(prefix);
  });
  if (!paths.includes(entryPath)) {
    paths.unshift(entryPath);
  }
  return [entryPath, ...paths.filter((filePath) => filePath !== entryPath).toSorted()];
}

function createFileRecord(
  sourcePath: string,
  bytes: Uint8Array,
  entryPath: string,
  kind: PrimitiveKind
): BundleInstallFile {
  const root = kind === 'skill' ? entryPath.slice(0, entryPath.lastIndexOf('/')) : '';
  const relativePath = kind === 'skill' && root.length > 0
    ? sourcePath.slice(root.length + 1)
    : sourcePath.slice(sourcePath.lastIndexOf('/') + 1);
  return {
    sourcePath,
    relativePath,
    bytes,
    sourceChecksum: checksum(bytes)
  };
}

/**
 * Build a plan for an identity-only legacy manifest (`id`/`version`/`name`
 * with no `prompts[]` and no `items[]`) by inferring each file's kind from
 * its top-level source directory.
 *
 * This is the only place in the install pipeline that still derives a kind
 * from a path, and it is deliberately confined here: writers and the target
 * planner only ever read `BundleInstallItem.kind`. It cannot be dropped,
 * because in-repo bundle producers synthesize exactly this manifest shape:
 *
 *  - `AwesomeCopilotBundleResolver` / `LocalAwesomeCopilotBundleResolver`
 *    (`infra/src/resolvers/awesome-copilot-resolver.ts`, wired from
 *    `cli/src/commands/install.ts`) write `id`/`version`/`name` only and place
 *    collection items under their repo-relative `prompts/`, `instructions/`,
 *    `chatmodes/` and `skills/` prefixes.
 *  - `SkillsBundleResolver` / `LocalSkillsBundleResolver`
 *    (`infra/src/resolvers/skills-resolver.ts`) write the same identity-only
 *    manifest.
 *
 * Every path placed this way is reported in `legacyInferredPaths` so callers
 * can emit `BUNDLE.LEGACY_KIND_INFERENCE` and publishers can migrate to a
 * declared `prompts[]`/`items[]` manifest.
 * @param files - Extracted archive files.
 * @param manifest - Validated identity-only legacy manifest.
 * @returns Install plan whose kinds were inferred from source prefixes.
 */
function createPlanFromLegacyPaths(
  files: ExtractedFiles,
  manifest: LegacyValidatedManifest
): BundleInstallPlan {
  const items: BundleInstallItem[] = [];
  const inferredPaths: string[] = [];
  const skillRoots = new Set<string>();

  for (const [sourcePath, bytes] of files) {
    if (sourcePath === MANIFEST_FILENAME) {
      continue;
    }
    const kind = inferLegacyKind(sourcePath);
    if (kind === null) {
      continue;
    }
    inferredPaths.push(sourcePath);
    if (kind === 'skill') {
      skillRoots.add(skillRoot(sourcePath));
      continue;
    }
    items.push({
      id: legacyItemId(sourcePath, kind),
      kind,
      entryPath: sourcePath,
      files: [createFileRecord(sourcePath, bytes, sourcePath, kind)]
    });
  }

  for (const root of skillRoots) {
    const entryPath = [...files.keys()].find((sourcePath) =>
      sourcePath.toLowerCase() === `${root.toLowerCase()}/skill.md`);
    if (entryPath === undefined) {
      continue;
    }
    items.push({
      id: root.slice(root.lastIndexOf('/') + 1),
      kind: 'skill',
      entryPath,
      files: skillOwnedPaths(files, undefined, entryPath).map((sourcePath) =>
        createFileRecord(sourcePath, files.get(sourcePath)!, entryPath, 'skill'))
    });
  }

  assertNoDuplicateOwnership(items);

  return {
    bundleId: manifest.id,
    bundleVersion: manifest.version,
    manifest,
    items,
    legacyInferredPaths: inferredPaths
  };
}

/**
 * Read the declared items of a legacy (non-`formatVersion`) manifest.
 *
 * Only the `prompts[]` shape is read. `items[]` belongs to the governed
 * release schema, and a manifest that declares it must also declare
 * `formatVersion: 1` — `createBundleInstallPlan` routes those to
 * `createPlanFromGovernedManifest` before this function runs.
 * @param manifest - Validated legacy manifest.
 * @returns Declared item inputs, or an empty array when none are declared.
 */
function getLegacyItems(manifest: LegacyValidatedManifest): ManifestItemInput[] {
  const prompts = manifest.prompts;
  if (!Array.isArray(prompts)) {
    return [];
  }
  return prompts.map((item) => {
    const value = item as Record<string, unknown>;
    return {
      id: value.id,
      path: value.file,
      type: value.type,
      tags: value.tags
    };
  });
}

function assertNoDuplicateOwnership(items: readonly BundleInstallItem[]): void {
  const owners = new Map<string, string>();
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) {
      throw bundleError(`duplicate item id "${item.id}"`, 'BUNDLE.MANIFEST_DUPLICATE_ITEM_ID');
    }
    ids.add(item.id);
    for (const file of item.files) {
      const previous = owners.get(file.sourcePath);
      if (previous !== undefined) {
        throw bundleError(
          `archive file "${file.sourcePath}" is owned by both "${previous}" and "${item.id}"`,
          'BUNDLE.MANIFEST_DUPLICATE_OWNERSHIP'
        );
      }
      owners.set(file.sourcePath, item.id);
    }
  }
}

function assertGovernedCoverage(
  files: ExtractedFiles,
  inventory: ReadonlyMap<string, string>,
  items: readonly BundleInstallItem[]
): void {
  const owned = new Set(items.flatMap((item) => item.files.map((file) => file.sourcePath)));
  for (const [filePath, role] of inventory) {
    if (role === 'installable' && !owned.has(filePath)) {
      throw bundleError(
        `installable archive file "${filePath}" is not owned by a declared item`,
        'BUNDLE.MANIFEST_UNCLAIMED_FILE'
      );
    }
  }
  for (const filePath of files.keys()) {
    if (filePath !== MANIFEST_FILENAME && inventory.get(filePath) === 'installable' && !owned.has(filePath)) {
      throw bundleError(
        `installable archive file "${filePath}" is not owned by a declared item`,
        'BUNDLE.MANIFEST_UNCLAIMED_FILE'
      );
    }
  }
}

function inferLegacyKind(filePath: string): PrimitiveKind | null {
  const segment = filePath.split('/')[0];
  return normalizePrimitiveKind(segment);
}

function skillRoot(filePath: string): string {
  const segments = filePath.split('/');
  const skillsIndex = segments.findIndex((segment) => segment.toLowerCase() === 'skills');
  return skillsIndex !== -1 && segments.length > skillsIndex + 1
    ? segments.slice(0, skillsIndex + 2).join('/')
    : filePath.slice(0, filePath.lastIndexOf('/'));
}

function readNonEmptyString(value: unknown, code: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw bundleError(`${label} must be a non-empty string`, code);
  }
  return value;
}

function readBundlePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/')
    || value.includes('\\')
    || value.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw bundleError(`${label} must be a canonical bundle-relative path`, 'BUNDLE.MANIFEST_PATH_INVALID');
  }
  return value;
}

function legacyItemId(entryPath: string, type: unknown): string {
  if (normalizePrimitiveKind(type) === 'skill') {
    const parent = entryPath.slice(0, entryPath.lastIndexOf('/'));
    return parent.slice(parent.lastIndexOf('/') + 1);
  }
  const fileName = entryPath.slice(entryPath.lastIndexOf('/') + 1);
  return fileName.replace(/\.(prompt|instructions|chatmode|agent)\.md$/iu, '')
    .replace(/\.md$/iu, '');
}

function checksum(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function bundleError(message: string, code: string): ManifestValidationError {
  return new ManifestValidationError(`deployment-manifest.yml ${message}`, code);
}
