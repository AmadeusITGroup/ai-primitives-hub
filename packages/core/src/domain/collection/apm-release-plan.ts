import {
  createHash,
} from 'node:crypto';
import {
  normalizePrimitiveKind,
} from '../primitive/types';
import {
  RegistryError,
} from '../registry-error';
import {
  APM_MANIFEST_FILENAME,
  MANIFEST_FILENAME,
  validateManifest,
} from './manifest-validator';
import {
  RELEASE_FILE_MODE,
  type ReleaseArchiveEntry,
  type ReleaseManifestPlan,
  serializeReleaseManifest,
} from './release-manifest-plan';
import type {
  ReleaseManifestFile,
} from './types';
import {
  normalizeRepoRelativePath,
} from './validate';

export type BundleArchiveLayout = 'aph' | 'apm';

export interface ReleaseLayoutResult {
  plan: ReleaseManifestPlan;
  warnings: string[];
}

const nativePaths: Readonly<Record<string, { directory: string; suffix: string }>> = {
  prompt: { directory: 'prompts/', suffix: '.prompt.md' },
  instruction: { directory: 'instructions/', suffix: '.instructions.md' },
  agent: { directory: 'agents/', suffix: '.agent.md' },
  'chat-mode': { directory: 'agents/', suffix: '.agent.md' },
  skill: { directory: 'skills/', suffix: '/SKILL.md' }
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const unsupported = (message: string): RegistryError => new RegistryError({
  code: 'BUNDLE.APM_UNSUPPORTED_CONTENT',
  message,
  hint: 'Use the default --layout aph for content not yet supported by the experimental APM layout.'
});

const nativeRelativePath = (filePath: string): string => {
  const canonical = normalizeRepoRelativePath(filePath);
  return canonical.replace(/^(?:\.apm|\.github)\//, '');
};

const apmPath = (filePath: string): string => `.apm/${nativeRelativePath(filePath)}`;

const isNativeApmDiscoveryPathForRelative = (kind: string | null, relative: string): boolean => {
  if (kind === null) {
    return false;
  }
  const convention = nativePaths[kind];
  if (convention === undefined) {
    return false;
  }
  const nativeLocation = relative.startsWith(convention.directory) && relative.endsWith(convention.suffix);
  const nestedLeaf = (kind === 'instruction' || kind === 'prompt')
    && relative.slice(convention.directory.length).includes('/');
  const nestedSkill = kind === 'skill' && relative.split('/').length !== 3;
  return nativeLocation && !nestedLeaf && !nestedSkill;
};

/**
 * Whether the native APM tooling discovers a primitive at this path.
 * @param kind - Normalized primitive kind.
 * @param filePath - Repository-relative primitive path.
 */
export const isNativeApmDiscoveryPath = (kind: string | null, filePath: string): boolean =>
  isNativeApmDiscoveryPathForRelative(kind, nativeRelativePath(filePath));

const rewireItems = (items: unknown, pathField: 'path' | 'file', warnings: string[]): Record<string, unknown>[] => {
  if (!Array.isArray(items)) {
    throw unsupported('APM layout requires a file-backed primitive list');
  }
  return items.map((item: unknown) => {
    if (!record(item) || typeof item[pathField] !== 'string') {
      throw unsupported('APM layout requires a path for every primitive');
    }
    const sourcePath = item[pathField];
    const kind = normalizePrimitiveKind(pathField === 'path' ? item.kind : item.type);
    const convention = kind === null ? undefined : nativePaths[kind];
    const relative = nativeRelativePath(sourcePath);
    if (convention === undefined) {
      throw unsupported(`APM layout does not yet support "${sourcePath}" (${String(kind)})`);
    }
    if (!isNativeApmDiscoveryPathForRelative(kind, relative)) {
      warnings.push(`Native APM discovery is not qualified for "${apmPath(sourcePath)}". `
        + 'APH preserves manifest-driven installation; consider a flat native path if APM consumption is required.');
    }
    return { ...item, [pathField]: apmPath(sourcePath) };
  });
};

/**
 * Create the sorted SHA-256 inventory shared by bundle layouts and replication.
 * @param entries - Archive files with their intended installation roles.
 * @returns A complete deployment-manifest inventory excluding the manifest itself.
 */
export const createReleaseManifestFileInventory = (
  entries: readonly Pick<ReleaseArchiveEntry, 'path' | 'role' | 'bytes'>[]
): ReleaseManifestFile[] => entries.toSorted(
  (a, b) => a.path < b.path ? -1 : (a.path > b.path ? 1 : 0)
).map((entry) => ({
  path: entry.path,
  role: entry.role,
  size: entry.bytes.byteLength,
  sha256: `sha256:${createHash('sha256').update(entry.bytes).digest('hex')}`
}));

const inventory = createReleaseManifestFileInventory;

/**
 *
 * @param manifest
 */
/**
 * Project APH release metadata into the Agent Packages manifest shape.
 * @param manifest - Validated APH deployment manifest.
 * @returns APM manifest metadata retaining the original manifest as `x-aph`.
 */
export function createApmReleaseManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  return {
    name: manifest.id,
    version: manifest.version,
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    ...(manifest.author === undefined ? {} : { author: manifest.author }),
    ...(manifest.license === undefined ? {} : { license: manifest.license }),
    ...(manifest.repository === undefined ? {} : { repository: manifest.repository }),
    ...(manifest.tags === undefined ? {} : { tags: manifest.tags }),
    dependencies: { apm: [], mcp: [] },
    includes: 'auto',
    'x-aph': { deploymentManifest: MANIFEST_FILENAME, ...manifest }
  };
}

/**
 * Repackage a planned release without changing source files or payload bytes.
 * The embedded deployment inventory omits `apm.yml` to avoid a circular
 * digest; the final root deployment manifest inventory includes it.
 * @param plan - Existing governed or legacy release plan.
 * @param layout - Opt-in archive layout; the default is unchanged.
 * @returns A validated plan for the selected layout.
 */
export function applyReleaseLayout(
  plan: ReleaseManifestPlan,
  layout: BundleArchiveLayout = 'aph'
): ReleaseLayoutResult {
  if (layout === 'aph') {
    return { plan, warnings: [] };
  }
  if (layout !== 'apm') {
    throw new RegistryError({ code: 'USAGE.INVALID_ARGUMENT', message: `Unknown bundle layout: ${String(layout)}` });
  }
  const original = plan.manifest;
  const warnings: string[] = [];
  if ((Array.isArray(original.dependencies) && original.dependencies.length > 0)
    || (record(original.mcpServers) && Object.keys(original.mcpServers).length > 0)) {
    warnings.push('APH dependency/MCP declarations are preserved in the deployment manifest and x-aph metadata, '
      + 'but are not translated into native APM dependencies.');
  }
  const governed = original.formatVersion === 1;
  const items = rewireItems(governed ? original.items : original.prompts, governed ? 'path' : 'file', warnings);
  if (items.length === 0) {
    throw unsupported('APM layout requires at least one supported primitive');
  }
  const entries = plan.entries.map((entry) => ({ ...entry, path: apmPath(entry.path) }));
  const paths = new Set<string>();
  for (const entry of entries) {
    if (paths.has(entry.path)) {
      throw unsupported(`APM layout creates duplicate archive path "${entry.path}"`);
    }
    paths.add(entry.path);
  }
  const manifest: Record<string, unknown> = {
    ...original,
    ...(governed ? { items, prompts: rewireItems(original.prompts, 'file', warnings) } : { prompts: items })
  };
  if (typeof original.readme === 'string' && paths.has(apmPath(original.readme))) {
    manifest.readme = apmPath(original.readme);
  }
  if (record(original.provenance)) {
    const provenance = { ...original.provenance };
    for (const field of ['sourceSnapshotPath', 'licensePath']) {
      if (typeof provenance[field] === 'string') {
        provenance[field] = apmPath(provenance[field]);
      }
    }
    manifest.provenance = provenance;
  }
  if (governed) {
    manifest.files = inventory(entries);
  }
  const apmManifest = createApmReleaseManifest(manifest);
  entries.push({
    path: APM_MANIFEST_FILENAME,
    role: 'metadata',
    mode: RELEASE_FILE_MODE,
    bytes: new TextEncoder().encode(serializeReleaseManifest(apmManifest))
  });
  entries.sort((a, b) => a.path < b.path ? -1 : (a.path > b.path ? 1 : 0));
  if (governed) {
    manifest.files = inventory(entries);
  }
  validateManifest(new Map([
    ...entries.map((entry): [string, Uint8Array] => [entry.path, entry.bytes]),
    [MANIFEST_FILENAME, new TextEncoder().encode(serializeReleaseManifest(manifest))]
  ]), {});
  return { plan: { ...plan, manifest, entries }, warnings: [...new Set(warnings)] };
}
