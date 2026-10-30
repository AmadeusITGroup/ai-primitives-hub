import type {
  PreparedReplicationArchive,
  ReplicationArchivePreparer,
  ReplicationCandidate,
} from '@ai-primitives-hub/core';
import {
  createApmReleaseManifest,
  normalizePrimitiveKind,
  RegistryError,
  serializeReleaseManifest,
} from '@ai-primitives-hub/core';
import AdmZip from 'adm-zip';
import * as yaml from 'js-yaml';
import {
  buildZip,
} from '../writers/zip-writer';

const DEPLOYMENT_MANIFEST = 'deployment-manifest.yml';
const APM_MANIFEST = 'apm.yml';
const APM_ROOT = '.apm/';
const allowedPrimitiveKinds = new Set(['agent', 'chat-mode', 'instruction', 'prompt', 'skill']);
const nativePaths: Readonly<Record<string, { directory: string; suffix: string }>> = {
  prompt: { directory: 'prompts/', suffix: '.prompt.md' },
  instruction: { directory: 'instructions/', suffix: '.instructions.md' },
  agent: { directory: 'agents/', suffix: '.agent.md' },
  'chat-mode': { directory: 'agents/', suffix: '.agent.md' },
  skill: { directory: 'skills/', suffix: '/SKILL.md' }
};

interface ArchiveFile {
  path: string;
  bytes: Uint8Array;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const displayValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return '<missing>';
  }
  return `<${typeof value}>`;
};

function normalizeArchivePath(entryName: string): string {
  const path = entryName.replaceAll('\\', '/');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new Error(`Unsafe ZIP path: ${entryName}`);
  }
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) {
    throw new Error(`Unsafe ZIP path: ${entryName}`);
  }
  return segments.join('/');
}

function readArchive(bytes: Uint8Array): ArchiveFile[] {
  let entries: AdmZip.IZipEntry[];
  try {
    entries = new AdmZip(Buffer.from(bytes)).getEntries();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const duplicatePath = /^ADM-ZIP: Duplicate entry name "(.+)"$/.exec(detail)?.[1];
    if (duplicatePath) {
      throw new RegistryError({
        code: 'BUNDLE.APM_UNSUPPORTED_CONTENT',
        message: `Transition mode does not accept duplicate ZIP paths: ${duplicatePath}`
      });
    }
    throw new Error(`Transition mode requires a valid ZIP archive: ${detail}`);
  }
  const files: ArchiveFile[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory) {
      continue;
    }
    const path = normalizeArchivePath(entry.entryName);
    // eslint-disable-next-line no-bitwise -- ZIP external attributes encode the Unix file type
    const fileType = (entry.attr >>> 16) & 0o17_0000;
    if (fileType === 0o12_0000) {
      throw new RegistryError({
        code: 'BUNDLE.APM_UNSUPPORTED_CONTENT',
        message: `Transition mode does not accept symbolic links in ZIP archives: ${path}`
      });
    }
    if (seen.has(path)) {
      throw new RegistryError({
        code: 'BUNDLE.APM_UNSUPPORTED_CONTENT',
        message: `Transition mode does not accept duplicate ZIP paths: ${path}`
      });
    }
    seen.add(path);
    files.push({ path, bytes: entry.getData() });
  }
  if (files.length === 0) {
    throw new Error('Transition mode cannot prepare an empty ZIP archive.');
  }
  return files;
}

function apmManifestFromArchive(files: readonly ArchiveFile[]): Record<string, unknown> | undefined {
  const bytes = files.find((file) => file.path === APM_MANIFEST)?.bytes;
  if (!bytes) {
    return undefined;
  }
  try {
    const value: unknown = yaml.load(new TextDecoder().decode(bytes));
    if (!isRecord(value) || typeof value.name !== 'string' || typeof value.version !== 'string'
      || !isRecord(value.dependencies) || !Array.isArray(value.dependencies.apm)
      || !Array.isArray(value.dependencies.mcp)) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function isApmReady(
  files: readonly ArchiveFile[],
  candidate: ReplicationCandidate
): string | undefined {
  const manifest = apmManifestFromArchive(files);
  if (!manifest || manifest.name !== candidate.manifest.id || manifest.version !== candidate.version) {
    return undefined;
  }
  const nativeFiles = files.filter((file) =>
    file.path.startsWith(APM_ROOT)
    && file.path !== `${APM_ROOT}apm.yml`
    && file.path !== `${APM_ROOT}apm.lock.yaml`
  );
  return nativeFiles.length > 0 && typeof manifest.name === 'string' ? manifest.name : undefined;
}

function getDeclaredItems(manifest: Record<string, unknown>): Record<string, unknown>[] {
  const items = Array.isArray(manifest.items) ? manifest.items : manifest.prompts;
  if (!Array.isArray(items) || items.length === 0) {
    throw new RegistryError({
      code: 'BUNDLE.APM_UNSUPPORTED_CONTENT',
      message: 'Transition mode requires at least one declared APM-supported primitive.'
    });
  }
  return items.map((item) => {
    if (!isRecord(item)) {
      throw new Error('Transition mode requires a mapping for every declared primitive.');
    }
    const path = item.path ?? item.file;
    const kind = normalizePrimitiveKind(item.kind ?? item.type);
    if (typeof path !== 'string') {
      throw new Error('Transition mode requires a path for every declared primitive.');
    }
    if (!kind || !allowedPrimitiveKinds.has(kind)) {
      throw new RegistryError({
        code: 'BUNDLE.APM_UNSUPPORTED_CONTENT',
        message: `Transition mode does not support primitive "${displayValue(path)}" (${displayValue(item.kind ?? item.type)}).`
      });
    }
    return { ...item, path, kind };
  });
}

function translatedPath(path: string): string {
  const nativePath = path.replace(/^(?:\.apm|\.github)\//, '');
  return `${APM_ROOT}${nativePath}`;
}

function validateDeclaredFiles(
  items: readonly Record<string, unknown>[],
  files: readonly ArchiveFile[],
  warnings: string[]
): void {
  const filePaths = new Set(files.map((file) => file.path));
  for (const item of items) {
    const path = item.path as string;
    if (!filePaths.has(path)) {
      throw new Error(`Transition mode cannot find declared primitive "${path}" in the release ZIP.`);
    }
    const kind = item.kind as string;
    const convention = nativePaths[kind];
    const relative = path.replace(/^(?:\.apm|\.github)\//, '');
    if (!relative.startsWith(convention.directory) || !relative.endsWith(convention.suffix)) {
      warnings.push(`APM discovery may not recognize "${translatedPath(path)}"; its path does not follow the native ${kind} layout.`);
    }
  }
}

export class ApmTransitionArchivePreparer implements ReplicationArchivePreparer {
  // Keep the Promise contract so malformed input becomes a rejected preparation operation.
  // eslint-disable-next-line @typescript-eslint/require-await -- async converts validation throws into rejected Promises.
  public async prepare(
    candidate: ReplicationCandidate,
    archive: Uint8Array
  ): Promise<PreparedReplicationArchive> {
    const files = readArchive(archive);
    const existingDeploymentManifest = files.find((file) => file.path === DEPLOYMENT_MANIFEST);
    if (existingDeploymentManifest
      && !Buffer.from(existingDeploymentManifest.bytes).equals(Buffer.from(candidate.manifestBytes))) {
      throw new Error(`Release ZIP deployment manifest does not match the published manifest asset for ${candidate.bundleId}@${candidate.version}.`);
    }
    const existingApmName = isApmReady(files, candidate);
    if (existingApmName) {
      return { bytes: archive, packageName: existingApmName, translated: false, warnings: [] };
    }

    const id = candidate.manifest.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      throw new Error(`Transition mode cannot use manifest id "${String(id)}" as an Agent Packages name.`);
    }
    if (candidate.manifest.version !== candidate.version) {
      throw new Error(`Transition mode found mismatched release version for ${candidate.bundleId}@${candidate.version}.`);
    }

    const items = getDeclaredItems(candidate.manifest);
    const warnings: string[] = [];
    validateDeclaredFiles(items, files, warnings);
    if ((Array.isArray(candidate.manifest.dependencies) && candidate.manifest.dependencies.length > 0)
      || (isRecord(candidate.manifest.mcpServers) && Object.keys(candidate.manifest.mcpServers).length > 0)) {
      warnings.push('APH dependency/MCP declarations remain in deployment-manifest.yml and x-aph metadata; they are not translated into native APM dependencies.');
    }

    const output = new Map<string, Uint8Array>();
    const add = (path: string, contentBytes: Uint8Array): void => {
      const previous = output.get(path);
      if (previous && !Buffer.from(previous).equals(Buffer.from(contentBytes))) {
        throw new Error(`Transition mode found conflicting content for ZIP path "${path}".`);
      }
      output.set(path, contentBytes);
    };
    for (const file of files) {
      if (file.path === APM_MANIFEST) {
        continue;
      }
      add(file.path, file.bytes);
      if (file.path !== DEPLOYMENT_MANIFEST) {
        add(translatedPath(file.path), file.bytes);
      }
    }
    if (!existingDeploymentManifest) {
      add(DEPLOYMENT_MANIFEST, candidate.manifestBytes);
    }
    const apmManifest = createApmReleaseManifest(candidate.manifest);
    add(APM_MANIFEST, new TextEncoder().encode(serializeReleaseManifest(apmManifest)));
    const nativeCount = [...output.keys()].filter((path) => path.startsWith(APM_ROOT)).length;
    if (nativeCount === 0) {
      throw new Error('Transition mode could not create APM primitive files from this release archive.');
    }
    const bytes = buildZip([...output].map(([path, content]) => ({ path, bytes: content })));
    return { bytes, packageName: id, translated: true, warnings: [...new Set(warnings)] };
  }
}
